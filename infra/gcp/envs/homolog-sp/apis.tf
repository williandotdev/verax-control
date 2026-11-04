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

# O número do projeto, para o orçamento. Ler o projeto chama a API do Resource Manager, cobrada deste projeto
# (`billing_project` no versions.tf), que vem desligada num projeto novo e só o `apply` liga: lido no `plan`, todo
# `plan` pararia com 403. Com o `depends_on`, a leitura fica para o `apply` sempre que alguma API do `for_each` for
# ligada; com todas ligadas, volta para o `plan` (tests/primeira_subida.tftest.hcl).
data "google_project" "this" {
  depends_on = [google_project_service.apis]
}
