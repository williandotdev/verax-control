# APIs que os recursos deste ambiente e do módulo do nó usam. Ligar uma API não muda nada do que já existe no projeto.
resource "google_project_service" "apis" {
  for_each = toset([
    # Só para a cota da chamada que dá à VM a leitura do registro de imagens (no outro projeto).
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
  ])

  service = each.key
  # Ao desfazer (`terraform destroy`), as APIs continuam ligadas: os outros nós do projeto dependem delas.
  disable_on_destroy         = false
  disable_dependent_services = false
}

data "google_project" "this" {}
