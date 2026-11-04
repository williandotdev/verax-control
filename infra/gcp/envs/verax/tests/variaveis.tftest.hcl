# O nó da Verax está no ar, e o estado tem tudo o que a primeira subida criou, inclusive o orçamento. O
# `terraform.tfvars` deste ambiente precisa de todas as variáveis daquela subida (GUIA, passo 3): uma que falte vira
# mudança no `plan`.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. Os blocos `moved` não entram aqui (o estado do
# teste já nasce com os endereços novos); quem os confere é o `plan` contra o estado real (GUIA, passo 5).

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }

  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos.
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/projeto-exemplo/serviceAccounts/verax-node@projeto-exemplo.iam.gserviceaccount.com"
      email = "verax-node@projeto-exemplo.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_logging_project_sink" {
    defaults = {
      writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com"
    }
  }
}

# As variáveis da primeira subida: o projeto, os projetos monitorados e o orçamento.
variables {
  project_id         = "projeto-exemplo"
  monitored_projects = ["projeto-exemplo", "projeto-exemplo-dois"]
  billing_account_id = "000000-000000-000000"
}

run "primeira_subida" {
  assert {
    condition     = length(google_billing_budget.project) == 1
    error_message = "A primeira subida do nó da Verax criou o orçamento."
  }
}

run "tfvars_com_todas_as_variaveis" {
  command = plan

  assert {
    condition = (
      length(google_billing_budget.project) == 1 &&
      google_billing_budget.project[0].amount[0].specified_amount[0].units == "50"
    )
    error_message = "Com as mesmas variáveis, o orçamento continua no plano, com o mesmo valor."
  }
}

# É o erro que o passo 3 do GUIA evita: no `plan`, `google_billing_budget.project[0] will be destroyed`.
run "tfvars_sem_a_conta_de_faturamento" {
  command = plan

  variables {
    billing_account_id = ""
  }

  assert {
    condition     = length(google_billing_budget.project) == 0
    error_message = "Sem billing_account_id, o orçamento continua no plano; o GUIA diz que o plan o apaga."
  }
}
