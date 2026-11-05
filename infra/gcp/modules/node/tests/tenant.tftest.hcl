# O nó de um cliente, chamado como em envs/tenant/main.tf (CP-06): perfil standard, prefixo `vx-<slug>`, o cofre da
# conta de suporte, os atributos de convidado e a configuração do nó nos metadados. Os testes do próprio envs/tenant
# só alcançam as saídas do módulo; o que fica dentro dele (os nomes de cada recurso, quem acessa cada cofre e os
# metadados da VM) é conferido aqui. Os padrões dos três interruptores (desligados: nada muda nos nós que já existem)
# estão em `perfis` (homologação) e `lean_verax` (nó da Verax).
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. O projeto, o cliente, o IP e o ID são
# fictícios.

mock_provider "google" {
  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos.
  mock_resource "google_service_account" {
    defaults = {
      name      = "projects/projeto-exemplo-nos/serviceAccounts/vx-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com"
      email     = "vx-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com"
      unique_id = "123456789012345678901"
    }
  }

  mock_resource "google_compute_address" {
    defaults = {
      address = "203.0.113.20"
    }
  }
}

variables {
  project_id               = "projeto-exemplo-nos"
  region                   = "southamerica-east1"
  zone                     = "southamerica-east1-b"
  name_prefix              = "vx-demo-a"
  node_profile             = "standard"
  subnet_cidr              = "10.1.0.0/24"
  support_bootstrap_secret = true
  guest_attributes         = true
  install_config           = true
  install_metadata = {
    verax-plan                    = "profissional"
    verax-plan-max-cloud-accounts = ""
    verax-plan-max-users          = ""
    verax-plan-monthly-gib        = ""
    verax-plan-history-days       = ""
    verax-node-version            = "node-v1.2.3"
    verax-node-package-sha256     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    verax-images-repository       = "us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control"
    verax-web-origin              = "https://demo-a.control.example.com"
    verax-api-origin              = "https://api-demo-a.example.com"
    verax-mail-from               = "nao-responda@example.com"
    verax-tenant-name             = "Cliente Demo A"
    verax-admin-email             = "admin@cliente-demo-a.example.com"
    verax-support-email           = "suporte@example.com"
  }
}

# O aceite do CP-06 é um `plan` do tenant que só mostra recursos `vx-<slug>`: cada nome que o módulo cria começa com o
# prefixo (o bucket, que é único no mundo, leva o projeto antes). Nada de sink, tópico, operador ou agente: o nó de
# cliente nasce sem nenhum deles.
run "so_nomes_do_cliente" {
  command = plan

  assert {
    condition = alltrue([
      for name in concat(
        [
          google_compute_network.node.name, google_compute_subnetwork.node.name, google_compute_router.node.name,
          google_compute_router_nat.node.name, google_compute_firewall.iap_ssh.name, google_compute_firewall.deny_ingress.name,
          google_service_account.node.account_id, google_compute_disk.node.name, google_compute_resource_policy.snapshot.name,
          google_compute_disk_resource_policy_attachment.node.name, google_compute_instance.node.name,
        ],
        google_compute_address.nat[*].name,
        [for secret in google_secret_manager_secret.node : secret.secret_id],
        [for secret in google_secret_manager_secret.node_written : secret.secret_id],
      ) : name == "vx-demo-a" || startswith(name, "vx-demo-a-")
    ])
    error_message = "Um recurso do nó do cliente tem nome fora do prefixo vx-<slug>."
  }

  assert {
    condition = (
      google_storage_bucket.backups.name == "projeto-exemplo-nos-vx-demo-a-backups" &&
      startswith(google_monitoring_alert_policy.stalled_subscription[0].display_name, "vx-demo-a: ")
    )
    error_message = "O bucket de backups ou o alerta do nó do cliente saiu do prefixo vx-<slug>."
  }

  assert {
    condition = (
      length(google_pubsub_topic.security_logs) == 0 && length(google_logging_project_sink.security) == 0 &&
      length(google_project_iam_custom_role.operator_lookup) == 0 && length(google_compute_address.agents) == 0 &&
      length(google_monitoring_notification_channel.email) == 0
    )
    error_message = "O nó do cliente nasceu com sink, tópico, operador, agentes ou canal de e-mail."
  }
}

# O IP de saída não vai para os metadados (node.tf explica): nem no standard, que tem o IP reservado.
run "sem_ip_de_saida_nos_metadados" {
  command = plan

  assert {
    condition     = length([for key in keys(google_compute_instance.node.metadata) : key if strcontains(key, "egress")]) == 0
    error_message = "Os metadados da VM ganharam o IP de saída, que o checkov não avalia (CKV_GCP_32 deixaria de conferir as chaves de segurança)."
  }
}

# Contrato 1 do CP-06 com o CP-10: o `support-bootstrap` existe, na região do nó, e a única permissão que este
# Terraform dá nele é a da VM gravar versões. No `apply` simulado cada cofre tem um ID próprio, e é por ele que as
# permissões são comparadas.
run "cofre_da_conta_de_suporte" {
  assert {
    condition = (
      keys(google_secret_manager_secret.node_written) == ["admin-bootstrap", "credentials-key", "support-bootstrap"] &&
      google_secret_manager_secret.node_written["support-bootstrap"].secret_id == "vx-demo-a-support-bootstrap" &&
      [for replica in google_secret_manager_secret.node_written["support-bootstrap"].replication[0].user_managed[0].replicas : replica.location] == ["southamerica-east1"] &&
      output.node_written_secrets["support-bootstrap"] == "vx-demo-a-support-bootstrap" &&
      !contains(keys(output.secrets), "support-bootstrap")
    )
    error_message = "O cofre vx-<slug>-support-bootstrap não existe, está fora da região do nó ou saiu entre os cofres que você preenche."
  }

  assert {
    condition = (
      [
        for key, member in google_secret_manager_secret_iam_member.node_written_adder : "${key} ${member.role} ${member.member}"
        if member.secret_id == google_secret_manager_secret.node_written["support-bootstrap"].id
        ] == [
        "support-bootstrap roles/secretmanager.secretVersionAdder serviceAccount:vx-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com",
      ] &&
      length([for member in google_secret_manager_secret_iam_member.node : member if member.secret_id == google_secret_manager_secret.node_written["support-bootstrap"].id]) == 0 &&
      length([for member in google_secret_manager_secret_iam_member.credentials_key_accessor : member if member.secret_id == google_secret_manager_secret.node_written["support-bootstrap"].id]) == 0
    )
    error_message = "No support-bootstrap, a única permissão do Terraform é a da VM gravar versões (secretVersionAdder)."
  }

  # A leitura da VM continua só na chave do cofre de credenciais.
  assert {
    condition = (
      length(google_secret_manager_secret_iam_member.credentials_key_accessor) == 1 &&
      google_secret_manager_secret_iam_member.credentials_key_accessor[0].secret_id == google_secret_manager_secret.node_written["credentials-key"].id
    )
    error_message = "A VM lê algum cofre além da chave do cofre de credenciais."
  }
}

# Contratos 2 e 3: os atributos de convidado ligados e a configuração do nó nas chaves `verax-*`, as do ambiente como
# vieram e as que o módulo conhece (perfil, prefixo, cofre, bucket e ID da conta). As chaves de segurança e o
# script de boot continuam lá, com os mesmos valores.
run "metadados_da_instalacao" {
  assert {
    condition = output.install_metadata == tomap({
      enable-guest-attributes       = "TRUE"
      verax-config-version          = "1"
      verax-node-profile            = "standard"
      verax-secret-prefix           = "vx-demo-a"
      verax-credentials-vault       = "true"
      verax-backup-bucket           = "projeto-exemplo-nos-vx-demo-a-backups"
      verax-node-sa-unique-id       = "123456789012345678901"
      verax-images-repository       = "us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control"
      verax-node-version            = "node-v1.2.3"
      verax-node-package-sha256     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      verax-plan                    = "profissional"
      verax-plan-max-cloud-accounts = ""
      verax-plan-max-users          = ""
      verax-plan-monthly-gib        = ""
      verax-plan-history-days       = ""
      verax-web-origin              = "https://demo-a.control.example.com"
      verax-api-origin              = "https://api-demo-a.example.com"
      verax-mail-from               = "nao-responda@example.com"
      verax-tenant-name             = "Cliente Demo A"
      verax-admin-email             = "admin@cliente-demo-a.example.com"
      verax-support-email           = "suporte@example.com"
    })
    error_message = "As chaves dos metadados da instalação (contrato com o PR-N7 e o CP-10) mudaram."
  }

  assert {
    condition = google_compute_instance.node.metadata == tomap(merge(output.install_metadata, {
      enable-oslogin         = "TRUE"
      block-project-ssh-keys = "TRUE"
      serial-port-enable     = "FALSE"
      startup-script         = replace(file("startup.sh.tftpl"), "$${node_profile}", "standard")
    }))
    error_message = "Os metadados da VM não são as chaves da instalação mais as de segurança e o script de boot, sem nada a mais."
  }
}

# Os valores do ambiente entram como vieram (o formato é conferido no envs/tenant): o plano configurável com os quatro
# limites.
run "valores_do_ambiente_como_vieram" {
  command = plan

  variables {
    install_metadata = {
      verax-plan                    = "enterprise"
      verax-plan-max-cloud-accounts = "15"
      verax-plan-max-users          = "20"
      verax-plan-monthly-gib        = "60"
      verax-plan-history-days       = "365"
      verax-tenant-name             = "Ação & \"Filhos\" Ltda."
    }
  }

  assert {
    condition = (
      google_compute_instance.node.metadata["verax-plan"] == "enterprise" &&
      google_compute_instance.node.metadata["verax-plan-max-cloud-accounts"] == "15" &&
      google_compute_instance.node.metadata["verax-plan-max-users"] == "20" &&
      google_compute_instance.node.metadata["verax-plan-monthly-gib"] == "60" &&
      google_compute_instance.node.metadata["verax-plan-history-days"] == "365" &&
      google_compute_instance.node.metadata["verax-tenant-name"] == "Ação & \"Filhos\" Ltda." &&
      google_compute_instance.node.metadata["verax-secret-prefix"] == "vx-demo-a"
    )
    error_message = "Os valores do ambiente não chegaram aos metadados como vieram."
  }
}

# Uma quebra de linha num valor viraria outra linha (outra variável) no node.conf.
run "recusa_quebra_de_linha" {
  command = plan

  variables {
    install_metadata = {
      verax-tenant-name = "Cliente Demo A\nPLAN=interno"
    }
  }

  expect_failures = [var.install_metadata]
}

run "recusa_chave_fora_do_padrao" {
  command = plan

  variables {
    install_metadata = {
      PLAN = "interno"
    }
  }

  expect_failures = [var.install_metadata]
}

# As chaves que o módulo acrescenta não vêm do ambiente: um prefixo de cofre de outro nó apontaria a instalação para os
# cofres dele.
run "recusa_chave_do_modulo" {
  command = plan

  variables {
    install_metadata = {
      verax-secret-prefix = "vx-outro"
    }
  }

  expect_failures = [var.install_metadata]
}

# As duas variáveis andam juntas: as chaves do módulo sem as do ambiente (ou o contrário) deixariam a instalação pela
# metade.
run "recusa_install_config_sem_as_chaves" {
  command = plan

  variables {
    install_metadata = {}
  }

  expect_failures = [var.install_metadata]
}

run "recusa_chaves_sem_install_config" {
  command = plan

  variables {
    install_config = false
  }

  expect_failures = [var.install_metadata]
}
