# Retenção dos backups do banco (`backup_retention_days`, CE-03): 90 dias por padrão, como sempre (os nós dedicados, a
# homologação e o nó da Verax não mudam), e o valor dado pelo ambiente na célula (85). As versões antigas continuam
# saindo 30 dias depois de substituídas, nos dois casos.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada.

mock_provider "google" {}

variables {
  project_id   = "projeto-exemplo-nos"
  region       = "southamerica-east1"
  zone         = "southamerica-east1-b"
  name_prefix  = "verax-teste"
  subnet_cidr  = "10.81.0.0/24"
  node_profile = "standard"
}

run "padrao_noventa_dias" {
  command = plan

  assert {
    condition = (
      one(google_storage_bucket.backups.lifecycle_rule[0].condition).age == 90 &&
      one(google_storage_bucket.backups.lifecycle_rule[1].condition).days_since_noncurrent_time == 30
    )
    error_message = "Sem backup_retention_days, os backups saem com 90 dias, como antes."
  }
}

run "celula_oitenta_e_cinco_dias" {
  command = plan

  variables {
    backup_retention_days = 85
  }

  assert {
    condition = (
      one(google_storage_bucket.backups.lifecycle_rule[0].condition).age == 85 &&
      one(google_storage_bucket.backups.lifecycle_rule[1].condition).days_since_noncurrent_time == 30
    )
    error_message = "Com backup_retention_days = 85, os backups saem com 85 dias."
  }
}

run "fora_da_faixa" {
  command = plan

  variables {
    backup_retention_days = 7
  }

  expect_failures = [var.backup_retention_days]
}

run "nao_inteiro" {
  command = plan

  variables {
    backup_retention_days = 85.5
  }

  expect_failures = [var.backup_retention_days]
}
