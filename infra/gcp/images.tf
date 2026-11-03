# Imagens do nó (API e migrations): registro privado na mesma região da VM. O GitHub Actions publica sem chave, pela
# federação de identidade (o mesmo pool do Painel), e a VM baixa com a própria identidade. Nenhuma chave em lugar
# nenhum.

data "google_project" "node" {}

resource "google_artifact_registry_repository" "node" {
  #checkov:skip=CKV_GCP_84:Cifrado pelo Google (AES-256). As imagens são públicas no código-fonte (repositório aberto) e não carregam segredo.
  location      = var.region
  repository_id = "verax-control"
  description   = "Imagens do Verax Control (API e migrations) para o nó."
  format        = "DOCKER"

  docker_config {
    # Uma versão publicada nunca é sobrescrita: o nó roda sempre pelo digest.
    immutable_tags = true
  }

  # Guarda as 10 versões mais recentes e apaga o resto depois de 30 dias, para o registro não crescer sem limite.
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "manter-recentes"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }
  cleanup_policies {
    id     = "apagar-antigas"
    action = "DELETE"
    condition {
      older_than = "2592000s"
    }
  }

  depends_on = [google_project_service.apis]
}

# Quem publica: só jobs do repositório do Verax Control no environment `imagens` do GitHub (que só aceita a `main`).
resource "google_service_account" "images_publisher" {
  account_id   = "${var.name_prefix}-images"
  display_name = "Publicação das imagens do Verax Control (GitHub Actions)"
}

resource "google_artifact_registry_repository_iam_member" "publisher" {
  location   = google_artifact_registry_repository.node.location
  repository = google_artifact_registry_repository.node.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.images_publisher.email}"
}

resource "google_service_account_iam_member" "publisher_wif" {
  service_account_id = google_service_account.images_publisher.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/projects/${data.google_project.node.number}/locations/global/workloadIdentityPools/${var.github_wif_pool}/subject/repo:${var.github_repository}:environment:imagens"
}

# A VM do nó só baixa.
resource "google_artifact_registry_repository_iam_member" "node_reader" {
  location   = google_artifact_registry_repository.node.location
  repository = google_artifact_registry_repository.node.name
  role       = "roles/artifactregistry.reader"
  member     = local.node_member
}
