# Imagens do plano de controle (serviços cp-public/cp-worker, a mesma imagem, e o executor Terraform cp-terraform):
# registro próprio, neste projeto e nesta região. O registro do nó (`verax-control`, envs/verax) fica em outro projeto
# e em outra região: um registro aqui evita a leitura entre projetos e o tráfego entre regiões a cada instância nova,
# e o custo é o mesmo (cerca de R$ 0,20 por mês pelas versões guardadas, plano, seção 6). O GitHub Actions publica
# sem chave, pela federação de identidade (identities.tf).

resource "google_artifact_registry_repository" "control_plane" {
  #checkov:skip=CKV_GCP_84:Cifrado pelo Google (AES-256). As imagens são públicas no código-fonte (repositório aberto) e não carregam segredo.
  location      = var.region
  repository_id = "verax-control-plane"
  description   = "Imagens do plano de controle do Verax Control (cp-public, cp-worker e cp-terraform)."
  format        = "DOCKER"

  docker_config {
    # Uma versão publicada nunca é sobrescrita: os serviços rodam sempre pelo digest.
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

# Quem publica: só o job do environment `control-plane` (identities.tf). Quem baixa é o agente de serviço do Cloud Run
# do projeto, que já lê os registros do próprio projeto; as contas de execução dos serviços não baixam imagem e não
# ganham leitura aqui.
resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  location   = google_artifact_registry_repository.control_plane.location
  repository = google_artifact_registry_repository.control_plane.name
  role       = "roles/artifactregistry.writer"
  member     = local.deployer_member
}
