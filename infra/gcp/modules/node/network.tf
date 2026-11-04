# Rede própria do nó, separada de qualquer outra do projeto. A VM não tem IP público: sai para a internet pelo
# Cloud NAT (baixar imagens, falar com o Cloudflare) e ninguém de fora consegue iniciar conexão com ela.

resource "google_compute_network" "node" {
  name                    = "${var.name_prefix}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "node" {
  name                     = "${var.name_prefix}-subnet"
  network                  = google_compute_network.node.id
  region                   = var.region
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true

  # Registro do tráfego da rede (flow logs), para investigar um incidente no próprio nó. Amostra de 10% em janelas
  # de 15 minutos: o bastante para ver com quem a VM falou, com custo desprezível.
  log_config {
    aggregation_interval = "INTERVAL_15_MIN"
    flow_sampling        = 0.1
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_router" "node" {
  name    = "${var.name_prefix}-router"
  network = google_compute_network.node.id
  region  = var.region
}

# IP de saída fixo, no perfil standard: é o único IP de onde a chave de leitura da AWS do cliente funciona (a política
# IAM nega qualquer outro). Se ele mudasse, a coleta pararia até o cliente atualizar a pilha; por isso o endereço é
# reservado e protegido contra `terraform destroy`. O lean (nó da Verax) sai pelo IP automático do NAT.
resource "google_compute_address" "nat" {
  count = local.static_nat_ip ? 1 : 0

  name         = "${var.name_prefix}-nat-ip"
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
  description  = "IP de saída do nó (Cloud NAT): o que a política IAM da AWS do cliente libera."

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_router_nat" "node" {
  name                               = "${var.name_prefix}-nat"
  router                             = google_compute_router.node.name
  region                             = var.region
  nat_ip_allocate_option             = local.static_nat_ip ? "MANUAL_ONLY" : "AUTO_ONLY"
  nat_ips                            = local.static_nat_ip ? google_compute_address.nat[*].self_link : null
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.node.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# SSH só pelo IAP do Google (faixa fixa dele), e só para a VM do nó: não há porta 22 aberta para a internet.
# Quem entra precisa estar em `operators` (ou ser dono do projeto) e passa pelo login com a conta Google.
resource "google_compute_firewall" "iap_ssh" {
  name      = "${var.name_prefix}-allow-iap-ssh"
  network   = google_compute_network.node.id
  direction = "INGRESS"
  priority  = 1000

  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [google_service_account.node.email]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}

# Todo o resto que chega é recusado e registrado. A GCP já recusa por padrão; a regra explícita deixa a intenção
# clara e grava as tentativas.
resource "google_compute_firewall" "deny_ingress" {
  name      = "${var.name_prefix}-deny-ingress"
  network   = google_compute_network.node.id
  direction = "INGRESS"
  priority  = 65000

  source_ranges = ["0.0.0.0/0"]

  deny {
    protocol = "all"
  }

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}
