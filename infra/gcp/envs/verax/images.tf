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
    # Tags mutáveis, para a limpeza abaixo poder apagar. Com tags imutáveis, o Artifact Registry não apaga nenhuma
    # versão com tag ("If a repository has immutable tags enabled, tagged artifacts can't be deleted", documentação
    # das políticas de limpeza), e o workflow `Imagens do nó` põe a tag do commit em toda imagem: a política DELETE
    # nunca apagava nada, e o registro guardava todas as versões (o nível gratuito é 0,5 GB). A tag mutável não muda
    # o risco: o nó instala sempre pelo digest conferido contra a atestação de origem (infra/node/bin/deploy.sh),
    # nunca pela tag, que só serve para achar o digest do commit. É a mesma decisão do registro do plano de controle.
    # Mudar este valor é uma atualização no lugar do registro, não uma recriação: no provider google 8.9.0, nenhum
    # campo de `docker_config` tem `ForceNew`, e a mudança vai no `updateMask` como `dockerConfig`.
    immutable_tags = false
  }

  # Guarda a versão no ar e as 3 versões mais recentes de cada imagem (para voltar, com `deploy.sh <commit anterior>`)
  # e apaga o resto depois de 30 dias, para o registro não crescer sem limite. Uma versão que casa com uma política
  # KEEP e com a DELETE fica. Três bastam: o nó não volta mais do que isso, porque as migrations do banco rodam a cada
  # partida e só andam para a frente, e uma versão apagada não se republica (o environment `imagens` só aceita a
  # `main`): para voltar mais longe, o caminho é reverter o commit na `main`, que publica uma imagem nova e atestada.
  #
  # A versão no ar fica sempre, por mais antiga que seja: o workflow `Imagens do nó` publica a cada push na `main`,
  # sem esperar o deploy, então as 3 mais recentes podem não incluir a que o nó roda. Se ela sumisse, a partida
  # seguinte do nó (`start.sh up` faz `compose pull` antes de subir) pararia. O `deploy.sh` marca as imagens
  # instaladas com a tag `no-<vm>`, que sai da versão anterior, e a política `manter-no-ar` guarda toda versão com
  # tag `no-` (as tags dos commits são hexadecimais e nunca começam assim).
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "manter-no-ar"
    action = "KEEP"
    condition {
      tag_state    = "TAGGED"
      tag_prefixes = ["no-"]
    }
  }
  cleanup_policies {
    id     = "manter-recentes"
    action = "KEEP"
    most_recent_versions {
      keep_count = 3
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
  member             = "principal://iam.googleapis.com/projects/${data.google_project.node.number}/locations/global/workloadIdentityPools/${var.github_wif_pool}/subject/repo:${var.github_oidc_repository}:environment:imagens"
}

# A VM do nó só baixa.
resource "google_artifact_registry_repository_iam_member" "node_reader" {
  location   = google_artifact_registry_repository.node.location
  repository = google_artifact_registry_repository.node.name
  role       = "roles/artifactregistry.reader"
  member     = local.node_member
}
