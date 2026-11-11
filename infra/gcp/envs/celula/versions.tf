terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.9.0"
    }
  }

  # Estado próprio (prefixo `celula`), no bucket de estado do projeto do nó da Verax, separado do estado do nó lean. O
  # nome do bucket vem no `terraform init -backend-config`.
  backend "gcs" {
    prefix = "celula"
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
    component  = "cell-node"
    managed-by = "terraform"
  }
}
