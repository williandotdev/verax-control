terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.9.0"
    }
  }

  # O estado fica num bucket do Cloud Storage criado no passo 2 do GUIA.md, com versionamento: dá para voltar a
  # uma versão anterior se algo der errado. O nome do bucket vem no `terraform init -backend-config`.
  backend "gcs" {
    prefix = "verax-node"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone

  # O orçamento é da conta de faturamento: as chamadas usam este projeto para cota e cobrança da API.
  user_project_override = true
  billing_project       = var.project_id

  # Rótulos em todos os recursos: dá para achar tudo o que o Terraform criou (e o custo) no console.
  default_labels = {
    project    = "verax-control"
    component  = "soc-node"
    managed-by = "terraform"
  }
}
