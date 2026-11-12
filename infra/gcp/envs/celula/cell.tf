# O que a célula tem além de um nó (CE-03; docs/ARQUITETURA.md, "Célula compartilhada (Plataforma)"):
#
# - o canal com o plano de controle, Pub/Sub nos dois sentidos, só com `control_plane_project_id` e
#   `control_plane_worker_url` preenchidos (sem eles, nada daqui existe e a célula fica como antes):
#   - comandos (`vxc-<célula>-commands`): só o cp-worker publica, e só a VM da célula lê, pela assinatura com ordem por
#     chave (a chave é o cliente: os comandos de um cliente chegam na ordem em que saíram);
#   - relatórios (`vxc-<célula>-reports`): só a VM da célula publica, e uma assinatura push entrega cada um ao cp-worker
#     (`/internal/cells/<célula>/reports`), com um token OIDC de uma conta só para isso (`vxc-<célula>-push`). O lado do
#     plano de controle (a rota, o `run.invoker` dessa conta no cp-worker e a conferência de que cada cliente citado é
#     desta célula) é do CE-06; daqui saem os nomes que ele precisa (outputs.tf, `cell`).
#   O IAM dos tópicos prova quem publicou: nenhuma outra conta tem papel do Pub/Sub nesses tópicos por este Terraform;
#   nada é exposto na internet;
# - o bucket das exportações dos clientes (`<projeto>-vxc-<célula>-exports`): no cancelamento, a célula exporta os dados
#   do cliente para `<célula>/<cliente>/...` e o plano de controle gera o link para o responsável. A VM só cria objetos,
#   e só dentro da pasta da célula (nem lê, nem apaga, nem sobrescreve); o ciclo de vida apaga tudo com 31 dias (o
#   plano de controle apaga antes, em D+30). Existe sempre: vazio, não custa nada.
#
# Os backups de 85 dias são o `backup_retention_days` do módulo (main.tf).

locals {
  cell_channel = var.control_plane_project_id != ""
  # Os nomes da célula no projeto: os tópicos do canal, a conta do push, o bucket das exportações e, no envs/cell-tenant,
  # os tópicos da GCP de cada cliente (`vxc-<célula>-gcp-<UUID da conta>`).
  cell_namespace = "vxc-${var.cell_id}"
  cell_member    = "serviceAccount:${module.node.service_account_email}"
  # A conta do cp-worker tem nome fixo no envs/control-plane (identities.tf; o envs/nodes-platform conta com o mesmo).
  cp_worker_member = "serviceAccount:cp-worker@${var.control_plane_project_id}.iam.gserviceaccount.com"
  reports_endpoint = "${var.control_plane_worker_url}/internal/cells/${var.cell_id}/reports"
}

# --- Comandos: do plano de controle para a célula ---------------------------------------------------------------------

resource "google_pubsub_topic" "commands" {
  #checkov:skip=CKV_GCP_83:Cifrado pelo Google (AES-256). Os comandos levam o estado desejado de cada cliente, sem segredo (nenhuma senha, chave ou token).
  count = local.cell_channel ? 1 : 0

  name = "${local.cell_namespace}-commands"

  # Com a célula parada, os comandos esperam até 7 dias.
  message_retention_duration = "604800s"

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }

  depends_on = [google_project_service.apis]
}

# Só o cp-worker publica comandos.
resource "google_pubsub_topic_iam_member" "commands_publisher" {
  count = local.cell_channel ? 1 : 0

  topic  = google_pubsub_topic.commands[0].id
  role   = "roles/pubsub.publisher"
  member = local.cp_worker_member
}

resource "google_pubsub_subscription" "commands" {
  count = local.cell_channel ? 1 : 0

  name  = google_pubsub_topic.commands[0].name
  topic = google_pubsub_topic.commands[0].id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = false
  # A chave de ordem é o cliente: a geração de um cliente nunca chega antes da anterior. Mudar recria a assinatura.
  enable_message_ordering = true

  # A assinatura nunca expira por falta de uso.
  expiration_policy {
    ttl = ""
  }
}

# Só a VM da célula lê os comandos (o worker, com a identidade da VM).
resource "google_pubsub_subscription_iam_member" "commands_subscriber" {
  count = local.cell_channel ? 1 : 0

  subscription = google_pubsub_subscription.commands[0].id
  role         = "roles/pubsub.subscriber"
  member       = local.cell_member
}

# --- Relatórios: da célula para o plano de controle -------------------------------------------------------------------

resource "google_pubsub_topic" "reports" {
  #checkov:skip=CKV_GCP_83:Cifrado pelo Google (AES-256). Os relatórios levam estado, contagens e uso diário por cliente, sem segredo.
  count = local.cell_channel ? 1 : 0

  name = "${local.cell_namespace}-reports"

  message_retention_duration = "604800s"

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }

  depends_on = [google_project_service.apis]
}

# Só a VM da célula publica relatórios.
resource "google_pubsub_topic_iam_member" "reports_publisher" {
  count = local.cell_channel ? 1 : 0

  topic  = google_pubsub_topic.reports[0].id
  role   = "roles/pubsub.publisher"
  member = local.cell_member
}

# A conta que assina o token OIDC de cada entrega do push. Não tem papel nenhum: o cp-worker aceita o token dela só na
# rota dos relatórios desta célula (CE-06, `@WorkerCallers('cell-push')`), e o `run.invoker` dela no cp-worker é do
# envs/control-plane.
resource "google_service_account" "reports_push" {
  count = local.cell_channel ? 1 : 0

  account_id   = "${local.cell_namespace}-push"
  display_name = "Verax Control - relatórios da célula ${var.cell_id}"
  description  = "Identidade do push dos relatórios da célula ${var.cell_id} para o cp-worker (token OIDC). Sem papel nenhum."

  depends_on = [google_project_service.apis]
}

# O agente do Pub/Sub do projeto emite o token OIDC em nome da conta do push, e só dela (projetos de antes de abril de
# 2021 exigem a permissão; nos outros, ela não muda nada).
resource "google_service_account_iam_member" "reports_push_token" {
  count = local.cell_channel ? 1 : 0

  service_account_id = google_service_account.reports_push[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription" "reports_push" {
  count = local.cell_channel ? 1 : 0

  name  = "${local.cell_namespace}-reports-push"
  topic = google_pubsub_topic.reports[0].id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  expiration_policy {
    ttl = ""
  }

  # O cp-worker fora do ar ou recusando (5xx, 429): a entrega espera de 10 s a 10 min entre as tentativas, até 7 dias.
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  push_config {
    push_endpoint = local.reports_endpoint

    oidc_token {
      service_account_email = google_service_account.reports_push[0].email
      # A audiência que o cp-worker confere (`identity-token.ts`): o endereço do serviço.
      audience = var.control_plane_worker_url
    }
  }

  depends_on = [google_service_account_iam_member.reports_push_token]
}

# --- Exportações dos clientes -----------------------------------------------------------------------------------------

# nosemgrep: terraform.gcp.security.gcp-cloud-storage-logging.gcp-cloud-storage-logging -- mesmo motivo do checkov abaixo.
resource "google_storage_bucket" "exports" {
  #checkov:skip=CKV_GCP_62:O log de acesso legado precisaria de outro bucket só para ele; quem cria e lê objetos fica nos logs de auditoria do Cloud Storage, como no bucket de backups do nó.
  #checkov:skip=CKV_GCP_78:Sem versionamento de propósito: a exportação sai em D+30 (o plano de controle apaga) ou pelo ciclo de vida (31 dias), e uma versão anterior guardada passaria do prazo prometido ao cliente. A VM só cria objetos, então não há o que sobrescrever.
  # O nome de bucket é único no mundo: o ID do projeto entra para não colidir.
  name     = "${var.project_id}-${local.cell_namespace}-exports"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Um `terraform destroy` não apaga um bucket com exportações dentro.
  force_destroy = false

  # Objeto apagado fica recuperável por 7 dias (a exportação apagada em D+30 some de vez até D+37).
  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  # O limite das exportações: 31 dias depois de criadas, mesmo que o plano de controle não as tenha apagado em D+30.
  lifecycle_rule {
    condition {
      age = 31
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

# A VM só cria objetos, e só na pasta da célula (`<célula>/<cliente>/...`): não lê, não lista, não apaga e não
# sobrescreve (o `objectCreator` não tem `storage.objects.delete`, que a troca de um objeto exige). O acesso uniforme no
# nível do bucket é o que permite a condição.
resource "google_storage_bucket_iam_member" "cell_exports" {
  bucket = google_storage_bucket.exports.name
  role   = "roles/storage.objectCreator"
  member = local.cell_member

  condition {
    title       = "Só a pasta da célula"
    description = "As exportações dos clientes desta célula (<célula>/<cliente>/...)."
    expression  = "resource.name.startsWith(\"projects/_/buckets/${google_storage_bucket.exports.name}/objects/${var.cell_id}/\")"
  }
}
