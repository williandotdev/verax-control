terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.10.0"
    }
  }

  # Estado próprio, num bucket do projeto dos nós de clientes (passo 2 do GUIA.md, com versionamento), separado do
  # estado do nó da Verax. O nome do bucket vem no `terraform init -backend-config`.
  backend "gcs" {
    prefix = "homolog-sp"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone

  # O orçamento é da conta de faturamento: as chamadas usam este projeto para cota e cobrança da API.
  user_project_override = true
  billing_project       = var.project_id

  default_labels = {
    project    = "verax-control"
    component  = "homolog-node"
    managed-by = "terraform"
  }
}
