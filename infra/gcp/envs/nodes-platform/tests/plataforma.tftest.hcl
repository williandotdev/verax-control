# O projeto dos nós de clientes (CP-06): as APIs, o bucket do estado adotado no primeiro `apply`, o orçamento e as
# permissões do plano de controle neste projeto, uma a uma. Estas permissões estavam no envs/control-plane
# (cross_project.tf) e mudaram para cá; os casos são os mesmos de lá (tests/identidades.tftest.hcl, até o CP-06), mais o
# papel novo do credentials-key.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. O simulado não importa recurso nenhum: o
# `override_resource` do bucket faz o papel do bucket que o passo 2 do GUIA cria à mão.

# Como a GCP num projeto novo, com a API do Resource Manager desligada: ler o projeto falha. Só um `plan` que deixa a
# leitura para o `apply` passa com este provider (o mesmo caso da homologação).
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
}

override_resource {
  target = google_storage_bucket.tfstate
  values = {
    name     = "projeto-exemplo-nos-tfstate"
    location = "SOUTHAMERICA-EAST1"
  }
}

variables {
  project_id         = "projeto-exemplo-nos"
  billing_account_id = "000000-000000-000000"
}

run "primeira_subida_num_projeto_novo" {
  command = plan

  providers = {
    google = google.api_desligada
  }

  assert {
    condition = alltrue([
      for api in ["compute.googleapis.com", "iam.googleapis.com", "secretmanager.googleapis.com", "pubsub.googleapis.com", "storage.googleapis.com", "monitoring.googleapis.com", "logging.googleapis.com", "cloudresourcemanager.googleapis.com", "billingbudgets.googleapis.com"] :
      contains(keys(google_project_service.apis), api)
    ])
    error_message = "Falta uma API que os nós de clientes ou o orçamento usam."
  }

  assert {
    condition     = alltrue([for api in google_project_service.apis : !api.disable_on_destroy && !api.disable_dependent_services])
    error_message = "Um destroy deste ambiente desligaria uma API de que os nós dependem."
  }

  assert {
    condition     = length(google_billing_budget.project) == 1
    error_message = "Com billing_account_id preenchido, o orçamento entra no plano, com o projeto lido no apply."
  }

  # Sem o projeto do plano de controle, nenhuma permissão dele: só a base (o que a homologação precisa).
  assert {
    condition = (
      length(google_project_iam_member.terraform_nodes) == 0 &&
      length(google_project_iam_custom_role.secrets_provisioner) == 0 &&
      length(google_project_iam_custom_role.buckets_provisioner) == 0 &&
      length(google_project_iam_custom_role.node_lifecycle) == 0 &&
      length(google_project_iam_custom_role.secret_version_destroyer) == 0 &&
      length(google_project_iam_member.worker_node_lifecycle) == 0 &&
      length(google_storage_bucket_iam_member.terraform_state) == 0 &&
      length(google_storage_bucket_iam_member.worker_runs) == 0 &&
      output.control_plane_roles == null
    )
    error_message = "Sem control_plane_project_id, nenhuma permissão do plano de controle é criada no projeto dos nós."
  }
}

# O bucket do estado, com o que o plano de controle exige dele.
run "bucket_do_estado" {
  command = plan

  assert {
    condition = (
      google_storage_bucket.tfstate.name == "projeto-exemplo-nos-tfstate" &&
      lower(google_storage_bucket.tfstate.location) == "southamerica-east1" &&
      output.tfstate_bucket == "projeto-exemplo-nos-tfstate"
    )
    error_message = "O bucket do estado não é <projeto>-tfstate em São Paulo (o nome que o plano de controle usa e o GUIA cria)."
  }

  # A concessão condicionada do cp-worker em `runs/` exige o acesso uniforme (com ACL por objeto, a GCP recusa).
  assert {
    condition = (
      google_storage_bucket.tfstate.uniform_bucket_level_access &&
      google_storage_bucket.tfstate.public_access_prevention == "enforced" &&
      !google_storage_bucket.tfstate.force_destroy &&
      google_storage_bucket.tfstate.versioning[0].enabled &&
      google_storage_bucket.tfstate.soft_delete_policy[0].retention_duration_seconds == 604800
    )
    error_message = "O bucket do estado perdeu o acesso uniforme, a proteção contra acesso público, o versionamento ou a recusa de apagar com estado dentro."
  }

  assert {
    condition = (
      length(google_storage_bucket.tfstate.lifecycle_rule) == 2 &&
      anytrue([for rule in google_storage_bucket.tfstate.lifecycle_rule : try(one(rule.action).type == "Delete" && one(rule.condition).days_since_noncurrent_time == 30, false)]) &&
      anytrue([for rule in google_storage_bucket.tfstate.lifecycle_rule : try(one(rule.action).type == "Delete" && one(rule.condition).age == 180 && tolist(one(rule.condition).matches_prefix) == tolist(["runs/"]), false)])
    )
    error_message = "A retenção do bucket do estado mudou: versões anteriores por 30 dias e os outputs.json de runs/ por 180."
  }
}

run "com_o_plano_de_controle" {
  variables {
    control_plane_project_id = "projeto-exemplo-cp"
  }

  assert {
    condition = (
      keys(google_project_iam_member.terraform_nodes) == [
        "cpBucketsProvisioner",
        "cpSecretsProvisioner",
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
      ] &&
      alltrue([for member in google_project_iam_member.terraform_nodes : member.project == "projeto-exemplo-nos" && member.member == "serviceAccount:cp-terraform@projeto-exemplo-cp.iam.gserviceaccount.com"]) &&
      google_project_iam_member.terraform_nodes["cpSecretsProvisioner"].role == google_project_iam_custom_role.secrets_provisioner[0].id &&
      google_project_iam_member.terraform_nodes["cpBucketsProvisioner"].role == google_project_iam_custom_role.buckets_provisioner[0].id
    )
    error_message = "Os 12 papéis do cp-terraform no projeto dos nós: os 10 predefinidos da seção 2.2 e os dois personalizados no lugar de secretmanager.admin e storage.admin."
  }

  assert {
    condition = (
      !contains([for member in google_project_iam_member.terraform_nodes : member.role], "roles/secretmanager.admin") &&
      !contains([for member in google_project_iam_member.terraform_nodes : member.role], "roles/storage.admin")
    )
    error_message = "secretmanager.admin e storage.admin no projeto dos nós deixariam o cp-terraform ler os segredos e os backups de todos os tenants."
  }

  assert {
    condition = (
      google_project_iam_custom_role.secrets_provisioner[0].project == "projeto-exemplo-nos" &&
      google_project_iam_custom_role.secrets_provisioner[0].role_id == "cpSecretsProvisioner" &&
      google_project_iam_custom_role.secrets_provisioner[0].permissions == toset([
        "secretmanager.secrets.create", "secretmanager.secrets.delete", "secretmanager.secrets.get", "secretmanager.secrets.list",
        "secretmanager.secrets.update", "secretmanager.secrets.getIamPolicy", "secretmanager.secrets.setIamPolicy",
        "secretmanager.versions.list",
      ]) &&
      alltrue([for permission in google_project_iam_custom_role.secrets_provisioner[0].permissions : !contains(["secretmanager.versions.access", "secretmanager.versions.add", "secretmanager.versions.destroy"], permission)])
    )
    error_message = "cpSecretsProvisioner: o cofre e a política de acesso, nunca ler, gravar ou destruir versão."
  }

  assert {
    condition = (
      google_project_iam_custom_role.buckets_provisioner[0].project == "projeto-exemplo-nos" &&
      google_project_iam_custom_role.buckets_provisioner[0].role_id == "cpBucketsProvisioner" &&
      google_project_iam_custom_role.buckets_provisioner[0].permissions == toset([
        "storage.buckets.create", "storage.buckets.delete", "storage.buckets.get", "storage.buckets.list",
        "storage.buckets.update", "storage.buckets.getIamPolicy", "storage.buckets.setIamPolicy",
      ]) &&
      alltrue([for permission in google_project_iam_custom_role.buckets_provisioner[0].permissions : !startswith(permission, "storage.objects.")])
    )
    error_message = "cpBucketsProvisioner: o bucket e a política de acesso, nenhum storage.objects.*."
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.terraform_state[0].bucket == "projeto-exemplo-nos-tfstate" &&
      google_storage_bucket_iam_member.terraform_state[0].role == "roles/storage.objectAdmin" &&
      google_storage_bucket_iam_member.terraform_state[0].member == "serviceAccount:cp-terraform@projeto-exemplo-cp.iam.gserviceaccount.com" &&
      google_storage_bucket_iam_member.worker_runs[0].bucket == "projeto-exemplo-nos-tfstate" &&
      google_storage_bucket_iam_member.worker_runs[0].role == "roles/storage.objectViewer" &&
      google_storage_bucket_iam_member.worker_runs[0].member == "serviceAccount:cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com" &&
      google_storage_bucket_iam_member.worker_runs[0].condition[0].expression == "resource.name.startsWith(\"projects/_/buckets/projeto-exemplo-nos-tfstate/objects/runs/\")"
    )
    error_message = "No bucket do estado: o executor grava tudo (a única leitura de objeto que ele tem no projeto dos nós); o cp-worker lê só runs/."
  }

  assert {
    condition = (
      google_project_iam_custom_role.node_lifecycle[0].project == "projeto-exemplo-nos" &&
      google_project_iam_custom_role.node_lifecycle[0].role_id == "cpNodeLifecycle" &&
      google_project_iam_custom_role.node_lifecycle[0].permissions == toset(["compute.instances.get", "compute.instances.start", "compute.instances.stop", "compute.instances.getGuestAttributes"]) &&
      google_project_iam_member.worker_node_lifecycle[0].project == "projeto-exemplo-nos" &&
      google_project_iam_member.worker_node_lifecycle[0].role == google_project_iam_custom_role.node_lifecycle[0].id &&
      google_project_iam_member.worker_node_lifecycle[0].member == "serviceAccount:cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com" &&
      google_project_iam_member.worker_node_lifecycle[0].condition[0].expression == "resource.type == \"compute.googleapis.com/Instance\" && resource.name.extract(\"/instances/{name}\").startsWith(\"vx-\")"
    )
    error_message = "O cp-worker para, liga e lê só as VMs vx-* do projeto dos nós, pelo papel cpNodeLifecycle com condição."
  }

  # O papel que o envs/tenant concede ao cp-worker no credentials-key de cada nó: listar e destruir versões, nunca ler,
  # gravar ou reativar. Não é concedido no projeto.
  assert {
    condition = (
      google_project_iam_custom_role.secret_version_destroyer[0].project == "projeto-exemplo-nos" &&
      google_project_iam_custom_role.secret_version_destroyer[0].role_id == "cpSecretVersionDestroyer" &&
      google_project_iam_custom_role.secret_version_destroyer[0].permissions == toset(["secretmanager.versions.destroy", "secretmanager.versions.get", "secretmanager.versions.list"]) &&
      !contains([for member in google_project_iam_member.terraform_nodes : member.role], google_project_iam_custom_role.secret_version_destroyer[0].id) &&
      google_project_iam_member.worker_node_lifecycle[0].role != google_project_iam_custom_role.secret_version_destroyer[0].id
    )
    error_message = "cpSecretVersionDestroyer: só listar e destruir versões, concedido por cofre (envs/tenant), nunca no projeto."
  }

  # Nenhuma concessão do cp-worker no projeto além do ciclo de vida das VMs (os cofres são por tenant).
  assert {
    condition = alltrue([
      for member in google_project_iam_member.terraform_nodes : member.member != "serviceAccount:cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com"
    ])
    error_message = "O cp-worker ganhou um papel do executor Terraform no projeto dos nós."
  }

  assert {
    condition = (
      output.control_plane_roles.cpNodeLifecycle == google_project_iam_custom_role.node_lifecycle[0].id &&
      output.control_plane_roles.cpSecretVersionDestroyer == google_project_iam_custom_role.secret_version_destroyer[0].id
    )
    error_message = "A saída control_plane_roles não traz os papéis personalizados."
  }
}

# As contas vêm do envs/control-plane com os nomes fixos `cp-terraform` e `cp-worker`, e as permissões deste projeto
# estão só aqui (dois estados com o mesmo papel personalizado brigariam por ele).
run "contrato_com_o_plano_de_controle" {
  command = plan

  assert {
    condition = (
      can(regex("account_id\\s+=\\s+\"cp-terraform\"", file("${path.module}/../control-plane/identities.tf"))) &&
      can(regex("account_id\\s+=\\s+\"cp-worker\"", file("${path.module}/../control-plane/identities.tf")))
    )
    error_message = "As contas cp-terraform e cp-worker do envs/control-plane mudaram de nome: as permissões deste projeto iriam para contas que não existem."
  }

  assert {
    condition = alltrue([
      for role in ["cpSecretsProvisioner", "cpBucketsProvisioner", "cpNodeLifecycle", "cpSecretVersionDestroyer"] :
      !can(regex("role_id\\s+=\\s+\"${role}\"", join("\n", [for name in fileset("${path.module}/../control-plane", "*.tf") : file("${path.module}/../control-plane/${name}")])))
    ])
    error_message = "O envs/control-plane define de novo um papel personalizado do projeto dos nós, que fica neste ambiente."
  }
}

run "recusa_o_plano_de_controle_no_projeto_dos_nos" {
  command = plan

  variables {
    control_plane_project_id = "projeto-exemplo-nos"
  }

  expect_failures = [var.control_plane_project_id]
}

# Com as APIs já ligadas, a leitura volta para o `plan`: o orçamento fica com o número do projeto.
run "orcamento_do_projeto" {
  command = plan

  assert {
    condition = (
      google_billing_budget.project[0].budget_filter[0].projects == toset(["projects/123456789012"]) &&
      google_billing_budget.project[0].amount[0].specified_amount[0].units == "300" &&
      length(google_billing_budget.project[0].threshold_rules) == 4
    )
    error_message = "O orçamento do projeto dos nós não vigia o projeto, ou mudou o valor ou os avisos."
  }
}

run "sem_conta_de_faturamento_sem_orcamento" {
  command = plan

  variables {
    billing_account_id = ""
  }

  assert {
    condition     = length(google_billing_budget.project) == 0
    error_message = "Sem billing_account_id, não há orçamento."
  }
}
