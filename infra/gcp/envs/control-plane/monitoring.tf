# Alertas por log (plano, 4b e CP-12): o Cloud Logging guarda o JSON do pino em `jsonPayload`, e cada alerta abre um
# incidente quando aparece uma linha com o campo `event` combinado abaixo. Sem métrica intermediária: a condição lê o
# log direto, e o custo é zero.
#
# Contrato com o app (o CP-04 emite, o CP-12 reaproveita; os nomes têm de ser estes):
#   - cp-worker, `logger.error({ event: "provisioning_failed", tenantId, step, code })`: um passo esgotou as
#     tentativas ou falhou sem repetição (`provisioning_disabled`, `ready_timeout`, `node_error:<código>`);
#   - cp-public, `logger.warn({ event: "stripe_webhook_signature_failed", requestId })`: `constructEvent` recusou a
#     assinatura. Nunca o corpo nem os cabeçalhos.
# O `tenantId` e o `requestId` viram rótulos do incidente; nada mais do log entra no e-mail.

resource "google_monitoring_notification_channel" "email" {
  count = var.alert_email == "" ? 0 : 1

  display_name = "Plano de controle: alertas"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

locals {
  log_alerts = {
    provisioning_failed = {
      service      = "cp-worker"
      event        = "provisioning_failed"
      display_name = "Plano de controle: provisionamento com falha"
      labels       = { tenant = "EXTRACT(jsonPayload.tenantId)", step = "EXTRACT(jsonPayload.step)", code = "EXTRACT(jsonPayload.code)" }
      runbook      = "Um tenant ficou em `provisioning_failed`. O cliente vê \"estamos finalizando\"; resolva a causa (rótulos `step` e `code`) e retome com `POST /internal/tenants/<id>/resume` no cp-worker."
    }
    webhook_signature_failed = {
      service      = "cp-public"
      event        = "stripe_webhook_signature_failed"
      display_name = "Plano de controle: assinatura inválida no webhook da Stripe"
      labels       = { request = "EXTRACT(jsonPayload.requestId)" }
      runbook      = "O cp-public recusou um webhook por assinatura inválida. Uma ocorrência isolada é ruído da internet; várias seguidas indicam segredo trocado (rotação no Dashboard sem nova versão em `cp-stripe-webhook-secret`) ou tentativa de forjar eventos."
    }
  }
}

resource "google_monitoring_alert_policy" "log" {
  for_each = local.log_alerts

  display_name          = each.value.display_name
  combiner              = "OR"
  notification_channels = google_monitoring_notification_channel.email[*].id

  conditions {
    display_name = "Linha de log com event=${each.value.event} no ${each.value.service}"
    condition_matched_log {
      filter           = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${each.value.service}\" AND jsonPayload.event=\"${each.value.event}\""
      label_extractors = each.value.labels
    }
  }

  # Um aviso por hora no máximo, e o incidente fecha sozinho em 7 dias se não voltar a acontecer.
  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "604800s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = each.value.runbook
  }

  depends_on = [google_project_service.apis]
}
