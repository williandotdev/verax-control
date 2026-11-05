# O que o plano de controle precisa fora deste projeto (plano, seção 2.2), tudo opcional e desligado por padrão:
#   - no projeto do registro das imagens do nó (envs/verax): dar leitura do registro à conta de cada nó;
#   - no bucket de releases do nó (PR-N7): leitura para o cp-worker.
#
# O que vale no projeto dos nós de clientes (os papéis do cp-terraform, o `cpNodeLifecycle` do cp-worker e o acesso ao
# bucket do estado) mudou para o envs/nodes-platform no CP-06 (control_plane.tf de lá), junto com o bucket do estado,
# as APIs e o orçamento daquele projeto: o bucket e as concessões nele ficam no mesmo estado. Aqui, `nodes_project_id`
# só vira as variáveis dos serviços e do Job (NODES_PROJECT_ID e TFSTATE_BUCKET, run.tf). Por tenant, o envs/tenant dá
# ao cp-worker o que ele faz nos cofres de cada nó.

locals {
  nodes_tfstate_bucket = var.nodes_project_id != "" ? "${var.nodes_project_id}-tfstate" : ""
  images_enabled       = var.images_project_id != ""
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
