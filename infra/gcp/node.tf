# A VM do nó: API (com a leitura dos logs e as regras de detecção), banco e o túnel do Cloudflare rodam nela, em
# contêineres (o pacote vem no próximo passo). Sem Wazuh: para monitorar a GCP e o Cloudflare, a API lê os logs
# direto do Pub/Sub, e tudo cabe numa e2-micro do nível gratuito.

# Identidade da VM. Sem chave: a VM pega credenciais temporárias pelo servidor de metadados, e nenhuma chave JSON
# de conta de serviço é criada.
resource "google_service_account" "node" {
  account_id   = var.name_prefix
  display_name = "Nó do Verax Control (SOC)"
  description  = "Identidade da VM do nó: lê os logs de segurança e os segredos do nó."

  depends_on = [google_project_service.apis]
}

locals {
  node_member = "serviceAccount:${google_service_account.node.email}"

  # Só o que a VM usa hoje: mandar os próprios logs e métricas. Os papéis de leitura da configuração do projeto,
  # para a postura e o inventário, entram junto com essa etapa.
  node_project_roles = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])
}

resource "google_project_iam_member" "node" {
  for_each = local.node_project_roles

  project = var.project_id
  role    = each.key
  member  = local.node_member
}

# Disco único da VM (sistema, banco e dados do nó), criado à parte da VM: se a VM for apagada, o disco fica.
# Disco padrão de 30 GB, dentro do nível gratuito. Protegido contra `terraform destroy` (veja o guia).
resource "google_compute_disk" "node" {
  #checkov:skip=CKV_GCP_37:Cifrado pelo Google (AES-256). Chave própria (CMEK/CSEK) não muda o risco que importa aqui: quem domina a VM lê o disco montado.
  name  = var.name_prefix
  type  = "pd-standard"
  size  = var.disk_gb
  zone  = var.zone
  image = "debian-cloud/debian-12"

  depends_on = [google_project_service.apis]

  lifecycle {
    prevent_destroy = true
    # Uma imagem nova do Debian não recria o disco; as atualizações são feitas dentro da VM.
    ignore_changes = [image]
  }
}

# Snapshot semanal do disco, guardado por 4 semanas na mesma região. O backup diário do banco vai para o bucket.
resource "google_compute_resource_policy" "weekly_snapshot" {
  name   = "${var.name_prefix}-weekly-snapshot"
  region = var.region

  depends_on = [google_project_service.apis]

  snapshot_schedule_policy {
    schedule {
      weekly_schedule {
        day_of_weeks {
          day        = "SUNDAY"
          start_time = "06:00"
        }
      }
    }
    retention_policy {
      max_retention_days    = 28
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
    snapshot_properties {
      storage_locations = [var.region]
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "node" {
  name = google_compute_resource_policy.weekly_snapshot.name
  disk = google_compute_disk.node.name
  zone = var.zone
}

resource "google_compute_instance" "node" {
  #checkov:skip=CKV_GCP_38:O disco é cifrado pelo Google (AES-256); mesmo motivo do recurso do disco.
  name         = var.name_prefix
  machine_type = var.machine_type
  zone         = var.zone

  # Não some por engano: para apagar, é preciso desligar esta proteção antes (veja o guia).
  deletion_protection       = true
  allow_stopping_for_update = true

  boot_disk {
    source      = google_compute_disk.node.self_link
    auto_delete = false
  }

  # Sem `access_config`: a VM não tem IP público.
  network_interface {
    subnetwork = google_compute_subnetwork.node.id
  }

  service_account {
    email = google_service_account.node.email
    # O que a VM pode fazer é decidido pelos papéis da conta de serviço acima, não pelo escopo.
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    # Login com a conta Google (OS Login), sem chaves SSH soltas no projeto, e sem console serial.
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    serial-port-enable     = "FALSE"
  }

  # Só prepara a VM (pasta dos dados e memória de troca); não instala nada ainda.
  metadata_startup_script = file("${path.module}/startup.sh")

  depends_on = [google_compute_router_nat.node]
}

# Acesso de quem opera o nó: túnel do IAP e login de administrador só nesta VM, nada no resto do projeto.
resource "google_iap_tunnel_instance_iam_member" "operators" {
  for_each = toset(var.operators)

  instance = google_compute_instance.node.name
  zone     = var.zone
  role     = "roles/iap.tunnelResourceAccessor"
  member   = each.key
}

resource "google_compute_instance_iam_member" "operators" {
  for_each = toset(var.operators)

  instance_name = google_compute_instance.node.name
  zone          = var.zone
  role          = "roles/compute.osAdminLogin"
  member        = each.key
}

# Entrar numa VM que tem conta de serviço exige poder "usar" essa conta.
resource "google_service_account_iam_member" "operators" {
  for_each = toset(var.operators)

  service_account_id = google_service_account.node.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.key
}
