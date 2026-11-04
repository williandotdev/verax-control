# O que o plano de controle precisa fora deste projeto (plano, seção 2.2), tudo opcional e desligado por padrão:
#   - no projeto dos nós de clientes (criado na primeira venda): os papéis do cp-terraform, o papel personalizado
#     `cpNodeLifecycle` do cp-worker e o acesso ao bucket do estado;
#   - no projeto do registro das imagens do nó (envs/verax): dar leitura do registro à conta de cada nó;
#   - no bucket de releases do nó (PR-N7): leitura para o cp-worker.
#
# TODO(CP-06, envs/nodes-platform): o bucket do estado, as APIs e o orçamento do projeto dos nós vão nascer lá. Os
# papéis personalizados e as concessões abaixo podem mudar para lá no mesmo PR (basta mover os blocos; o estado segue
# com `moved`), ou ficar aqui, onde estão as contas. Até lá, `nodes_project_id` exige o bucket `<projeto>-tfstate` já
# criado (passo 2 do GUIA.md, no projeto dos nós), senão o `apply` para na concessão do bucket.

locals {
  nodes_enabled        = var.nodes_project_id != ""
  nodes_tfstate_bucket = local.nodes_enabled ? "${var.nodes_project_id}-tfstate" : ""
  images_enabled       = var.images_project_id != ""

  # Os papéis do executor Terraform no projeto dos nós: o que o módulo `node` cria (rede, NAT, VM, disco, snapshot,
  # conta de serviço e papéis dela, segredos, Pub/Sub, bucket de backups e alerta). `projectIamAdmin` é o mais
  # sensível (plano, seção 2.2): o Job só roda a imagem fixada, só com variáveis validadas, num projeto que contém só
  # nós, e o CP-12 alerta em `SetIamPolicy` fora da lista.
  terraform_nodes_roles = toset([
    "roles/compute.instanceAdmin.v1",
    "roles/compute.networkAdmin",
    "roles/compute.securityAdmin",
    "roles/compute.storageAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/resourcemanager.projectIamAdmin",
    "roles/secretmanager.admin",
    "roles/pubsub.admin",
    "roles/storage.admin",
    "roles/monitoring.alertPolicyEditor",
    "roles/monitoring.notificationChannelEditor",
  ])
}

resource "google_project_iam_member" "terraform_nodes" {
  for_each = local.nodes_enabled ? local.terraform_nodes_roles : toset([])

  project = var.nodes_project_id
  role    = each.key
  member  = local.terraform_member
}

# O estado de cada tenant (`tenants/<slug>/`) e o `outputs.json` de cada execução (`runs/<slug>/<runId>/`). O
# `storage.admin` do projeto já cobre o bucket; a concessão explícita fica, para valer mesmo que aquele papel encolha.
resource "google_storage_bucket_iam_member" "terraform_state" {
  count = local.nodes_enabled ? 1 : 0

  bucket = local.nodes_tfstate_bucket
  role   = "roles/storage.objectAdmin"
  member = local.terraform_member
}

# O cp-worker lê só `runs/` do bucket do estado (os `outputs.json`), nunca o estado dos tenants.
resource "google_storage_bucket_iam_member" "worker_runs" {
  count = local.nodes_enabled ? 1 : 0

  bucket = local.nodes_tfstate_bucket
  role   = "roles/storage.objectViewer"
  member = local.worker_member

  condition {
    title       = "Só a pasta runs/"
    description = "Os outputs.json das execuções do executor Terraform."
    expression  = "resource.name.startsWith(\"projects/_/buckets/${local.nodes_tfstate_bucket}/objects/runs/\")"
  }
}

# Parar, ligar e ler o estado (guest attributes) das VMs dos nós, e só das que começam com `vx-`. Suspensão por
# inadimplência, reativação e o `tick` (plano, 4b e 4d).
resource "google_project_iam_custom_role" "node_lifecycle" {
  count = local.nodes_enabled ? 1 : 0

  project     = var.nodes_project_id
  role_id     = "cpNodeLifecycle"
  title       = "Verax Control: ciclo de vida das VMs dos nós"
  description = "Parar, ligar e ler os atributos de convidado das VMs dos nós de clientes (vx-*)."
  permissions = [
    "compute.instances.get",
    "compute.instances.start",
    "compute.instances.stop",
    "compute.instances.getGuestAttributes",
  ]
}

resource "google_project_iam_member" "worker_node_lifecycle" {
  count = local.nodes_enabled ? 1 : 0

  project = var.nodes_project_id
  role    = google_project_iam_custom_role.node_lifecycle[0].id
  member  = local.worker_member

  condition {
    title       = "Só as VMs dos nós de clientes (vx-*)"
    description = "Nenhuma outra VM do projeto, hoje ou no futuro."
    expression  = "resource.type == \"compute.googleapis.com/Instance\" && resource.name.extract(\"/instances/{name}\").startsWith(\"vx-\")"
  }
}

# O envs/tenant dá à conta de cada nó a leitura do registro de imagens (como o envs/homolog-sp faz à mão): o executor
# precisa gravar a política do registro, e só isso, só nesse registro.
resource "google_project_iam_custom_role" "images_access_granter" {
  count = local.images_enabled ? 1 : 0

  project     = var.images_project_id
  role_id     = "cpImagesAccessGranter"
  title       = "Verax Control: dá leitura do registro de imagens à conta de cada nó"
  description = "Ler e gravar a política de acesso de um registro do Artifact Registry."
  permissions = [
    "artifactregistry.repositories.get",
    "artifactregistry.repositories.getIamPolicy",
    "artifactregistry.repositories.setIamPolicy",
  ]
}

resource "google_artifact_registry_repository_iam_member" "terraform_images" {
  count = local.images_enabled ? 1 : 0

  project    = var.images_project_id
  location   = var.images_location
  repository = var.images_repository_id
  role       = google_project_iam_custom_role.images_access_granter[0].id
  member     = local.terraform_member
}

# O manifesto da versão promovida e o bundle do painel, que o `preflight` e o `firebase.site` leem.
resource "google_storage_bucket_iam_member" "worker_releases" {
  count = var.release_bucket == "" ? 0 : 1

  bucket = var.release_bucket
  role   = "roles/storage.objectViewer"
  member = local.worker_member
}
