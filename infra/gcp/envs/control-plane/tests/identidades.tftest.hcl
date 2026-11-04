# As identidades e os papéis do plano de controle (plano, seção 2.2), conta a conta: o que cada uma pode, e só isso.
# Quem chama o cp-worker e o Job nunca é allUsers. Com o projeto dos nós preenchido, as concessões de lá; sem ele,
# nada fora deste projeto.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }

  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos.
  mock_resource "google_iam_workload_identity_pool" {
    defaults = {
      name = "projects/123456789012/locations/global/workloadIdentityPools/cp-github"
    }
  }

  mock_resource "google_iam_workload_identity_pool_provider" {
    defaults = {
      name = "projects/123456789012/locations/global/workloadIdentityPools/cp-github/providers/github"
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
  project_id       = "projeto-exemplo"
  services_enabled = true
  owner_principals = ["user:responsavel@example.com"]
}

run "cp_public" {
  assert {
    condition     = keys(google_project_iam_member.public) == ["roles/datastore.user"]
    error_message = "No projeto, o cp-public tem só datastore.user."
  }

  assert {
    condition = sort([
      for key, member in google_cloud_tasks_queue_iam_member.enqueuers : key
      if member.member == "serviceAccount:cp-public@projeto-exemplo.iam.gserviceaccount.com"
    ]) == tolist(["lifecycle/public", "provisioning/public"])
    error_message = "O cp-public enfileira nas duas filas (cloudtasks.enqueuer), e só nelas."
  }

  assert {
    condition = sort([
      for key, member in google_secret_manager_secret_iam_member.readers : key
      if member.member == "serviceAccount:cp-public@projeto-exemplo.iam.gserviceaccount.com"
    ]) == tolist(["cp-cookie-key/public", "cp-stripe-secret-key/public", "cp-stripe-webhook-secret/public"])
    error_message = "O cp-public lê a chave da Stripe, o segredo do webhook e a chave do cookie, e nada mais."
  }

  assert {
    condition = (
      alltrue([for member in google_secret_manager_secret_iam_member.readers : member.role == "roles/secretmanager.secretAccessor"]) &&
      alltrue([for member in google_cloud_tasks_queue_iam_member.enqueuers : member.role == "roles/cloudtasks.enqueuer"])
    )
    error_message = "Nos segredos só secretAccessor; nas filas só cloudtasks.enqueuer."
  }

  assert {
    condition = (
      sort([for member in google_service_account_iam_member.worker_token_users : member.member]) == tolist([
        "serviceAccount:cp-public@projeto-exemplo.iam.gserviceaccount.com",
        "serviceAccount:cp-worker@projeto-exemplo.iam.gserviceaccount.com",
      ]) &&
      alltrue([for member in google_service_account_iam_member.worker_token_users : member.role == "roles/iam.serviceAccountUser"]) &&
      alltrue([for member in google_service_account_iam_member.worker_token_users : member.service_account_id == google_service_account.worker.name])
    )
    error_message = "Só o cp-public e o próprio cp-worker agem como o cp-worker (o token das tasks)."
  }

  assert {
    condition     = google_cloud_run_v2_service.public[0].template[0].service_account == "cp-public@projeto-exemplo.iam.gserviceaccount.com"
    error_message = "O cp-public roda com a própria conta."
  }
}

run "cp_worker" {
  assert {
    condition     = keys(google_project_iam_member.worker) == ["roles/datastore.user"]
    error_message = "No projeto, o cp-worker tem só datastore.user (o firebasehosting.admin é por projeto do pool)."
  }

  assert {
    condition = (
      keys(google_project_iam_member.worker_hosting_admin) == ["projeto-exemplo"] &&
      google_project_iam_member.worker_hosting_admin["projeto-exemplo"].role == "roles/firebasehosting.admin"
    )
    error_message = "O cp-worker é firebasehosting.admin neste projeto, o primeiro do pool dos painéis."
  }

  assert {
    condition = sort([
      for key, member in google_cloud_tasks_queue_iam_member.enqueuers : key
      if member.member == "serviceAccount:cp-worker@projeto-exemplo.iam.gserviceaccount.com"
    ]) == tolist(["lifecycle/worker", "provisioning/worker"])
    error_message = "O cp-worker enfileira nas duas filas."
  }

  assert {
    condition = sort([
      for key, member in google_secret_manager_secret_iam_member.readers : key
      if member.member == "serviceAccount:cp-worker@projeto-exemplo.iam.gserviceaccount.com"
    ]) == tolist(["cp-cloudflare-api-token/worker", "cp-smtp-password/worker", "cp-stripe-secret-key/worker"])
    error_message = "O cp-worker lê a chave da Stripe, o token do Cloudflare e a senha do SMTP, e nada mais (nem o cookie, nem o webhook)."
  }

  assert {
    condition = (
      google_project_iam_custom_role.job_runner.role_id == "cpJobRunner" &&
      google_project_iam_custom_role.job_runner.permissions == toset(["run.jobs.run", "run.jobs.runWithOverrides", "run.executions.get", "run.executions.list"]) &&
      google_cloud_run_v2_job_iam_member.worker_runner[0].role == google_project_iam_custom_role.job_runner.id &&
      google_cloud_run_v2_job_iam_member.worker_runner[0].member == "serviceAccount:cp-worker@projeto-exemplo.iam.gserviceaccount.com"
    )
    error_message = "O cp-worker dispara o Job pelo papel cpJobRunner (só executar e acompanhar), concedido no próprio Job."
  }

  assert {
    condition     = google_cloud_run_v2_service.worker[0].template[0].service_account == "cp-worker@projeto-exemplo.iam.gserviceaccount.com"
    error_message = "O cp-worker roda com a própria conta."
  }
}

run "cp_terraform" {
  assert {
    condition     = google_cloud_run_v2_job.terraform[0].template[0].template[0].service_account == "cp-terraform@projeto-exemplo.iam.gserviceaccount.com"
    error_message = "O Job roda com a conta cp-terraform."
  }

  assert {
    condition = (
      length(google_project_iam_member.terraform_nodes) == 0 &&
      length(google_storage_bucket_iam_member.terraform_state) == 0 &&
      length(google_storage_bucket_iam_member.worker_runs) == 0 &&
      length(google_project_iam_custom_role.node_lifecycle) == 0 &&
      length(google_project_iam_member.worker_node_lifecycle) == 0 &&
      length(google_project_iam_custom_role.images_access_granter) == 0 &&
      length(google_artifact_registry_repository_iam_member.terraform_images) == 0 &&
      length(google_storage_bucket_iam_member.worker_releases) == 0
    )
    error_message = "Sem o projeto dos nós, o registro das imagens e o bucket de releases, nada é concedido fora deste projeto."
  }

  assert {
    condition = !contains(
      [for member in google_secret_manager_secret_iam_member.readers : member.member],
      "serviceAccount:cp-terraform@projeto-exemplo.iam.gserviceaccount.com",
    )
    error_message = "O cp-terraform não lê segredo nenhum."
  }
}

run "cp_deployer" {
  assert {
    condition = (
      sort([for member in google_service_account_iam_member.deployer_acts_as : member.service_account_id]) == sort([
        google_service_account.public.name,
        google_service_account.worker.name,
        google_service_account.terraform.name,
      ]) &&
      alltrue([for member in google_service_account_iam_member.deployer_acts_as : member.role == "roles/iam.serviceAccountUser" && member.member == "serviceAccount:cp-deployer@projeto-exemplo.iam.gserviceaccount.com"])
    )
    error_message = "Quem implanta age como as três contas de execução."
  }

  assert {
    condition = (
      sort([for member in google_cloud_run_v2_service_iam_member.deployer : member.name]) == tolist(["cp-public", "cp-worker"]) &&
      alltrue([for member in google_cloud_run_v2_service_iam_member.deployer : member.role == "roles/run.developer"]) &&
      google_cloud_run_v2_job_iam_member.deployer[0].role == "roles/run.developer" &&
      google_cloud_run_v2_job_iam_member.deployer[0].member == "serviceAccount:cp-deployer@projeto-exemplo.iam.gserviceaccount.com"
    )
    error_message = "Quem implanta é run.developer nos dois serviços e no Job."
  }

  assert {
    condition = (
      google_artifact_registry_repository_iam_member.deployer_writer.role == "roles/artifactregistry.writer" &&
      google_artifact_registry_repository_iam_member.deployer_writer.member == "serviceAccount:cp-deployer@projeto-exemplo.iam.gserviceaccount.com"
    )
    error_message = "Quem implanta publica no registro das imagens do plano de controle."
  }

  assert {
    condition = (
      google_service_account_iam_member.deployer_wif.role == "roles/iam.workloadIdentityUser" &&
      google_service_account_iam_member.deployer_wif.member == "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/cp-github/subject/repo:williandotdev/verax-control:environment:control-plane"
    )
    error_message = "Só o environment control-plane do repositório vira a conta de implantação."
  }

  assert {
    condition = (
      google_iam_workload_identity_pool_provider.github.oidc[0].issuer_uri == "https://token.actions.githubusercontent.com" &&
      google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.sub == \"repo:williandotdev/verax-control:environment:control-plane\" && assertion.repository_owner_id == \"92734416\" && assertion.repository_id == \"1441377752\"" &&
      google_iam_workload_identity_pool_provider.github.attribute_mapping["google.subject"] == "assertion.sub"
    )
    error_message = "O provedor aceita só o token do environment control-plane do repositório, pelos IDs fixos do repositório e do dono."
  }

  assert {
    condition     = output.github_environment.GCP_WIF_PROVIDER == "projects/123456789012/locations/global/workloadIdentityPools/cp-github/providers/github" && output.github_environment.GCP_DEPLOYER_SA == "cp-deployer@projeto-exemplo.iam.gserviceaccount.com"
    error_message = "As saídas do environment do GitHub apontam para o provedor e a conta de implantação."
  }
}

run "ninguem_anonimo_no_worker_nem_no_job" {
  assert {
    condition = sort([for member in google_cloud_run_v2_service_iam_member.worker_invokers : member.member]) == tolist([
      "serviceAccount:cp-worker@projeto-exemplo.iam.gserviceaccount.com",
      "user:responsavel@example.com",
    ])
    error_message = "Só a conta das tasks e do Scheduler (a do cp-worker) e o responsável chamam o cp-worker."
  }

  assert {
    condition = alltrue([
      for member in concat(
        [for member in google_cloud_run_v2_service_iam_member.worker_invokers : member.member],
        [google_cloud_run_v2_job_iam_member.worker_runner[0].member, google_cloud_run_v2_job_iam_member.deployer[0].member],
      ) : !contains(["allUsers", "allAuthenticatedUsers"], member)
    ])
    error_message = "Nenhum acesso anônimo ou de qualquer conta Google ao cp-worker e ao Job."
  }

  assert {
    condition     = google_cloud_run_v2_service.worker[0].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY"
    error_message = "Por padrão, o cp-worker só recebe tráfego de dentro do projeto."
  }

  assert {
    condition     = google_cloud_run_v2_service_iam_member.public_invoker[0].member == "allUsers" && google_cloud_run_v2_service.public[0].ingress == "INGRESS_TRAFFIC_ALL"
    error_message = "O cp-public aceita invocação anônima, que o rewrite do Hosting exige."
  }
}

run "projeto_dos_nos_preenchido" {
  variables {
    nodes_project_id  = "projeto-exemplo-nos"
    images_project_id = "projeto-exemplo-imagens"
    release_bucket    = "projeto-exemplo-releases"
  }

  assert {
    condition = (
      keys(google_project_iam_member.terraform_nodes) == [
        "roles/compute.instanceAdmin.v1",
        "roles/compute.networkAdmin",
        "roles/compute.securityAdmin",
        "roles/compute.storageAdmin",
        "roles/iam.serviceAccountAdmin",
        "roles/iam.serviceAccountUser",
        "roles/monitoring.alertPolicyEditor",
        "roles/monitoring.notificationChannelEditor",
        "roles/pubsub.admin",
        "roles/resourcemanager.projectIamAdmin",
        "roles/secretmanager.admin",
        "roles/storage.admin",
      ] &&
      alltrue([for member in google_project_iam_member.terraform_nodes : member.project == "projeto-exemplo-nos" && member.member == "serviceAccount:cp-terraform@projeto-exemplo.iam.gserviceaccount.com"])
    )
    error_message = "Os 12 papéis do cp-terraform no projeto dos nós (plano, seção 2.2), e nenhum outro."
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.terraform_state[0].bucket == "projeto-exemplo-nos-tfstate" &&
      google_storage_bucket_iam_member.terraform_state[0].role == "roles/storage.objectAdmin" &&
      google_storage_bucket_iam_member.worker_runs[0].bucket == "projeto-exemplo-nos-tfstate" &&
      google_storage_bucket_iam_member.worker_runs[0].role == "roles/storage.objectViewer" &&
      google_storage_bucket_iam_member.worker_runs[0].condition[0].expression == "resource.name.startsWith(\"projects/_/buckets/projeto-exemplo-nos-tfstate/objects/runs/\")"
    )
    error_message = "No bucket do estado: o executor grava tudo; o cp-worker lê só runs/."
  }

  assert {
    condition = (
      google_project_iam_custom_role.node_lifecycle[0].project == "projeto-exemplo-nos" &&
      google_project_iam_custom_role.node_lifecycle[0].permissions == toset(["compute.instances.get", "compute.instances.start", "compute.instances.stop", "compute.instances.getGuestAttributes"]) &&
      google_project_iam_member.worker_node_lifecycle[0].role == google_project_iam_custom_role.node_lifecycle[0].id &&
      google_project_iam_member.worker_node_lifecycle[0].member == "serviceAccount:cp-worker@projeto-exemplo.iam.gserviceaccount.com" &&
      strcontains(google_project_iam_member.worker_node_lifecycle[0].condition[0].expression, "startsWith(\"vx-\")")
    )
    error_message = "O cp-worker para, liga e lê só as VMs vx-* do projeto dos nós, pelo papel cpNodeLifecycle com condição."
  }

  assert {
    condition = (
      google_project_iam_custom_role.images_access_granter[0].project == "projeto-exemplo-imagens" &&
      google_artifact_registry_repository_iam_member.terraform_images[0].project == "projeto-exemplo-imagens" &&
      google_artifact_registry_repository_iam_member.terraform_images[0].repository == "verax-control" &&
      google_artifact_registry_repository_iam_member.terraform_images[0].role == google_project_iam_custom_role.images_access_granter[0].id &&
      google_artifact_registry_repository_iam_member.terraform_images[0].member == "serviceAccount:cp-terraform@projeto-exemplo.iam.gserviceaccount.com"
    )
    error_message = "O cp-terraform grava a política de acesso só do registro das imagens do nó."
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.worker_releases[0].bucket == "projeto-exemplo-releases" &&
      google_storage_bucket_iam_member.worker_releases[0].role == "roles/storage.objectViewer" &&
      google_storage_bucket_iam_member.worker_releases[0].member == "serviceAccount:cp-worker@projeto-exemplo.iam.gserviceaccount.com"
    )
    error_message = "O cp-worker lê o bucket de releases."
  }
}

run "grupo_nao_opera" {
  command = plan

  variables {
    owner_principals = ["group:operacao@example.com"]
  }

  expect_failures = [var.owner_principals]
}
