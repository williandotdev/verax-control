# Caminho dos logs de segurança até o nó: em cada projeto monitorado, o Cloud Logging copia (sink) só os eventos
# de segurança para um tópico do Pub/Sub do projeto do nó, e o nó lê a assinatura. Os logs originais continuam
# onde estão; nenhum sink, bucket de log ou retenção que já existe é alterado.

locals {
  # Auditoria (quem fez o quê) e bloqueios do Cloud Armor. As leituras que o próprio nó faz no Pub/Sub ficam de
  # fora, para não virar um laço de logs sobre a leitura dos logs.
  security_log_filter = <<-EOT
    (
      log_id("cloudaudit.googleapis.com/activity") OR
      log_id("cloudaudit.googleapis.com/system_event") OR
      log_id("cloudaudit.googleapis.com/policy") OR
      log_id("cloudaudit.googleapis.com/data_access") OR
      (resource.type="http_load_balancer" AND jsonPayload.enforcedSecurityPolicy.outcome="DENY")
    )
    AND NOT (
      protoPayload.serviceName="pubsub.googleapis.com" AND
      protoPayload.authenticationInfo.principalEmail="${google_service_account.node.email}"
    )
  EOT
}

# Um tópico e uma assinatura por projeto monitorado: no painel, cada projeto é uma conta cloud com a própria
# assinatura, e é ela que diz de qual cliente é cada evento (uma origem de log pertence a um só cliente).
resource "google_pubsub_topic" "security_logs" {
  #checkov:skip=CKV_GCP_83:Cifrado pelo Google (AES-256). As mensagens são cópias de logs que já estão no Cloud Logging com a mesma proteção.
  for_each = toset(var.monitored_projects)

  name = "${var.name_prefix}-security-${each.key}"

  # Se o nó ficar parado, as mensagens esperam até 7 dias.
  message_retention_duration = "604800s"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription" "security_logs" {
  for_each = google_pubsub_topic.security_logs

  name  = each.value.name
  topic = each.value.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  # A assinatura nunca expira por falta de uso.
  expiration_policy {
    ttl = ""
  }
}

resource "google_logging_project_sink" "security" {
  for_each = toset(var.monitored_projects)

  project     = each.key
  name        = "${var.name_prefix}-security"
  description = "Eventos de segurança para o nó do Verax Control (só cópia; os logs originais não mudam)."
  destination = "pubsub.googleapis.com/${google_pubsub_topic.security_logs[each.key].id}"
  filter      = local.security_log_filter

  unique_writer_identity = true
}

# Cada sink escreve só no tópico do próprio projeto, com uma identidade própria criada pela GCP.
resource "google_pubsub_topic_iam_member" "sink_publisher" {
  for_each = google_logging_project_sink.security

  topic  = google_pubsub_topic.security_logs[each.key].id
  role   = "roles/pubsub.publisher"
  member = each.value.writer_identity
}

# O nó só lê as assinaturas; não publica nem mexe nos tópicos.
resource "google_pubsub_subscription_iam_member" "node_subscriber" {
  for_each = google_pubsub_subscription.security_logs

  subscription = each.value.id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.node.email}"
}
