# A chave de release e a única identidade que assina com ela.
#
# Algoritmo: ECDSA P-256 com SHA-256 (`EC_SIGN_P256_SHA256`), em software. Motivos:
# - o nó confere com `openssl dgst -sha256 -verify`, que existe em qualquer Linux, sem nada a instalar
#   (infra/node/bin/verify-release.sh), e a assinatura é a DER padrão, que o openssl, o cosign e o Node leem;
# - o workflow manda ao KMS só o SHA-256 do manifesto (o `digest` do asymmetricSign), e não o arquivo;
# - é o algoritmo que o Cloud KMS marca como recomendado e o único dos dois que existe também em HSM: se um cliente
#   exigir HSM, a troca é uma chave nova com o mesmo algoritmo, e o verificador e o formato não mudam. O Ed25519 só
#   existe em software (é o da chave das licenças, SH-03, porque lá quem confere é o Node, em JWS EdDSA).
# Software basta nesta escala (a mesma conclusão da proposta do modo próprio, decisão 13): a privada nunca sai do KMS
# em nenhum dos dois níveis. O Cloud KMS não faz rotação automática de chave assimétrica; a troca é manual e planejada
# (docs/runbooks/versao-no.md).

resource "google_kms_key_ring" "release" {
  name     = "verax-release"
  location = var.region

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "node_manifest" {
  #checkov:skip=CKV_GCP_43:Chave assimétrica de assinatura. O Cloud KMS não faz rotação automática de chave assimétrica ("does not support automatic rotation of asymmetric keys"); a troca é uma versão nova com a pública fixada no pacote do nó, feita à mão (docs/runbooks/versao-no.md).
  name     = "node-manifest"
  key_ring = google_kms_key_ring.release.id
  purpose  = "ASYMMETRIC_SIGN"

  version_template {
    algorithm        = "EC_SIGN_P256_SHA256"
    protection_level = "SOFTWARE"
  }

  # Os nós confiam nesta chave: apagá-la por engano obriga a publicar um pacote com outra chave antes de qualquer
  # atualização. O chaveiro nunca se apaga (é assim no Cloud KMS).
  lifecycle {
    prevent_destroy = true
  }
}

# A conta que o workflow usa. Só assina (`useToSign`): não confere, não lê a pública, não administra a chave. O workflow
# confere a assinatura com a pública fixada no repositório, e quem administra é o dono do projeto.
resource "google_service_account" "signer" {
  account_id   = "verax-release-signer"
  display_name = "Assinatura das versões do nó (GitHub Actions, environment release)"

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key_iam_member" "signer" {
  crypto_key_id = google_kms_crypto_key.node_manifest.id
  role          = "roles/cloudkms.signer"
  member        = "serviceAccount:${google_service_account.signer.email}"
}

# Federação de identidade só para este workflow: um pool próprio, com a condição inteira no Terraform (o pool das
# imagens e do Painel foi criado fora dele). O token do GitHub só entra se vier:
#   1. do environment de assinatura deste repositório (o subject imutável, com os IDs do dono e do repositório);
#   2 e 3. da branch main (não de uma tag com esse nome);
#   4. de um disparo manual (a promoção de uma versão é sempre uma decisão);
#   5. do arquivo do workflow de assinatura, na main: outro workflow que use o mesmo environment não assina;
#   6. de um executor do GitHub (não de um auto-hospedado).
locals {
  github_subject      = "repo:${var.github_oidc_repository}:environment:${var.github_environment}"
  github_workflow_ref = "${var.github_repository}/.github/workflows/${var.github_workflow}@refs/heads/main"

  github_attribute_condition = join(" && ", [
    "assertion.sub == \"${local.github_subject}\"",
    "assertion.ref == \"refs/heads/main\"",
    "assertion.ref_type == \"branch\"",
    "assertion.event_name == \"workflow_dispatch\"",
    "assertion.workflow_ref == \"${local.github_workflow_ref}\"",
    "assertion.runner_environment == \"github-hosted\"",
  ])
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "verax-release-github"
  # No máximo 32 caracteres (limite da API).
  display_name = "GitHub Actions (release)"
  description  = "Tokens OIDC do workflow Versão do nó, no environment de assinatura."

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  #checkov:skip=CKV_GCP_125:O checkov trata todo subject com `environment` como abusável, mas o environment só é configurado por administradores do repositório e exige aprovação, e a condição ainda exige o subject imutável (IDs do dono e do repositório), a branch main, o disparo manual, o arquivo do workflow e um executor do GitHub.
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  # Quem disparou, o ref e o workflow aparecem nos logs de auditoria de cada token.
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.ref"           = "assertion.ref"
    "attribute.event_name"    = "assertion.event_name"
    "attribute.workflow_ref"  = "assertion.workflow_ref"
    "attribute.actor"         = "assertion.actor"
  }

  attribute_condition = local.github_attribute_condition

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "signer_wif" {
  service_account_id = google_service_account.signer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/${local.github_subject}"
}

# A pública da versão em uso, para o arquivo de infra/node/keys. Só lê; para no `apply` se a versão não estiver
# habilitada ou não for P-256 (por exemplo, um release_key_version que aponta para uma versão desativada).
data "google_kms_crypto_key_version" "node_manifest" {
  crypto_key = google_kms_crypto_key.node_manifest.id
  version    = var.release_key_version

  lifecycle {
    postcondition {
      condition     = self.state == "ENABLED" && self.algorithm == "EC_SIGN_P256_SHA256" && length(self.public_key) == 1
      error_message = "A versão release_key_version da chave não está habilitada ou não é EC P-256."
    }
  }
}
