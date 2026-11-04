# Nó da própria Verax (SOC), perfil lean: o mesmo nó aplicado em 03/11/2026, agora pelo módulo. O estado é o mesmo
# de antes (bucket e prefixo `verax-node`); os blocos `moved` abaixo dizem ao Terraform que cada recurso só mudou de
# endereço, e o `plan` não pode mostrar nada para destruir ou recriar (veja o GUIA.md).

module "node" {
  source = "../../modules/node"

  project_id         = var.project_id
  region             = var.region
  zone               = var.zone
  name_prefix        = var.name_prefix
  node_profile       = "lean"
  machine_type       = var.machine_type
  disk_gb            = var.disk_gb
  subnet_cidr        = var.subnet_cidr
  monitored_projects = var.monitored_projects
  operators          = var.operators

  # O que fica como estava no nó aplicado antes do módulo:
  # - o script de boot, idêntico ao aplicado: mudar o `metadata_startup_script` recria a VM. O swap cifrado do script
  #   do módulo só chega a este nó numa manutenção planejada (veja o GUIA.md);
  # - os tópicos sem `message_storage_policy` (é uma mudança no lugar, que fica para uma janela própria);
  # - sem os cofres novos: a chave do cofre de credenciais entra junto com o cofre (PR-V1), e o primeiro admin deste
  #   nó já existe;
  # - sem o alerta de fila parada (é só ligar quando quiser; o `plan` deste PR fica sem nenhuma mudança).
  legacy_startup_script      = file("${path.module}/startup.sh")
  pubsub_storage_in_region   = false
  credentials_vault          = false
  bootstrap_secret           = false
  stalled_subscription_alert = false

  # As APIs do projeto vêm antes de qualquer recurso do nó.
  depends_on = [google_project_service.apis]
}

locals {
  node_member = "serviceAccount:${module.node.service_account_email}"
}

# Recursos que estavam na raiz de infra/gcp e passaram para o módulo. Cada bloco só muda o endereço no estado; nada é
# destruído nem criado. Os blocos podem sair quando todos os estados já tiverem os endereços novos (depois do
# primeiro `apply` deste ambiente), mas não atrapalham se ficarem.

moved {
  from = google_compute_network.node
  to   = module.node.google_compute_network.node
}

moved {
  from = google_compute_subnetwork.node
  to   = module.node.google_compute_subnetwork.node
}

moved {
  from = google_compute_router.node
  to   = module.node.google_compute_router.node
}

moved {
  from = google_compute_router_nat.node
  to   = module.node.google_compute_router_nat.node
}

moved {
  from = google_compute_firewall.iap_ssh
  to   = module.node.google_compute_firewall.iap_ssh
}

moved {
  from = google_compute_firewall.deny_ingress
  to   = module.node.google_compute_firewall.deny_ingress
}

moved {
  from = google_service_account.node
  to   = module.node.google_service_account.node
}

moved {
  from = google_project_iam_member.node
  to   = module.node.google_project_iam_member.node
}

moved {
  from = google_compute_disk.node
  to   = module.node.google_compute_disk.node
}

# O nome do recurso muda (no standard o snapshot é diário); o nome na GCP continua `<prefixo>-weekly-snapshot`.
moved {
  from = google_compute_resource_policy.weekly_snapshot
  to   = module.node.google_compute_resource_policy.snapshot
}

moved {
  from = google_compute_disk_resource_policy_attachment.node
  to   = module.node.google_compute_disk_resource_policy_attachment.node
}

moved {
  from = google_compute_instance.node
  to   = module.node.google_compute_instance.node
}

moved {
  from = google_iap_tunnel_instance_iam_member.operators
  to   = module.node.google_iap_tunnel_instance_iam_member.operators
}

moved {
  from = google_compute_instance_iam_member.operators
  to   = module.node.google_compute_instance_iam_member.operators
}

moved {
  from = google_project_iam_custom_role.operator_lookup
  to   = module.node.google_project_iam_custom_role.operator_lookup
}

moved {
  from = google_project_iam_member.operator_lookup
  to   = module.node.google_project_iam_member.operator_lookup
}

moved {
  from = google_service_account_iam_member.operators
  to   = module.node.google_service_account_iam_member.operators
}

moved {
  from = google_secret_manager_secret.node
  to   = module.node.google_secret_manager_secret.node
}

moved {
  from = google_secret_manager_secret_iam_member.node
  to   = module.node.google_secret_manager_secret_iam_member.node
}

moved {
  from = google_pubsub_topic.security_logs
  to   = module.node.google_pubsub_topic.security_logs
}

moved {
  from = google_pubsub_subscription.security_logs
  to   = module.node.google_pubsub_subscription.security_logs
}

moved {
  from = google_logging_project_sink.security
  to   = module.node.google_logging_project_sink.security
}

moved {
  from = google_pubsub_topic_iam_member.sink_publisher
  to   = module.node.google_pubsub_topic_iam_member.sink_publisher
}

moved {
  from = google_pubsub_subscription_iam_member.node_subscriber
  to   = module.node.google_pubsub_subscription_iam_member.node_subscriber
}

moved {
  from = google_storage_bucket.backups
  to   = module.node.google_storage_bucket.backups
}

moved {
  from = google_storage_bucket_iam_member.node_backups
  to   = module.node.google_storage_bucket_iam_member.node_backups
}
