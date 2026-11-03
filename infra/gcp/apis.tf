# APIs que os recursos abaixo usam. Ligar uma API não muda nada do que já existe no projeto.
resource "google_project_service" "apis" {
  for_each = toset([
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
  # Ao desfazer (`terraform destroy`), as APIs continuam ligadas: outras coisas do projeto (o site, por exemplo)
  # podem depender delas.
  disable_on_destroy         = false
  disable_dependent_services = false
}

data "google_project" "this" {}
