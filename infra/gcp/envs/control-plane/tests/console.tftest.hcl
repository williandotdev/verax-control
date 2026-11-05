# O console do responsável (admin.tf): o cp-admin com o IAP direto no Cloud Run, só o agente do IAP como invocador,
# só os responsáveis passando pelo IAP, a conta própria só com o Firestore e sem segredo, as variáveis que o app
# confere (IAP_AUDIENCE e OWNER_PRINCIPALS), a implantação pelo workflow e os dois alertas. Sem `admin_enabled`, nada
# disso existe.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
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

override_resource {
  target = google_project_service_identity.iap
  values = {
    email  = "service-123456789012@gcp-sa-iap.iam.gserviceaccount.com"
    member = "serviceAccount:service-123456789012@gcp-sa-iap.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.admin
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-admin@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-admin@projeto-exemplo.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.public
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-public@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-public@projeto-exemplo.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.worker
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-worker@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-worker@projeto-exemplo.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.terraform
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-terraform@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-terraform@projeto-exemplo.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.invoker
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-invoker@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-invoker@projeto-exemplo.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.deployer
  values = {
    name  = "projects/projeto-exemplo/serviceAccounts/cp-deployer@projeto-exemplo.iam.gserviceaccount.com"
    email = "cp-deployer@projeto-exemplo.iam.gserviceaccount.com"
  }
}

variables {
  project_id = "projeto-exemplo"
}

run "sem_console_por_padrao" {
  variables {
    services_enabled = true
    owner_principals = ["user:responsavel@example.com"]
  }

  assert {
    condition = (
      length(google_cloud_run_v2_service.admin) == 0 &&
      length(google_service_account.admin) == 0 &&
      length(google_project_iam_member.admin) == 0 &&
      length(google_project_service.iap) == 0 &&
      length(google_project_service_identity.iap) == 0 &&
      length(google_iap_web_cloud_run_service_iam_member.owners) == 0 &&
      length(google_logging_metric.admin_auth_failed) == 0 &&
      length(google_monitoring_alert_policy.admin_auth_failed) == 0 &&
      !contains(keys(google_monitoring_alert_policy.log), "pricing_margin_alert") &&
      !contains(keys(google_service_account_iam_member.deployer_acts_as), "admin")
    )
    error_message = "Sem admin_enabled, nem o serviço, nem a conta, nem o IAP, nem os alertas do console."
  }

  assert {
    condition     = !contains(keys(output.github_environment), "CP_ADMIN_SERVICE") && output.admin == null && output.service_accounts.admin == null
    error_message = "Sem o console, o workflow não recebe o serviço para implantar."
  }

  # Os preços saíram das variáveis (tabela de preços no Firestore): nenhum STRIPE_PRICE_LOOKUP_* nos serviços.
  assert {
    condition = (
      length([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name if startswith(env.name, "STRIPE_PRICE_LOOKUP")]) == 0 &&
      length([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name if startswith(env.name, "STRIPE_PRICE_LOOKUP")]) == 0 &&
      !contains([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name], "IAP_AUDIENCE")
    )
    error_message = "Nenhum STRIPE_PRICE_LOOKUP_* nos serviços (os preços vêm da tabela publicada), e o IAP_AUDIENCE é só do cp-admin."
  }
}

run "console_atras_do_iap" {
  variables {
    admin_enabled    = true
    owner_principals = ["user:responsavel@example.com", "user:socia@example.com"]
    alert_email      = "alertas@example.com"
  }

  assert {
    condition = (
      google_cloud_run_v2_service.admin[0].name == "cp-admin" &&
      google_cloud_run_v2_service.admin[0].location == "southamerica-east1" &&
      google_cloud_run_v2_service.admin[0].iap_enabled &&
      google_cloud_run_v2_service.admin[0].ingress == "INGRESS_TRAFFIC_ALL" &&
      google_cloud_run_v2_service.admin[0].deletion_protection &&
      google_cloud_run_v2_service.admin[0].template[0].service_account == "cp-admin@projeto-exemplo.iam.gserviceaccount.com" &&
      google_cloud_run_v2_service.admin[0].template[0].scaling[0].min_instance_count == 0 &&
      google_cloud_run_v2_service.admin[0].template[0].scaling[0].max_instance_count == 1 &&
      google_cloud_run_v2_service.admin[0].template[0].timeout == "300s" &&
      google_cloud_run_v2_service.admin[0].template[0].containers[0].resources[0].cpu_idle &&
      google_cloud_run_v2_service.admin[0].template[0].containers[0].resources[0].limits["memory"] == "512Mi"
    )
    error_message = "cp-admin: IAP ligado no próprio serviço, entrada por qualquer caminho (o IAP cobre todos), a conta própria, 0 a 1 instância e CPU só na requisição."
  }

  assert {
    condition = (
      google_cloud_run_v2_service.admin[0].template[0].containers[0].startup_probe[0].http_get[0].path == "/health" &&
      google_cloud_run_v2_service.admin[0].template[0].containers[0].startup_probe[0].failure_threshold == 12
    )
    error_message = "Sonda de partida em /health (a única rota sem o JWT do IAP), como nos outros serviços."
  }

  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "ROLE"]) == "admin" &&
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "NODE_ENV"]) == "production" &&
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "IAP_AUDIENCE"]) == "/projects/123456789012/locations/southamerica-east1/services/cp-admin" &&
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "OWNER_PRINCIPALS"]) == "responsavel@example.com,socia@example.com" &&
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "FIRESTORE_DATABASE"]) == "(default)"
    )
    error_message = "ROLE=admin, produção, o aud do IAP no formato do Cloud Run (/projects/<número>/locations/<região>/services/cp-admin) e os e-mails dos responsáveis."
  }

  assert {
    condition = (
      alltrue([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : length(env.value_source) == 0]) &&
      length([
        for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.name
        if can(regex("^(STRIPE_|SITE_|TASKS_|WORKER_|SMTP_|MAIL_|COOKIE_|CLOUDFLARE_|NODES_|PROVISIONING_)", env.name))
      ]) == 0
    )
    error_message = "O cp-admin não monta segredo nenhum (nem a chave da Stripe) e não recebe as variáveis do site, das filas, do e-mail nem do provisionamento."
  }

  assert {
    condition = (
      keys(google_project_iam_member.admin) == ["roles/datastore.user"] &&
      google_project_iam_member.admin["roles/datastore.user"].member == "serviceAccount:cp-admin@projeto-exemplo.iam.gserviceaccount.com" &&
      !contains([for member in google_secret_manager_secret_iam_member.readers : member.member], "serviceAccount:cp-admin@projeto-exemplo.iam.gserviceaccount.com") &&
      !contains([for member in google_service_account_iam_member.invoker_token_users : member.member], "serviceAccount:cp-admin@projeto-exemplo.iam.gserviceaccount.com")
    )
    error_message = "A conta cp-admin só lê e grava o Firestore: nenhum segredo e nenhum token para chamar o cp-worker."
  }

  assert {
    condition = (
      google_project_service.iap[0].service == "iap.googleapis.com" &&
      !google_project_service.iap[0].disable_on_destroy &&
      google_project_service_identity.iap[0].service == "iap.googleapis.com" &&
      google_cloud_run_v2_service_iam_member.admin_iap_invoker[0].name == "cp-admin" &&
      google_cloud_run_v2_service_iam_member.admin_iap_invoker[0].role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.admin_iap_invoker[0].member == "serviceAccount:service-123456789012@gcp-sa-iap.iam.gserviceaccount.com"
    )
    error_message = "O agente de serviço do IAP existe e é o invocador do cp-admin."
  }

  assert {
    condition = alltrue([
      for member in [google_cloud_run_v2_service_iam_member.admin_iap_invoker[0], google_cloud_run_v2_service_iam_member.admin_deployer[0]] :
      member.member != "allUsers" && member.member != "allAuthenticatedUsers"
    ])
    error_message = "Ninguém anônimo chama o cp-admin (nada de allUsers)."
  }

  assert {
    condition = (
      sort(keys(google_iap_web_cloud_run_service_iam_member.owners)) == tolist(["user:responsavel@example.com", "user:socia@example.com"]) &&
      alltrue([
        for member in google_iap_web_cloud_run_service_iam_member.owners :
        member.role == "roles/iap.httpsResourceAccessor" && member.cloud_run_service_name == "cp-admin" && member.location == "southamerica-east1" && member.project == "projeto-exemplo"
      ])
    )
    error_message = "Só os responsáveis passam pelo IAP do cp-admin, no próprio serviço."
  }

  assert {
    condition = (
      google_service_account_iam_member.deployer_acts_as["admin"].service_account_id == "projects/projeto-exemplo/serviceAccounts/cp-admin@projeto-exemplo.iam.gserviceaccount.com" &&
      google_cloud_run_v2_service_iam_member.admin_deployer[0].role == "roles/run.developer" &&
      google_cloud_run_v2_service_iam_member.admin_deployer[0].member == "serviceAccount:cp-deployer@projeto-exemplo.iam.gserviceaccount.com"
    )
    error_message = "Quem implanta publica revisões do cp-admin e age como a conta dele."
  }

  assert {
    condition = (
      google_monitoring_alert_policy.log["pricing_margin_alert"].conditions[0].condition_matched_log[0].filter == "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"cp-admin\" AND jsonPayload.event=\"pricing_margin_alert\"" &&
      google_monitoring_alert_policy.log["pricing_margin_alert"].conditions[0].condition_matched_log[0].label_extractors == tomap({ price_table = "EXTRACT(jsonPayload.priceTableVersion)", cost_model = "EXTRACT(jsonPayload.costModelVersion)" }) &&
      length(google_monitoring_alert_policy.log["pricing_margin_alert"].notification_channels) == 1
    )
    error_message = "Alerta por log quando um modelo de custos novo deixa a tabela vigente abaixo da margem mínima."
  }

  assert {
    condition = (
      google_logging_metric.admin_auth_failed[0].filter == "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"cp-admin\" AND jsonPayload.event=\"admin_auth_failed\"" &&
      google_logging_metric.admin_auth_failed[0].label_extractors["reason"] == "EXTRACT(jsonPayload.reason)" &&
      google_monitoring_alert_policy.admin_auth_failed[0].conditions[0].condition_threshold[0].filter == "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/cp_admin_auth_failed\"" &&
      google_monitoring_alert_policy.admin_auth_failed[0].conditions[0].condition_threshold[0].threshold_value == 2 &&
      google_monitoring_alert_policy.admin_auth_failed[0].conditions[0].condition_threshold[0].comparison == "COMPARISON_GT" &&
      google_monitoring_alert_policy.admin_auth_failed[0].conditions[0].condition_threshold[0].aggregations[0].alignment_period == "600s" &&
      length(google_monitoring_alert_policy.admin_auth_failed[0].notification_channels) == 1
    )
    error_message = "Recusas repetidas no console (3 ou mais em 10 minutos) abrem um incidente."
  }

  assert {
    condition = (
      output.github_environment.CP_ADMIN_SERVICE == "cp-admin" &&
      output.admin.iap_audience == "/projects/123456789012/locations/southamerica-east1/services/cp-admin" &&
      output.service_accounts.admin == "cp-admin@projeto-exemplo.iam.gserviceaccount.com"
    )
    error_message = "O workflow recebe o cp-admin para implantar, e o aud do IAP sai numa saída."
  }
}

# O workflow troca a imagem do cp-admin; no plan seguinte, o Terraform não a devolve (o mesmo ignore_changes dos outros).
run "imagem_do_console_trocada_pelo_workflow_fica" {
  command = plan

  variables {
    admin_enabled    = true
    owner_principals = ["user:responsavel@example.com", "user:socia@example.com"]
    alert_email      = "alertas@example.com"
    admin_image      = "southamerica-east1-docker.pkg.dev/projeto-exemplo/verax-control-plane/control-plane@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }

  assert {
    condition     = google_cloud_run_v2_service.admin[0].template[0].containers[0].image == "us-docker.pkg.dev/cloudrun/container/hello"
    error_message = "Outra imagem na variável não entra no plano: a do cp-admin fica a que o workflow implantou."
  }
}

run "console_exige_responsavel" {
  command = plan

  variables {
    admin_enabled = true
  }

  expect_failures = [var.admin_enabled]
}
