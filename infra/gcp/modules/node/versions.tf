# Módulo de um nó do Verax Control na GCP: rede, VM, disco, segredos, logs e backups de um nó. Cada ambiente
# (`envs/verax`, `envs/homolog-sp` e, na fase 3, um por cliente) chama este módulo com o próprio estado. O que é do
# projeto inteiro (APIs, orçamento, registro das imagens) fica no ambiente.

terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 8.9.0, < 9.0.0"
    }
  }
}
