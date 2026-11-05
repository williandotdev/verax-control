# A VM do nó: API (com a leitura dos logs e as regras de detecção), worker, banco e o túnel do Cloudflare rodam nela,
# em contêineres (pacote em infra/node). No perfil lean (o nó da Verax) não há Wazuh: o worker lê os logs da GCP direto
# do Pub/Sub, e tudo cabe numa e2-micro do nível gratuito. O standard (nó de cliente) tem 8 GB para o Wazuh.

locals {
  # O que cada perfil define. O lean repete o que o nó da Verax tinha antes do módulo, valor por valor: qualquer
  # diferença aqui recriaria o disco ou a política de snapshot dele.
  profiles = {
    lean = {
      machine_types  = ["e2-micro", "e2-small", "e2-medium"]
      disk_type      = "pd-standard"
      disk_gb        = 30
      snapshot_name  = "weekly-snapshot"
      snapshot_days  = 28
      static_nat_ip  = false
      daily_snapshot = false
    }
    standard = {
      machine_types  = ["e2-standard-2", "e2-standard-4"]
      disk_type      = "pd-balanced"
      disk_gb        = 60
      snapshot_name  = "daily-snapshot"
      snapshot_days  = 7
      static_nat_ip  = true
      daily_snapshot = true
    }
  }
  profile       = local.profiles[var.node_profile]
  machine_type  = coalesce(var.machine_type, local.profile.machine_types[0])
  static_nat_ip = local.profile.static_nat_ip

  # Nó novo: o script do módulo vai na chave `startup-script` dos metadados, que muda sem recriar a VM. O nó criado
  # antes do módulo mantém o `metadata_startup_script` dele (veja `legacy_startup_script`).
  startup_metadata = var.legacy_startup_script == null ? {
    startup-script = templatefile("${path.module}/startup.sh.tftpl", { node_profile = var.node_profile })
  } : {}

  # Atributos de convidado (`guest_attributes`): o worker do nó grava o próprio estado no espaço `verax/` pelo
  # servidor de metadados, e o plano de controle lê com `compute.instances.getGuestAttributes` (o papel `cpNodeLifecycle`
  # do envs/nodes-platform, só nas VMs `vx-*`). Chaves: `verax/version`, `verax/accounts-connected`,
  # `verax/last-event-at` e `verax/disk-free` (CP-10), `verax/ready` e `verax/error` (instalação, PR-N7). Mudar os
  # metadados é uma mudança no lugar: a VM não é recriada.
  guest_attributes_metadata = var.guest_attributes ? { enable-guest-attributes = "TRUE" } : {}

  # A configuração do nó para a instalação sem operador: a VM lê cada chave com
  # `curl -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/<chave>`
  # e monta o node.conf (PR-N7) e as contas do cliente (CP-10). Os nomes são um contrato com o pacote do nó: mudar um
  # deles exige mudar a instalação junto, e `verax-config-version` sobe quando o formato muda. Nada aqui é segredo.
  # Os textos são dados (e-mails e nome do cliente, que o cliente digitou no checkout): a instalação nunca os
  # interpreta num shell. Valor vazio é "não definido" (a instalação não escreve a linha).
  #
  # As que o ambiente manda em `install_metadata` (o envs/tenant manda todas; o formato de cada uma é conferido lá):
  #   verax-plan                    PLAN
  #   verax-plan-max-cloud-accounts PLAN_MAX_CLOUD_ACCOUNTS (vazio: o do plano; idem os três seguintes)
  #   verax-plan-max-users          PLAN_MAX_USERS
  #   verax-plan-monthly-gib        PLAN_MONTHLY_GIB
  #   verax-plan-history-days       PLAN_HISTORY_DAYS
  #   verax-node-version            a versão do pacote do nó (`node-vX.Y.Z`, o release do manifesto assinado)
  #   verax-node-package-sha256     o SHA-256 do pacote dessa versão, conferido antes de instalar
  #   verax-images-repository       IMAGES_REPOSITORY
  #   verax-web-origin              WEB_ORIGIN
  #   verax-api-origin              API_ORIGIN
  #   verax-mail-from               MAIL_FROM
  #   verax-tenant-name             o nome do cliente no nó (CP-10)
  #   verax-admin-email             o e-mail do primeiro admin do cliente (CP-10)
  #   verax-support-email           o e-mail da conta de suporte da Verax no nó (CP-10)
  # As que só o módulo conhece, acrescentadas com `install_config`:
  #   verax-config-version          versão deste contrato ("1")
  #   verax-node-profile            NODE_PROFILE
  #   verax-secret-prefix           VERAX_SECRET_PREFIX (o `name_prefix`, `vx-<slug>` no cliente; os cofres são
  #                                 `<prefixo>-<nome>`)
  #   verax-credentials-vault       CREDENTIALS_VAULT ("true" ou "false")
  #   verax-backup-bucket           BACKUP_BUCKET
  #   verax-node-sa-unique-id       NODE_SA_UNIQUE_ID (o ID único da conta de serviço da VM)
  # O projeto não vai aqui: a VM o lê em `project/project-id`, no mesmo servidor de metadados. O IP de saída
  # (NODE_EGRESS_IPS) também não: o checkov 3.4.0 não avalia os metadados com uma referência ao IP reservado do NAT
  # (um recurso com `count`), em forma nenhuma das testadas. A instalação o descobre pela própria saída (todo o tráfego
  # sai por esse IP) ou o recebe do plano de controle (a saída `nat_ip`), decisão do PR-N7.
  #
  # A forma é a que o checkov consegue avaliar nos três ambientes que chamam o módulo, para ele conferir as chaves de
  # segurança dos metadados (CKV_GCP_32): o mapa do ambiente entra direto no `merge`, só com referências diretas; o do
  # módulo é um literal só, ligado por uma variável booleana. Com `merge`, `for`, interpolação, `length`, um campo de
  # objeto ou o IP do NAT ali, o checkov deixava os metadados da VM sem avaliar e reprovava a checagem.
  node_derived_metadata = var.install_config ? local.node_derived_values : {}
  node_derived_values = {
    verax-config-version    = "1"
    verax-node-profile      = var.node_profile
    verax-secret-prefix     = var.name_prefix
    verax-credentials-vault = tostring(var.credentials_vault)
    verax-backup-bucket     = google_storage_bucket.backups.name
    verax-node-sa-unique-id = google_service_account.node.unique_id
  }
}

# Identidade da VM. Sem chave: a VM pega credenciais temporárias pelo servidor de metadados, e nenhuma chave JSON
# de conta de serviço é criada.
#
# É também quem entra na AWS do cliente: o papel verax-control-reader confia no ID único desta conta (o `sub` e o
# `azp` do token que o Google assina para ela; saída `service_account_unique_id`). Recriada, mesmo com o mesmo nome,
# ela ganha outro ID, e o papel de todo cliente deste nó deixa de aceitá-la até cada um atualizar a pilha.
#
# Sem `prevent_destroy` de propósito: a homologação é destruída entre as janelas de teste, e a exclusão do cliente
# (CP-11) destrói o ambiente inteiro; o `lifecycle` não muda por variável. A proteção é outra:
# - o que recria a conta (`account_id` e `project`, os dois ForceNew no provider) sai só do `name_prefix` e do
#   `project_id`, que não mudam na vida do nó; tests/conta_de_servico.tftest.hcl confere que as mudanças de rotina
#   não a recriam;
# - o executor do Terraform do plano de controle (CP-07) recusa um plano que recrie ou apague esta conta, salvo na
#   exclusão do cliente (docs/ARQUITETURA.md, "Exclusão em dois tempos").
# Apagada por engano fora do Terraform, volta com o mesmo ID em até 30 dias (`gcloud iam service-accounts undelete`),
# desde que nenhuma outra tenha sido criada com o mesmo nome.
resource "google_service_account" "node" {
  project      = var.project_id
  account_id   = var.name_prefix
  display_name = "Nó do Verax Control (SOC)"
  description  = "Identidade da VM do nó: lê os logs de segurança e os segredos do nó."
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
# No lean, disco padrão de 30 GB, dentro do nível gratuito; no standard, 60 GB pd-balanced, que cresce sem parar a VM.
# Protegido contra `terraform destroy` (veja o guia).
resource "google_compute_disk" "node" {
  #checkov:skip=CKV_GCP_37:Cifrado pelo Google (AES-256). Chave própria (CMEK/CSEK) não muda o risco que importa aqui: quem domina a VM lê o disco montado.
  name  = var.name_prefix
  type  = local.profile.disk_type
  size  = coalesce(var.disk_gb, local.profile.disk_gb)
  zone  = var.zone
  image = "debian-cloud/debian-12"

  lifecycle {
    prevent_destroy = true
    # Uma imagem nova do Debian não recria o disco; as atualizações são feitas dentro da VM.
    ignore_changes = [image]
  }
}

# Snapshot do disco na mesma região: no lean, semanal, guardado por 4 semanas; no standard, diário, guardado por 7
# dias. O backup diário do banco vai para o bucket.
resource "google_compute_resource_policy" "snapshot" {
  name   = "${var.name_prefix}-${local.profile.snapshot_name}"
  region = var.region

  snapshot_schedule_policy {
    schedule {
      dynamic "weekly_schedule" {
        for_each = local.profile.daily_snapshot ? [] : [1]
        content {
          day_of_weeks {
            day        = "SUNDAY"
            start_time = "06:00"
          }
        }
      }
      dynamic "daily_schedule" {
        for_each = local.profile.daily_snapshot ? [1] : []
        content {
          days_in_cycle = 1
          start_time    = "06:00"
        }
      }
    }
    retention_policy {
      max_retention_days    = local.profile.snapshot_days
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
    snapshot_properties {
      storage_locations = [var.region]
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "node" {
  name = google_compute_resource_policy.snapshot.name
  disk = google_compute_disk.node.name
  zone = var.zone
}

resource "google_compute_instance" "node" {
  #checkov:skip=CKV_GCP_38:O disco é cifrado pelo Google (AES-256); mesmo motivo do recurso do disco.
  name         = var.name_prefix
  machine_type = local.machine_type
  zone         = var.zone

  # Não some por engano: para apagar ou recriar a VM, é preciso desligar esta proteção antes (veja o guia).
  deletion_protection       = var.deletion_protection
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

  # As chaves de segurança vêm depois da configuração do nó e dos atributos de convidado no `merge`: nenhuma delas é
  # sobrescrita. Sem `install_metadata` e sem `guest_attributes` (os padrões), os metadados são os de antes.
  metadata = merge(var.install_metadata, local.node_derived_metadata, local.guest_attributes_metadata, {
    # Login com a conta Google (OS Login), sem chaves SSH soltas no projeto, e sem console serial.
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    serial-port-enable     = "FALSE"
  }, local.startup_metadata)

  # Só prepara a VM (pasta dos dados, swap e ajustes do kernel); não instala nada. Mudar este campo recria a VM: só o
  # nó criado antes do módulo o usa, com o script de sempre.
  metadata_startup_script = var.legacy_startup_script

  depends_on = [google_compute_router_nat.node]

  lifecycle {
    precondition {
      condition     = contains(local.profile.machine_types, local.machine_type)
      error_message = "Tamanho de VM fora do perfil: lean aceita e2-micro, e2-small e e2-medium; standard aceita e2-standard-2 e e2-standard-4."
    }
  }
}

# Acesso de quem opera o nó: túnel do IAP e login de administrador só nesta VM, nada no resto do projeto.
#
# A política de IAM de uma VM some junto com ela. Quando a VM é recriada (a manutenção do GUIA.md), o nome continua o
# mesmo e, sem o `replace_triggered_by`, o Terraform não veria diferença nestes acessos: o estado diria que existem e a
# VM nova nasceria sem eles. Com ele, o `plan` que recria a VM também recria os acessos, na VM nova. O `instance_id`
# só muda quando a VM é recriada; uma mudança no lugar (o tamanho da VM, por exemplo) não mexe nos acessos.
resource "google_iap_tunnel_instance_iam_member" "operators" {
  for_each = toset(var.operators)

  instance = google_compute_instance.node.name
  zone     = var.zone
  role     = "roles/iap.tunnelResourceAccessor"
  member   = each.key

  lifecycle {
    replace_triggered_by = [google_compute_instance.node.instance_id]
  }
}

resource "google_compute_instance_iam_member" "operators" {
  for_each = toset(var.operators)

  instance_name = google_compute_instance.node.name
  zone          = var.zone
  role          = "roles/compute.osAdminLogin"
  member        = each.key

  lifecycle {
    replace_triggered_by = [google_compute_instance.node.instance_id]
  }
}

# O `gcloud compute ssh` lê o projeto antes de conectar (`compute.projects.get`), e o OS Login concedido só na VM
# não cobre isso. Um papel próprio, só com essa permissão, evita dar leitura do Compute inteiro a quem opera.
resource "google_project_iam_custom_role" "operator_lookup" {
  count = length(var.operators) > 0 ? 1 : 0

  role_id     = replace("${var.name_prefix}_operator_lookup", "-", "_")
  title       = "Operador do nó: ler o projeto para o SSH"
  description = "Só compute.projects.get, que o gcloud compute ssh exige antes de conectar pelo IAP."
  permissions = ["compute.projects.get"]
}

resource "google_project_iam_member" "operator_lookup" {
  for_each = toset(var.operators)

  project = var.project_id
  role    = google_project_iam_custom_role.operator_lookup[0].id
  member  = each.key
}

# Entrar numa VM que tem conta de serviço exige poder "usar" essa conta.
resource "google_service_account_iam_member" "operators" {
  for_each = toset(var.operators)

  service_account_id = google_service_account.node.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.key
}
