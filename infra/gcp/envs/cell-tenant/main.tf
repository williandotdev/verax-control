# O que é de um cliente na célula (CE-07; docs/ARQUITETURA.md, "Célula compartilhada (Plataforma)"), no projeto da
# célula. Cada permissão vale só para o recurso do cliente, nunca para o projeto:
#
# - a conta de serviço do cliente (`vxt-<slug>`): é a identidade dele na AWS (o papel de leitura confia no ID único
#   dela). A VM da célula só emite o token OIDC dela (`serviceAccountOpenIdTokenCreator`, nesta conta e em nenhuma
#   outra; nenhum token de acesso, então nada na GCP com ela), e o cp-worker só a desativa e reativa (o papel
#   `cpTenantSaToggle_<célula>` do envs/celula, só nela), na suspensão. Só o `slug` e o `project_id` decidem se ela é
#   recriada, e o executor recusa um plano que a apague ou recrie fora da exclusão do cliente (a conta nova teria outro
#   ID único, e o papel da AWS do cliente deixaria de aceitar a célula);
# - o cofre do primeiro acesso (`vxt-<slug>-admin-bootstrap`): a VM só grava a senha temporária (o host, start.sh
#   tenant-bootstrap), e o cp-worker a lê uma vez e destrói a versão (a revelação, como no nó dedicado). Nenhuma versão
#   passa pelo Terraform;
# - os tópicos e as assinaturas da GCP do cliente (`vxc-<célula>-gcp-<UUID da conta>`): só a identidade do sink do
#   cliente publica, e só a VM da célula lê. O nome leva o UUID da conta cloud e nunca volta: depois da exclusão de um
#   cliente, outro não herda o tópico (nem o sink esquecido) dele.

locals {
  tenant_account_id = "vxt-${var.slug}"
  cell_member       = "serviceAccount:${var.cell_node_service_account}"
  worker_member     = "serviceAccount:${var.control_plane_sa}"
  # O papel do cp-worker na conta do cliente, criado uma vez por célula pelo envs/celula (control_plane.tf).
  toggle_role = "projects/${var.project_id}/roles/cpTenantSaToggle_${var.cell_id}"
}

resource "google_service_account" "tenant" {
  account_id   = local.tenant_account_id
  display_name = "Verax Control - cliente ${var.slug} (célula ${var.cell_id})"
  description  = "Identidade do cliente ${var.slug} na AWS (o papel de leitura dele confia no ID único desta conta). Só a VM da célula emite o token, e só o cp-worker a desativa."

  # A suspensão desativa a conta pela API (o cp-worker, `cpTenantSaToggle`), fora do Terraform: um `apply` seguinte (uma
  # conta GCP nova do cliente, por exemplo) não pode reativá-la.
  lifecycle {
    ignore_changes = [disabled]
  }
}

resource "google_service_account_iam_member" "cell_id_token" {
  service_account_id = google_service_account.tenant.name
  role               = "roles/iam.serviceAccountOpenIdTokenCreator"
  member             = local.cell_member
}

resource "google_service_account_iam_member" "worker_toggle" {
  service_account_id = google_service_account.tenant.name
  role               = local.toggle_role
  member             = local.worker_member
}

# --- Cofre do primeiro acesso -----------------------------------------------------------------------------------------

resource "google_secret_manager_secret" "admin_bootstrap" {
  secret_id = "${local.tenant_account_id}-admin-bootstrap"
  labels    = { purpose = "admin_bootstrap" }
  annotations = {
    description = "Senha temporária do primeiro admin do cliente ${var.slug} na célula ${var.cell_id}, gravada pela VM."
  }

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

# A VM grava e não lê de volta.
resource "google_secret_manager_secret_iam_member" "cell_admin_bootstrap" {
  secret_id = google_secret_manager_secret.admin_bootstrap.id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = local.cell_member
}

# O cp-worker lê a senha uma vez, na revelação, e destrói a versão logo depois (CP-05).
resource "google_secret_manager_secret_iam_member" "worker_admin_bootstrap" {
  for_each = toset(["roles/secretmanager.secretAccessor", "roles/secretmanager.secretVersionManager"])

  secret_id = google_secret_manager_secret.admin_bootstrap.id
  role      = each.key
  member    = local.worker_member
}

# --- Tópicos da GCP do cliente ----------------------------------------------------------------------------------------

resource "google_pubsub_topic" "gcp_source" {
  #checkov:skip=CKV_GCP_83:Cifrado pelo Google (AES-256). As mensagens são cópias de logs que já estão no Cloud Logging do cliente com a mesma proteção.
  for_each = var.gcp_sources

  name = "vxc-${var.cell_id}-gcp-${each.key}"

  # Se a célula ficar parada, as mensagens esperam até 7 dias.
  message_retention_duration = "604800s"

  # Os logs de auditoria do cliente ficam só na região da célula.
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
}

resource "google_pubsub_subscription" "gcp_source" {
  for_each = google_pubsub_topic.gcp_source

  name  = each.value.name
  topic = each.value.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  expiration_policy {
    ttl = ""
  }
}

# Só a identidade do sink do cliente publica, e só no tópico da conta dela.
resource "google_pubsub_topic_iam_member" "sink_publisher" {
  for_each = var.gcp_sources

  topic  = google_pubsub_topic.gcp_source[each.key].id
  role   = "roles/pubsub.publisher"
  member = each.value.writer_identity
}

# Só a VM da célula lê.
resource "google_pubsub_subscription_iam_member" "cell_subscriber" {
  for_each = google_pubsub_subscription.gcp_source

  subscription = each.value.id
  role         = "roles/pubsub.subscriber"
  member       = local.cell_member
}
