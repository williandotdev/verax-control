# O nó de um cliente (fase 3, CP-06): um estado por cliente, no bucket do estado do projeto dos nós
# (envs/nodes-platform), aplicado pelo executor Terraform do plano de controle (o Job `cp-terraform`, CP-07) com as
# variáveis de cada cliente. Ninguém aplica este ambiente à mão, fora o `plan` de aceite num projeto de teste
# (GUIA.md, "O nó de cada cliente").

terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.9.0"
    }
  }

  # O bucket e o prefixo vêm no `terraform init`, um prefixo por cliente:
  #   terraform init -backend-config="bucket=<projeto-dos-nos>-tfstate" -backend-config="prefix=tenants/<slug>"
  # O executor monta os dois a partir de TFSTATE_BUCKET e do slug já validado.
  backend "gcs" {}
}

# Sem `user_project_override`: cada chamada é cobrada do projeto do recurso (o dos nós; o do registro, na leitura das
# imagens). O executor não tem `serviceusage.services.use` em projeto nenhum, que o cabeçalho de cota exigiria.
provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone

  # Rótulos em todos os recursos que aceitam: o custo de cada cliente aparece no faturamento pelo rótulo `tenant`.
  default_labels = {
    project    = "verax-control"
    component  = "customer-node"
    managed-by = "terraform"
    tenant     = var.slug
  }
}
