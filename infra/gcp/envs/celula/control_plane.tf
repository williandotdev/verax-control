# O que o plano de controle pode fazer no projeto da célula para cada cliente dela (CE-07), só com
# `control_plane_project_id` preenchido. O envs/cell-tenant (um estado por cliente, aplicado pelo executor Terraform,
# `cp-terraform`) cria a conta de serviço `vxt-<slug>`, o cofre `vxt-<slug>-admin-bootstrap` e os tópicos
# `vxc-<célula>-gcp-<UUID>` de cada cliente, e dá acesso a eles. Aqui, as duas coisas que valem para a célula inteira:
#
# - o papel `cpCellTenants_<célula>` do cp-terraform no projeto: criar, mudar, apagar e dar acesso a contas de serviço,
#   cofres e tópicos, sem ler nem gravar versão de cofre, sem mensagem do Pub/Sub e sem chave de conta de serviço. O
#   projeto da célula é o do nó da Verax (com o nó lean, a chave de release e o registro das imagens): por isso não há
#   `projectIamAdmin` nem `serviceAccountAdmin` no projeto, como no projeto dos nós (envs/nodes-platform), e a
#   concessão tem uma condição que só deixa passar o projeto (as criações e as listas, conferidas no projeto) e os
#   recursos com o nome dos clientes da célula (`vxt-...` e `vxc-<célula>-gcp-...`). Sem a condição, o cp-terraform
#   poderia se dar o token de qualquer conta do projeto (a da VM da célula, que lê a chave do cofre de credenciais). A
#   condição é escrita no sentido positivo: um tipo de recurso cujo nome a GCP não passe à condição fica de fora, e o
#   `apply` do cliente falha (nunca concede a mais). A conferir no primeiro `apply` do envs/cell-tenant
#   (docs/runbooks/celula.md);
# - o papel `cpTenantSaToggle_<célula>`: desativar e reativar uma conta de serviço (a suspensão do cliente). Não é
#   concedido no projeto: o envs/cell-tenant o dá ao cp-worker só na conta do cliente.
#
# O estado de cada cliente fica no bucket do estado do projeto dos nós (`cells/<célula>/tenants/<slug>`), onde o
# cp-terraform já tem o `objectAdmin` (envs/nodes-platform): nada do bucket do estado deste projeto.

locals {
  cp_terraform_member = "serviceAccount:cp-terraform@${var.control_plane_project_id}.iam.gserviceaccount.com"
  # Os nomes dos recursos de cliente desta célula, os mesmos do envs/cell-tenant.
  tenant_account_prefix = "vxt-"
  tenant_topic_prefix   = "${local.cell_namespace}-gcp-"
  cell_tenants_condition = join(" || ", [
    "resource.type == \"cloudresourcemanager.googleapis.com/Project\"",
    "(resource.type == \"iam.googleapis.com/ServiceAccount\" && resource.name.extract(\"serviceAccounts/{account}\").startsWith(\"${local.tenant_account_prefix}\"))",
    "(resource.type == \"secretmanager.googleapis.com/Secret\" && resource.name.extract(\"/secrets/{secret}\").startsWith(\"${local.tenant_account_prefix}\"))",
    "(resource.type == \"pubsub.googleapis.com/Topic\" && resource.name.extract(\"/topics/{topic}\").startsWith(\"${local.tenant_topic_prefix}\"))",
    "(resource.type == \"pubsub.googleapis.com/Subscription\" && resource.name.extract(\"/subscriptions/{subscription}\").startsWith(\"${local.tenant_topic_prefix}\"))",
  ])
}

resource "google_project_iam_custom_role" "cell_tenants" {
  count = local.cell_channel ? 1 : 0

  project     = var.project_id
  role_id     = "cpCellTenants_${var.cell_id}"
  title       = "Verax Control: os recursos de cada cliente da célula ${var.cell_id}"
  description = "Criar, mudar, apagar e dar acesso às contas de serviço, aos cofres e aos tópicos dos clientes da célula, sem ler nem gravar versão de cofre, sem mensagem e sem chave de conta."
  permissions = [
    "iam.serviceAccounts.create",
    "iam.serviceAccounts.delete",
    "iam.serviceAccounts.get",
    "iam.serviceAccounts.getIamPolicy",
    "iam.serviceAccounts.list",
    "iam.serviceAccounts.setIamPolicy",
    "iam.serviceAccounts.update",
    "pubsub.subscriptions.create",
    "pubsub.subscriptions.delete",
    "pubsub.subscriptions.get",
    "pubsub.subscriptions.getIamPolicy",
    "pubsub.subscriptions.list",
    "pubsub.subscriptions.setIamPolicy",
    "pubsub.subscriptions.update",
    "pubsub.topics.attachSubscription",
    "pubsub.topics.create",
    "pubsub.topics.delete",
    "pubsub.topics.get",
    "pubsub.topics.getIamPolicy",
    "pubsub.topics.list",
    "pubsub.topics.setIamPolicy",
    "pubsub.topics.update",
    "secretmanager.secrets.create",
    "secretmanager.secrets.delete",
    "secretmanager.secrets.get",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.list",
    "secretmanager.secrets.setIamPolicy",
    "secretmanager.secrets.update",
  ]

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "terraform_cell_tenants" {
  count = local.cell_channel ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.cell_tenants[0].id
  member  = local.cp_terraform_member

  condition {
    title       = "Só os recursos dos clientes da célula ${var.cell_id}"
    description = "O projeto (criar e listar) e as contas vxt-, os cofres vxt- e os tópicos e assinaturas ${local.tenant_topic_prefix}."
    expression  = local.cell_tenants_condition
  }
}

resource "google_project_iam_custom_role" "tenant_sa_toggle" {
  count = local.cell_channel ? 1 : 0

  project     = var.project_id
  role_id     = "cpTenantSaToggle_${var.cell_id}"
  title       = "Verax Control: suspender a conta de um cliente da célula ${var.cell_id}"
  description = "Desativar e reativar uma conta de serviço. Concedido ao cp-worker só na conta de cada cliente (envs/cell-tenant)."
  permissions = [
    "iam.serviceAccounts.disable",
    "iam.serviceAccounts.enable",
    "iam.serviceAccounts.get",
  ]

  depends_on = [google_project_service.apis]
}
