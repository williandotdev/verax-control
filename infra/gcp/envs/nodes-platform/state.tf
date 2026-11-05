# Bucket do estado do projeto dos nós: o estado de cada tenant (`tenants/<slug>/`, gravado pelo executor Terraform), o
# `outputs.json` de cada execução (`runs/<slug>/<runId>/`, que o cp-worker lê), o estado da homologação
# (`homolog-sp/`) e o deste ambiente (`nodes-platform/`).
#
# O bucket precisa existir antes do primeiro `terraform init` (é nele que o estado deste ambiente fica): ele é criado à
# mão, no passo 2 do GUIA.md, e o primeiro `apply` daqui o adota (o bloco `import`), sem recriar nada. Daí em diante o
# Terraform mantém as configurações dele: acesso uniforme no nível do bucket (a concessão condicionada do cp-worker em
# `runs/` exige; com ACL por objeto, a GCP recusa a condição), sem acesso público, versionado e com a retenção abaixo.
# Depois do primeiro `apply`, o bloco `import` não faz mais nada.

import {
  to = google_storage_bucket.tfstate
  id = "${var.project_id}/${var.project_id}-tfstate"
}

# nosemgrep: terraform.gcp.security.gcp-cloud-storage-logging.gcp-cloud-storage-logging -- mesmo motivo do checkov abaixo.
resource "google_storage_bucket" "tfstate" {
  #checkov:skip=CKV_GCP_62:O log de acesso legado precisaria de outro bucket só para ele; quem cria e lê objetos fica nos logs de auditoria do Cloud Storage, como no bucket de backups do nó.
  # O nome que o plano de controle usa (TFSTATE_BUCKET, envs/control-plane/cross_project.tf) e o GUIA cria.
  name     = "${var.project_id}-tfstate"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Um `terraform destroy` não apaga um bucket com estado dentro.
  force_destroy = false

  # Cada `apply` grava uma versão nova do estado; a anterior fica para voltar atrás.
  versioning {
    enabled = true
  }

  # Objeto apagado fica recuperável por 7 dias.
  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  # As versões anteriores de cada estado saem 30 dias depois de substituídas. Também é o que apaga, depois da
  # Exclusão 2 do cliente (D+97, que remove `tenants/<slug>/`), as versões antigas do estado dele, que têm o e-mail do
  # admin nos metadados da VM.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }

  # Os `outputs.json` das execuções ficam 180 dias, o mesmo prazo de `provisioningRuns` no Firestore.
  lifecycle_rule {
    condition {
      age            = 180
      matches_prefix = ["runs/"]
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}
