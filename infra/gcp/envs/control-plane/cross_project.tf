# O que o plano de controle precisa fora deste projeto (plano, seção 2.2), tudo opcional e desligado por padrão:
#   - no projeto dos nós de clientes (criado na primeira venda): os papéis do cp-terraform, o papel personalizado
#     `cpNodeLifecycle` do cp-worker e o acesso ao bucket do estado;
#   - no projeto do registro das imagens do nó (envs/verax): dar leitura do registro à conta de cada nó;
#   - no bucket de releases do nó (PR-N7): leitura para o cp-worker.
#
# TODO(CP-06, envs/nodes-platform): o bucket do estado, as APIs e o orçamento do projeto dos nós vão nascer lá. Os
# papéis personalizados e as concessões abaixo podem mudar para lá no mesmo PR (basta mover os blocos; o estado segue
# com `moved`), ou ficar aqui, onde estão as contas. Até lá, `nodes_project_id` exige o bucket `<projeto>-tfstate` já
# criado (passo 2 do GUIA.md, no projeto dos nós), senão o `apply` para na concessão do bucket. O que o nodes-platform
# precisa garantir nesse bucket e nesse projeto:
#   - acesso uniforme no nível do bucket (`uniform_bucket_level_access = true`) no bucket do estado: a concessão
#     condicionada `worker_runs` (abaixo) exige; com ACLs por objeto, a GCP recusa a condição;
#   - o alerta por log do CP-12 em `SetIamPolicy` feito pelo cp-terraform com um papel fora da lista permitida é do
#     projeto dos nós (é lá que o `projectIamAdmin` vale), e não deste; fica para o nodes-platform.

locals {
  nodes_enabled        = var.nodes_project_id != ""
  nodes_tfstate_bucket = local.nodes_enabled ? "${var.nodes_project_id}-tfstate" : ""
  images_enabled       = var.images_project_id != ""

  # Os papéis do executor Terraform no projeto dos nós: o que o módulo `node` cria (rede, NAT, VM, disco, snapshot,
  # conta de serviço e papéis dela, segredos, Pub/Sub, bucket de backups e alerta). `projectIamAdmin` é o mais
  # sensível (plano, seção 2.2): o Job só roda a imagem fixada, só com variáveis validadas, num projeto que contém só
  # nós, e o CP-12 alerta em `SetIamPolicy` fora da lista.
  #
  # Dois papéis da seção 2.2 ficam de fora, de propósito: `secretmanager.admin` e `storage.admin` no projeto
  # inteiro deixariam o cp-terraform ler a chave privada do cofre de credenciais de todo tenant, as senhas
  # temporárias do admin, os tokens de túnel e os backups do Postgres de todos os nós. No lugar deles, os dois papéis
  # personalizados abaixo: criar, mudar, apagar e dar acesso a cofres e buckets, sem ler o conteúdo de nenhum. É tudo
  # o que o módulo `node` faz com eles (cofres vazios com os papéis da VM; o bucket de backups com `force_destroy =
  # false`, sem tocar em objeto). Destruir as versões de `credentials-key` em D+97 é do cp-worker, pelo
  # `secretVersionManager` por tenant que o envs/tenant concede; o estado dos tenants continua no `objectAdmin`
  # explícito do bucket do estado. Com o `projectIamAdmin`, o cp-terraform ainda poderia se conceder a leitura; é o
  # que o alerta em `SetIamPolicy` do CP-12 vigia: a leitura deixa de ser silenciosa.
  terraform_nodes_predefined_roles = [
    "roles/compute.instanceAdmin.v1",
    "roles/compute.networkAdmin",
    "roles/compute.securityAdmin",
    "roles/compute.storageAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/resourcemanager.projectIamAdmin",
    "roles/pubsub.admin",
    "roles/monitoring.alertPolicyEditor",
    "roles/monitoring.notificationChannelEditor",
  ]

  terraform_nodes_roles = merge(
    { for role in local.terraform_nodes_predefined_roles : role => role },
    local.nodes_enabled ? {
      cpSecretsProvisioner = google_project_iam_custom_role.secrets_provisioner[0].id
      cpBucketsProvisioner = google_project_iam_custom_role.buckets_provisioner[0].id
    } : {},
  )
}

# Cofres do Secret Manager: o contêiner e a política de acesso, nunca o conteúdo. Sem `versions.access` (ler), sem
# `versions.add` (gravar) e sem `versions.destroy`; `versions.list` só mostra os metadados.
resource "google_project_iam_custom_role" "secrets_provisioner" {
  count = local.nodes_enabled ? 1 : 0

  project     = var.nodes_project_id
  role_id     = "cpSecretsProvisioner"
  title       = "Verax Control: cria os cofres dos nós"
  description = "Cria, muda, apaga e dá acesso aos cofres do Secret Manager dos nós de clientes, sem ler nem gravar versão."
  permissions = [
    "secretmanager.secrets.create",
    "secretmanager.secrets.delete",
    "secretmanager.secrets.get",
    "secretmanager.secrets.list",
    "secretmanager.secrets.update",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.setIamPolicy",
    "secretmanager.versions.list",
  ]
}

# Buckets do Cloud Storage: o bucket e a política de acesso, nunca os objetos (nenhum `storage.objects.*`).
resource "google_project_iam_custom_role" "buckets_provisioner" {
  count = local.nodes_enabled ? 1 : 0

  project     = var.nodes_project_id
  role_id     = "cpBucketsProvisioner"
  title       = "Verax Control: cria os buckets dos nós"
  description = "Cria, muda, apaga e dá acesso aos buckets dos nós de clientes (backups), sem ler nem gravar objeto."
  permissions = [
    "storage.buckets.create",
    "storage.buckets.delete",
    "storage.buckets.get",
    "storage.buckets.list",
    "storage.buckets.update",
    "storage.buckets.getIamPolicy",
    "storage.buckets.setIamPolicy",
  ]
}

resource "google_project_iam_member" "terraform_nodes" {
  for_each = local.nodes_enabled ? local.terraform_nodes_roles : {}

  project = var.nodes_project_id
  role    = each.value
  member  = local.terraform_member
}

# O estado de cada tenant (`tenants/<slug>/`) e o `outputs.json` de cada execução (`runs/<slug>/<runId>/`). É a única
# leitura e gravação de objeto que o cp-terraform tem no projeto dos nós (o `cpBucketsProvisioner` não alcança
# objeto).
resource "google_storage_bucket_iam_member" "terraform_state" {
  count = local.nodes_enabled ? 1 : 0

  bucket = local.nodes_tfstate_bucket
  role   = "roles/storage.objectAdmin"
  member = local.terraform_member
}

# O cp-worker lê só `runs/` do bucket do estado (os `outputs.json`), nunca o estado dos tenants. A condição exige o
# acesso uniforme no nível do bucket (TODO no cabeçalho).
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
