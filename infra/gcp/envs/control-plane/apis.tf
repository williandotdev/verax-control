# APIs que os recursos deste ambiente usam. Ligar uma API não muda nada do que já existe no projeto (o Firebase dos
# painéis continua igual).
resource "google_project_service" "apis" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "cloudtasks.googleapis.com",
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    # Os três da federação de identidade com o GitHub: iam, iamcredentials e sts.
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sts.googleapis.com",
  ])

  service = each.key
  # Ao desfazer (`terraform destroy`), as APIs continuam ligadas: o Firebase dos painéis e o que mais houver no projeto
  # dependem delas.
  disable_on_destroy         = false
  disable_dependent_services = false
}

# O número do projeto, para o orçamento, a federação de identidade e a URL do cp-worker. Como no envs/homolog-sp: a
# leitura fica para o `apply` enquanto alguma API do `for_each` for ligada, e volta para o `plan` com todas ligadas.
data "google_project" "this" {
  depends_on = [google_project_service.apis]
}
