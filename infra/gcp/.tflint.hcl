# Lint do Terraform da GCP. Roda no CI pelo workflow iac.yml, com as regras do próprio Terraform.
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}
