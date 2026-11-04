# Os serviços, o Job, as filas e o relógio: os tamanhos da seção 2.1 do plano, zero instâncias mínimas, a sonda de
# partida, as variáveis e os segredos de cada serviço (o que é só do worker não chega ao público; o que o Terraform
# deriva não é substituído), a imagem que o workflow troca sem o Terraform desfazer, e a primeira subida sem os
# serviços (os segredos nascem vazios).
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }
}

mock_provider "google-beta" {
  mock_resource "google_project_service_identity" {
    defaults = {
      email  = "service-123456789012@gcp-sa-exemplo.iam.gserviceaccount.com"
      member = "serviceAccount:service-123456789012@gcp-sa-exemplo.iam.gserviceaccount.com"
    }
  }
}

override_resource {
  target = google_service_account.public
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-public@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-public@projeto-exemplo.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.worker
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-worker@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-worker@projeto-exemplo.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.terraform
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-terraform@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-terraform@projeto-exemplo.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.invoker
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-invoker@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-invoker@projeto-exemplo.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.deployer
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-deployer@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-deployer@projeto-exemplo.iam.gserviceaccount.com"
  }
}

variables {
  project_id = "projeto-exemplo"
}

# A primeira subida (`services_enabled = false`): as contas, os segredos vazios, as filas, o banco, o site e o domínio;
# nada que precise de segredo preenchido.
run "primeira_subida_sem_servicos" {
  command = plan

  assert {
    condition = (
      length(google_cloud_run_v2_service.public) == 0 &&
      length(google_cloud_run_v2_service.worker) == 0 &&
      length(google_cloud_run_v2_job.terraform) == 0 &&
      length(google_cloud_scheduler_job.cp) == 0 &&
      length(google_firebase_hosting_version.conta) == 0 &&
      length(google_firebase_hosting_release.conta) == 0
    )
    error_message = "Sem services_enabled, nem serviço, nem Job, nem relógio, nem o rewrite do Hosting."
  }

  assert {
    condition = (
      keys(google_secret_manager_secret.cp) == ["cp-cloudflare-api-token", "cp-cookie-key", "cp-smtp-password", "cp-stripe-secret-key", "cp-stripe-webhook-secret"] &&
      alltrue([for secret in google_secret_manager_secret.cp : secret.replication[0].user_managed[0].replicas[0].location == "southamerica-east1"])
    )
    error_message = "Os cinco segredos do plano, guardados só na região."
  }

  assert {
    condition = (
      keys(google_cloud_tasks_queue.cp) == ["lifecycle", "provisioning"] &&
      alltrue([for queue in google_cloud_tasks_queue.cp : queue.location == "southamerica-east1"])
    )
    error_message = "As filas provisioning e lifecycle, na região."
  }

  assert {
    condition = (
      google_firebase_hosting_site.conta.site_id == "verax-conta" &&
      google_firebase_hosting_custom_domain.conta.custom_domain == "conta.veraxsistemas.com.br" &&
      google_firebase_hosting_custom_domain.conta.wait_dns_verification == false
    )
    error_message = "O site verax-conta e o domínio nascem na primeira subida, sem esperar o DNS."
  }

  assert {
    condition = (
      google_artifact_registry_repository.control_plane.repository_id == "verax-control-plane" &&
      one([for policy in google_artifact_registry_repository.control_plane.cleanup_policies : policy.most_recent_versions[0].keep_count if policy.action == "KEEP"]) == 3 &&
      one([for policy in google_artifact_registry_repository.control_plane.cleanup_policies : policy.condition[0].older_than if policy.action == "DELETE"]) == "2592000s"
    )
    error_message = "O registro das imagens do plano de controle: as 3 versões mais recentes de cada imagem ficam (a conta da estimativa de custo) e o resto sai depois de 30 dias."
  }

  # Com tags imutáveis, o Artifact Registry não apaga artefato com tag (documentação das políticas de limpeza), e uma
  # política DELETE que alcance versões com tag vira letra morta: o registro guardaria todas as versões. O workflow
  # publica com a tag do commit; então, ou as tags são mutáveis (o desenho de images.tf), ou a limpeza só apaga o que
  # não tem tag (`tag_state = "UNTAGGED"`). As duas coisas juntas, nunca.
  assert {
    condition = (
      !try(google_artifact_registry_repository.control_plane.docker_config[0].immutable_tags, false) ||
      alltrue([for policy in google_artifact_registry_repository.control_plane.cleanup_policies : try(policy.condition[0].tag_state, "") == "UNTAGGED" if policy.action == "DELETE"])
    )
    error_message = "Tags imutáveis com uma política DELETE que alcança versões com tag: a limpeza não apagaria nada e o registro cresceria sem limite, contra a estimativa de custo (3 versões por imagem)."
  }
}

run "servicos_no_tamanho_do_plano" {
  variables {
    services_enabled = true
    owner_principals = ["user:responsavel@example.com"]
    alert_email      = "alertas@example.com"
  }

  assert {
    condition = (
      google_cloud_run_v2_service.public[0].name == "cp-public" &&
      google_cloud_run_v2_service.public[0].location == "southamerica-east1" &&
      google_cloud_run_v2_service.public[0].template[0].scaling[0].min_instance_count == 0 &&
      google_cloud_run_v2_service.public[0].template[0].scaling[0].max_instance_count == 2 &&
      google_cloud_run_v2_service.public[0].template[0].max_instance_request_concurrency == 80 &&
      google_cloud_run_v2_service.public[0].template[0].containers[0].resources[0].limits["cpu"] == "1" &&
      google_cloud_run_v2_service.public[0].template[0].containers[0].resources[0].limits["memory"] == "512Mi" &&
      google_cloud_run_v2_service.public[0].template[0].containers[0].resources[0].cpu_idle &&
      google_cloud_run_v2_service.public[0].template[0].timeout == "60s" &&
      google_cloud_run_v2_service.public[0].deletion_protection
    )
    error_message = "cp-public: 1 vCPU, 512 MiB, concorrência 80, 0 a 2 instâncias, CPU só na requisição."
  }

  assert {
    condition = (
      google_cloud_run_v2_service.worker[0].name == "cp-worker" &&
      google_cloud_run_v2_service.worker[0].template[0].scaling[0].min_instance_count == 0 &&
      google_cloud_run_v2_service.worker[0].template[0].scaling[0].max_instance_count == 1 &&
      google_cloud_run_v2_service.worker[0].template[0].containers[0].resources[0].cpu_idle &&
      google_cloud_run_v2_service.worker[0].template[0].timeout == "900s" &&
      google_cloud_run_v2_service.worker[0].deletion_protection
    )
    error_message = "cp-worker: 0 a 1 instância, CPU só na requisição, 15 min por requisição."
  }

  # A sonda de partida em /health nos dois serviços: a revisão candidata do workflow só fica pronta depois dela.
  assert {
    condition = alltrue([
      for service in [google_cloud_run_v2_service.public[0], google_cloud_run_v2_service.worker[0]] : (
        service.template[0].containers[0].startup_probe[0].http_get[0].path == "/health" &&
        service.template[0].containers[0].startup_probe[0].period_seconds == 5 &&
        service.template[0].containers[0].startup_probe[0].failure_threshold == 12 &&
        service.template[0].containers[0].startup_probe[0].timeout_seconds == 3
      )
    ])
    error_message = "Sonda de partida HTTP em /health (a cada 5 s, 12 tentativas de 3 s) nos dois serviços."
  }

  assert {
    condition = (
      google_cloud_run_v2_job.terraform[0].name == "cp-terraform" &&
      google_cloud_run_v2_job.terraform[0].template[0].task_count == 1 &&
      google_cloud_run_v2_job.terraform[0].template[0].template[0].timeout == "1800s" &&
      google_cloud_run_v2_job.terraform[0].template[0].template[0].max_retries == 0 &&
      google_cloud_run_v2_job.terraform[0].template[0].template[0].containers[0].resources[0].limits["cpu"] == "1" &&
      google_cloud_run_v2_job.terraform[0].template[0].template[0].containers[0].resources[0].limits["memory"] == "2Gi" &&
      google_cloud_run_v2_job.terraform[0].deletion_protection
    )
    error_message = "cp-terraform: 1 vCPU, 2 GiB, 30 min, 1 tentativa."
  }

  # As variáveis de cada serviço: o papel, o que o Terraform sabe e os segredos certos, sem valor vazio.
  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "ROLE"]) == "public" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "ROLE"]) == "worker"
    )
    error_message = "ROLE=public no cp-public e ROLE=worker no cp-worker."
  }

  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "WORKER_URL"]) == "https://cp-worker-123456789012.southamerica-east1.run.app" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "WORKER_SA_EMAIL"]) == "cp-invoker@projeto-exemplo.iam.gserviceaccount.com" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "SCHEDULER_SA_EMAIL"]) == "cp-invoker@projeto-exemplo.iam.gserviceaccount.com" &&
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "WORKER_SA_EMAIL"]) == "cp-invoker@projeto-exemplo.iam.gserviceaccount.com" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "OWNER_PRINCIPALS"]) == "responsavel@example.com" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "OWNER_ALERT_EMAIL"]) == "alertas@example.com" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "TASKS_QUEUE_PROVISIONING"]) == "provisioning" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "TASKS_PROJECT_ID"]) == "projeto-exemplo" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "PROVISIONING_ENABLED"]) == "false" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "FIRESTORE_DATABASE"]) == "(default)"
    )
    error_message = "As variáveis que o Terraform preenche (URL do worker, a cp-invoker como conta do token nos dois serviços, responsável, filas) no cp-worker."
  }

  # O cp-public enfileira o primeiro passo do provisionamento (CP-04): recebe o caminho completo da fila (projeto,
  # região e nome), a URL do worker (destino e `audience` do token) e a conta do token.
  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "TASKS_PROJECT_ID"]) == "projeto-exemplo" &&
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "TASKS_LOCATION"]) == "southamerica-east1" &&
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "TASKS_QUEUE_PROVISIONING"]) == "provisioning" &&
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "TASKS_QUEUE_LIFECYCLE"]) == "lifecycle" &&
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "WORKER_URL"]) == "https://cp-worker-123456789012.southamerica-east1.run.app"
    )
    error_message = "O cp-public recebe o grupo inteiro da fila (TASKS_PROJECT_ID, TASKS_LOCATION, os nomes das filas e WORKER_URL)."
  }

  assert {
    condition = (
      !contains([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name], "NODES_PROJECT_ID") &&
      !contains([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name], "CLOUDFLARE_ZONE_ID") &&
      !contains([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name], "FIREBASE_PANEL_PROJECTS") &&
      alltrue([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value != ""]) &&
      alltrue([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value != ""])
    )
    error_message = "Variável sem valor (projeto dos nós, zona do Cloudflare, pool dos painéis vazio) não vai para o serviço; nenhuma vai vazia."
  }

  # O que é só do worker não chega ao público; nenhum dos dois leva um TRUST_PROXY_HOPS decidido aqui.
  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "SMTP_HOST"]) == "smtp.zoho.com" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "SMTP_PORT"]) == "465" &&
      !contains([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name], "SMTP_HOST") &&
      !contains([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name], "SMTP_PORT") &&
      !contains([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name], "TRUST_PROXY_HOPS") &&
      !contains([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name], "TRUST_PROXY_HOPS")
    )
    error_message = "SMTP_HOST e SMTP_PORT só no cp-worker; TRUST_PROXY_HOPS é do app (ou de service_env), não do Terraform."
  }

  assert {
    condition = (
      sort([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name if length(env.value_source) > 0]) == tolist(["COOKIE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) &&
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value_source[0].secret_key_ref[0].secret if env.name == "STRIPE_WEBHOOK_SECRET"]) == "cp-stripe-webhook-secret" &&
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value_source[0].secret_key_ref[0].version if env.name == "COOKIE_KEY"]) == "latest"
    )
    error_message = "cp-public monta a chave da Stripe, o segredo do webhook e a chave do cookie, do Secret Manager."
  }

  assert {
    condition = (
      sort([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name if length(env.value_source) > 0]) == tolist(["CLOUDFLARE_API_TOKEN", "SMTP_PASSWORD", "STRIPE_SECRET_KEY"]) &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value_source[0].secret_key_ref[0].secret if env.name == "CLOUDFLARE_API_TOKEN"]) == "cp-cloudflare-api-token"
    )
    error_message = "cp-worker monta a chave da Stripe, o token do Cloudflare e a senha do SMTP; nunca o cookie nem o webhook."
  }

  assert {
    condition = (
      alltrue([for queue in google_cloud_tasks_queue.cp : queue.retry_config[0].max_attempts == 8 && queue.retry_config[0].min_backoff == "30s" && queue.retry_config[0].max_backoff == "600s" && queue.retry_config[0].max_doublings == 4]) &&
      alltrue([for queue in google_cloud_tasks_queue.cp : queue.rate_limits[0].max_concurrent_dispatches == 2])
    )
    error_message = "Filas: 8 tentativas, recuo de 30 s a 600 s com 4 dobras, 2 despachos ao mesmo tempo."
  }

  assert {
    condition = (
      keys(google_cloud_scheduler_job.cp) == ["reconcile", "tick"] &&
      google_cloud_scheduler_job.cp["tick"].schedule == "0 * * * *" &&
      google_cloud_scheduler_job.cp["reconcile"].schedule == "0 3 * * *" &&
      alltrue([for job in google_cloud_scheduler_job.cp : job.time_zone == "America/Sao_Paulo" && job.attempt_deadline == "900s"]) &&
      google_cloud_scheduler_job.cp["tick"].http_target[0].uri == "https://cp-worker-123456789012.southamerica-east1.run.app/internal/tick" &&
      google_cloud_scheduler_job.cp["reconcile"].http_target[0].uri == "https://cp-worker-123456789012.southamerica-east1.run.app/internal/reconcile" &&
      alltrue([for job in google_cloud_scheduler_job.cp : job.http_target[0].http_method == "POST" && job.http_target[0].oidc_token[0].service_account_email == "cp-invoker@projeto-exemplo.iam.gserviceaccount.com" && job.http_target[0].oidc_token[0].audience == "https://cp-worker-123456789012.southamerica-east1.run.app"])
    )
    error_message = "Relógio: tick a cada hora e reconcile às 3 h de São Paulo, no cp-worker, com o token da cp-invoker e o mesmo prazo do worker (900 s)."
  }

  assert {
    condition = (
      google_firebase_hosting_version.conta[0].config[0].rewrites[0].glob == "/**" &&
      google_firebase_hosting_version.conta[0].config[0].rewrites[0].run[0].service_id == "cp-public" &&
      google_firebase_hosting_version.conta[0].config[0].rewrites[0].run[0].region == "southamerica-east1" &&
      google_firebase_hosting_release.conta[0].site_id == "verax-conta"
    )
    error_message = "O Hosting reescreve tudo para o cp-public em southamerica-east1."
  }
}

# As variáveis do responsável: `service_env` vai aos dois serviços; `worker_env` só ao cp-worker e vence `service_env`
# e os padrões de SMTP; nenhuma das duas muda o que o Terraform deriva (as chaves reservadas são recusadas, abaixo).
run "variaveis_do_responsavel" {
  command = plan

  variables {
    services_enabled = true
    service_env = {
      LOG_LEVEL     = "debug"
      TERMS_VERSION = "2026-11-01"
    }
    worker_env = {
      SMTP_HOST            = "smtp.exemplo.com"
      MAIL_FROM            = "Verax Control <nao-responda@exemplo.com>"
      PROVISIONING_ENABLED = "true"
    }
  }

  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "LOG_LEVEL"]) == "debug" &&
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "TERMS_VERSION"]) == "2026-11-01" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "LOG_LEVEL"]) == "debug" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "TERMS_VERSION"]) == "2026-11-01"
    )
    error_message = "service_env substitui um padrão e acrescenta uma variável nos dois serviços."
  }

  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "SMTP_HOST"]) == "smtp.exemplo.com" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "MAIL_FROM"]) == "Verax Control <nao-responda@exemplo.com>" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "PROVISIONING_ENABLED"]) == "true" &&
      !contains([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name], "SMTP_HOST") &&
      !contains([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name], "MAIL_FROM") &&
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "PROVISIONING_ENABLED"]) == "false"
    )
    error_message = "worker_env vence o padrão de SMTP e o service_env só no cp-worker; o cp-public não vê nada dele."
  }
}

run "service_env_nao_muda_o_que_o_terraform_deriva" {
  command = plan

  variables {
    service_env = {
      WORKER_SA_EMAIL = "outra@projeto-exemplo.iam.gserviceaccount.com"
    }
  }

  expect_failures = [var.service_env]
}

run "service_env_nao_leva_smtp" {
  command = plan

  variables {
    service_env = {
      MAIL_FROM = "nao-responda@exemplo.com"
    }
  }

  expect_failures = [var.service_env]
}

run "worker_env_nao_leva_segredo_nem_papel" {
  command = plan

  variables {
    worker_env = {
      ROLE              = "public"
      STRIPE_SECRET_KEY = "rk_test_exemplo"
    }
  }

  expect_failures = [var.worker_env]
}

# O workflow de implantação troca a imagem dos serviços e do Job; no `plan` seguinte, o Terraform não a devolve (o
# `ignore_changes` de run.tf). O estado vem do `apply` do caso anterior, com a imagem de exemplo.
run "imagem_trocada_pelo_workflow_fica" {
  command = plan

  variables {
    services_enabled = true
    owner_principals = ["user:responsavel@example.com"]
    alert_email      = "alertas@example.com"
    public_image     = "southamerica-east1-docker.pkg.dev/projeto-exemplo/verax-control-plane/control-plane@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    worker_image     = "southamerica-east1-docker.pkg.dev/projeto-exemplo/verax-control-plane/control-plane@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    terraform_image  = "southamerica-east1-docker.pkg.dev/projeto-exemplo/verax-control-plane/terraform@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }

  assert {
    condition = (
      google_cloud_run_v2_service.public[0].template[0].containers[0].image == "us-docker.pkg.dev/cloudrun/container/hello" &&
      google_cloud_run_v2_service.worker[0].template[0].containers[0].image == "us-docker.pkg.dev/cloudrun/container/hello" &&
      google_cloud_run_v2_job.terraform[0].template[0].template[0].containers[0].image == "us-docker.pkg.dev/cloudrun/container/job"
    )
    error_message = "Outra imagem na variável não entra no plano: a do serviço fica a que o workflow implantou."
  }
}

run "worker_aberto_so_por_escolha" {
  command = plan

  variables {
    services_enabled = true
    worker_ingress   = "INGRESS_TRAFFIC_ALL"
  }

  assert {
    condition     = google_cloud_run_v2_service.worker[0].ingress == "INGRESS_TRAFFIC_ALL" && length(google_cloud_run_v2_service_iam_member.worker_invokers) == 1
    error_message = "Com INGRESS_TRAFFIC_ALL, o cp-worker continua só com o IAM (a cp-invoker; sem responsável, ninguém mais)."
  }
}

run "entrada_invalida_no_worker" {
  command = plan

  variables {
    worker_ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  }

  expect_failures = [var.worker_ingress]
}
