# Os serviços, o Job, as filas e o relógio: os tamanhos da seção 2.1 do plano, zero instâncias mínimas, as variáveis
# e os segredos de cada serviço, a imagem que o workflow troca sem o Terraform desfazer, e a primeira subida sem os
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

mock_provider "google-beta" {}

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
    condition     = google_artifact_registry_repository.control_plane.repository_id == "verax-control-plane" && google_artifact_registry_repository.control_plane.docker_config[0].immutable_tags
    error_message = "O registro das imagens do plano de controle, com tags imutáveis."
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
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "WORKER_SA_EMAIL"]) == "cp-worker@projeto-exemplo.iam.gserviceaccount.com" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "SCHEDULER_SA_EMAIL"]) == "cp-worker@projeto-exemplo.iam.gserviceaccount.com" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "OWNER_PRINCIPALS"]) == "responsavel@example.com" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "OWNER_ALERT_EMAIL"]) == "alertas@example.com" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "FIREBASE_PANEL_PROJECTS"]) == "projeto-exemplo" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "TASKS_QUEUE_PROVISIONING"]) == "provisioning" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "PROVISIONING_ENABLED"]) == "false" &&
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "FIRESTORE_DATABASE"]) == "(default)"
    )
    error_message = "As variáveis que o Terraform preenche (URL e conta do worker, responsável, pool dos painéis, filas) no cp-worker."
  }

  assert {
    condition = (
      !contains([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name], "NODES_PROJECT_ID") &&
      !contains([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name], "CLOUDFLARE_ZONE_ID") &&
      alltrue([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value != ""]) &&
      alltrue([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value != ""])
    )
    error_message = "Variável sem valor (projeto dos nós, zona do Cloudflare) não vai para o serviço; nenhuma vai vazia."
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
      alltrue([for job in google_cloud_scheduler_job.cp : job.time_zone == "America/Sao_Paulo"]) &&
      google_cloud_scheduler_job.cp["tick"].http_target[0].uri == "https://cp-worker-123456789012.southamerica-east1.run.app/internal/tick" &&
      google_cloud_scheduler_job.cp["reconcile"].http_target[0].uri == "https://cp-worker-123456789012.southamerica-east1.run.app/internal/reconcile" &&
      alltrue([for job in google_cloud_scheduler_job.cp : job.http_target[0].http_method == "POST" && job.http_target[0].oidc_token[0].service_account_email == "cp-worker@projeto-exemplo.iam.gserviceaccount.com" && job.http_target[0].oidc_token[0].audience == "https://cp-worker-123456789012.southamerica-east1.run.app"])
    )
    error_message = "Relógio: tick a cada hora e reconcile às 3 h de São Paulo, no cp-worker, com o token da conta dele."
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
    error_message = "Com INGRESS_TRAFFIC_ALL, o cp-worker continua só com o IAM (a conta dele; sem responsável, ninguém mais)."
  }
}

run "entrada_invalida_no_worker" {
  command = plan

  variables {
    worker_ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  }

  expect_failures = [var.worker_ingress]
}
