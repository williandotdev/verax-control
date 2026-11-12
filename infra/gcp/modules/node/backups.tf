# Backups do banco do nó (o pacote do nó grava aqui todo dia). Privado, versionado e só com acesso pelas
# permissões do projeto (sem lista de acesso por objeto). Objetos com mais de `backup_retention_days` dias são apagados
# (90 por padrão; 85 na célula, para a promessa dos 100 dias depois do expurgo de um cliente).

# nosemgrep: terraform.gcp.security.gcp-cloud-storage-logging.gcp-cloud-storage-logging -- mesmo motivo do checkov abaixo.
resource "google_storage_bucket" "backups" {
  #checkov:skip=CKV_GCP_62:O log de acesso legado precisaria de outro bucket só para ele; quem cria e lê objetos fica nos logs de auditoria do Cloud Storage.
  # O nome de bucket é único no mundo: o ID do projeto entra para não colidir.
  name     = "${var.project_id}-${var.name_prefix}-backups"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Um `terraform destroy` não apaga um bucket com backups dentro.
  force_destroy = false

  versioning {
    enabled = true
  }

  # Objeto apagado fica recuperável por 7 dias.
  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  lifecycle_rule {
    condition {
      age = var.backup_retention_days
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }
}

# O nó cria backups novos e lê os antigos, mas não apaga nem sobrescreve: um nó comprometido não destrói os backups.
resource "google_storage_bucket_iam_member" "node_backups" {
  for_each = toset(["roles/storage.objectCreator", "roles/storage.objectViewer"])

  bucket = google_storage_bucket.backups.name
  role   = each.key
  member = local.node_member
}
