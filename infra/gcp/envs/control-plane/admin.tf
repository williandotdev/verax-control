# O console do responsável (`cp-admin`): o terceiro serviço da mesma imagem, com `ROLE=admin`, que serve as telas
# (apps/console) e a API `/v1/admin/...` (tabelas de preço, modelos de custo, publicação, simulador de DRE e clientes).
# O endereço é o site próprio do Firebase Hosting, `admin.veraxsistemas.com.br`, com o rewrite de tudo (`/**`) para o
# cp-admin, igual ao `conta` → cp-public (hosting.tf). Nada disto existe sem `admin_enabled = true`.
#
# Quem entra é decidido pelo próprio app (decisão do responsável, 09/11/2026, no lugar do IAP): e-mail de
# `owner_principals`, senha (scrypt) e código do aplicativo autenticador (TOTP), com bloqueio depois de 5 códigos errados
# (com a senha certa) em 15 minutos, limites de falhas por IP e no total e sessão no Firestore (cookie `__session`, o
# único que o Hosting repassa ao Cloud Run). O primeiro cadastro (`/configurar`) exige o token de uso único do
# segredo `cp-admin-setup-token`; o segredo do TOTP fica cifrado no Firestore com a chave derivada de
# `cp-admin-totp-key` (secrets.tf). Os dois são lidos pela API do Secret Manager na hora do uso, não montados: sem eles
# o serviço sobe e o `/health` responde; só o login e o cadastro respondem 503. Passo a passo em
# docs/runbooks/console-do-responsavel.md.
#
# Por isso o serviço aceita invocação anônima (`allUsers`), como o cp-public: o rewrite do Hosting chama o Cloud Run sem
# token de identidade e exige isso. A barreira é o app: toda rota fora de `/health`, do login e do cadastro exige uma
# sessão de responsável. A conta do serviço lê e grava o Firestore, lê os dois segredos do console e, com os serviços no
# ar, invoca o cp-worker (só `run.invoker` nele, abaixo): é assim que as operações do responsável chegam ao worker, com o
# token da própria conta e o e-mail da sessão no corpo (o worker aceita essa conta só nas operações do responsável,
# `ADMIN_SA_EMAIL` em run.tf). Da Stripe, só o id da alíquota do imposto por cima (`STRIPE_TAX_RATE_ID`), sem chave.

locals {
  admin_service_name = "cp-admin"

  # Só o que o console usa: nenhuma variável do site, da Stripe, das filas ou do provisionamento (o app tira as de
  # outro papel, mas aqui elas nem chegam), e nenhum segredo montado. `WORKER_URL` é a audiência do token que o console
  # pede ao servidor de metadados para chamar o cp-worker (a mesma URL determinística de run.tf);
  # `ADMIN_SECRETS_PROJECT_ID` é o projeto dos segredos `cp-admin-totp-key` e `cp-admin-setup-token`, lidos pela API.
  # `TRUSTED_PROXIES` não vai para o console, de propósito, nem a de `service_env`: confiar nas saídas da CDN do Hosting
  # (Fastly) deixaria qualquer um com um serviço na mesma CDN chamar o `run.app` com um `X-Forwarded-For` escolhido e
  # escapar do limite por IP do login. Sem ela, quem chega pelo Hosting conta no balde da saída do Hosting; o que segura
  # adivinhação são os limites que só contam falhas (por IP e global) e o bloqueio da conta (admin-auth.controller.ts).
  # `TRUST_PROXY_HOPS` fica no padrão do app (1, o front end do Cloud Run). A única de `service_env` que vem para cá é
  # `STRIPE_TAX_RATE_ID` (só o id da alíquota do imposto por cima, o mesmo do cp-public): sem ela, o console recusa
  # publicar uma tabela de preços sem impostos, que o checkout não saberia cobrar. Vazia, a variável não vai.
  admin_env = {
    NODE_ENV                 = "production"
    LOG_LEVEL                = "info"
    FIRESTORE_DATABASE       = google_firestore_database.default.name
    ADMIN_SECRETS_PROJECT_ID = var.project_id
    OWNER_PRINCIPALS         = join(",", local.owner_emails)
    WORKER_URL               = local.worker_url
    STRIPE_TAX_RATE_ID       = lookup(var.service_env, "STRIPE_TAX_RATE_ID", "")
  }
}

resource "google_service_account" "admin" {
  count = var.admin_enabled ? 1 : 0

  account_id   = local.admin_service_name
  display_name = "Plano de controle: console do responsável (cp-admin)"
}

# Só o Firestore (as tabelas de preço, os modelos de custo, os clientes, a auditoria e as contas e sessões do console).
# Os dois segredos do console são concedidos em cada segredo (secrets.tf), nunca no projeto. Nenhuma fila, nada da Stripe.
resource "google_project_iam_member" "admin" {
  for_each = var.admin_enabled ? toset(["roles/datastore.user"]) : toset([])

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.admin[0].email}"
}

resource "google_cloud_run_v2_service" "admin" {
  count = var.admin_enabled ? 1 : 0

  name                = local.admin_service_name
  location            = var.region
  description         = "Plano de controle do Verax Control: console do responsável (preço, DRE e clientes), com login próprio."
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account = google_service_account.admin[0].email
    # A checagem de publicação percorre a grade inteira da tabela (até 500 mil configurações, o teto do app).
    timeout                          = "300s"
    max_instance_request_concurrency = 10

    # Uma instância só: o limite por IP do login fica em memória e vale para o serviço inteiro.
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

      # `/health` responde sem sessão (como o login e o cadastro); é a sonda de partida.
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

  depends_on = [google_project_service.apis, google_project_iam_member.admin]
}

# Invocação anônima, como o cp-public (run.tf): o rewrite do Hosting exige. A proteção é do app (sessão de responsável
# em toda rota de dado, senha mais TOTP, bloqueio e limite por IP no login).
resource "google_cloud_run_v2_service_iam_member" "admin_invoker" {
  count = var.admin_enabled ? 1 : 0

  name     = google_cloud_run_v2_service.admin[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Quem implanta publica revisões novas do cp-admin (a mesma largura do run.developer dos outros serviços, run.tf).
resource "google_cloud_run_v2_service_iam_member" "admin_deployer" {
  count = var.admin_enabled ? 1 : 0

  name     = google_cloud_run_v2_service.admin[0].name
  location = var.region
  role     = "roles/run.developer"
  member   = local.deployer_member
}

# O console chama o cp-worker com o token da própria conta (aud = WORKER_URL) para as operações do responsável: o
# início do provisionamento de um cliente de contrato direto e o `resume` (e, com o CP-11, `delete-now` e `export`). Só
# `run.invoker` e só no cp-worker: nem no cp-public, nem no Job, nem no projeto, e nenhum `actAs` na cp-invoker (o
# console não enfileira nada). O app do worker aceita esta conta só nas rotas marcadas com o grupo `console`, e sempre
# com um responsável de `owner_principals` no corpo (o e-mail da sessão do console); nos passos e na revelação, recusa.
# Como as chamadas do cp-public, esta sai pela internet: com `worker_ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"` a
# entrada do worker a recusa (GUIA, "Operações do responsável no cp-worker").
resource "google_cloud_run_v2_service_iam_member" "admin_worker_invoker" {
  count = var.admin_enabled && var.services_enabled ? 1 : 0

  name     = google_cloud_run_v2_service.worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.admin[0].email}"
}

# O endereço do console: um site próprio do Firebase Hosting com o domínio `admin.veraxsistemas.com.br` e o rewrite de
# tudo (`/**`) para o cp-admin, no mesmo desenho do site `conta` (hosting.tf): o mapeamento de domínio do Cloud Run não
# existe em southamerica-east1, e o Hosting só repassa o cookie `__session`, que é o da sessão do console. Os quatro
# recursos existem só no provider beta na 8.9.0. O rewrite pede o plano Blaze, como o do `conta`.

resource "google_firebase_hosting_site" "admin" {
  provider = google-beta
  count    = var.admin_enabled ? 1 : 0

  site_id = var.admin_hosting_site_id

  depends_on = [google_project_service.apis]
}

resource "google_firebase_hosting_version" "admin" {
  provider = google-beta
  count    = var.admin_enabled ? 1 : 0

  site_id = google_firebase_hosting_site.admin[0].site_id

  config {
    rewrites {
      glob = "/**"
      run {
        service_id = google_cloud_run_v2_service.admin[0].name
        region     = var.region
      }
    }
  }
}

resource "google_firebase_hosting_release" "admin" {
  provider = google-beta
  count    = var.admin_enabled ? 1 : 0

  site_id      = google_firebase_hosting_site.admin[0].site_id
  version_name = google_firebase_hosting_version.admin[0].name
  message      = "Rewrite /** para o Cloud Run cp-admin (Terraform)."
}

# O domínio próprio do console. Como o do `conta`, o `apply` não espera o DNS: os registros que o Firebase pede saem em
# `terraform output cloudflare_dns_records` (junto com os do `conta`), e o certificado é emitido depois que eles existem
# no Cloudflare, sem proxy.
resource "google_firebase_hosting_custom_domain" "admin" {
  provider = google-beta
  count    = var.admin_enabled ? 1 : 0

  site_id               = google_firebase_hosting_site.admin[0].site_id
  custom_domain         = var.admin_hosting_domain
  wait_dns_verification = false
}
