# O que o plano de controle pode no projeto da célula para os clientes dela (CE-07, control_plane.tf): o cp-terraform,
# só com uma condição que deixa passar o projeto e os recursos de nome de cliente da célula; o papel de suspensão do
# cp-worker, sem concessão no projeto. Sem o plano de controle, nada.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. Projetos e contas são fictícios.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }

  # O id do papel como a GCP o devolve (o simulado inventaria um texto solto).
  mock_resource "google_project_iam_custom_role" {
    defaults = {
      id = "projects/projeto-exemplo-nos/roles/papel-simulado"
    }
  }
}

variables {
  project_id               = "projeto-exemplo-nos"
  images_project_id        = "projeto-exemplo-imagens"
  control_plane_project_id = "projeto-exemplo-cp"
  control_plane_worker_url = "https://cp-worker-exemplo-rj.a.run.app"
}

run "cp_terraform_so_nos_recursos_dos_clientes" {
  command = plan

  assert {
    condition = (
      google_project_iam_member.terraform_cell_tenants[0].member == "serviceAccount:cp-terraform@projeto-exemplo-cp.iam.gserviceaccount.com" &&
      google_project_iam_custom_role.cell_tenants[0].role_id == "cpCellTenants_sp1"
    )
    error_message = "O papel dos clientes da célula vai para o cp-terraform, e é o da célula."
  }

  # Nada que leia ou grave segredo, mensagem ou chave de conta, nem que mude o IAM do projeto.
  assert {
    condition = length([
      for permission in google_project_iam_custom_role.cell_tenants[0].permissions : permission
      if can(regex("^(secretmanager\\.versions\\.|pubsub\\.subscriptions\\.consume|pubsub\\.topics\\.publish|iam\\.serviceAccountKeys\\.|iam\\.serviceAccounts\\.(actAs|getAccessToken|getOpenIdToken|signBlob|signJwt|implicitDelegation)|resourcemanager\\.)", permission))
    ]) == 0
    error_message = "O papel do cp-terraform na célula lê ou grava segredo, mensagem ou chave, emite token ou mexe no IAM do projeto."
  }

  # A condição no sentido positivo: o projeto e os nomes de cliente desta célula, e nada mais.
  assert {
    condition = (
      strcontains(google_project_iam_member.terraform_cell_tenants[0].condition[0].expression, "resource.type == \"cloudresourcemanager.googleapis.com/Project\"") &&
      strcontains(google_project_iam_member.terraform_cell_tenants[0].condition[0].expression, "resource.name.extract(\"serviceAccounts/{account}\").startsWith(\"vxt-\")") &&
      strcontains(google_project_iam_member.terraform_cell_tenants[0].condition[0].expression, "resource.name.extract(\"/secrets/{secret}\").startsWith(\"vxt-\")") &&
      strcontains(google_project_iam_member.terraform_cell_tenants[0].condition[0].expression, "resource.name.extract(\"/topics/{topic}\").startsWith(\"vxc-sp1-gcp-\")") &&
      strcontains(google_project_iam_member.terraform_cell_tenants[0].condition[0].expression, "resource.name.extract(\"/subscriptions/{subscription}\").startsWith(\"vxc-sp1-gcp-\")") &&
      !strcontains(google_project_iam_member.terraform_cell_tenants[0].condition[0].expression, "!=")
    )
    error_message = "A condição do cp-terraform não é a dos nomes de cliente da célula, no sentido positivo."
  }

  assert {
    condition = (
      toset(google_project_iam_custom_role.tenant_sa_toggle[0].permissions) == toset(["iam.serviceAccounts.disable", "iam.serviceAccounts.enable", "iam.serviceAccounts.get"]) &&
      google_project_iam_custom_role.tenant_sa_toggle[0].role_id == "cpTenantSaToggle_sp1"
    )
    error_message = "O papel de suspensão só desativa, reativa e lê uma conta de serviço."
  }
}

run "sem_o_plano_de_controle" {
  command = plan

  variables {
    control_plane_project_id = ""
    control_plane_worker_url = ""
  }

  assert {
    condition = (
      length(google_project_iam_custom_role.cell_tenants) == 0 && length(google_project_iam_member.terraform_cell_tenants) == 0 &&
      length(google_project_iam_custom_role.tenant_sa_toggle) == 0 && output.cell.tenant_sa_toggle_role == null
    )
    error_message = "Sem o plano de controle, nenhuma permissão dele no projeto da célula."
  }
}
