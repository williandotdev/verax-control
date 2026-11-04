# A conta de serviço do nó é quem entra na AWS do cliente: o papel verax-control-reader confia no ID único dela, e uma
# conta recriada ganha outro ID, que o papel de nenhum cliente aceita. O provider recria a conta quando `account_id` ou
# `project` mudam (os dois são ForceNew). Estes casos conferem que os dois saem só do `name_prefix` e do `project_id`,
# que não mudam na vida do nó, e que as mudanças de rotina do nó não recriam a conta.
#
# A conta não tem `prevent_destroy`: a homologação é destruída entre as janelas de teste, e a exclusão do cliente
# (CP-11) destrói o ambiente inteiro. Quem recusa um plano que a recrie ou apague fora da exclusão é o executor do
# Terraform do plano de controle (CP-07).
#
# Provider simulado: nada fala com a GCP. O ID único é fictício e só existe no estado do primeiro caso: se a conta fosse
# recriada num caso seguinte, o ID planejado deixaria de ser esse (um valor novo, ainda desconhecido no `plan`).

mock_provider "google" {
  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos.
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/projeto-exemplo-nos/serviceAccounts/verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com"
      email = "verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_logging_project_sink" {
    defaults = {
      writer_identity = "serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com"
    }
  }
}

variables {
  project_id         = "projeto-exemplo-nos"
  region             = "southamerica-east1"
  zone               = "southamerica-east1-b"
  name_prefix        = "verax-teste"
  node_profile       = "standard"
  subnet_cidr        = "10.81.0.0/24"
  monitored_projects = ["projeto-monitorado-a"]
}

run "cria_o_no" {
  override_resource {
    target = google_service_account.node
    values = {
      name      = "projects/projeto-exemplo-nos/serviceAccounts/verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com"
      email     = "verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com"
      unique_id = "123456789012345678901"
    }
  }

  assert {
    condition     = google_service_account.node.account_id == var.name_prefix && google_service_account.node.project == var.project_id
    error_message = "O que recria a conta de serviço do nó (account_id e project) tem de sair só do name_prefix e do project_id."
  }

  assert {
    condition     = output.service_account_unique_id == "123456789012345678901"
    error_message = "A saída service_account_unique_id não é o ID único da conta de serviço do nó."
  }
}

# Tudo o que muda na vida de um nó sem mudar de nome nem de projeto: o tamanho da VM e do disco, quem opera, os projetos
# monitorados e de clientes, os cofres, o alerta e a proteção da VM. Nenhum recria a conta.
run "mudancas_de_rotina_nao_recriam_a_conta" {
  command = plan

  variables {
    machine_type               = "e2-standard-4"
    disk_gb                    = 120
    operators                  = ["user:operador@example.com"]
    monitored_projects         = ["projeto-monitorado-a", "projeto-monitorado-b"]
    customer_projects          = { "cliente-demo-a" = { writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com" } }
    pubsub_storage_in_region   = false
    credentials_vault          = false
    bootstrap_secret           = false
    turnstile_secret           = true
    alert_email                = "alertas@example.com"
    stalled_subscription_hours = 48
    deletion_protection        = false
  }

  assert {
    condition     = google_service_account.node.unique_id == "123456789012345678901"
    error_message = "Uma mudança de rotina recriaria a conta de serviço do nó, com outro ID único: o papel de leitura de todo cliente deste nó deixaria de aceitá-la."
  }

  assert {
    condition     = google_service_account.node.account_id == "verax-teste" && google_service_account.node.project == "projeto-exemplo-nos"
    error_message = "O account_id ou o project da conta de serviço do nó mudou com uma mudança de rotina."
  }
}
