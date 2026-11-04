# Agentes do Wazuh nas instâncias do cliente (`wazuh_agents`, desligado por padrão; só no perfil standard). O cliente
# instala o agente nas VMs e EC2 dele, e os agentes falam com o manager do nó pelas portas 1514 (eventos, conexão
# segura com a chave de cada agente) e 1515 (registro com a senha do nó). Com o interruptor desligado, nada daqui
# existe e o nó é o de sempre, sem nenhuma porta aberta.
#
# Por que um IP de encaminhamento (protocol forwarding) e não um IP externo na VM: na GCP, uma interface com IP externo
# faz o NAT um para um por ele e deixa de usar o Cloud NAT (docs.cloud.google.com/nat/docs/public-nat). Toda a saída do
# nó passaria a sair por outro IP, e a chave da AWS do cliente, que só vale a partir do IP reservado do NAT, pararia de
# funcionar. Com a regra de encaminhamento, a VM continua sem IP externo: o que chega no IP fixo, nas duas portas, é
# entregue à VM com o IP de origem do agente preservado, a resposta sai com o IP da regra, e a saída que o nó inicia
# continua pelo Cloud NAT. O ambiente de convidado da imagem do Debian da GCP aceita o IP da regra na VM, e o Docker
# entrega as duas portas ao manager (infra/node/compose.wazuh-agents.yaml).
#
# Quem pode chegar às portas é só quem está em `wazuh_agents_sources` (as faixas de saída do cliente). Lista vazia: a
# regra de entrada não existe, e a regra `deny-ingress` (prioridade 65000) recusa tudo; o painel diz que a liberação
# está pendente.

resource "google_compute_address" "agents" {
  count = var.wazuh_agents ? 1 : 0

  name         = "${var.name_prefix}-agents-ip"
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
  description  = "IP fixo de entrada dos agentes do Wazuh nas instâncias do cliente (TCP 1514 e 1515)."
}

# A VM como destino da regra de encaminhamento. A VM recriada (a manutenção do GUIA.md) leva o destino junto, como os
# acessos dos operadores.
resource "google_compute_target_instance" "agents" {
  count = var.wazuh_agents ? 1 : 0

  name        = "${var.name_prefix}-agents"
  zone        = var.zone
  instance    = google_compute_instance.node.self_link
  description = "VM do nó, destino dos agentes do Wazuh."

  lifecycle {
    replace_triggered_by = [google_compute_instance.node.instance_id]
  }
}

resource "google_compute_forwarding_rule" "agents" {
  count = var.wazuh_agents ? 1 : 0

  name                  = "${var.name_prefix}-agents"
  region                = var.region
  ip_address            = google_compute_address.agents[0].address
  ip_protocol           = "TCP"
  port_range            = "1514-1515"
  target                = google_compute_target_instance.agents[0].self_link
  load_balancing_scheme = "EXTERNAL"
  network_tier          = "PREMIUM"
  description           = "Agentes do Wazuh: 1514 (eventos) e 1515 (registro) para a VM do nó."
}

# Só as faixas do cliente, só as duas portas, só para a VM do nó; cada conexão fica registrada.
resource "google_compute_firewall" "agents" {
  count = var.wazuh_agents && length(var.wazuh_agents_sources) > 0 ? 1 : 0

  name      = "${var.name_prefix}-allow-wazuh-agents"
  network   = google_compute_network.node.id
  direction = "INGRESS"
  priority  = 1000

  source_ranges           = var.wazuh_agents_sources
  target_service_accounts = [google_service_account.node.email]

  allow {
    protocol = "tcp"
    ports    = ["1514", "1515"]
  }

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}
