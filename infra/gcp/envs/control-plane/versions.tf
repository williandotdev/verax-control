# Plano de controle do Verax Control (fase 3): checkout, webhook da Stripe, página de status e provisionamento dos
# nós de clientes. Fica no projeto da Verax que hospeda o Firebase dos painéis: o rewrite do Hosting para o Cloud Run
# exige o mesmo projeto, e o Firestore gratuito é um banco por projeto. Tudo o que é da própria Verax cabe no nível
# gratuito: Cloud Run sem instância mínima, sem Cloud SQL, sem IP reservado e sem NAT.

terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.10.0"
    }
    # Só para o Firebase Hosting (site, versão com o rewrite, release e domínio próprio, em hosting.tf): na 8.9.0,
    # esses recursos existem só no provider beta. Mesma versão fixa, mesmo lock.
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "8.10.0"
    }
  }

  # Estado próprio, no bucket do estado que já existe (passo 2 do GUIA.md), com este prefixo. O nome do bucket vem no
  # `terraform init -backend-config`.
  backend "gcs" {
    prefix = "control-plane"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  # O orçamento é da conta de faturamento: as chamadas usam este projeto para cota e cobrança da API.
  user_project_override = true
  billing_project       = var.project_id

  # Rótulos em todos os recursos: dá para achar tudo o que o Terraform criou (e o custo) no console.
  default_labels = {
    project    = "verax-control"
    component  = "control-plane"
    managed-by = "terraform"
  }
}

provider "google-beta" {
  project = var.project_id
  region  = var.region

  user_project_override = true
  billing_project       = var.project_id

  default_labels = {
    project    = "verax-control"
    component  = "control-plane"
    managed-by = "terraform"
  }
}
