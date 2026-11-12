# O que é de cada cliente da célula (fase 3, CE-07): um estado por cliente, no bucket do estado do projeto dos nós
# (envs/nodes-platform), no prefixo `cells/<célula>/tenants/<slug>`, aplicado pelo executor Terraform do plano de
# controle (o Job `cp-terraform`) com as variáveis de cada cliente. Os recursos ficam no projeto da célula (hoje, o do nó
# da Verax). Ninguém aplica este ambiente à mão, fora o `plan` de aceite (docs/runbooks/celula.md).

terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.9.0"
    }
  }

  # O bucket e o prefixo vêm no `terraform init`, um prefixo por cliente da célula:
  #   terraform init -backend-config="bucket=<projeto-dos-nos>-tfstate" -backend-config="prefix=cells/<célula>/tenants/<slug>"
  # O executor monta os dois a partir de TFSTATE_BUCKET, do CELL_ID e do slug já validados.
  backend "gcs" {}
}

# Sem `user_project_override`, como no envs/tenant: cada chamada é cobrada do projeto do recurso (o da célula).
provider "google" {
  project = var.project_id
  region  = var.region

  default_labels = {
    project    = "verax-control"
    component  = "cell-tenant"
    managed-by = "terraform"
    tenant     = var.slug
    cell       = var.cell_id
  }
}
