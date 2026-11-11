# O console do responsável (admin.tf): o cp-admin com login próprio e invocação anônima (o rewrite do Hosting exige),
# o site do Hosting com o domínio admin.veraxsistemas.com.br e o rewrite para ele, a conta própria com o Firestore e a
# leitura só dos dois segredos do console (não montados), e, com os serviços no ar, `run.invoker` só no cp-worker (as
# operações do responsável), as variáveis que o app confere (ADMIN_SECRETS_PROJECT_ID, OWNER_PRINCIPALS e WORKER_URL;
# no worker, ADMIN_SA_EMAIL), a implantação pelo workflow e os alertas. Sem `admin_enabled`, nada disso existe.
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
      length(google_cloud_run_v2_service_iam_member.admin_invoker) == 0 &&
      length(google_firebase_hosting_site.admin) == 0 &&
      length(google_firebase_hosting_version.admin) == 0 &&
      length(google_firebase_hosting_release.admin) == 0 &&
      length(google_firebase_hosting_custom_domain.admin) == 0 &&
      length(google_logging_metric.admin_auth_failed) == 0 &&
      length(google_monitoring_alert_policy.admin_auth_failed) == 0 &&
      !contains(keys(google_monitoring_alert_policy.log), "pricing_margin_alert") &&
      !contains(keys(google_monitoring_alert_policy.log), "admin_account_locked") &&
      length([for key, member in google_secret_manager_secret_iam_member.readers : key if endswith(key, "/admin")]) == 0 &&
      !contains(keys(google_service_account_iam_member.deployer_acts_as), "admin") &&
      length(google_cloud_run_v2_service_iam_member.admin_worker_invoker) == 0
    )
    error_message = "Sem admin_enabled, nem o serviço, nem a conta, nem o site do Hosting, nem a leitura dos segredos do console, nem os alertas, nem o run.invoker dele no cp-worker."
  }

  assert {
    condition     = !contains([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name], "ADMIN_SA_EMAIL")
    error_message = "Sem o console, o cp-worker não recebe ADMIN_SA_EMAIL: nenhuma conta de console é aceita nas rotas do responsável."
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
      !contains([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name], "ADMIN_SECRETS_PROJECT_ID") &&
      !contains([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.name], "ADMIN_SECRETS_PROJECT_ID")
    )
    error_message = "Nenhum STRIPE_PRICE_LOOKUP_* nos serviços (os preços vêm da tabela publicada), e o ADMIN_SECRETS_PROJECT_ID é só do cp-admin."
  }
}

run "console_com_login_proprio" {
  variables {
    admin_enabled    = true
    owner_principals = ["user:responsavel@example.com", "user:socia@example.com"]
    alert_email      = "alertas@example.com"
  }

  assert {
    condition = (
      google_cloud_run_v2_service.admin[0].name == "cp-admin" &&
      google_cloud_run_v2_service.admin[0].location == "southamerica-east1" &&
      google_cloud_run_v2_service.admin[0].ingress == "INGRESS_TRAFFIC_ALL" &&
      google_cloud_run_v2_service.admin[0].deletion_protection &&
      google_cloud_run_v2_service.admin[0].template[0].service_account == "cp-admin@projeto-exemplo.iam.gserviceaccount.com" &&
      google_cloud_run_v2_service.admin[0].template[0].scaling[0].min_instance_count == 0 &&
      google_cloud_run_v2_service.admin[0].template[0].scaling[0].max_instance_count == 1 &&
      google_cloud_run_v2_service.admin[0].template[0].timeout == "300s" &&
      google_cloud_run_v2_service.admin[0].template[0].containers[0].resources[0].cpu_idle &&
      google_cloud_run_v2_service.admin[0].template[0].containers[0].resources[0].limits["memory"] == "512Mi"
    )
    error_message = "cp-admin: entrada por qualquer caminho (o Hosting chama a URL run.app), a conta própria, 0 a 1 instância e CPU só na requisição."
  }

  assert {
    condition = (
      google_cloud_run_v2_service.admin[0].template[0].containers[0].startup_probe[0].http_get[0].path == "/health" &&
      google_cloud_run_v2_service.admin[0].template[0].containers[0].startup_probe[0].failure_threshold == 12
    )
    error_message = "Sonda de partida em /health (responde sem sessão), como nos outros serviços."
  }

  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "ROLE"]) == "admin" &&
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "NODE_ENV"]) == "production" &&
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "ADMIN_SECRETS_PROJECT_ID"]) == "projeto-exemplo" &&
      !contains([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.name], "IAP_AUDIENCE") &&
      !contains([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.name], "TRUSTED_PROXIES") &&
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "OWNER_PRINCIPALS"]) == "responsavel@example.com,socia@example.com" &&
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "FIRESTORE_DATABASE"]) == "(default)" &&
      one([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.value if env.name == "WORKER_URL"]) == "https://cp-worker-123456789012.southamerica-east1.run.app"
    )
    error_message = "ROLE=admin, produção, o projeto dos segredos do console, os e-mails dos responsáveis e a URL do cp-worker (a audiência do token do console); nada do IAP, e TRUSTED_PROXIES só quando o responsável a define."
  }

  assert {
    condition = (
      alltrue([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : length(env.value_source) == 0]) &&
      length([
        for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.name
        if can(regex("^(STRIPE_|SITE_|TASKS_|WORKER_SA_|SCHEDULER_|PUBLIC_SA_|ADMIN_SA_|SMTP_|MAIL_|COOKIE_|CLOUDFLARE_|NODES_|PROVISIONING_)", env.name))
      ]) == 0
    )
    error_message = "O cp-admin não monta segredo nenhum (os dois dele são lidos pela API; nem a chave da Stripe) e não recebe as variáveis do site, das filas, das contas que o worker aceita, do e-mail nem do provisionamento (só WORKER_URL, a audiência)."
  }

  assert {
    condition = (
      keys(google_project_iam_member.admin) == ["roles/datastore.user"] &&
      google_project_iam_member.admin["roles/datastore.user"].member == "serviceAccount:cp-admin@projeto-exemplo.iam.gserviceaccount.com" &&
      sort([
        for key, member in google_secret_manager_secret_iam_member.readers : key
        if member.member == "serviceAccount:cp-admin@projeto-exemplo.iam.gserviceaccount.com"
      ]) == tolist(["cp-admin-setup-token/admin", "cp-admin-totp-key/admin"]) &&
      alltrue([for key, member in google_secret_manager_secret_iam_member.readers : member.role == "roles/secretmanager.secretAccessor" if endswith(key, "/admin")]) &&
      !contains([for member in google_service_account_iam_member.invoker_token_users : member.member], "serviceAccount:cp-admin@projeto-exemplo.iam.gserviceaccount.com")
    )
    error_message = "A conta cp-admin lê e grava o Firestore e lê só os dois segredos do console (no segredo, nunca no projeto); nenhum actAs na cp-invoker (o console não enfileira nada)."
  }

  # Sem os serviços (services_enabled = false), o cp-worker não existe, e nem o run.invoker do console nele.
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.admin_worker_invoker) == 0
    error_message = "Sem o cp-worker, nenhuma permissão do console nele."
  }

  assert {
    condition = (
      google_cloud_run_v2_service_iam_member.admin_invoker[0].name == "cp-admin" &&
      google_cloud_run_v2_service_iam_member.admin_invoker[0].role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.admin_invoker[0].member == "allUsers" &&
      google_cloud_run_v2_service_iam_member.admin_deployer[0].member != "allUsers"
    )
    error_message = "O cp-admin aceita invocação anônima, como o cp-public (o rewrite do Hosting exige); a barreira é o login do app."
  }

  assert {
    condition = (
      google_firebase_hosting_site.admin[0].site_id == "verax-admin" &&
      google_firebase_hosting_version.admin[0].config[0].rewrites[0].glob == "/**" &&
      google_firebase_hosting_version.admin[0].config[0].rewrites[0].run[0].service_id == "cp-admin" &&
      google_firebase_hosting_version.admin[0].config[0].rewrites[0].run[0].region == "southamerica-east1" &&
      google_firebase_hosting_release.admin[0].site_id == "verax-admin" &&
      google_firebase_hosting_custom_domain.admin[0].custom_domain == "admin.veraxsistemas.com.br" &&
      google_firebase_hosting_custom_domain.admin[0].wait_dns_verification == false &&
      google_firebase_hosting_site.conta.site_id == "verax-conta"
    )
    error_message = "O site verax-admin reescreve tudo para o cp-admin, com o domínio admin.veraxsistemas.com.br sem esperar o DNS; o site conta continua o mesmo."
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
      google_monitoring_alert_policy.log["admin_account_locked"].conditions[0].condition_matched_log[0].filter == "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"cp-admin\" AND jsonPayload.event=\"admin_account_locked\"" &&
      length(google_monitoring_alert_policy.log["admin_account_locked"].notification_channels) == 1
    )
    error_message = "Alerta por linha quando o login de um e-mail é bloqueado no console."
  }

  assert {
    condition = (
      google_logging_metric.admin_auth_failed[0].filter == "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"cp-admin\" AND jsonPayload.event=\"admin_auth_failed\"" &&
      google_logging_metric.admin_auth_failed[0].label_extractors["reason"] == "EXTRACT(jsonPayload.reason)" &&
      google_monitoring_alert_policy.admin_auth_failed[0].conditions[0].condition_threshold[0].filter == "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/cp_admin_auth_failed\"" &&
      google_monitoring_alert_policy.admin_auth_failed[0].conditions[0].condition_threshold[0].threshold_value == 4 &&
      google_monitoring_alert_policy.admin_auth_failed[0].conditions[0].condition_threshold[0].comparison == "COMPARISON_GT" &&
      google_monitoring_alert_policy.admin_auth_failed[0].conditions[0].condition_threshold[0].aggregations[0].alignment_period == "600s" &&
      length(google_monitoring_alert_policy.admin_auth_failed[0].notification_channels) == 1
    )
    error_message = "Tentativas recusadas repetidas no console (5 ou mais em 10 minutos) abrem um incidente."
  }

  assert {
    condition = (
      output.github_environment.CP_ADMIN_SERVICE == "cp-admin" &&
      output.admin.url == "https://admin.veraxsistemas.com.br" &&
      output.admin.site_id == "verax-admin" &&
      output.service_accounts.admin == "cp-admin@projeto-exemplo.iam.gserviceaccount.com"
    )
    error_message = "O workflow recebe o cp-admin para implantar, e o endereço do console sai numa saída."
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

# Com os serviços no ar: o console invoca o cp-worker com a própria conta (só `run.invoker`, só no cp-worker), e o
# worker recebe o e-mail dela para aceitá-la só nas operações do responsável.
run "console_chama_o_worker_com_a_propria_conta" {
  variables {
    services_enabled = true
    admin_enabled    = true
    owner_principals = ["user:responsavel@example.com"]
  }

  assert {
    condition = (
      google_cloud_run_v2_service_iam_member.admin_worker_invoker[0].name == "cp-worker" &&
      google_cloud_run_v2_service_iam_member.admin_worker_invoker[0].location == "southamerica-east1" &&
      google_cloud_run_v2_service_iam_member.admin_worker_invoker[0].role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.admin_worker_invoker[0].member == "serviceAccount:cp-admin@projeto-exemplo.iam.gserviceaccount.com"
    )
    error_message = "O cp-admin é run.invoker do cp-worker, com a conta própria."
  }

  assert {
    condition = (
      !contains([for member in google_cloud_run_v2_service_iam_member.public_invoker : member.member], "serviceAccount:cp-admin@projeto-exemplo.iam.gserviceaccount.com") &&
      !contains([for member in google_cloud_run_v2_service_iam_member.worker_invokers : member.member], "serviceAccount:cp-admin@projeto-exemplo.iam.gserviceaccount.com") &&
      !contains([for member in google_cloud_run_v2_job_iam_member.worker_runner : member.member], "serviceAccount:cp-admin@projeto-exemplo.iam.gserviceaccount.com") &&
      !contains([for member in google_project_iam_member.admin : member.role], "roles/run.invoker") &&
      sort(keys(google_cloud_run_v2_service_iam_member.worker_invokers)) == tolist(["invoker", "public", "user:responsavel@example.com"])
    )
    error_message = "Só no cp-worker: nem no cp-public, nem no Job, nem no projeto; os outros invocadores do worker não mudam."
  }

  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.worker[0].template[0].containers[0].env : env.value if env.name == "ADMIN_SA_EMAIL"]) == "cp-admin@projeto-exemplo.iam.gserviceaccount.com" &&
      !contains([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.name], "ADMIN_SA_EMAIL") &&
      !contains([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.name], "ADMIN_SA_EMAIL")
    )
    error_message = "ADMIN_SA_EMAIL só no cp-worker, com a conta do console."
  }
}

# A conta do console no worker é derivada: o responsável não a escolhe por variável.
run "admin_sa_email_nao_vem_de_variavel" {
  command = plan

  variables {
    services_enabled = true
    worker_env = {
      ADMIN_SA_EMAIL = "outra@projeto-exemplo.iam.gserviceaccount.com"
    }
  }

  expect_failures = [var.worker_env]
}

# As saídas do Hosting que o responsável lista em service_env (TRUSTED_PROXIES, para o cp-public) não chegam ao console:
# confiar na CDN deixaria quem tem um serviço nela forjar o X-Forwarded-For no run.app e escapar do limite do login.
run "console_nao_recebe_os_proxies_confiaveis" {
  command = plan

  variables {
    services_enabled = true
    admin_enabled    = true
    owner_principals = ["user:responsavel@example.com"]
    service_env = {
      TRUSTED_PROXIES         = "203.0.113.0/24"
      TRUST_PROXY_HOPS        = "1"
      STRIPE_PORTAL_LOGIN_URL = "https://billing.stripe.com/p/login/test_demo"
    }
  }

  assert {
    condition = (
      !contains([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.name], "TRUSTED_PROXIES") &&
      !contains([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.name], "TRUST_PROXY_HOPS") &&
      !contains([for env in google_cloud_run_v2_service.admin[0].template[0].containers[0].env : env.name], "STRIPE_PORTAL_LOGIN_URL") &&
      one([for env in google_cloud_run_v2_service.public[0].template[0].containers[0].env : env.value if env.name == "TRUSTED_PROXIES"]) == "203.0.113.0/24"
    )
    error_message = "service_env (inclusive TRUSTED_PROXIES e TRUST_PROXY_HOPS) vai para o cp-public, nunca para o cp-admin."
  }
}

# O projeto dos segredos do console é derivado: o responsável não o escolhe por variável.
run "projeto_dos_segredos_do_console_nao_vem_de_variavel" {
  command = plan

  variables {
    service_env = {
      ADMIN_SECRETS_PROJECT_ID = "outro-projeto"
    }
  }

  expect_failures = [var.service_env]
}
