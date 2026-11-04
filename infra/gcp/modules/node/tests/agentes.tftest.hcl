# Agentes do Wazuh nas instâncias do cliente (`wazuh_agents`): desligado por padrão (nada é criado e a VM não muda);
# ligado, um IP fixo de entrada na frente da VM, só nas portas 1514 e 1515, e a regra de entrada só com as faixas do
# cliente (sem faixa, nenhuma regra). A VM continua sem IP externo, e a saída continua pelo IP reservado do Cloud NAT.
# E o que a variável recusa.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada.

mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      email = "verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_compute_address" {
    defaults = {
      address = "203.0.113.10"
    }
  }
}

variables {
  project_id   = "projeto-exemplo-nos"
  region       = "southamerica-east1"
  zone         = "southamerica-east1-b"
  name_prefix  = "verax-teste"
  subnet_cidr  = "10.81.0.0/24"
  node_profile = "standard"
}

run "desligado_por_padrao" {
  command = plan

  assert {
    condition = (
      length(google_compute_address.agents) == 0 &&
      length(google_compute_target_instance.agents) == 0 &&
      length(google_compute_forwarding_rule.agents) == 0 &&
      length(google_compute_firewall.agents) == 0 &&
      output.wazuh_agents == null
    )
    error_message = "Sem wazuh_agents, nenhum recurso dos agentes existe."
  }

  assert {
    condition     = length(google_compute_instance.node.network_interface[0].access_config) == 0
    error_message = "A VM do nó não tem IP externo."
  }
}

run "lean_recusado" {
  command = plan

  variables {
    node_profile = "lean"
    wazuh_agents = true
  }

  expect_failures = [var.wazuh_agents]
}

run "faixas_sem_o_interruptor_recusadas" {
  command = plan

  variables {
    wazuh_agents_sources = ["198.51.100.0/28"]
  }

  expect_failures = [var.wazuh_agents_sources]
}

run "internet_inteira_recusada" {
  command = plan

  variables {
    wazuh_agents         = true
    wazuh_agents_sources = ["0.0.0.0/0"]
  }

  expect_failures = [var.wazuh_agents_sources]
}

run "faixa_larga_demais_recusada" {
  command = plan

  variables {
    wazuh_agents         = true
    wazuh_agents_sources = ["10.0.0.0/8"]
  }

  expect_failures = [var.wazuh_agents_sources]
}

run "faixa_fora_do_endereco_da_rede_recusada" {
  command = plan

  variables {
    wazuh_agents         = true
    wazuh_agents_sources = ["198.51.100.7/28"]
  }

  expect_failures = [var.wazuh_agents_sources]
}

run "faixa_que_nao_e_ipv4_recusada" {
  command = plan

  variables {
    wazuh_agents         = true
    wazuh_agents_sources = ["2001:db8::/48"]
  }

  expect_failures = [var.wazuh_agents_sources]
}

run "faixa_repetida_recusada" {
  command = plan

  variables {
    wazuh_agents         = true
    wazuh_agents_sources = ["192.0.2.15/32", "192.0.2.15/32"]
  }

  expect_failures = [var.wazuh_agents_sources]
}

# Por último, os que aplicam (o estado do teste guarda o IP do NAT, protegido contra a destruição: um plano do lean
# depois deles tentaria apagá-lo).
run "ligado_com_as_faixas_do_cliente" {
  variables {
    wazuh_agents         = true
    wazuh_agents_sources = ["198.51.100.0/28", "192.0.2.15/32"]
  }

  assert {
    condition = (
      google_compute_address.agents[0].name == "verax-teste-agents-ip" &&
      google_compute_address.agents[0].address_type == "EXTERNAL" &&
      google_compute_address.agents[0].region == "southamerica-east1"
    )
    error_message = "O IP fixo dos agentes é externo, na região do nó."
  }

  assert {
    condition = (
      google_compute_forwarding_rule.agents[0].ip_address == google_compute_address.agents[0].address &&
      google_compute_forwarding_rule.agents[0].ip_protocol == "TCP" &&
      google_compute_forwarding_rule.agents[0].port_range == "1514-1515" &&
      google_compute_forwarding_rule.agents[0].load_balancing_scheme == "EXTERNAL" &&
      google_compute_forwarding_rule.agents[0].target == google_compute_target_instance.agents[0].self_link &&
      google_compute_target_instance.agents[0].instance == google_compute_instance.node.self_link
    )
    error_message = "A regra de encaminhamento leva o IP fixo, só TCP 1514 e 1515, para a VM do nó."
  }

  assert {
    condition = (
      length(google_compute_firewall.agents) == 1 &&
      google_compute_firewall.agents[0].name == "verax-teste-allow-wazuh-agents" &&
      google_compute_firewall.agents[0].direction == "INGRESS" &&
      toset(google_compute_firewall.agents[0].source_ranges) == toset(["198.51.100.0/28", "192.0.2.15/32"]) &&
      length(google_compute_firewall.agents[0].allow) == 1 &&
      [for rule in google_compute_firewall.agents[0].allow : rule.protocol] == ["tcp"] &&
      [for rule in google_compute_firewall.agents[0].allow : toset(rule.ports)][0] == toset(["1514", "1515"]) &&
      length(google_compute_firewall.agents[0].deny) == 0 &&
      tolist(google_compute_firewall.agents[0].target_service_accounts) == tolist(["verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com"])
    )
    error_message = "A regra de entrada libera exatamente TCP 1514 e 1515, só das faixas do cliente e só para a VM do nó."
  }

  # A saída do nó não muda: a VM segue sem IP externo (com um, o NAT um para um passaria na frente do Cloud NAT) e o
  # NAT continua com o IP reservado, o que a política IAM da AWS do cliente libera.
  assert {
    condition = (
      length(google_compute_instance.node.network_interface[0].access_config) == 0 &&
      google_compute_router_nat.node.nat_ip_allocate_option == "MANUAL_ONLY" &&
      length(google_compute_address.nat) == 1
    )
    error_message = "Com os agentes, a VM ganhou IP externo ou o NAT mudou."
  }

  assert {
    condition = (
      output.wazuh_agents.address == "203.0.113.10" &&
      output.wazuh_agents.sources == tolist(["198.51.100.0/28", "192.0.2.15/32"]) &&
      !output.wazuh_agents.allowlist_pending
    )
    error_message = "A saída wazuh_agents traz o IP fixo (WAZUH_AGENTS_ADDRESS) e as faixas (WAZUH_AGENTS_SOURCES)."
  }
}

run "ligado_sem_faixas_fica_fechado" {
  variables {
    wazuh_agents = true
  }

  assert {
    condition = (
      length(google_compute_address.agents) == 1 &&
      length(google_compute_forwarding_rule.agents) == 1 &&
      length(google_compute_firewall.agents) == 0 &&
      output.wazuh_agents.allowlist_pending
    )
    error_message = "Sem faixa, o IP existe, mas nenhuma regra de entrada (a deny-ingress recusa tudo) e a liberação fica pendente."
  }
}
