# APIs que este ambiente usa: o Cloud KMS e as três da federação de identidade com o GitHub (iam, iamcredentials e
# sts). Ligar uma API não muda nada do que já existe no projeto.
resource "google_project_service" "apis" {
  for_each = toset([
    "cloudkms.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ])

  service = each.key
  # Ao desfazer, as APIs continuam ligadas: o nó da Verax e o resto do projeto podem depender delas.
  disable_on_destroy         = false
  disable_dependent_services = false
}
