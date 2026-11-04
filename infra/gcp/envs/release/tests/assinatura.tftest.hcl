# A chave de release do nó e quem assina com ela: o algoritmo que o verificador do nó espera (ECDSA P-256 com SHA-256,
# o `openssl dgst -sha256 -verify` de infra/node/bin/verify-release.sh), a chave protegida contra exclusão, a conta do
# workflow só com `cloudkms.signer` na chave (nada no projeto, nada de conferir ou administrar), e o token do GitHub
# aceito só do environment de assinatura, na main, num disparo manual, do arquivo do workflow e num executor do GitHub.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada.

mock_provider "google" {
  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos.
  mock_resource "google_iam_workload_identity_pool" {
    defaults = {
      name = "projects/123456789012/locations/global/workloadIdentityPools/verax-release-github"
    }
  }

  mock_resource "google_iam_workload_identity_pool_provider" {
    defaults = {
      name = "projects/123456789012/locations/global/workloadIdentityPools/verax-release-github/providers/github"
    }
  }

  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/projeto-exemplo/serviceAccounts/verax-release-signer@projeto-exemplo.iam.gserviceaccount.com"
      email = "verax-release-signer@projeto-exemplo.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_kms_key_ring" {
    defaults = {
      id = "projects/projeto-exemplo/locations/us-east1/keyRings/verax-release"
    }
  }

  mock_resource "google_kms_crypto_key" {
    defaults = {
      id = "projects/projeto-exemplo/locations/us-east1/keyRings/verax-release/cryptoKeys/node-manifest"
    }
  }

  mock_data "google_kms_crypto_key_version" {
    defaults = {
      state     = "ENABLED"
      algorithm = "EC_SIGN_P256_SHA256"
      public_key = [{
        algorithm = "EC_SIGN_P256_SHA256"
        pem       = "-----BEGIN PUBLIC KEY-----\nchave-publica-de-exemplo\n-----END PUBLIC KEY-----\n"
      }]
    }
  }
}

variables {
  project_id = "projeto-exemplo"
}

run "chave_que_o_no_confere" {
  command = plan

  assert {
    condition = (
      google_kms_crypto_key.node_manifest.purpose == "ASYMMETRIC_SIGN" &&
      length(google_kms_crypto_key.node_manifest.version_template) == 1 &&
      google_kms_crypto_key.node_manifest.version_template[0].algorithm == "EC_SIGN_P256_SHA256" &&
      google_kms_crypto_key.node_manifest.version_template[0].protection_level == "SOFTWARE"
    )
    error_message = "A chave de release assina em ECDSA P-256 com SHA-256 (o que o verify-release.sh confere com o openssl), em software."
  }

  # Chave assimétrica não tem rotação automática no Cloud KMS: um período aqui falharia no `apply`.
  assert {
    condition     = google_kms_crypto_key.node_manifest.rotation_period == null
    error_message = "Chave assimétrica sem rotation_period (a troca é manual, com a pública no pacote)."
  }

  assert {
    condition     = google_kms_key_ring.release.location == "us-east1" && google_kms_key_ring.release.name == "verax-release" && google_kms_crypto_key.node_manifest.name == "node-manifest"
    error_message = "Chaveiro e chave com os nomes e o local do roteiro (o arquivo da pública leva o nome da chave)."
  }

  # O `prevent_destroy` não aparece no plano; o texto do arquivo é o que conta.
  assert {
    condition     = can(regex("lifecycle \\{\\s*prevent_destroy = true\\s*\\}", file("${path.module}/release.tf")))
    error_message = "A chave de release fica protegida contra exclusão (prevent_destroy)."
  }
}

run "so_o_workflow_assina_e_so_assina" {
  assert {
    condition = (
      google_kms_crypto_key_iam_member.signer.role == "roles/cloudkms.signer" &&
      google_kms_crypto_key_iam_member.signer.member == "serviceAccount:verax-release-signer@projeto-exemplo.iam.gserviceaccount.com" &&
      google_kms_crypto_key_iam_member.signer.crypto_key_id == "projects/projeto-exemplo/locations/us-east1/keyRings/verax-release/cryptoKeys/node-manifest"
    )
    error_message = "A conta do workflow tem só cloudkms.signer (useToSign), e só nesta chave."
  }

  # Nenhum papel no projeto e nenhuma outra concessão na chave, em nenhum arquivo do ambiente.
  assert {
    condition = (
      alltrue([for f in fileset(path.module, "*.tf") : !can(regex("resource \"google_project_iam_", file("${path.module}/${f}")))]) &&
      length(flatten([for f in fileset(path.module, "*.tf") : regexall("resource \"google_kms_(key_ring|crypto_key)_iam_", file("${path.module}/${f}"))])) == 1
    )
    error_message = "A chave de release tem uma concessão só (a do workflow) e o ambiente não concede papel no projeto."
  }

  assert {
    condition = (
      google_service_account_iam_member.signer_wif.role == "roles/iam.workloadIdentityUser" &&
      google_service_account_iam_member.signer_wif.member == "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/verax-release-github/subject/repo:williandotdev@92734416/verax-control@1441377752:environment:release"
    )
    error_message = "Só o subject imutável do environment release vira a conta de assinatura."
  }
}

run "token_aceito_so_do_workflow_de_assinatura" {
  assert {
    condition = google_iam_workload_identity_pool_provider.github.attribute_condition == join(" && ", [
      "assertion.sub == \"repo:williandotdev@92734416/verax-control@1441377752:environment:release\"",
      "assertion.ref == \"refs/heads/main\"",
      "assertion.ref_type == \"branch\"",
      "assertion.event_name == \"workflow_dispatch\"",
      "assertion.workflow_ref == \"williandotdev/verax-control/.github/workflows/versao-no.yml@refs/heads/main\"",
      "assertion.runner_environment == \"github-hosted\"",
    ])
    error_message = "A condição do provedor mudou: environment, main, disparo manual, arquivo do workflow e executor do GitHub."
  }

  assert {
    condition = (
      google_iam_workload_identity_pool_provider.github.attribute_mapping["google.subject"] == "assertion.sub" &&
      google_iam_workload_identity_pool_provider.github.oidc[0].issuer_uri == "https://token.actions.githubusercontent.com"
    )
    error_message = "O provedor aceita só tokens do GitHub Actions, com o sub como subject."
  }

  # O workflow que o provedor aceita é o arquivo que existe no repositório, com o environment da condição.
  assert {
    condition     = can(regex("(?m)^    environment: release$", file("${path.module}/../../../../.github/workflows/versao-no.yml")))
    error_message = "O workflow versao-no.yml não usa mais o environment release que a condição exige."
  }
}

run "saidas_para_o_github_e_para_o_pacote" {
  assert {
    condition = output.github_environment == {
      GCP_RELEASE_WIF_PROVIDER = "projects/123456789012/locations/global/workloadIdentityPools/verax-release-github/providers/github"
      GCP_RELEASE_SA           = "verax-release-signer@projeto-exemplo.iam.gserviceaccount.com"
      RELEASE_KMS_KEY_VERSION  = "projects/projeto-exemplo/locations/us-east1/keyRings/verax-release/cryptoKeys/node-manifest/cryptoKeyVersions/1"
    }
    error_message = "As variáveis do environment release são os nomes que o workflow lê."
  }

  # O nome do arquivo casa com o que o verify-release.sh procura (release-*.pem).
  assert {
    condition     = output.release_public_key_file == "infra/node/keys/release-node-manifest-v1.pem" && startswith(output.release_public_key_pem, "-----BEGIN PUBLIC KEY-----")
    error_message = "A pública sai em PEM, com o caminho que o verificador do nó lê."
  }
}

run "versao_da_chave_desativada_para_o_apply" {
  command = plan

  variables {
    release_key_version = 2
  }

  override_data {
    target = data.google_kms_crypto_key_version.node_manifest
    values = {
      state      = "DISABLED"
      algorithm  = "EC_SIGN_P256_SHA256"
      public_key = []
    }
  }

  expect_failures = [data.google_kms_crypto_key_version.node_manifest]
}

run "environment_de_outro_workflow_nao_assina" {
  command = plan

  variables {
    github_environment = "imagens"
  }

  expect_failures = [var.github_environment]
}
