# O nó da Verax (perfil lean) chamado como em envs/verax/main.tf. Estes valores são os do nó aplicado antes do
# módulo, um a um: qualquer diferença recriaria o disco, a VM ou a política de snapshot, ou trocaria o IP de saída do
# nó no ar. Se um destes testes falhar, o `plan` de envs/verax deixou de ser zero.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada.

mock_provider "google" {}

# Os mesmos valores de envs/verax (padrões de variables.tf e as opções fixas do main.tf). O projeto, o projeto
# monitorado e o operador são fictícios.
variables {
  project_id                 = "projeto-exemplo-verax"
  region                     = "us-east1"
  zone                       = "us-east1-b"
  name_prefix                = "verax-node"
  node_profile               = "lean"
  machine_type               = "e2-micro"
  disk_gb                    = 30
  subnet_cidr                = "10.80.0.0/24"
  monitored_projects         = ["projeto-monitorado-a"]
  operators                  = ["user:operador@example.com"]
  legacy_startup_script      = file("../../envs/verax/startup.sh")
  pubsub_storage_in_region   = false
  credentials_vault          = false
  bootstrap_secret           = false
  stalled_subscription_alert = false
}

run "vm_e_script_de_boot" {
  command = plan

  assert {
    condition     = google_compute_instance.node.name == "verax-node" && google_compute_instance.node.machine_type == "e2-micro" && google_compute_instance.node.zone == "us-east1-b"
    error_message = "Nome, tamanho ou zona da VM diferente do nó aplicado."
  }

  assert {
    condition     = google_compute_instance.node.deletion_protection && google_compute_instance.node.allow_stopping_for_update && !google_compute_instance.node.boot_disk[0].auto_delete
    error_message = "A VM perdeu a proteção contra exclusão, a parada para atualizar ou o disco à parte."
  }

  # O conteúdo do envs/verax/startup.sh aplicado em 03/11/2026. Mudar um byte dele (ou deixar de passá-lo) recria a VM.
  assert {
    condition     = sha256(google_compute_instance.node.metadata_startup_script) == "532735a6438690f9320c4b14e353e562d1b1e0e8cd39bde4a7e2bb73ae79a29a"
    error_message = "O script de boot do nó da Verax mudou: o provider recriaria a VM (veja o GUIA.md antes de mexer nele)."
  }

  assert {
    condition = google_compute_instance.node.metadata == tomap({
      enable-oslogin         = "TRUE"
      block-project-ssh-keys = "TRUE"
      serial-port-enable     = "FALSE"
    })
    error_message = "Os metadados da VM mudaram (no lean com o script de antes, não há a chave startup-script)."
  }
}

run "disco_e_snapshot" {
  command = plan

  assert {
    condition     = google_compute_disk.node.name == "verax-node" && google_compute_disk.node.type == "pd-standard" && google_compute_disk.node.size == 30 && google_compute_disk.node.image == "debian-cloud/debian-12"
    error_message = "O disco mudou: tipo, tamanho ou imagem diferente recria o disco do nó."
  }

  assert {
    condition     = google_compute_resource_policy.snapshot.name == "verax-node-weekly-snapshot" && google_compute_resource_policy.snapshot.region == "us-east1"
    error_message = "O nome da política de snapshot mudou: a política do nó seria apagada e criada de novo."
  }

  assert {
    condition = (
      length(google_compute_resource_policy.snapshot.snapshot_schedule_policy[0].schedule[0].daily_schedule) == 0 &&
      [for day in google_compute_resource_policy.snapshot.snapshot_schedule_policy[0].schedule[0].weekly_schedule[0].day_of_weeks : "${day.day} ${day.start_time}"] == ["SUNDAY 06:00"]
    )
    error_message = "O snapshot do lean deixou de ser semanal, no domingo às 06:00."
  }

  assert {
    condition = (
      google_compute_resource_policy.snapshot.snapshot_schedule_policy[0].retention_policy[0].max_retention_days == 28 &&
      google_compute_resource_policy.snapshot.snapshot_schedule_policy[0].retention_policy[0].on_source_disk_delete == "KEEP_AUTO_SNAPSHOTS" &&
      tolist(google_compute_resource_policy.snapshot.snapshot_schedule_policy[0].snapshot_properties[0].storage_locations) == tolist(["us-east1"])
    )
    error_message = "A retenção ou o local dos snapshots do lean mudou."
  }

  assert {
    condition     = google_compute_disk_resource_policy_attachment.node.name == "verax-node-weekly-snapshot" && google_compute_disk_resource_policy_attachment.node.disk == "verax-node"
    error_message = "O vínculo do snapshot com o disco mudou."
  }
}

run "nat_e_extras_desligados" {
  command = plan

  assert {
    condition     = google_compute_router_nat.node.nat_ip_allocate_option == "AUTO_ONLY" && length(google_compute_address.nat) == 0 && output.nat_ip == null
    error_message = "O NAT do lean deixou de ser automático: o nó no ar ganharia outro IP de saída."
  }

  assert {
    condition     = length(google_pubsub_topic.security_logs["projeto-monitorado-a"].message_storage_policy) == 0
    error_message = "O tópico do nó da Verax ganhou a política de região (mudança que fica para uma janela própria)."
  }

  assert {
    condition     = length(google_secret_manager_secret.node_written) == 0 && length(google_secret_manager_secret_iam_member.credentials_key_accessor) == 0
    error_message = "O nó da Verax ganhou os cofres novos, desligados em envs/verax."
  }

  assert {
    condition     = length(google_monitoring_alert_policy.stalled_subscription) == 0 && length(google_monitoring_notification_channel.email) == 0
    error_message = "O nó da Verax ganhou o alerta de fila parada, desligado em envs/verax."
  }

  assert {
    condition     = keys(google_secret_manager_secret.node) == ["cloudflare-tunnel-token", "smtp-password"] && google_secret_manager_secret.node["smtp-password"].secret_id == "verax-node-smtp-password"
    error_message = "Os cofres de antes (SMTP e túnel) mudaram de nome."
  }
}
