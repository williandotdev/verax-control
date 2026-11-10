# A primeira subida num projeto novo. A API do Resource Manager vem desligada num projeto novo, e
# só o `apply` deste ambiente a liga: o `plan` não pode ler o projeto (o número dele, para o orçamento) antes disso.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada.

# Como a GCP com a API desligada: ler o projeto falha (o valor simulado nem é um número de projeto). Só um `plan` que
# deixa a leitura para o `apply` passa com este provider.
mock_provider "google" {
  alias = "api_desligada"

  mock_data "google_project" {
    defaults = {
      number = ["a", "API", "do", "Resource", "Manager", "está", "desligada"]
    }
  }
}

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }

  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos. O ID único é fictício.
  mock_resource "google_service_account" {
    defaults = {
      name      = "projects/projeto-exemplo-nos/serviceAccounts/verax-celula@projeto-exemplo-nos.iam.gserviceaccount.com"
      email     = "verax-celula@projeto-exemplo-nos.iam.gserviceaccount.com"
      unique_id = "123456789012345678901"
    }
  }
}

variables {
  project_id         = "projeto-exemplo-nos"
  images_project_id  = "projeto-exemplo-imagens"
  billing_account_id = "000000-000000-000000"
}

run "plan_num_projeto_novo" {
  command = plan

  providers = {
    google = google.api_desligada
  }

  assert {
    condition     = contains(keys(google_project_service.apis), "cloudresourcemanager.googleapis.com")
    error_message = "O próprio ambiente liga a API do Resource Manager, que a leitura do projeto usa."
  }

  assert {
    condition     = length(google_billing_budget.project) == 1
    error_message = "Com billing_account_id preenchido, o orçamento entra no plano, com o projeto lido no apply."
  }
}

run "apply_da_primeira_subida" {
  assert {
    condition     = google_billing_budget.project[0].budget_filter[0].projects == toset(["projects/123456789012"])
    error_message = "No apply, o orçamento recebe o número do projeto lido depois das APIs."
  }

  # O que o teste do papel sem chave na AWS de teste pede: o ID único da conta de serviço do nó.
  assert {
    condition     = output.node_service_account_unique_id == "123456789012345678901"
    error_message = "A saída node_service_account_unique_id não é o ID único da conta de serviço do nó."
  }
}

# Com as APIs já ligadas, a leitura volta para o `plan`: o orçamento fica com o número do projeto, sem nada para depois
# do `apply` e sem mudança a cada `plan`. Vale também depois de um `apply` que parou num 403 de API: tudo depende das
# APIs, que já estão no estado, então o `plan` seguinte lê o projeto, e um 403 nele é propagação, que se resolve
# esperando (GUIA, passo 6).
run "plan_seguinte" {
  command = plan

  assert {
    condition     = data.google_project.this.number == "123456789012"
    error_message = "Com as APIs no estado, o plan lê o projeto, e não deixa a leitura para o apply."
  }

  assert {
    condition     = google_billing_budget.project[0].budget_filter[0].projects == toset(["projects/123456789012"])
    error_message = "Com as APIs no estado, o plan lê o projeto e o orçamento fica igual."
  }
}
