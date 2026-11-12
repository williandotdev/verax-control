# O que vale para o projeto dos nós de clientes inteiro (fase 3, CP-06): as APIs, o orçamento, o bucket do estado (o
# de cada tenant, o deste ambiente e o da homologação) e as permissões do plano de controle nesse projeto (os papéis
# do executor Terraform `cp-terraform` e o ciclo de vida das VMs para o `cp-worker`). Cada nó de cliente é um
# envs/tenant à parte, com o próprio estado, aplicado pelo plano de controle; este ambiente é aplicado à mão, pelo
# responsável, uma vez e a cada mudança dele.

terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.10.0"
    }
  }

  # O estado fica no próprio bucket do estado do projeto dos nós (criado à mão no passo 2 do GUIA.md e adotado por
  # este ambiente no primeiro `apply`, em state.tf), com este prefixo. O nome do bucket vem no
  # `terraform init -backend-config`.
  backend "gcs" {
    prefix = "nodes-platform"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  # O orçamento é da conta de faturamento: as chamadas usam este projeto para cota e cobrança da API.
  user_project_override = true
  billing_project       = var.project_id

  default_labels = {
    project    = "verax-control"
    component  = "nodes-platform"
    managed-by = "terraform"
  }
}
