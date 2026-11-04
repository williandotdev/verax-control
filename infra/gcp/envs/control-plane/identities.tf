# As quatro identidades do plano de controle (plano, seção 2.2), sem chave JSON em lugar nenhum: três contas de
# execução (uma por peça) e a conta que o GitHub Actions usa para implantar, pela federação de identidade. Cada papel
# vale no menor recurso possível (a fila, o segredo, o Job, a conta), nunca no projeto quando dá para evitar.

resource "google_service_account" "public" {
  account_id   = "cp-public"
  display_name = "Plano de controle: checkout, webhook e status (cp-public)"
}

resource "google_service_account" "worker" {
  account_id   = "cp-worker"
  display_name = "Plano de controle: passos internos, tick e reconciliação (cp-worker)"
}

resource "google_service_account" "terraform" {
  account_id   = "cp-terraform"
  display_name = "Plano de controle: executor Terraform dos nós de clientes (Job cp-terraform)"
}

resource "google_service_account" "deployer" {
  account_id   = "cp-deployer"
  display_name = "Implantação do plano de controle (GitHub Actions, environment control-plane)"
}

locals {
  public_member    = "serviceAccount:${google_service_account.public.email}"
  worker_member    = "serviceAccount:${google_service_account.worker.email}"
  terraform_member = "serviceAccount:${google_service_account.terraform.email}"
  deployer_member  = "serviceAccount:${google_service_account.deployer.email}"

  runtime_members = {
    public = local.public_member
    worker = local.worker_member
  }

  # Projetos do pool do Firebase dos painéis: este (o primeiro) e os demais, quando houver.
  panel_projects = toset(concat([var.project_id], var.firebase_panel_projects))
}

# Papéis no projeto: só o acesso ao Firestore. O resto é por recurso (abaixo e nos outros arquivos).
resource "google_project_iam_member" "public" {
  for_each = toset(["roles/datastore.user"])

  project = var.project_id
  role    = each.key
  member  = local.public_member
}

resource "google_project_iam_member" "worker" {
  for_each = toset(["roles/datastore.user"])

  project = var.project_id
  role    = each.key
  member  = local.worker_member
}

# O cp-worker cria o site e o domínio do painel de cada cliente nos projetos do pool.
resource "google_project_iam_member" "worker_hosting_admin" {
  for_each = local.panel_projects

  project = each.key
  role    = "roles/firebasehosting.admin"
  member  = local.worker_member
}

# As tasks levam o token de identidade do cp-worker. Quem cria a task precisa poder "agir como" ele: o cp-public (que
# enfileira o primeiro passo) e o próprio cp-worker (que enfileira o passo seguinte; o Cloud Tasks exige a permissão
# mesmo de quem age como si mesmo).
resource "google_service_account_iam_member" "worker_token_users" {
  for_each = local.runtime_members

  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value
}

# Papel personalizado do cp-worker sobre o Job: disparar (com as variáveis do tenant em overrides) e acompanhar as
# execuções. Nada de criar, mudar ou apagar o Job. A concessão fica no próprio Job (run.tf).
resource "google_project_iam_custom_role" "job_runner" {
  role_id     = "cpJobRunner"
  title       = "Verax Control: dispara o Job cp-terraform"
  description = "Dispara execuções do Job do executor Terraform, com overrides, e lê o resultado."
  permissions = [
    "run.jobs.run",
    "run.jobs.runWithOverrides",
    "run.executions.get",
    "run.executions.list",
  ]

  depends_on = [google_project_service.apis]
}

# Quem implanta age como as três contas de execução (uma revisão nova do serviço roda com a conta dele).
resource "google_service_account_iam_member" "deployer_acts_as" {
  for_each = {
    public    = google_service_account.public.name
    worker    = google_service_account.worker.name
    terraform = google_service_account.terraform.name
  }

  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = local.deployer_member
}

# Federação de identidade com o GitHub Actions: o job entra na GCP com o token OIDC do GitHub, sem chave. O pool do
# Painel fica em outro projeto e foi criado fora do Terraform; este é próprio deste projeto e deste repositório.
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "cp-github"
  display_name              = "GitHub Actions (plano de controle)"
  description               = "Tokens OIDC do GitHub Actions do repositório do Verax Control."

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  #checkov:skip=CKV_GCP_125:O checkov trata todo subject com `environment` como abusável, mas o environment só é configurado por administradores do repositório, o GitHub o restringe à `main`, e a condição ainda exige os IDs fixos do repositório e do dono. É o mesmo desenho do Painel e das imagens do nó.
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository"    = "assertion.repository"
    "attribute.repository_id" = "assertion.repository_id"
  }

  # Só o token do environment `control-plane` deste repositório, e ainda pelos IDs fixos do GitHub (molde do
  # envs/verax): um repositório recriado com o mesmo nome tem outro ID e não entra; uma troca de nome não abre nada
  # por si só (o subject cita o nome; depois de renomear, atualize `github_repository`).
  attribute_condition = "assertion.sub == \"repo:${var.github_repository}:environment:${var.github_environment}\" && assertion.repository_owner_id == \"${var.github_repository_owner_id}\" && assertion.repository_id == \"${var.github_repository_id}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Só o environment `control-plane` (que o GitHub restringe à `main`) vira a conta de implantação.
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/repo:${var.github_repository}:environment:${var.github_environment}"
}
