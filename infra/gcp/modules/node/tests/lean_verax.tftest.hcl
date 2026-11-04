# O nó da Verax (perfil lean) chamado como em envs/verax/main.tf. Estes valores são os do nó aplicado antes do
# módulo, um a um: os nomes de todos os recursos e os valores que, se mudassem, recriariam algo no ar (a VM, o disco, a
# rede, o NAT, a conta de serviço, os cofres, os tópicos, o bucket) ou trocariam o IP de saída do nó. Se um destes
# testes falhar, o `plan` de envs/verax deixou de ser zero. O contrário não vale: passar aqui não dispensa o `plan`
# contra o estado real (passo 5 do GUIA.md), que confere tudo.
#
# Na manutenção do swap (GUIA.md), o nó da Verax deixa o script de antes: no mesmo commit que tira o
# `legacy_startup_script` de envs/verax/main.tf e apaga o envs/verax/startup.sh, saem daqui a linha
# `legacy_startup_script` do bloco `variables` e o `run "vm_e_script_de_boot"`. O `run "apos_a_manutencao_do_swap"`
# já confere a VM como ela fica.
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

# A VM do nó da Verax depois da manutenção do swap: sem o script de antes, com o do módulo na chave `startup-script`,
# a proteção ligada de novo e o mesmo disco.
run "apos_a_manutencao_do_swap" {
  command = plan

  variables {
    legacy_startup_script = null
  }

  assert {
    condition     = google_compute_instance.node.name == "verax-node" && google_compute_instance.node.machine_type == "e2-micro" && google_compute_instance.node.zone == "us-east1-b"
    error_message = "Depois da manutenção, a VM do nó da Verax mudou de nome, tamanho ou zona."
  }

  assert {
    condition     = google_compute_instance.node.deletion_protection && google_compute_instance.node.allow_stopping_for_update && !google_compute_instance.node.boot_disk[0].auto_delete
    error_message = "Depois da manutenção, a VM volta com a proteção contra exclusão, a parada para atualizar e o disco à parte."
  }

  assert {
    condition = google_compute_instance.node.metadata_startup_script == null && google_compute_instance.node.metadata == tomap({
      enable-oslogin         = "TRUE"
      block-project-ssh-keys = "TRUE"
      serial-port-enable     = "FALSE"
      startup-script         = replace(file("startup.sh.tftpl"), "$${node_profile}", "lean")
    })
    error_message = "Depois da manutenção, o nó da Verax usa o script do módulo (lean) na chave startup-script, e mais nada muda nos metadados."
  }

  assert {
    condition     = google_compute_disk.node.name == "verax-node" && google_compute_disk.node.type == "pd-standard" && google_compute_disk.node.size == 30
    error_message = "A manutenção recria só a VM: o disco continua o mesmo."
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

  # Sem os agentes do Wazuh (`wazuh_agents` fica no padrão, falso, em envs/verax; o lean nem os aceita): nenhum IP de
  # entrada, regra de encaminhamento ou regra de firewall nova.
  assert {
    condition = (
      length(google_compute_address.agents) == 0 && length(google_compute_target_instance.agents) == 0 &&
      length(google_compute_forwarding_rule.agents) == 0 && length(google_compute_firewall.agents) == 0 &&
      output.wazuh_agents == null
    )
    error_message = "O nó da Verax ganhou recursos dos agentes do Wazuh."
  }

  # Sem projeto de cliente (envs/verax não passa `customer_projects`): os tópicos e as assinaturas são os dos projetos
  # monitorados, como antes, e nenhuma identidade de fora publica neles.
  assert {
    condition = (
      keys(google_pubsub_topic.security_logs) == ["projeto-monitorado-a"] &&
      keys(google_pubsub_subscription.security_logs) == ["projeto-monitorado-a"] &&
      keys(google_pubsub_subscription_iam_member.node_subscriber) == ["projeto-monitorado-a"] &&
      length(google_pubsub_topic_iam_member.customer_sink_publisher) == 0
    )
    error_message = "O nó da Verax ganhou tópico, assinatura ou publicação de projeto de cliente."
  }

  # Também sem o cofre do Turnstile: `turnstile_secret` fica no padrão (falso) em envs/verax até a mudança no lugar.
  assert {
    condition     = keys(google_secret_manager_secret.node) == ["cloudflare-tunnel-token", "smtp-password"] && google_secret_manager_secret.node["smtp-password"].secret_id == "verax-node-smtp-password"
    error_message = "Os cofres de antes (SMTP e túnel) mudaram de nome, ou o nó da Verax ganhou o cofre do Turnstile sem a mudança no lugar."
  }
}

# O resto do nó no ar. Um nome ou uma faixa diferente aqui apagaria o recurso e criaria outro: a rede ou o NAT (o nó
# perde a saída e o túnel), a conta de serviço (perde o Pub/Sub e os segredos), um cofre (perde o token gravado nele)
# ou um tópico (perde as mensagens ainda não lidas).
run "rede_conta_cofres_logs_e_backups" {
  command = plan

  # O e-mail da conta e o ID do tópico só existem depois do apply; aqui, valores fixos para o filtro e o destino do sink.
  # O provider confere o formato do nome da conta já no plan.
  override_resource {
    target          = google_service_account.node
    override_during = plan
    values = {
      name  = "projects/projeto-exemplo-verax/serviceAccounts/verax-node@projeto-exemplo-verax.iam.gserviceaccount.com"
      email = "verax-node@projeto-exemplo-verax.iam.gserviceaccount.com"
    }
  }

  override_resource {
    target          = google_pubsub_topic.security_logs
    override_during = plan
    values = {
      id = "projects/projeto-exemplo-verax/topics/verax-node-security-projeto-monitorado-a"
    }
  }

  assert {
    condition = (
      google_compute_network.node.name == "verax-node-vpc" && !google_compute_network.node.auto_create_subnetworks &&
      google_compute_network.node.routing_mode == "REGIONAL" &&
      google_compute_subnetwork.node.name == "verax-node-subnet" && google_compute_subnetwork.node.region == "us-east1" &&
      google_compute_subnetwork.node.ip_cidr_range == "10.80.0.0/24" && google_compute_subnetwork.node.private_ip_google_access
    )
    error_message = "A rede ou a sub-rede do nó da Verax mudou (nome, região ou faixa)."
  }

  assert {
    condition = (
      google_compute_router.node.name == "verax-node-router" && google_compute_router.node.region == "us-east1" &&
      google_compute_router_nat.node.name == "verax-node-nat" && google_compute_router_nat.node.router == "verax-node-router" &&
      google_compute_router_nat.node.region == "us-east1" &&
      google_compute_router_nat.node.source_subnetwork_ip_ranges_to_nat == "LIST_OF_SUBNETWORKS"
    )
    error_message = "O roteador ou o NAT do nó da Verax mudou: o nó ficaria sem saída para a internet."
  }

  assert {
    condition = (
      google_compute_firewall.iap_ssh.name == "verax-node-allow-iap-ssh" && google_compute_firewall.iap_ssh.direction == "INGRESS" &&
      google_compute_firewall.iap_ssh.priority == 1000 && tolist(google_compute_firewall.iap_ssh.source_ranges) == tolist(["35.235.240.0/20"]) &&
      tolist(google_compute_firewall.iap_ssh.target_service_accounts) == tolist(["verax-node@projeto-exemplo-verax.iam.gserviceaccount.com"]) &&
      google_compute_firewall.deny_ingress.name == "verax-node-deny-ingress" && google_compute_firewall.deny_ingress.direction == "INGRESS" &&
      google_compute_firewall.deny_ingress.priority == 65000 && tolist(google_compute_firewall.deny_ingress.source_ranges) == tolist(["0.0.0.0/0"])
    )
    error_message = "As regras de firewall do nó da Verax mudaram."
  }

  assert {
    condition = (
      google_service_account.node.account_id == "verax-node" &&
      keys(google_project_iam_member.node) == ["roles/logging.logWriter", "roles/monitoring.metricWriter"] &&
      alltrue([for member in google_project_iam_member.node : member.member == "serviceAccount:verax-node@projeto-exemplo-verax.iam.gserviceaccount.com"]) &&
      google_project_iam_custom_role.operator_lookup[0].role_id == "verax_node_operator_lookup"
    )
    error_message = "A conta de serviço, os papéis dela no projeto ou o papel dos operadores mudou."
  }

  assert {
    condition = alltrue([
      for secret in google_secret_manager_secret.node :
      [for replica in secret.replication[0].user_managed[0].replicas : replica.location] == ["us-east1"]
    ])
    error_message = "A réplica dos cofres de antes mudou: o cofre seria apagado com o valor gravado nele."
  }

  assert {
    condition = (
      google_storage_bucket.backups.name == "projeto-exemplo-verax-verax-node-backups" &&
      upper(google_storage_bucket.backups.location) == "US-EAST1" && !google_storage_bucket.backups.force_destroy &&
      google_storage_bucket.backups.versioning[0].enabled
    )
    error_message = "O bucket dos backups do nó da Verax mudou (nome, região, versionamento ou a recusa de apagar com backups dentro)."
  }

  assert {
    condition = (
      google_pubsub_topic.security_logs["projeto-monitorado-a"].name == "verax-node-security-projeto-monitorado-a" &&
      google_pubsub_topic.security_logs["projeto-monitorado-a"].message_retention_duration == "604800s" &&
      google_pubsub_subscription.security_logs["projeto-monitorado-a"].name == "verax-node-security-projeto-monitorado-a" &&
      google_pubsub_subscription.security_logs["projeto-monitorado-a"].topic == "projects/projeto-exemplo-verax/topics/verax-node-security-projeto-monitorado-a" &&
      google_pubsub_subscription.security_logs["projeto-monitorado-a"].ack_deadline_seconds == 60 &&
      google_pubsub_subscription.security_logs["projeto-monitorado-a"].message_retention_duration == "604800s" &&
      !google_pubsub_subscription.security_logs["projeto-monitorado-a"].retain_acked_messages
    )
    error_message = "O tópico ou a assinatura dos logs do nó da Verax mudou (nome ou retenção)."
  }

  assert {
    condition = (
      google_logging_project_sink.security["projeto-monitorado-a"].name == "verax-node-security" &&
      google_logging_project_sink.security["projeto-monitorado-a"].project == "projeto-monitorado-a" &&
      google_logging_project_sink.security["projeto-monitorado-a"].unique_writer_identity &&
      google_logging_project_sink.security["projeto-monitorado-a"].destination == "pubsub.googleapis.com/projects/projeto-exemplo-verax/topics/verax-node-security-projeto-monitorado-a"
    )
    error_message = "O sink do projeto monitorado mudou (nome, projeto, identidade ou destino)."
  }

  # O filtro muda no lugar, sem recriar nada, mas decide quais logs chegam ao nó: uma mudança nele é uma escolha.
  assert {
    condition     = google_logging_project_sink.security["projeto-monitorado-a"].filter == <<-EOT
      (
        log_id("cloudaudit.googleapis.com/activity") OR
        log_id("cloudaudit.googleapis.com/system_event") OR
        log_id("cloudaudit.googleapis.com/policy") OR
        log_id("cloudaudit.googleapis.com/data_access") OR
        (resource.type="http_load_balancer" AND jsonPayload.enforcedSecurityPolicy.outcome="DENY")
      )
      AND NOT (
        protoPayload.serviceName="pubsub.googleapis.com" AND
        protoPayload.authenticationInfo.principalEmail="verax-node@projeto-exemplo-verax.iam.gserviceaccount.com"
      )
    EOT
    error_message = "O filtro do sink mudou: os logs que chegam ao nó da Verax seriam outros."
  }
}
