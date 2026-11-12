# Célula compartilhada em São Paulo, perfil standard (decisão de 10/11/2026): o nó que atende os clientes da
# Plataforma e o SOC da própria Verax, que migra para cá do nó lean de us-east1 (envs/verax). A configuração é a de um
# nó de cliente (e2-standard-2, 60 GB pd-balanced, snapshot diário, IP fixo no NAT, Pub/Sub só na região), no projeto
# do nó da Verax, onde também fica o registro das imagens. Fica ligada o tempo todo.

module "node" {
  source = "../../modules/node"

  project_id         = var.project_id
  region             = var.region
  zone               = var.zone
  name_prefix        = var.name_prefix
  node_profile       = "standard"
  machine_type       = var.machine_type
  disk_gb            = var.disk_gb
  subnet_cidr        = var.subnet_cidr
  monitored_projects = var.monitored_projects
  customer_projects  = var.customer_projects
  operators          = var.operators

  alert_email                = var.alert_email
  stalled_subscription_hours = var.stalled_subscription_hours

  # Backups de 85 dias (e não 90): o último backup com um cliente expurgado (D+1) sai até cerca de D+95, dentro da
  # promessa dos 100 dias (cell.tf e docs/ARQUITETURA.md, "Exclusão e a promessa dos 100 dias na célula").
  backup_retention_days = var.backup_retention_days

  # O cofre da chave secreta do Turnstile (desafio no login do painel).
  turnstile_secret = true

  # Agentes do Wazuh nas instâncias de teste (desligados por padrão): o ensaio da liberação por faixa e do registro.
  wazuh_agents         = var.wazuh_agents
  wazuh_agents_sources = var.wazuh_agents_sources

  # As APIs do projeto vêm antes de qualquer recurso do nó.
  depends_on = [google_project_service.apis]
}

# A VM baixa as imagens do registro que o GitHub Actions já publica (no projeto do nó da Verax), só com leitura. São
# só as imagens do código aberto: nenhum dado de cliente passa por lá.
resource "google_artifact_registry_repository_iam_member" "node_reader" {
  project    = var.images_project_id
  location   = var.images_location
  repository = var.images_repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${module.node.service_account_email}"

  depends_on = [google_project_service.apis]
}
