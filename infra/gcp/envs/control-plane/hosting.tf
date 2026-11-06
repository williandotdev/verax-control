# Endereço público do plano de controle: o site `verax-conta` do Firebase Hosting, com o domínio próprio e o rewrite de
# tudo (`/**`) para o cp-public (plano, seção 2.1). O mapeamento de domínio do próprio Cloud Run está em prévia e não
# existe em southamerica-east1; o Hosting faz esse papel e exige o Cloud Run no mesmo projeto. O rewrite pede o plano
# Blaze no projeto (passo do responsável; o Terraform não muda o plano).
#
# Os quatro recursos existem só no provider beta na 8.9.0 (versions.tf). O site e o domínio nascem na primeira subida,
# para o DNS e o certificado começarem cedo; a versão com o rewrite e a release esperam o cp-public existir.

resource "google_firebase_hosting_site" "conta" {
  provider = google-beta

  site_id = var.hosting_site_id

  depends_on = [google_project_service.apis]
}

resource "google_firebase_hosting_version" "conta" {
  provider = google-beta
  count    = var.services_enabled ? 1 : 0

  site_id = google_firebase_hosting_site.conta.site_id

  config {
    rewrites {
      glob = "/**"
      run {
        service_id = google_cloud_run_v2_service.public[0].name
        region     = var.region
      }
    }
  }
}

resource "google_firebase_hosting_release" "conta" {
  provider = google-beta
  count    = var.services_enabled ? 1 : 0

  site_id      = google_firebase_hosting_site.conta.site_id
  version_name = google_firebase_hosting_version.conta[0].name
  message      = "Rewrite /** para o Cloud Run cp-public (Terraform)."
}

# O domínio próprio. O `apply` não espera o DNS: os registros que o Firebase pede (propriedade e endereço) saem em
# `terraform output cloudflare_dns_records`, e o certificado é emitido depois que eles existem no Cloudflare, sem proxy.
resource "google_firebase_hosting_custom_domain" "conta" {
  provider = google-beta

  site_id               = google_firebase_hosting_site.conta.site_id
  custom_domain         = var.hosting_domain
  wait_dns_verification = false
}
