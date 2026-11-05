# O console do responsável (`cp-admin`): o terceiro serviço da mesma imagem, com `ROLE=admin`, que serve as telas
# (apps/console) e a API `/v1/admin/...` (tabelas de preço, modelos de custo, publicação e simulador de DRE). Fica
# atrás do IAP ligado direto no Cloud Run, sem balanceador (GA desde 13/03/2026, notas de versão do Cloud Run; no
# provider, `iap_enabled` no `google_cloud_run_v2_service` desde a 7.21.0 e `google_iap_web_cloud_run_service_iam_*`
# desde a 6.31.0, ambos no schema da 8.9.0 fixada aqui). Nada disto existe sem `admin_enabled = true`.
#
# Quem entra: só quem está em `owner_principals`, com `roles/iap.httpsResourceAccessor` no serviço. O IAP chama o
# serviço como o agente de serviço dele (`service-<número>@gcp-sa-iap.iam.gserviceaccount.com`), que é o único
# `run.invoker` (nunca allUsers). O app confere de novo o JWT do IAP em toda requisição (`IAP_AUDIENCE`, que para o
# IAP no Cloud Run é `/projects/<número>/locations/<região>/services/<nome>`, documentação dos cabeçalhos assinados do
# IAP, e o e-mail em `OWNER_PRINCIPALS`). A conta do serviço só lê e grava o Firestore: nenhum segredo, nem a Stripe.
#
# Projeto sem organização: o IAP precisa de um cliente OAuth próprio para contas de fora de uma organização, e esse
# cliente não se cria por API. É um passo manual, uma vez (docs/runbooks/console-do-responsavel.md); o segredo do
# cliente nunca passa pelo Terraform.

locals {
  admin_service_name = "cp-admin"

  # O `aud` do JWT assinado pelo IAP para um serviço do Cloud Run (documentação "Securing your app with signed
  # headers"): o número do projeto, a região e o nome do serviço. O app recusa qualquer outro.
  admin_iap_audience = "/projects/${data.google_project.this.number}/locations/${var.region}/services/${local.admin_service_name}"

  # Só o que o console usa: nenhuma variável do site, da Stripe, das filas ou do provisionamento (o app tira as de
  # outro papel, mas aqui elas nem chegam), e nenhum segredo.
  admin_env = {
    NODE_ENV           = "production"
    LOG_LEVEL          = "info"
    FIRESTORE_DATABASE = google_firestore_database.default.name
    IAP_AUDIENCE       = local.admin_iap_audience
    OWNER_PRINCIPALS   = join(",", local.owner_emails)
  }
}

resource "google_project_service" "iap" {
  count = var.admin_enabled ? 1 : 0

  service                    = "iap.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
}

resource "google_service_account" "admin" {
  count = var.admin_enabled ? 1 : 0

  account_id   = local.admin_service_name
  display_name = "Plano de controle: console do responsável atrás do IAP (cp-admin)"
}

# Só o Firestore (as tabelas de preço, os modelos de custo e a auditoria). Nenhum segredo, nenhuma fila, nada da Stripe.
resource "google_project_iam_member" "admin" {
  for_each = var.admin_enabled ? toset(["roles/datastore.user"]) : toset([])

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.admin[0].email}"
}

# O agente de serviço do IAP, criado antes de receber o `run.invoker` (num projeto que acabou de ligar a API, ele só
# nasceria no primeiro uso). Mesmo desenho dos agentes do Cloud Tasks e do Scheduler (identities.tf).
resource "google_project_service_identity" "iap" {
  provider = google-beta
  count    = var.admin_enabled ? 1 : 0

  service = "iap.googleapis.com"

  depends_on = [google_project_service.iap]
}

resource "google_cloud_run_v2_service" "admin" {
  count = var.admin_enabled ? 1 : 0

  name        = local.admin_service_name
  location    = var.region
  description = "Plano de controle do Verax Control: console do responsável (preço e DRE), atrás do IAP."
  # O IAP no Cloud Run protege todas as entradas, inclusive o endereço run.app (documentação do IAP no Cloud Run).
  ingress             = "INGRESS_TRAFFIC_ALL"
  iap_enabled         = true
  deletion_protection = true

  template {
    service_account = google_service_account.admin[0].email
    # A checagem de publicação percorre a grade inteira da tabela (até 500 mil configurações, o teto do app).
    timeout                          = "300s"
    max_instance_request_concurrency = 10

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = var.admin_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      # A sonda não passa pelo IAP, e o app deixa `/health` sem o JWT (é a única rota assim).
      startup_probe {
        period_seconds    = 5
        failure_threshold = 12
        timeout_seconds   = 3

        http_get {
          path = "/health"
        }
      }

      env {
        name  = "ROLE"
        value = "admin"
      }

      dynamic "env" {
        for_each = { for name, value in local.admin_env : name => value if value != "" }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, traffic, client, client_version]
  }

  depends_on = [google_project_service.apis, google_project_service.iap, google_project_iam_member.admin]
}

# O IAP chama o serviço como o agente dele: é o único invocador. Nada de allUsers nem de pessoas aqui (quem entra é
# decidido no IAP, abaixo).
resource "google_cloud_run_v2_service_iam_member" "admin_iap_invoker" {
  count = var.admin_enabled ? 1 : 0

  name     = google_cloud_run_v2_service.admin[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_project_service_identity.iap[0].member
}

# Quem passa pelo IAP: só os responsáveis (`owner_principals`), no serviço, nunca no projeto.
resource "google_iap_web_cloud_run_service_iam_member" "owners" {
  for_each = var.admin_enabled ? toset(var.owner_principals) : toset([])

  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.admin[0].name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.value
}

# Quem implanta publica revisões novas do cp-admin (a mesma largura do run.developer dos outros serviços, run.tf).
resource "google_cloud_run_v2_service_iam_member" "admin_deployer" {
  count = var.admin_enabled ? 1 : 0

  name     = google_cloud_run_v2_service.admin[0].name
  location = var.region
  role     = "roles/run.developer"
  member   = local.deployer_member
}
