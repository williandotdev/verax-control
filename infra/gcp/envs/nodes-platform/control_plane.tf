# O que o plano de controle pode fazer neste projeto (plano da fase 3, seção 2.2), só com `control_plane_project_id`
# preenchido. Estava no envs/control-plane (cross_project.tf) até o CP-06 e mudou para cá: tudo o que vale no projeto
# dos nós fica no ambiente do projeto dos nós, e o bucket do estado e as concessões nele ficam no mesmo estado (a
# concessão nunca chega antes do bucket). As contas são as do envs/control-plane (identities.tf: `cp-terraform` e
# `cp-worker`, com esses nomes fixos; um teste confere).
#
# Por tenant, o envs/tenant concede ao cp-worker o resto (nos cofres daquele nó, e só neles): ler e destruir a senha
# temporária do primeiro admin, gravar o token do túnel e destruir as versões da chave do cofre de credenciais (o papel
# `cpSecretVersionDestroyer`, abaixo). Nunca ler o cofre de credenciais, nem o cofre da conta de suporte.
#
# TODO(CP-12): o alerta por log em `SetIamPolicy` feito pelo cp-terraform com um papel fora da lista permitida é deste
# projeto (é aqui que o `projectIamAdmin` dele vale) e entra neste ambiente.

locals {
  control_plane_enabled = var.control_plane_project_id != ""
  terraform_member      = "serviceAccount:cp-terraform@${var.control_plane_project_id}.iam.gserviceaccount.com"
  worker_member         = "serviceAccount:cp-worker@${var.control_plane_project_id}.iam.gserviceaccount.com"

  # Os papéis do executor Terraform neste projeto: o que o módulo `node` cria (rede, NAT, VM, disco, snapshot, conta de
  # serviço e papéis dela, segredos, Pub/Sub, bucket de backups e alerta). `projectIamAdmin` é o mais sensível (plano,
  # seção 2.2): o Job só roda a imagem fixada, só com variáveis validadas, num projeto que contém só nós, e o CP-12
  # alerta em `SetIamPolicy` fora da lista.
  #
  # Dois papéis da seção 2.2 ficam de fora, de propósito: `secretmanager.admin` e `storage.admin` no projeto
  # inteiro deixariam o cp-terraform ler a chave privada do cofre de credenciais de todo tenant, as senhas
  # temporárias, os tokens de túnel e os backups do Postgres de todos os nós. No lugar deles, os dois papéis
  # personalizados abaixo: criar, mudar, apagar e dar acesso a cofres e buckets, sem ler o conteúdo de nenhum. É tudo
  # o que o módulo `node` faz com eles (cofres vazios com os papéis da VM e do cp-worker; o bucket de backups com
  # `force_destroy = false`, sem tocar em objeto). O estado dos tenants fica no `objectAdmin` explícito do bucket do
  # estado. Com o `projectIamAdmin`, o cp-terraform ainda poderia se conceder a leitura; é o que o alerta em
  # `SetIamPolicy` do CP-12 vigia: a leitura deixa de ser silenciosa.
  terraform_predefined_roles = [
    "roles/compute.instanceAdmin.v1",
    "roles/compute.networkAdmin",
    "roles/compute.securityAdmin",
    "roles/compute.storageAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/resourcemanager.projectIamAdmin",
    "roles/pubsub.admin",
    "roles/monitoring.alertPolicyEditor",
    "roles/monitoring.notificationChannelEditor",
  ]

  terraform_roles = local.control_plane_enabled ? merge(
    { for role in local.terraform_predefined_roles : role => role },
    {
      cpSecretsProvisioner = google_project_iam_custom_role.secrets_provisioner[0].id
      cpBucketsProvisioner = google_project_iam_custom_role.buckets_provisioner[0].id
    },
  ) : {}
}

# Cofres do Secret Manager: o contêiner e a política de acesso, nunca o conteúdo. Sem `versions.access` (ler), sem
# `versions.add` (gravar) e sem `versions.destroy`; `versions.list` só mostra os metadados.
resource "google_project_iam_custom_role" "secrets_provisioner" {
  count = local.control_plane_enabled ? 1 : 0

  project     = var.project_id
  role_id     = "cpSecretsProvisioner"
  title       = "Verax Control: cria os cofres dos nós"
  description = "Cria, muda, apaga e dá acesso aos cofres do Secret Manager dos nós de clientes, sem ler nem gravar versão."
  permissions = [
    "secretmanager.secrets.create",
    "secretmanager.secrets.delete",
    "secretmanager.secrets.get",
    "secretmanager.secrets.list",
    "secretmanager.secrets.update",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.setIamPolicy",
    "secretmanager.versions.list",
  ]

  depends_on = [google_project_service.apis]
}

# Buckets do Cloud Storage: o bucket e a política de acesso, nunca os objetos (nenhum `storage.objects.*`).
resource "google_project_iam_custom_role" "buckets_provisioner" {
  count = local.control_plane_enabled ? 1 : 0

  project     = var.project_id
  role_id     = "cpBucketsProvisioner"
  title       = "Verax Control: cria os buckets dos nós"
  description = "Cria, muda, apaga e dá acesso aos buckets dos nós de clientes (backups), sem ler nem gravar objeto."
  permissions = [
    "storage.buckets.create",
    "storage.buckets.delete",
    "storage.buckets.get",
    "storage.buckets.list",
    "storage.buckets.update",
    "storage.buckets.getIamPolicy",
    "storage.buckets.setIamPolicy",
  ]

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "terraform_nodes" {
  for_each = local.terraform_roles

  project = var.project_id
  role    = each.value
  member  = local.terraform_member
}

# O estado de cada tenant (`tenants/<slug>/`) e o `outputs.json` de cada execução (`runs/<slug>/<runId>/`). É a única
# leitura e gravação de objeto que o cp-terraform tem neste projeto (o `cpBucketsProvisioner` não alcança objeto). O
# bucket tem também o estado da homologação e o deste ambiente: com o `projectIamAdmin`, o cp-terraform já alcançaria
# os dois de qualquer jeito; a vigilância é o alerta do CP-12.
resource "google_storage_bucket_iam_member" "terraform_state" {
  count = local.control_plane_enabled ? 1 : 0

  bucket = google_storage_bucket.tfstate.name
  role   = "roles/storage.objectAdmin"
  member = local.terraform_member
}

# O cp-worker lê só `runs/` do bucket do estado (os `outputs.json`), nunca o estado dos tenants. A condição exige o
# acesso uniforme no nível do bucket (state.tf).
resource "google_storage_bucket_iam_member" "worker_runs" {
  count = local.control_plane_enabled ? 1 : 0

  bucket = google_storage_bucket.tfstate.name
  role   = "roles/storage.objectViewer"
  member = local.worker_member

  condition {
    title       = "Só a pasta runs/"
    description = "Os outputs.json das execuções do executor Terraform."
    expression  = "resource.name.startsWith(\"projects/_/buckets/${google_storage_bucket.tfstate.name}/objects/runs/\")"
  }
}

# Parar, ligar e ler o estado (atributos de convidado) das VMs dos nós, e só das que começam com `vx-`. Suspensão por
# inadimplência, reativação e o `tick` (plano, 4b e 4d). Os atributos são os que o módulo liga com `guest_attributes`
# (modules/node/node.tf).
resource "google_project_iam_custom_role" "node_lifecycle" {
  count = local.control_plane_enabled ? 1 : 0

  project     = var.project_id
  role_id     = "cpNodeLifecycle"
  title       = "Verax Control: ciclo de vida das VMs dos nós"
  description = "Parar, ligar e ler os atributos de convidado das VMs dos nós de clientes (vx-*)."
  permissions = [
    "compute.instances.get",
    "compute.instances.start",
    "compute.instances.stop",
    "compute.instances.getGuestAttributes",
  ]

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "worker_node_lifecycle" {
  count = local.control_plane_enabled ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.node_lifecycle[0].id
  member  = local.worker_member

  condition {
    title       = "Só as VMs dos nós de clientes (vx-*)"
    description = "Nenhuma outra VM do projeto, hoje ou no futuro."
    expression  = "resource.type == \"compute.googleapis.com/Instance\" && resource.name.extract(\"/instances/{name}\").startsWith(\"vx-\")"
  }
}

# A atualização da frota (docs/ARQUITETURA.md, "Atualização da frota"): o cp-worker grava o pedido de versão nos
# metadados das VMs dos nós (`instances.setMetadata`, com a impressão digital lida por `instances.get`) e acompanha o
# host pelos guest attributes. Só nas VMs `vx-*`, como o `cpNodeLifecycle`; o `get` e o `getGuestAttributes` repetem os
# dele para o papel ser o mesmo no projeto da célula (envs/celula), onde não há o de ciclo de vida.
#
# Por que não menos: o `setMetadata` troca os metadados inteiros, e a GCP não restringe a permissão por chave. Com ele
# (e o `iam.serviceAccountUser` na conta de cada nó, que o envs/tenant concede e a API exige numa VM com conta de
# serviço), o cp-worker poderia trocar o `startup-script` e, com o `start`/`stop` que já tem, rodar código na VM no boot
# seguinte. É o risco aceito pela decisão de 16/11/2026, com estas contenções: só as VMs `vx-*`; o atualizador do host
# só instala versão assinada pela Verax (a chave de release não está no plano de controle); o Terraform do tenant
# reescreve as chaves dele no próximo `apply`; e toda chamada fica nos logs de auditoria de atividade do Compute.
resource "google_project_iam_custom_role" "node_updater" {
  count = local.control_plane_enabled ? 1 : 0

  project     = var.project_id
  role_id     = "cpNodeUpdater"
  title       = "Verax Control: pedido de versão das VMs dos nós"
  description = "Ler a VM e os atributos de convidado e gravar os metadados (o pedido de versão da frota) das VMs dos nós (vx-*)."
  permissions = [
    "compute.instances.get",
    "compute.instances.getGuestAttributes",
    "compute.instances.setMetadata",
  ]

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "worker_node_updater" {
  count = local.control_plane_enabled ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.node_updater[0].id
  member  = local.worker_member

  condition {
    title       = "Só as VMs dos nós de clientes (vx-*)"
    description = "O pedido de versão da frota, em nenhuma outra VM do projeto, hoje ou no futuro."
    expression  = "resource.type == \"compute.googleapis.com/Instance\" && resource.name.extract(\"/instances/{name}\").startsWith(\"vx-\")"
  }
}

# Destruir as versões da chave do cofre de credenciais na Exclusão 2 (D+97, cripto-destruição), sem ler nem gravar
# versão. Não é concedido no projeto: o envs/tenant dá este papel ao cp-worker só no `credentials-key` de cada nó. O
# papel predefinido `secretVersionManager`, que o plano citava, também deixaria o cp-worker gravar uma versão nova da
# chave (`versions.add`) e reativar uma desativada (`versions.enable`); este só destrói e lista.
resource "google_project_iam_custom_role" "secret_version_destroyer" {
  count = local.control_plane_enabled ? 1 : 0

  project     = var.project_id
  role_id     = "cpSecretVersionDestroyer"
  title       = "Verax Control: destrói as versões de um cofre"
  description = "Listar e destruir as versões de um cofre do Secret Manager, sem ler nem gravar versão. Concedido por cofre."
  permissions = [
    "secretmanager.versions.destroy",
    "secretmanager.versions.get",
    "secretmanager.versions.list",
  ]

  depends_on = [google_project_service.apis]
}

# Suspender o cliente da célula (CE-07): desativar e reativar a conta de serviço `vxt-<slug>` dele, que o
# envs/cell-tenant cria neste projeto. Não é concedido no projeto: o envs/cell-tenant o dá ao cp-worker só na conta de
# cada cliente. As contas, os cofres e os tópicos dos clientes da célula ficam aqui, e não no projeto da célula (o do nó
# da Verax, com a chave de release), porque aqui o cp-terraform já administra contas de serviço, cofres e Pub/Sub: no
# projeto da Verax, a mesma permissão alcançaria a conta que assina as versões do nó (docs/ARQUITETURA.md, "Célula
# compartilhada (Plataforma)").
resource "google_project_iam_custom_role" "tenant_sa_toggle" {
  count = local.control_plane_enabled ? 1 : 0

  project     = var.project_id
  role_id     = "cpTenantSaToggle"
  title       = "Verax Control: suspender a conta de um cliente da célula"
  description = "Desativar e reativar uma conta de serviço. Concedido ao cp-worker só na conta de cada cliente da célula (envs/cell-tenant)."
  permissions = [
    "iam.serviceAccounts.disable",
    "iam.serviceAccounts.enable",
    "iam.serviceAccounts.get",
  ]

  depends_on = [google_project_service.apis]
}

# O ambiente na VM do cliente (`hosting = customer`, o registro da VM no plano de controle): não há envs/tenant, então o
# cofre da senha temporária do primeiro admin (`vx-<slug>-admin-bootstrap`, o mesmo nome do gerenciado) é criado pelo
# próprio cp-worker quando a VM avisa que ficou pronta (`report ready`), e as permissões dele nesse cofre não podem ser
# dadas por cofre. São duas concessões no projeto, para o cp-worker:
#
# - `cpBootstrapSecretCreator`: só criar um cofre (`secrets.create`). A GCP confere a criação contra o projeto, e não
#   contra o nome do cofre que ainda não existe: uma condição de nome não serviria. Um cofre criado nasce vazio e sem
#   nenhuma permissão para quem o criou; com esta permissão sozinha, o cp-worker não lê, não grava versão, não apaga e
#   não dá acesso a nenhum cofre;
# - `cpBootstrapSecretWriter`: no cofre e nas versões, só nos `vx-<...>-admin-bootstrap` (a condição pelo nome), o que
#   o envs/tenant já dá ao cp-worker no cofre de cada nó gerenciado (`secretAccessor` e `secretVersionManager`): gravar a
#   senha (`versions.add`), ver o estado da `latest` (`access.ready`), ler uma vez na revelação e destruir as versões
#   depois (`secrets.destroy_bootstrap`). Nos nós gerenciados não é poder novo (o cp-worker já tem o mesmo em cada um);
#   fora desse nome (o cofre de credenciais, o token do túnel, a conta de suporte), nada.
resource "google_project_iam_custom_role" "bootstrap_secret_creator" {
  count = local.control_plane_enabled ? 1 : 0

  project     = var.project_id
  role_id     = "cpBootstrapSecretCreator"
  title       = "Verax Control: cria o cofre vazio da senha inicial da VM do cliente"
  description = "Só criar um cofre do Secret Manager (vazio, sem permissão para quem cria). O admin-bootstrap da VM do cliente."
  permissions = ["secretmanager.secrets.create"]

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "worker_bootstrap_secret_creator" {
  count = local.control_plane_enabled ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.bootstrap_secret_creator[0].id
  member  = local.worker_member
}

resource "google_project_iam_custom_role" "bootstrap_secret_writer" {
  count = local.control_plane_enabled ? 1 : 0

  project     = var.project_id
  role_id     = "cpBootstrapSecretWriter"
  title       = "Verax Control: senha inicial no cofre da VM do cliente"
  description = "Gravar, ler e destruir as versões do cofre admin-bootstrap. Concedido com condição pelo nome (vx-*-admin-bootstrap)."
  permissions = [
    "secretmanager.secrets.get",
    "secretmanager.versions.access",
    "secretmanager.versions.add",
    "secretmanager.versions.destroy",
    "secretmanager.versions.get",
    "secretmanager.versions.list",
  ]

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "worker_bootstrap_secret_writer" {
  count = local.control_plane_enabled ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.bootstrap_secret_writer[0].id
  member  = local.worker_member

  # O cofre (`projects/<n>/secrets/vx-<slug>-admin-bootstrap`) ou uma versão dele (`.../versions/<v>`). O `vxt-` dos
  # clientes da célula não começa com `vx-`.
  condition {
    title       = "Só os cofres vx-*-admin-bootstrap"
    description = "A senha temporária do primeiro admin, em nenhum outro cofre do projeto, hoje ou no futuro."
    expression  = "(resource.name.endsWith(\"-admin-bootstrap\") && resource.name.extract(\"/secrets/{name}\").startsWith(\"vx-\")) || (resource.name.extract(\"/secrets/{name}/versions/\").startsWith(\"vx-\") && resource.name.extract(\"/secrets/{name}/versions/\").endsWith(\"-admin-bootstrap\"))"
  }
}
