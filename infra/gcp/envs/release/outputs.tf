output "github_environment" {
  description = "Variáveis do environment de assinatura no GitHub (docs/runbooks/versao-no.md): o provedor da federação, a conta e a versão da chave."
  value = {
    GCP_RELEASE_WIF_PROVIDER = google_iam_workload_identity_pool_provider.github.name
    GCP_RELEASE_SA           = google_service_account.signer.email
    RELEASE_KMS_KEY_VERSION  = "${google_kms_crypto_key.node_manifest.id}/cryptoKeyVersions/${var.release_key_version}"
  }
}

output "release_public_key_file" {
  description = "Onde a pública desta versão da chave entra no repositório (por PR, antes da primeira versão assinada)."
  value       = "infra/node/keys/release-${google_kms_crypto_key.node_manifest.name}-v${var.release_key_version}.pem"
}

output "release_public_key_pem" {
  description = "A pública desta versão da chave (PEM), o conteúdo de release_public_key_file."
  value       = data.google_kms_crypto_key_version.node_manifest.public_key[0].pem
}
