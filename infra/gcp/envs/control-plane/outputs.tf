output "github_environment" {
  description = "Variáveis do environment `control-plane` do GitHub (Settings → Environments → control-plane → Environment variables), para o workflow de implantação do plano de controle (CP-01). Nenhuma é segredo."
  value = merge({
    GCP_WIF_PROVIDER     = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOYER_SA      = google_service_account.deployer.email
    GCP_PROJECT_ID       = var.project_id
    GCP_PROJECT_NUMBER   = data.google_project.this.number
    GCP_REGION           = var.region
    CP_IMAGES_REPOSITORY = "${google_artifact_registry_repository.control_plane.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.control_plane.repository_id}"
    CP_PUBLIC_SERVICE    = "cp-public"
    CP_WORKER_SERVICE    = "cp-worker"
    CP_TERRAFORM_JOB     = "cp-terraform"
    },
    # Só com admin_enabled: sem ela no environment, o workflow não implanta o console do responsável.
    var.admin_enabled ? { CP_ADMIN_SERVICE = local.admin_service_name } : {},
  )
}

output "cloudflare_dns_records" {
  description = "Registros que o Firebase pede para o domínio do plano de controle. Crie cada um no Cloudflare com o proxy DESLIGADO (\"DNS only\"). Lista vazia: o domínio já está verificado, ou o Firebase ainda não respondeu (rode `terraform refresh` e `terraform output` de novo)."
  value = flatten([
    for update in google_firebase_hosting_custom_domain.conta.required_dns_updates : [
      for desired in update.desired : [
        for record in desired.records : {
          name   = record.domain_name
          type   = record.type
          value  = record.rdata
          action = record.required_action
        }
      ]
    ]
  ])
}

output "service_accounts" {
  description = "As contas do plano de controle. A `invoker` é a do token das tasks e do Scheduler (WORKER_SA_EMAIL e SCHEDULER_SA_EMAIL): só chama o cp-worker. A `admin` (console do responsável) é nula sem admin_enabled."
  value = {
    public    = google_service_account.public.email
    worker    = google_service_account.worker.email
    terraform = google_service_account.terraform.email
    invoker   = google_service_account.invoker.email
    deployer  = google_service_account.deployer.email
    admin     = one(google_service_account.admin[*].email)
  }
}

output "admin" {
  description = "O console do responsável: o endereço (abre no navegador, com o login do Google pelo IAP) e o `aud` que o app confere no JWT do IAP (IAP_AUDIENCE). Nulo sem admin_enabled."
  value = var.admin_enabled ? {
    url          = google_cloud_run_v2_service.admin[0].uri
    iap_audience = local.admin_iap_audience
  } : null
}

output "secrets" {
  description = "Segredos a preencher com o gcloud (GUIA, plano de controle, passo 4), todos vazios depois do apply."
  value       = sort(keys(google_secret_manager_secret.cp))
}

output "worker_url" {
  description = "URL do cp-worker (WORKER_URL, o `aud` do token): a que o Cloud Tasks, o Scheduler e o responsável chamam."
  value       = local.worker_url
}

output "public_url" {
  description = "URL direta do cp-public no Cloud Run (o endereço de uso é o domínio do Hosting). Nula até services_enabled."
  value       = var.services_enabled ? google_cloud_run_v2_service.public[0].uri : null
}

output "hosting" {
  description = "Site do Firebase Hosting do plano de controle: o endereço padrão e o domínio próprio."
  value = {
    site_id     = google_firebase_hosting_site.conta.site_id
    default_url = google_firebase_hosting_site.conta.default_url
    domain      = var.hosting_domain
  }
}

output "firestore_database" {
  description = "Banco do Firestore (FIRESTORE_DATABASE) e a região dele."
  value = {
    name     = google_firestore_database.default.name
    location = google_firestore_database.default.location_id
  }
}

output "images_repository" {
  description = "Registro das imagens do plano de controle (o prefixo das imagens que o workflow publica)."
  value       = "${google_artifact_registry_repository.control_plane.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.control_plane.repository_id}"
}
