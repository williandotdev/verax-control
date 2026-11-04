# Nós novos: o perfil standard (homologação e clientes), o lean sem o script de antes e as recusas do módulo.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada.

mock_provider "google" {}

variables {
  project_id         = "projeto-exemplo-nos"
  region             = "southamerica-east1"
  zone               = "southamerica-east1-b"
  name_prefix        = "verax-teste"
  subnet_cidr        = "10.81.0.0/24"
  monitored_projects = ["projeto-monitorado-a"]
}

run "standard" {
  command = plan

  variables {
    node_profile = "standard"
    alert_email  = "alertas@example.com"
  }

  assert {
    condition     = google_compute_instance.node.machine_type == "e2-standard-2" && google_compute_instance.node.deletion_protection
    error_message = "O standard nasce com a e2-standard-2 e com a proteção contra exclusão."
  }

  assert {
    condition     = google_compute_disk.node.type == "pd-balanced" && google_compute_disk.node.size == 60
    error_message = "O disco do standard é de 60 GB pd-balanced."
  }

  assert {
    condition = (
      google_compute_resource_policy.snapshot.name == "verax-teste-daily-snapshot" &&
      google_compute_resource_policy.snapshot.snapshot_schedule_policy[0].retention_policy[0].max_retention_days == 7 &&
      length(google_compute_resource_policy.snapshot.snapshot_schedule_policy[0].schedule[0].daily_schedule) == 1 &&
      length(google_compute_resource_policy.snapshot.snapshot_schedule_policy[0].schedule[0].weekly_schedule) == 0
    )
    error_message = "O snapshot do standard é diário, guardado por 7 dias."
  }

  assert {
    condition     = google_compute_router_nat.node.nat_ip_allocate_option == "MANUAL_ONLY" && length(google_compute_address.nat) == 1
    error_message = "O standard sai por um IP reservado no NAT."
  }

  # O script que a VM recebe é o modelo com o perfil no lugar de `${node_profile}`, e nada mais: é assim que o CI o
  # monta para o shellcheck e para tests/startup-test.sh. Outra sequência de modelo no arquivo quebraria esta igualdade.
  assert {
    condition = (
      google_compute_instance.node.metadata_startup_script == null &&
      google_compute_instance.node.metadata["startup-script"] == replace(file("startup.sh.tftpl"), "$${node_profile}", "standard")
    )
    error_message = "O script de boot do standard não é o modelo com o perfil trocado."
  }

  assert {
    condition = (
      google_compute_instance.node.metadata["block-project-ssh-keys"] == "TRUE" &&
      google_compute_instance.node.metadata["enable-oslogin"] == "TRUE" &&
      google_compute_instance.node.metadata["serial-port-enable"] == "FALSE"
    )
    error_message = "Os metadados de segurança da VM (OS Login, chaves de projeto e console serial) mudaram."
  }

  assert {
    condition = (
      keys(google_secret_manager_secret.node_written) == ["admin-bootstrap", "credentials-key"] &&
      alltrue([for member in google_secret_manager_secret_iam_member.node_written_adder : member.role == "roles/secretmanager.secretVersionAdder"]) &&
      length(google_secret_manager_secret_iam_member.credentials_key_accessor) == 1
    )
    error_message = "Os cofres que a VM grava (e a leitura só da chave do cofre de credenciais) mudaram."
  }

  assert {
    condition     = tolist(google_pubsub_topic.security_logs["projeto-monitorado-a"].message_storage_policy[0].allowed_persistence_regions) == tolist(["southamerica-east1"])
    error_message = "As mensagens do Pub/Sub devem ficar só na região do nó."
  }

  assert {
    condition = (
      length(google_monitoring_alert_policy.stalled_subscription) == 1 &&
      google_monitoring_alert_policy.stalled_subscription[0].conditions[0].condition_threshold[0].threshold_value == 86400 &&
      length(google_monitoring_notification_channel.email) == 1
    )
    error_message = "O alerta de fila parada (24 h, com e-mail) mudou."
  }
}

run "lean_novo_usa_o_script_do_modulo" {
  command = plan

  variables {
    node_profile = "lean"
  }

  assert {
    condition = (
      google_compute_instance.node.metadata_startup_script == null &&
      google_compute_instance.node.metadata["startup-script"] == replace(file("startup.sh.tftpl"), "$${node_profile}", "lean")
    )
    error_message = "Um nó lean novo usa o script do módulo, com o perfil trocado."
  }

  assert {
    condition     = google_compute_instance.node.machine_type == "e2-micro" && google_compute_router_nat.node.nat_ip_allocate_option == "AUTO_ONLY"
    error_message = "O lean nasce com a e2-micro e o NAT automático."
  }
}

run "standard_recusa_vm_fora_do_perfil" {
  command = plan

  variables {
    node_profile = "standard"
    machine_type = "e2-micro"
  }

  expect_failures = [google_compute_instance.node]
}

run "lean_recusa_vm_fora_do_perfil" {
  command = plan

  variables {
    node_profile = "lean"
    machine_type = "e2-standard-2"
  }

  expect_failures = [google_compute_instance.node]
}

run "perfil_invalido" {
  command = plan

  variables {
    node_profile = "medio"
  }

  expect_failures = [var.node_profile]
}
