# O nó do cliente, perfil standard (o mesmo da homologação), com o prefixo `vx-<slug>` em todo recurso. O que é do
# projeto inteiro (APIs, orçamento, bucket do estado e os papéis do plano de controle) fica no envs/nodes-platform; o
# que este ambiente cria fora do módulo são só permissões: as do cp-worker nos cofres deste nó (control_plane.tf) e a
# leitura do registro das imagens para a conta da VM.
#
# A conta de serviço do nó (`vx-<slug>`) é quem entra na AWS do cliente, pelo ID único dela: só o `slug` e o
# `project_id` decidem se ela é recriada, e nenhum dos dois muda na vida do nó (modules/node/node.tf e
# tests/conta_de_servico.tftest.hcl, aqui e no módulo). Uma versão nova, outro plano, outros limites ou a proteção
# desligada são mudanças no lugar.

locals {
  name_prefix       = "vx-${var.slug}"
  images_repository = "${var.images_location}-docker.pkg.dev/${var.images_project_id}/${var.images_repository_id}"
}

module "node" {
  source = "../../modules/node"

  project_id          = var.project_id
  region              = var.region
  zone                = var.zone
  name_prefix         = local.name_prefix
  node_profile        = "standard"
  subnet_cidr         = var.subnet_cidr
  deletion_protection = var.deletion_protection

  # Os cofres que a VM grava, ditos aqui mesmo quando são o padrão: o nó do cliente depende de todos.
  credentials_vault        = true
  bootstrap_secret         = true
  support_bootstrap_secret = true

  # O estado do nó para o plano de controle (o `tick` e o `node.wait_ready` leem com o `cpNodeLifecycle`).
  guest_attributes = true

  # A configuração do nó nos metadados da VM, para a instalação sem operador (PR-N7) e as contas do cliente (CP-10):
  # as chaves do contrato (modules/node/node.tf), cada uma com uma variável já conferida. Só referências diretas, para
  # o checkov avaliar os metadados da VM (as chaves de segurança, CKV_GCP_32).
  install_config = true
  install_metadata = {
    verax-plan                    = var.plan
    verax-plan-max-cloud-accounts = var.plan_max_cloud_accounts
    verax-plan-max-users          = var.plan_max_users
    verax-plan-monthly-gib        = var.plan_monthly_gib
    verax-plan-history-days       = var.plan_history_days
    verax-node-version            = var.node_version
    verax-node-package-sha256     = var.node_package_sha256
    verax-images-repository       = local.images_repository
    verax-web-origin              = var.web_origin
    verax-api-origin              = var.api_origin
    verax-mail-from               = var.mail_from
    verax-tenant-name             = var.bootstrap_tenant_name
    verax-admin-email             = var.bootstrap_admin_email
    verax-support-email           = var.bootstrap_support_email
  }
}

# A VM baixa as imagens do registro do projeto da Verax, só com leitura (como na homologação). São só as imagens do
# código aberto: nenhum dado de cliente passa por lá. O executor grava esta permissão pelo `cpImagesAccessGranter`
# (envs/control-plane/cross_project.tf).
resource "google_artifact_registry_repository_iam_member" "node_reader" {
  project    = var.images_project_id
  location   = var.images_location
  repository = var.images_repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${module.node.service_account_email}"
}
