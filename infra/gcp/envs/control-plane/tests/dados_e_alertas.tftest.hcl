# O Firestore (banco, regras, prazos e índices da seção 3 do plano), os logs de auditoria do Secret Manager, os
# alertas por log, o orçamento e as APIs.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }

  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos.
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/projeto-exemplo/serviceAccounts/cp-conta@projeto-exemplo.iam.gserviceaccount.com"
      email = "cp-conta@projeto-exemplo.iam.gserviceaccount.com"
    }
  }
}

mock_provider "google-beta" {
  mock_resource "google_project_service_identity" {
    defaults = {
      email  = "service-123456789012@gcp-sa-exemplo.iam.gserviceaccount.com"
      member = "serviceAccount:service-123456789012@gcp-sa-exemplo.iam.gserviceaccount.com"
    }
  }
}

variables {
  project_id = "projeto-exemplo"
}

run "firestore" {
  command = plan

  assert {
    condition = (
      google_firestore_database.default.name == "(default)" &&
      google_firestore_database.default.location_id == "southamerica-east1" &&
      google_firestore_database.default.type == "FIRESTORE_NATIVE" &&
      google_firestore_database.default.delete_protection_state == "DELETE_PROTECTION_ENABLED" &&
      google_firestore_database.default.deletion_policy == "ABANDON"
    )
    error_message = "O banco (default), nativo, em São Paulo, protegido contra exclusão."
  }

  assert {
    condition     = google_firestore_database.default.point_in_time_recovery_enablement == "POINT_IN_TIME_RECOVERY_DISABLED"
    error_message = "O PITR fica desligado por padrão: é cobrado à parte, sem nível gratuito."
  }

  assert {
    condition = (
      keys(google_firestore_field.ttl) == ["auditLog", "provisioningRuns", "quotes", "rateLimits", "slugs", "statusTokens", "steps", "stripeEvents"] &&
      alltrue([for field in google_firestore_field.ttl : field.field == "expiresAt" && length(field.ttl_config) == 1 && field.database == "(default)"])
    )
    error_message = "Prazo (TTL) em expiresAt nas coleções com retenção do plano, e só nelas."
  }

  assert {
    condition = (
      keys(google_firestore_index.tenants) == ["state-crypto-destroy", "state-delete", "state-grace", "state-updated"] &&
      alltrue([for index in google_firestore_index.tenants : index.collection == "tenants" && index.query_scope == "COLLECTION" && index.fields[0].field_path == "state" && index.fields[0].order == "ASCENDING" && index.fields[1].order == "ASCENDING"]) &&
      google_firestore_index.tenants["state-grace"].fields[1].field_path == "billing.graceUntil" &&
      google_firestore_index.tenants["state-delete"].fields[1].field_path == "lifecycle.deleteAfter" &&
      google_firestore_index.tenants["state-crypto-destroy"].fields[1].field_path == "lifecycle.cryptoDestroyAfter" &&
      google_firestore_index.tenants["state-updated"].fields[1].field_path == "stateUpdatedAt"
    )
    error_message = "Os quatro índices compostos de tenants (estado e uma data), e só eles."
  }

  assert {
    condition = (
      strcontains(google_firebaserules_ruleset.firestore_deny_all.source[0].files[0].content, "allow read, write: if false;") &&
      strcontains(google_firebaserules_ruleset.firestore_deny_all.source[0].files[0].content, "match /{document=**}") &&
      google_firebaserules_release.firestore.name == "cloud.firestore" &&
      startswith(google_firebaserules_release.firestore.ruleset_name, "projects/projeto-exemplo/rulesets/")
    )
    error_message = "As regras do Firestore negam tudo aos SDKs de cliente, e a release do (default) é a cloud.firestore."
  }
}

run "auditoria_do_secret_manager" {
  command = plan

  assert {
    condition = (
      google_project_iam_audit_config.secretmanager.service == "secretmanager.googleapis.com" &&
      google_project_iam_audit_config.secretmanager.project == "projeto-exemplo" &&
      toset([for config in google_project_iam_audit_config.secretmanager.audit_log_config : config.log_type]) == toset(["ADMIN_READ", "DATA_READ", "DATA_WRITE"]) &&
      alltrue([for config in google_project_iam_audit_config.secretmanager.audit_log_config : config.exempted_members == null || length(config.exempted_members) == 0])
    )
    error_message = "Quem lê, grava e consulta a política dos segredos do projeto fica nos logs de auditoria, sem exceção."
  }
}

run "pitr_so_por_escolha" {
  command = plan

  variables {
    firestore_pitr = true
  }

  assert {
    condition     = google_firestore_database.default.point_in_time_recovery_enablement == "POINT_IN_TIME_RECOVERY_ENABLED"
    error_message = "Com firestore_pitr = true, o PITR liga."
  }
}

run "alertas_sem_email" {
  command = plan

  assert {
    condition     = length(google_monitoring_notification_channel.email) == 0 && length(google_monitoring_alert_policy.log) == 5
    error_message = "Sem e-mail, os cinco alertas existem e ficam só no console."
  }

  assert {
    condition     = length(google_billing_budget.project) == 0
    error_message = "Sem conta de faturamento, não há orçamento."
  }
}

run "alertas_com_email_e_orcamento" {
  variables {
    alert_email        = "alertas@example.com"
    billing_account_id = "000000-000000-000000"
  }

  assert {
    condition = (
      length(google_monitoring_notification_channel.email) == 1 &&
      google_monitoring_notification_channel.email[0].labels["email_address"] == "alertas@example.com" &&
      alltrue([for policy in google_monitoring_alert_policy.log : length(policy.notification_channels) == 1])
    )
    error_message = "Com e-mail, os cinco alertas avisam por ele."
  }

  assert {
    condition = (
      google_monitoring_alert_policy.log["webhook_attention"].conditions[0].condition_matched_log[0].filter == "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"cp-public\" AND jsonPayload.event=\"stripe_webhook_attention\"" &&
      google_monitoring_alert_policy.log["webhook_attention"].conditions[0].condition_matched_log[0].label_extractors == tomap({ reason = "EXTRACT(jsonPayload.reason)", tenant = "EXTRACT(jsonPayload.tenantId)", type = "EXTRACT(jsonPayload.eventType)" }) &&
      google_monitoring_alert_policy.log["webhook_failed"].conditions[0].condition_matched_log[0].filter == "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"cp-public\" AND jsonPayload.event=\"stripe_webhook_failed\"" &&
      google_monitoring_alert_policy.log["webhook_failed"].conditions[0].condition_matched_log[0].label_extractors == tomap({ type = "EXTRACT(jsonPayload.eventType)", event_id = "EXTRACT(jsonPayload.eventId)" })
    )
    error_message = "Os alertas do webhook (CP-04): decisão humana (motivo, cliente e tipo do evento) e falha de processamento (tipo e id do evento), os dois no cp-public."
  }

  assert {
    condition = (
      google_monitoring_alert_policy.log["provisioning_failed"].conditions[0].condition_matched_log[0].filter == "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"cp-worker\" AND jsonPayload.event=\"provisioning_failed\"" &&
      google_monitoring_alert_policy.log["webhook_signature_failed"].conditions[0].condition_matched_log[0].filter == "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"cp-public\" AND jsonPayload.event=\"stripe_webhook_signature_failed\"" &&
      google_monitoring_alert_policy.log["checkout_daily_limit"].conditions[0].condition_matched_log[0].filter == "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"cp-public\" AND jsonPayload.event=\"checkout_daily_limit_reached\"" &&
      google_monitoring_alert_policy.log["checkout_daily_limit"].conditions[0].condition_matched_log[0].label_extractors == tomap({ day = "EXTRACT(jsonPayload.day)" }) &&
      alltrue([for policy in google_monitoring_alert_policy.log : policy.alert_strategy[0].notification_rate_limit[0].period == "3600s"])
    )
    error_message = "Os filtros dos alertas leem jsonPayload.event (o contrato com o CP-03, o CP-04 e o CP-12), um aviso por hora; o do teto diário só leva o dia."
  }

  assert {
    condition = (
      google_billing_budget.project[0].amount[0].specified_amount[0].units == "15" &&
      google_billing_budget.project[0].budget_filter[0].projects == toset(["projects/123456789012"])
    )
    error_message = "O orçamento é de 15 no projeto do plano de controle."
  }
}

run "apis" {
  command = plan

  assert {
    condition = alltrue([
      for api in [
        "run.googleapis.com", "cloudtasks.googleapis.com", "cloudscheduler.googleapis.com", "firestore.googleapis.com",
        "secretmanager.googleapis.com", "artifactregistry.googleapis.com", "iamcredentials.googleapis.com",
        "sts.googleapis.com", "firebasehosting.googleapis.com", "firebase.googleapis.com", "firebaserules.googleapis.com",
        "cloudresourcemanager.googleapis.com",
      ] : contains(keys(google_project_service.apis), api)
    ])
    error_message = "As APIs do plano de controle (e as da federação, das regras do Firestore e do orçamento) ficam ligadas pelo ambiente."
  }

  assert {
    condition     = alltrue([for api in google_project_service.apis : !api.disable_on_destroy])
    error_message = "Desfazer o ambiente não desliga API nenhuma: o Firebase dos painéis depende delas."
  }
}
