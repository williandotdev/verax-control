# Nó de homologação em São Paulo, perfil standard: a mesma configuração que um nó de cliente vai ter (e2-standard-2,
# 60 GB pd-balanced, snapshot diário, IP fixo no NAT, Pub/Sub só na região), no projeto dos nós de clientes. Serve
# para ensaiar o Wazuh no nó e a chave da AWS antes da fase 3. Fica parado fora das janelas de teste.

module "node" {
  source = "../../modules/node"

  project_id         = var.project_id
  region             = var.region
  zone               = var.zone
  name_prefix        = var.name_prefix
  node_profile       = "standard"
  machine_type       = var.machine_type
  subnet_cidr        = var.subnet_cidr
  monitored_projects = var.monitored_projects
  operators          = var.operators

  alert_email                = var.alert_email
  stalled_subscription_hours = var.stalled_subscription_hours

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
