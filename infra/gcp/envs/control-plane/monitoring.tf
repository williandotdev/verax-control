# Alertas por log (plano, 4b e CP-12): o Cloud Logging guarda o JSON do pino em `jsonPayload`, e cada alerta abre um
# incidente quando aparece uma linha com o campo `event` combinado abaixo. Sem métrica intermediária: a condição lê o
# log direto, e o custo é zero.
#
# Contrato com o app (o CP-04 emite, o CP-12 reaproveita; os nomes têm de ser estes):
#   - cp-worker, `logger.error({ event: "provisioning_failed", tenantId, step, code })`: um passo esgotou as
#     tentativas ou falhou sem repetição (`provisioning_disabled`, `ready_timeout`, `node_error:<código>`);
#   - cp-public, `logger.warn({ event: "stripe_webhook_signature_failed", requestId })`: `constructEvent` recusou a
#     assinatura. Nunca o corpo nem os cabeçalhos;
#   - cp-public (CP-03), `warn({ event: "checkout_daily_limit_reached", limit, day, requestId })`: o teto global de
#     sessões do Checkout do dia (UTC) foi atingido e a sessão foi recusada. Sem dado do pedido nem o IP;
#   - cp-public (CP-04), `warn({ event: "stripe_webhook_attention", reason, eventId, eventType, tenantId })`: um evento
#     da Stripe pede decisão humana (`reason`: `fraud_review`, `orphan_payment`, `subscription_items_changed`,
#     `refund_outside_guarantee`, `reservation_missing`, `tax_id_rejected`...; a lista está em
#     stripe-event-processor.ts);
#   - cp-public (CP-04), `error({ event: "stripe_webhook_failed", eventId, eventType, attempt, failure })`: o
#     processamento de um evento falhou e a Stripe vai repetir a entrega (500). Uma falha isolada se resolve sozinha;
#     a mesma por horas é configuração (chave, fila) ou a Stripe fora.
#   - cp-admin (console do responsável, só com `admin_enabled`), `warn({ event: "pricing_margin_alert",
#     priceTableVersion, costModelVersion })`: um modelo de custos publicado deixou a tabela de preços vigente abaixo da
#     margem mínima em alguma configuração (a publicação do modelo não é bloqueada; a tabela não muda sozinha);
#   - cp-admin, `warn({ event: "admin_auth_failed", reason })`: o JWT do IAP faltou, não confere ou é de quem não é
#     responsável. Atrás do IAP isso não acontece no uso normal; o alerta é por repetição (abaixo), não por linha.
# O `tenantId`, o `requestId`, o `day`, o `reason`, as versões e o tipo e o id do evento viram rótulos do incidente;
# nada mais do log entra no e-mail (e os logs nunca têm e-mail, CNPJ ou razão social).

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
    checkout_daily_limit = {
      service      = "cp-public"
      event        = "checkout_daily_limit_reached"
      display_name = "Plano de controle: teto diário de sessões do Checkout atingido"
      labels       = { day = "EXTRACT(jsonPayload.day)" }
      runbook      = "O cp-public recusou uma sessão do Checkout (429 `checkout_daily_limit`) porque o teto global do dia (50 sessões, dia UTC) foi atingido: o disjuntor contra criação em massa. Compras novas voltam sozinhas à meia-noite UTC. Confira nos logs de requisição do cp-public (status 201 e 429 em `/v1/public/checkout`) se é um robô (poucos IPs, slugs em série) ou venda de verdade; reservas de robô vencem sozinhas em 2 h 30."
    }
    webhook_attention = {
      service      = "cp-public"
      event        = "stripe_webhook_attention"
      display_name = "Plano de controle: evento da Stripe pede decisão"
      labels       = { reason = "EXTRACT(jsonPayload.reason)", tenant = "EXTRACT(jsonPayload.tenantId)", type = "EXTRACT(jsonPayload.eventType)" }
      runbook      = "Um evento da Stripe precisa de decisão humana (rótulo `reason`). `fraud_review`: contestação ou alerta de fraude; o cliente ficou `suspended` e um pagamento não o reativa; decida no Dashboard (aceitar, reembolsar ou contestar) e retome pela operação do responsável. `orphan_payment`: pagamento de um Customer que o plano de controle não conhece; confira no Dashboard. `subscription_items_changed`: troca de preço ou quantidade na assinatura; ajuste o plano à mão (item de suporte). `refund_outside_guarantee`: reembolso parcial ou depois dos 7 dias; nada foi cancelado. `reservation_missing`: sessão paga sem a reserva (vencida ou tomada); crie o cliente à mão com os dados do Dashboard. `tax_id_rejected`: a Stripe recusou o CNPJ como `br_cnpj`; grave-o no Customer pelo Dashboard."
    }
    webhook_failed = {
      service      = "cp-public"
      event        = "stripe_webhook_failed"
      display_name = "Plano de controle: falha ao processar evento da Stripe"
      labels       = { type = "EXTRACT(jsonPayload.eventType)", event_id = "EXTRACT(jsonPayload.eventId)" }
      runbook      = "O cp-public respondeu 500 a um evento da Stripe, que repete a entrega por até 3 dias (o processamento é idempotente). Veja `failure` na linha do log: erro da Stripe (chave restrita sem permissão, Stripe fora), `StepQueueUnavailableError` (variáveis `TASKS_*` ou permissão na fila) ou outro. Resolvida a causa, a próxima repetição aplica; o Workbench da Stripe mostra as entregas e permite reenviar."
    }
  }
}

locals {
  # Os alertas do console só existem com ele (admin.tf).
  admin_log_alerts = {
    pricing_margin_alert = {
      service      = "cp-admin"
      event        = "pricing_margin_alert"
      display_name = "Plano de controle: a tabela de preços vigente ficou abaixo da margem mínima"
      labels       = { price_table = "EXTRACT(jsonPayload.priceTableVersion)", cost_model = "EXTRACT(jsonPayload.costModelVersion)" }
      runbook      = "Um modelo de custos novo foi publicado e, com ele, alguma configuração da tabela de preços vigente (rótulo `price_table`) ficou com margem de contribuição abaixo da mínima do modelo (rótulo `cost_model`). Ninguém é cobrado diferente: a tabela não muda sozinha. Abra o console (Tabelas de preço, a vigente, Novo rascunho a partir desta versão), confira o relatório da checagem e publique uma tabela ajustada, ou corrija o modelo de custos num rascunho novo. Passo a passo em docs/runbooks/console-do-responsavel.md."
    }
  }
}

resource "google_monitoring_alert_policy" "log" {
  for_each = merge(local.log_alerts, var.admin_enabled ? local.admin_log_alerts : {})

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

# Acessos recusados repetidos no console (`admin_auth_failed` no cp-admin). Atrás do IAP, uma recusa no app quer dizer
# que algo passou pelo IAP sem um JWT válido de responsável: o IAP desligado ou contornado, o `IAP_AUDIENCE` errado
# depois de uma mudança, as chaves do Google fora do ar, ou alguém com acesso ao IAP que não está em
# OWNER_PRINCIPALS. Uma linha solta pode ser um soluço na leitura das chaves; três ou mais em 10 minutos abrem o
# incidente. Por isso esta é a exceção à regra do arquivo: uma métrica de log (contador, com o motivo como rótulo),
# porque a condição por linha de log não conta repetições. São poucos pontos por mês, dentro da cota gratuita do
# Cloud Monitoring.
resource "google_logging_metric" "admin_auth_failed" {
  count = var.admin_enabled ? 1 : 0

  name        = "cp_admin_auth_failed"
  description = "Acessos recusados pelo console do responsável (cp-admin): JWT do IAP ausente, inválido ou de quem não é responsável."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"cp-admin\" AND jsonPayload.event=\"admin_auth_failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "reason"
      value_type  = "STRING"
      description = "O motivo da recusa (missing, invalid, not_owner, keys_unavailable...)."
    }
  }

  label_extractors = {
    reason = "EXTRACT(jsonPayload.reason)"
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "admin_auth_failed" {
  count = var.admin_enabled ? 1 : 0

  display_name          = "Plano de controle: acessos recusados repetidos no console do responsável"
  combiner              = "OR"
  notification_channels = google_monitoring_notification_channel.email[*].id

  conditions {
    display_name = "admin_auth_failed no cp-admin: 3 ou mais em 10 minutos"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.admin_auth_failed[0].name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2
      duration        = "0s"

      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "604800s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = "O console do responsável (cp-admin) recusou 3 ou mais requisições em 10 minutos (rótulo `reason` da métrica cp_admin_auth_failed). Atrás do IAP isso não acontece no uso normal. Confira, nesta ordem: o IAP continua ligado no cp-admin (`iap_enabled` no Terraform; no console da GCP, Cloud Run, cp-admin, Segurança); o `IAP_AUDIENCE` do serviço bate com `terraform output admin`; quem tem `roles/iap.httpsResourceAccessor` no cp-admin está em `owner_principals`; `keys_unavailable` repetido é a leitura das chaves públicas do IAP falhando. Nenhum dado do console sai sem o JWT de um responsável. Passo a passo em docs/runbooks/console-do-responsavel.md."
  }

  depends_on = [google_project_service.apis]
}
