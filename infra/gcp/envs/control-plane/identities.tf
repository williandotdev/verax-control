# As cinco identidades do plano de controle (plano, seção 2.2, mais a `cp-invoker` da revisão), sem chave JSON em
# lugar nenhum (a sexta, `cp-admin`, do console do responsável, fica em admin.tf e só existe com `admin_enabled`): três contas de execução (uma por peça), a conta que só serve de token para chamar o cp-worker e a
# conta que o GitHub Actions usa para implantar, pela federação de identidade. Cada papel vale no menor recurso
# possível (a fila, o segredo, o Job, a conta), nunca no projeto quando dá para evitar.

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

# A identidade que as tasks e o Scheduler levam no token para chamar o cp-worker. Só isso: `run.invoker` no
# cp-worker (run.tf) e nenhum outro papel. Quem enfileira (cp-public e cp-worker) age como ela, e não como o
# cp-worker: um cp-public comprometido não consegue um token com os papéis do cp-worker (Firestore, Hosting, o Job,
# os segredos do provisionamento); consegue, no máximo, chamar o cp-worker, que já é o que ele faz.
#
# Contrato com o app (plano, seção 2.5): o cp-worker confere `aud == WORKER_URL` e `email` do token em
# {WORKER_SA_EMAIL, SCHEDULER_SA_EMAIL} ∪ OWNER_PRINCIPALS nos passos, no tick e no reconcile; as duas variáveis
# apontam para esta conta (run.tf). Na revelação da senha (CP-05) vale só o token do próprio cp-public
# (PUBLIC_SA_EMAIL), que chama o worker com a identidade dele, e o desta conta não vale.
resource "google_service_account" "invoker" {
  account_id   = "cp-invoker"
  display_name = "Plano de controle: token das tasks e do Scheduler para o cp-worker (cp-invoker)"
}

resource "google_service_account" "deployer" {
  account_id   = "cp-deployer"
  display_name = "Implantação do plano de controle (GitHub Actions, environment control-plane)"
}

locals {
  public_member    = "serviceAccount:${google_service_account.public.email}"
  worker_member    = "serviceAccount:${google_service_account.worker.email}"
  terraform_member = "serviceAccount:${google_service_account.terraform.email}"
  invoker_member   = "serviceAccount:${google_service_account.invoker.email}"
  deployer_member  = "serviceAccount:${google_service_account.deployer.email}"

  runtime_members = {
    public = local.public_member
    worker = local.worker_member
  }

  # Projetos do pool do Firebase dos painéis dos clientes: só os de `firebase_panel_projects`, nunca este. O site do
  # plano de controle (`verax-conta`, hosting.tf) e os sites do Painel que já existem aqui ficam fora do alcance do
  # cp-worker: um cp-worker comprometido não troca o conteúdo de conta.veraxsistemas.com.br.
  panel_projects = toset(var.firebase_panel_projects)
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

# O cp-worker cria o site e o domínio do painel de cada cliente nos projetos do pool (e só neles).
resource "google_project_iam_member" "worker_hosting_admin" {
  for_each = local.panel_projects

  project = each.key
  role    = "roles/firebasehosting.admin"
  member  = local.worker_member
}

# Os agentes de serviço do Cloud Tasks e do Cloud Scheduler (contas que o Google gerencia, uma por projeto): são
# eles que geram o token OIDC da cp-invoker na hora de despachar. O recurso garante que cada agente já existe antes
# do primeiro job e da primeira task (num projeto que acabou de ligar a API, ele só nasce no primeiro uso, e a
# criação do job do Scheduler falha antes disso). O papel de agente de serviço de cada um (`cloudtasks.serviceAgent`,
# `cloudscheduler.serviceAgent`), concedido pelo Google ao ligar a API, é o que lhes permite gerar o token; a
# concessão abaixo deixa explícito, na própria conta, que os dois agem como a cp-invoker, e vale mesmo que aquele
# papel do projeto encolha.
resource "google_project_service_identity" "agents" {
  provider = google-beta
  for_each = toset(["cloudtasks", "cloudscheduler"])

  service = "${each.key}.googleapis.com"

  depends_on = [google_project_service.apis]
}

# Quem age como a cp-invoker: o cp-public (que enfileira o primeiro passo), o cp-worker (que enfileira o passo
# seguinte e o ciclo de vida) e os dois agentes de serviço. Ninguém age como o cp-worker além de quem implanta.
resource "google_service_account_iam_member" "invoker_token_users" {
  for_each = merge(local.runtime_members, {
    cloudtasks_agent     = google_project_service_identity.agents["cloudtasks"].member
    cloudscheduler_agent = google_project_service_identity.agents["cloudscheduler"].member
  })

  service_account_id = google_service_account.invoker.name
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

# Quem implanta age como as contas de execução (uma revisão nova do serviço roda com a conta dele): as três de sempre
# e a do cp-admin, quando ele existe (admin.tf). Não age como a cp-invoker: nenhum serviço roda com ela.
resource "google_service_account_iam_member" "deployer_acts_as" {
  for_each = merge(
    {
      public    = google_service_account.public.name
      worker    = google_service_account.worker.name
      terraform = google_service_account.terraform.name
    },
    { for account in google_service_account.admin : "admin" => account.name },
  )

  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = local.deployer_member
}

# Federação de identidade com o GitHub Actions: o job entra na GCP com o token OIDC do GitHub, sem chave. O pool do
# Painel fica em outro projeto e foi criado fora do Terraform; este é próprio deste projeto e deste repositório.
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "cp-github"
  # No máximo 32 caracteres (limite da API).
  display_name = "GitHub Actions (control-plane)"
  description  = "Tokens OIDC do GitHub Actions do repositório do Verax Control."

  depends_on = [google_project_service.apis]
}

locals {
  # O `sub` do token OIDC do GitHub para o environment de implantação, com os IDs fixos do dono e do repositório.
  github_subject = format(
    "repo:%s@%s/%s@%s:environment:%s",
    split("/", var.github_repository)[0], var.github_repository_owner_id,
    split("/", var.github_repository)[1], var.github_repository_id,
    var.github_environment,
  )

  # A condição do provedor, pedaço a pedaço (a mesma ordem vale no teste):
  #   1. o subject do environment `control-plane` deste repositório, no formato imutável que o repositório usa
  #      (`use_immutable_subject` na personalização do `sub` do OIDC do GitHub: `repo:dono@id/nome@id:environment:...`,
  #      como em `envs/verax`, variável `github_oidc_repository`). Com o formato só de nomes, o provedor recusaria
  #      todo token do repositório;
  #   2 e 3. os IDs fixos do dono e do repositório (molde do envs/verax): um repositório recriado com o mesmo nome
  #      tem outro ID e não entra;
  #   4 e 5. o token veio de um job na branch `main` (e não de uma tag com esse nome). A proteção "deployment
  #      branches" do environment no GitHub faz o mesmo, mas é configuração fora do Terraform; aqui a condição não
  #      depende dela;
  #   6. só os eventos que implantam (`push` e `workflow_dispatch`): um `pull_request_target`, que roda com o `ref`
  #      da base, também fica de fora.
  github_attribute_condition = join(" && ", [
    "assertion.sub == \"${local.github_subject}\"",
    "assertion.repository_owner_id == \"${var.github_repository_owner_id}\"",
    "assertion.repository_id == \"${var.github_repository_id}\"",
    "assertion.ref == \"refs/heads/main\"",
    "assertion.ref_type == \"branch\"",
    "(assertion.event_name == \"push\" || assertion.event_name == \"workflow_dispatch\")",
  ])
}

resource "google_iam_workload_identity_pool_provider" "github" {
  #checkov:skip=CKV_GCP_125:O checkov trata todo subject com `environment` como abusável, mas o environment só é configurado por administradores do repositório, e a condição ainda exige os IDs fixos do repositório e do dono, a branch `main` e um evento de push ou de disparo manual. É o mesmo desenho do Painel e das imagens do nó, com a branch e o evento conferidos aqui também.
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  # O `ref`, o tipo dele e o evento entram como atributos, para aparecerem nos logs de auditoria de cada token.
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository"    = "assertion.repository"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.ref"           = "assertion.ref"
    "attribute.ref_type"      = "assertion.ref_type"
    "attribute.event_name"    = "assertion.event_name"
  }

  attribute_condition = local.github_attribute_condition

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Só o environment `control-plane` (que a condição acima prende à `main`) vira a conta de implantação.
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/${local.github_subject}"
}
