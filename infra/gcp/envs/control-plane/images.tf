# Imagens do plano de controle (serviços cp-public/cp-worker, a mesma imagem, e o executor Terraform cp-terraform):
# registro próprio, neste projeto e nesta região. O registro do nó (`verax-control`, envs/verax) fica em outro projeto
# e em outra região: um registro aqui evita a leitura entre projetos e o tráfego entre regiões a cada instância nova,
# e o custo é o mesmo (cerca de R$ 0,20 por mês pelas 3 versões guardadas de cada imagem, plano, seção 6). O GitHub
# Actions publica sem chave, pela federação de identidade (identities.tf).

resource "google_artifact_registry_repository" "control_plane" {
  #checkov:skip=CKV_GCP_84:Cifrado pelo Google (AES-256). As imagens são públicas no código-fonte (repositório aberto) e não carregam segredo.
  location      = var.region
  repository_id = "verax-control-plane"
  description   = "Imagens do plano de controle do Verax Control (cp-public, cp-worker e cp-terraform)."
  format        = "DOCKER"

  docker_config {
    # Tags mutáveis, de propósito. Com tags imutáveis, a política de limpeza não apaga artefato com tag (documentação
    # das políticas de limpeza do Artifact Registry), e como o workflow publica cada versão com a tag do commit, a
    # política "apagar-antigas" abaixo não apagaria nada: o registro guardaria todas as versões, contra a estimativa
    # de custo. A imutabilidade acrescentaria pouco: os serviços rodam sempre pelo digest (run.tf; o workflow implanta
    # o digest que acabou de publicar, não a tag), e quem pode mover uma tag (`artifactregistry.writer`) já pode
    # implantar qualquer imagem (`run.developer`, identities.tf). O teste em tests/servicos.tftest.hcl prende isto.
    immutable_tags = false
  }

  # Guarda as 3 versões mais recentes de cada imagem (a que está no ar e duas para voltar; é a conta da estimativa de
  # custo) e apaga o resto depois de 30 dias, com tag e tudo, para o registro não crescer sem limite. Uma versão
  # apagada se recria a partir do commit (o workflow publica por SHA).
  cleanup_policy_dry_run = false
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

# Quem publica: só o job do environment `control-plane` (identities.tf). Quem baixa é o agente de serviço do Cloud Run
# do projeto, que já lê os registros do próprio projeto; as contas de execução dos serviços não baixam imagem e não
# ganham leitura aqui.
resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  location   = google_artifact_registry_repository.control_plane.location
  repository = google_artifact_registry_repository.control_plane.name
  role       = "roles/artifactregistry.writer"
  member     = local.deployer_member
}
