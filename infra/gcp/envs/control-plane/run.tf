# Os dois serviços e o Job do Cloud Run (plano, seção 2.1). Tudo com zero instâncias quando não há trabalho (cobrança
# por requisição), sem IP reservado, sem NAT e sem Cloud SQL: é o que mantém a Verax no nível gratuito.
#
# Só nascem com `services_enabled = true`: o Cloud Run recusa uma revisão que monte um segredo sem versão, e os cinco
# segredos nascem vazios (secrets.tf). A imagem de cada um é a de exemplo do Google na primeira subida; o workflow de
# implantação (CP-01) publica a imagem do plano de controle e troca a dos serviços, e o Terraform não mexe mais nela
# (`ignore_changes`), para os dois não brigarem. `client` e `client_version` ficam na mesma lista: o gcloud os grava a
# cada implantação.

locals {
  # URL determinística do Cloud Run (nome-número.região.run.app): o cp-worker a confere no `aud` do token, as tasks e o
  # Scheduler a chamam, e ela é conhecida antes de o serviço existir, sem ciclo entre os recursos.
  worker_url = "https://cp-worker-${data.google_project.this.number}.${var.region}.run.app"

  owner_emails = [for principal in var.owner_principals : split(":", principal)[1]]

  # Padrões seguros das variáveis da seção 2.5 do plano; `var.service_env` substitui ou acrescenta. Nada de segredo.
  # O que fica fora (versões dos aceites, URL do Portal, remetente e usuário do SMTP, versão do nó) é do responsável e
  # entra pelo terraform.tfvars; a validação na partida do serviço avisa o que falta.
  service_env_defaults = {
    NODE_ENV                         = "production"
    LOG_LEVEL                        = "info"
    TRUST_PROXY_HOPS                 = "1"
    SITE_ORIGINS                     = "https://veraxsistemas.com.br,https://www.veraxsistemas.com.br"
    SITE_SUCCESS_URL                 = "https://veraxsistemas.com.br/checkout/sucesso?cs={CHECKOUT_SESSION_ID}"
    SITE_CANCEL_URL                  = "https://veraxsistemas.com.br/#planos"
    STRIPE_LIVE                      = "false"
    STRIPE_PRICE_LOOKUP_ESSENCIAL    = "verax_control_essencial_mensal"
    STRIPE_PRICE_LOOKUP_PROFISSIONAL = "verax_control_profissional_mensal"
    PROVISIONING_ENABLED             = "false"
    CLOUDFLARE_ZONE_NAME             = "veraxsistemas.com.br"
    PANEL_DOMAIN_SUFFIX              = "control.veraxsistemas.com.br"
    API_DOMAIN_PREFIX                = "api-"
    SMTP_HOST                        = "smtp.zoho.com"
    SMTP_PORT                        = "465"
  }

  # O que o próprio Terraform sabe (nomes, URLs e contas que ele criou).
  service_env_infra = {
    FIRESTORE_DATABASE       = google_firestore_database.default.name
    TASKS_LOCATION           = var.region
    TASKS_QUEUE_PROVISIONING = google_cloud_tasks_queue.cp["provisioning"].name
    TASKS_QUEUE_LIFECYCLE    = google_cloud_tasks_queue.cp["lifecycle"].name
    WORKER_URL               = local.worker_url
    WORKER_SA_EMAIL          = google_service_account.worker.email
    SCHEDULER_SA_EMAIL       = google_service_account.worker.email
    OWNER_PRINCIPALS         = join(",", local.owner_emails)
    OWNER_ALERT_EMAIL        = var.alert_email
    TERRAFORM_JOB_NAME       = "cp-terraform"
    NODES_PROJECT_ID         = var.nodes_project_id
    NODES_REGION             = var.region
    NODES_ZONE               = var.nodes_zone
    TFSTATE_BUCKET           = local.nodes_tfstate_bucket
    IMAGES_PROJECT_ID        = var.images_project_id
    RELEASE_BUCKET           = var.release_bucket
    FIREBASE_PANEL_PROJECTS  = join(",", concat([var.project_id], var.firebase_panel_projects))
    CLOUDFLARE_ACCOUNT_ID    = var.cloudflare_account_id
    CLOUDFLARE_ZONE_ID       = var.cloudflare_zone_id
  }

  # Uma variável vazia não vai: o schema do serviço trata ausência, não texto vazio.
  service_env = {
    for name, value in merge(local.service_env_defaults, local.service_env_infra, var.service_env) : name => value
    if value != ""
  }

  # Segredos montados como variável (lidos na partida da instância), por serviço: variável => segredo, a partir de
  # quem lê cada um (secrets.tf). Os mesmos segredos que a conta do serviço tem permissão de ler, nem mais nem menos.
  public_secret_env = { for id, secret in local.secrets : secret.env => id if contains(secret.readers, "public") }
  worker_secret_env = { for id, secret in local.secrets : secret.env => id if contains(secret.readers, "worker") }

  # Variáveis fixas do Job; as de cada tenant chegam em `overrides` a cada execução (plano, 4c, passo 4).
  job_env = {
    for name, value in {
      NODES_PROJECT_ID = var.nodes_project_id
      NODES_REGION     = var.region
      NODES_ZONE       = var.nodes_zone
      TFSTATE_BUCKET   = local.nodes_tfstate_bucket
      CP_WORKER_SA     = google_service_account.worker.email
    } : name => value if value != ""
  }
}

# Público: checkout, webhook e página de status, atrás do site do Hosting (hosting.tf). Aceita invocação anônima
# porque o rewrite do Hosting exige; a proteção é do próprio app (limites por IP, assinatura do webhook, cookie).
resource "google_cloud_run_v2_service" "public" {
  count = var.services_enabled ? 1 : 0

  name                = "cp-public"
  location            = var.region
  description         = "Plano de controle do Verax Control: checkout, webhook da Stripe e página de status."
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account                  = google_service_account.public.email
    timeout                          = "60s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = var.public_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # CPU só durante a requisição (cobrança por requisição, a do nível gratuito).
        cpu_idle = true
      }

      env {
        name  = "ROLE"
        value = "public"
      }

      dynamic "env" {
        for_each = local.service_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.public_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.cp[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_secret_manager_secret_iam_member.readers, google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count = var.services_enabled ? 1 : 0

  name     = google_cloud_run_v2_service.public[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Interno: um passo do provisionamento por task, o `tick` horário, o `reconcile` diário e as operações do responsável.
# Só com token de identidade (IAM) e, por padrão, só de dentro do projeto (Cloud Tasks e Cloud Scheduler). O app ainda
# confere `aud` e `email` do token.
resource "google_cloud_run_v2_service" "worker" {
  count = var.services_enabled ? 1 : 0

  name                = "cp-worker"
  location            = var.region
  description         = "Plano de controle do Verax Control: passos do provisionamento, tick e reconciliação."
  ingress             = var.worker_ingress
  deletion_protection = true

  template {
    service_account = google_service_account.worker.email
    # Cada passo é curto (os longos se reagendam); 15 min é o prazo de despacho das tasks.
    timeout = "900s"

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = var.worker_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "ROLE"
        value = "worker"
      }

      dynamic "env" {
        for_each = local.service_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.worker_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.cp[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_secret_manager_secret_iam_member.readers, google_project_service.apis]
}

# Quem chama o cp-worker: a conta das tasks e do Scheduler (a própria conta do worker) e o responsável. Nunca allUsers.
resource "google_cloud_run_v2_service_iam_member" "worker_invokers" {
  for_each = var.services_enabled ? merge(
    { worker = local.worker_member },
    { for principal in var.owner_principals : principal => principal },
  ) : {}

  name     = google_cloud_run_v2_service.worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.value
}

# Quem implanta publica revisões novas dos dois serviços (e nada mais neles).
resource "google_cloud_run_v2_service_iam_member" "deployer" {
  for_each = var.services_enabled ? {
    public = google_cloud_run_v2_service.public[0].name
    worker = google_cloud_run_v2_service.worker[0].name
  } : {}

  name     = each.value
  location = var.region
  role     = "roles/run.developer"
  member   = local.deployer_member
}

# Executor Terraform: uma tarefa por execução, 1 vCPU, 2 GiB, 30 minutos, sem repetição (quem repete é o worker, uma
# vez, porque o Terraform é idempotente). A identidade tem papéis só no projeto dos nós (cross_project.tf).
resource "google_cloud_run_v2_job" "terraform" {
  count = var.services_enabled ? 1 : 0

  name                = "cp-terraform"
  location            = var.region
  deletion_protection = true

  template {
    task_count = 1

    template {
      service_account = google_service_account.terraform.email
      timeout         = "1800s"
      max_retries     = 0

      containers {
        image = var.terraform_image

        resources {
          limits = {
            cpu    = "1"
            memory = "2Gi"
          }
        }

        dynamic "env" {
          for_each = local.job_env
          content {
            name  = env.key
            value = env.value
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_job_iam_member" "worker_runner" {
  count = var.services_enabled ? 1 : 0

  name     = google_cloud_run_v2_job.terraform[0].name
  location = var.region
  role     = google_project_iam_custom_role.job_runner.id
  member   = local.worker_member
}

resource "google_cloud_run_v2_job_iam_member" "deployer" {
  count = var.services_enabled ? 1 : 0

  name     = google_cloud_run_v2_job.terraform[0].name
  location = var.region
  role     = "roles/run.developer"
  member   = local.deployer_member
}
