# Alerta de fila parada: se o nó deixar de ler uma assinatura de logs (VM parada, worker com erro, permissão
# retirada), a mensagem mais antiga envelhece. As mensagens ficam 7 dias na assinatura; o alerta chega bem antes, com
# tempo de arrumar sem perder log.

resource "google_monitoring_notification_channel" "email" {
  count = var.stalled_subscription_alert && var.alert_email != "" ? 1 : 0

  display_name = "${var.name_prefix}: alertas do nó"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

resource "google_monitoring_alert_policy" "stalled_subscription" {
  count = var.stalled_subscription_alert ? 1 : 0

  display_name          = "${var.name_prefix}: fila de logs parada"
  combiner              = "OR"
  notification_channels = google_monitoring_notification_channel.email[*].id

  conditions {
    display_name = "Mensagem sem leitura há mais de ${var.stalled_subscription_hours} h"
    condition_threshold {
      # Só as assinaturas dos logs de segurança deste nó.
      filter          = "resource.type = \"pubsub_subscription\" AND metric.type = \"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" AND resource.labels.subscription_id = starts_with(\"${var.name_prefix}-security-\")"
      comparison      = "COMPARISON_GT"
      threshold_value = var.stalled_subscription_hours * 3600
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "O nó `${var.name_prefix}` não lê uma assinatura de logs de segurança há mais de ${var.stalled_subscription_hours} h. As mensagens ficam 7 dias na assinatura: depois disso, o log some. Confira se a VM está ligada, o serviço `verax-node` (`sudo systemctl status verax-node`) e o log do worker (`sudo docker logs verax-worker-1`)."
  }
}
