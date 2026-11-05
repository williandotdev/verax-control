# APIs que os nós de clientes (envs/tenant, pelo módulo do nó) e a homologação usam. Ligadas aqui uma vez, pelo
# responsável: o executor Terraform (`cp-terraform`) não liga API nenhuma. Ligar uma API não muda nada do que já existe
# no projeto. O envs/homolog-sp liga as mesmas; dois estados com a mesma API ligada não brigam (nenhum desliga no
# destroy).
resource "google_project_service" "apis" {
  for_each = toset([
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
  # Ao desfazer (`terraform destroy`), as APIs continuam ligadas: os nós dos clientes dependem delas.
  disable_on_destroy         = false
  disable_dependent_services = false
}

# O número do projeto, para o orçamento. Como na homologação (envs/homolog-sp/apis.tf): num projeto novo a API do
# Resource Manager vem desligada, e a leitura fica para o `apply` enquanto alguma API for ligada.
data "google_project" "this" {
  depends_on = [google_project_service.apis]
}
