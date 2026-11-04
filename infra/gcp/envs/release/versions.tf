# Chave de release do nó (fase 3, SH-02): a chave do Cloud KMS que assina o manifesto de cada versão do nó, e a única
# identidade que pode usá-la, o workflow `Versão do nó` (.github/workflows/versao-no.yml) no environment `release` do
# GitHub, que exige aprovação. Fica num ambiente próprio, com estado próprio, separado do plano de controle (onde vai
# morar a chave das licenças, SH-03): quem comprometer o plano de controle não assina uma versão do nó, e vice-versa.
# Projeto recomendado: o do nó da Verax (envs/verax), nunca o do plano de controle (docs/runbooks/versao-no.md).

terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.9.0"
    }
  }

  # Estado no bucket do estado que já existe (passo 2 do GUIA.md), com este prefixo. O nome do bucket vem no
  # `terraform init -backend-config`.
  backend "gcs" {
    prefix = "release"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  # Rótulos em todos os recursos que aceitam: dá para achar tudo o que o Terraform criou no console.
  default_labels = {
    project    = "verax-control"
    component  = "release"
    managed-by = "terraform"
  }
}
