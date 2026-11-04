# Projeto GCP de cliente na homologação: o `customer_projects` do `terraform.tfvars` chega ao módulo, nenhum sink é
# criado no projeto do cliente, e a assinatura do projeto aparece na saída que vai para o painel. O que o módulo cria
# (a publicação só para a identidade do sink do cliente) e recusa está em
# modules/node/tests/projetos_de_clientes.tftest.hcl; daqui só se veem as saídas do módulo.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. O projeto e a identidade são fictícios.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }

  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos.
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/projeto-exemplo-nos/serviceAccounts/verax-homolog@projeto-exemplo-nos.iam.gserviceaccount.com"
      email = "verax-homolog@projeto-exemplo-nos.iam.gserviceaccount.com"
    }
  }
}

variables {
  project_id        = "projeto-exemplo-nos"
  images_project_id = "projeto-exemplo-imagens"
  customer_projects = {
    "cliente-demo-a" = { writer_identity = "serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com" }
  }
}

run "assinatura_do_projeto_de_cliente_na_saida" {
  assert {
    condition     = keys(output.pubsub_subscriptions) == ["cliente-demo-a"]
    error_message = "O projeto de cliente do terraform.tfvars não chegou ao módulo, ou a assinatura dele não está na saída."
  }

  # `monitored_projects` da saída é a lista dos sinks que o Terraform criou: nenhum.
  assert {
    condition     = length(module.node.monitored_projects) == 0
    error_message = "A homologação criou um sink no projeto do cliente."
  }
}

# A homologação sem projeto de cliente fica como antes.
run "sem_projeto_de_cliente" {
  command = plan

  variables {
    customer_projects = {}
  }

  assert {
    condition     = length(output.pubsub_subscriptions) == 0
    error_message = "Sem projeto monitorado nem de cliente, a homologação não tem assinatura."
  }
}
