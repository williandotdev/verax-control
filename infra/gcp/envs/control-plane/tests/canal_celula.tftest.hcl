# O lado do plano de controle do canal da célula (cell_channel.tf, CE-06): a conta de push de cada célula (criada pelo
# envs/celula) ganha `run.invoker` só no cp-worker e entra em CELL_PUSH_SA_EMAILS, só no worker. Sem
# `cell_push_service_accounts` (o padrão), nada. A assinatura push e a conta ficam no envs/celula (os testes de lá).
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
  target = google_service_account.admin
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-admin@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-admin@projeto-exemplo.iam.gserviceaccount.com"
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
  project_id       = "projeto-exemplo"
  services_enabled = true
  owner_principals = ["user:responsavel@example.com"]
}

run "canal_desligado_por_padrao" {
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.cell_push_invoker) == 0
    error_message = "Sem cell_push_service_accounts, nenhuma conta de push chama o cp-worker."
  }

  assert {
    condition     = !contains([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name], "CELL_PUSH_SA_EMAILS")
    error_message = "Sem o canal, o cp-worker não recebe CELL_PUSH_SA_EMAILS: a rota dos relatórios recusa tudo."
  }
}

run "duas_celulas" {
  variables {
    cell_push_service_accounts = {
      "verax-celula" = "vxc-verax-celula-push@projeto-celulas.iam.gserviceaccount.com"
      "sp2"          = "vxc-sp2-push@projeto-celulas.iam.gserviceaccount.com"
    }
  }

  assert {
    condition = (
      length(google_cloud_run_v2_service_iam_member.cell_push_invoker) == 2 &&
      google_cloud_run_v2_service_iam_member.cell_push_invoker["verax-celula"].member == "serviceAccount:vxc-verax-celula-push@projeto-celulas.iam.gserviceaccount.com" &&
      google_cloud_run_v2_service_iam_member.cell_push_invoker["sp2"].member == "serviceAccount:vxc-sp2-push@projeto-celulas.iam.gserviceaccount.com" &&
      alltrue([for binding in google_cloud_run_v2_service_iam_member.cell_push_invoker : binding.role == "roles/run.invoker" && binding.name == "cp-worker"])
    )
    error_message = "A conta de push de cada célula só ganha run.invoker no cp-worker."
  }

  assert {
    condition = contains(
      [for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : "${env.name}=${env.value}" if env.name == "CELL_PUSH_SA_EMAILS"],
      "CELL_PUSH_SA_EMAILS=vxc-sp2-push@projeto-celulas.iam.gserviceaccount.com,vxc-verax-celula-push@projeto-celulas.iam.gserviceaccount.com",
    ) && !contains([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name], "CELL_PUSH_SA_EMAILS")
    error_message = "CELL_PUSH_SA_EMAILS só no cp-worker, com as contas de push das células."
  }
}

run "sem_os_servicos_nenhum_invoker" {
  variables {
    services_enabled           = false
    cell_push_service_accounts = { "verax-celula" = "vxc-verax-celula-push@projeto-celulas.iam.gserviceaccount.com" }
  }

  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.cell_push_invoker) == 0
    error_message = "Sem o cp-worker no ar, não há onde conceder o invoker."
  }
}

run "conta_fora_do_padrao_recusada" {
  command = plan

  variables {
    cell_push_service_accounts = { "verax-celula" = "cp-worker@projeto-exemplo.iam.gserviceaccount.com" }
  }

  expect_failures = [var.cell_push_service_accounts]
}

run "celula_fora_do_padrao_recusada" {
  command = plan

  variables {
    cell_push_service_accounts = { "Celula" = "vxc-celula-push@projeto-celulas.iam.gserviceaccount.com" }
  }

  expect_failures = [var.cell_push_service_accounts]
}

run "worker_env_nao_troca_as_contas_de_push" {
  command = plan

  variables {
    worker_env = { CELL_PUSH_SA_EMAILS = "outra@projeto-exemplo.iam.gserviceaccount.com" }
  }

  expect_failures = [var.worker_env]
}
