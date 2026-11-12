output "node_instance" {
  description = "Nome da VM da célula."
  value       = module.node.instance_name
}

output "ssh_command" {
  description = "Como entrar na VM (pelo IAP, sem porta aberta)."
  value       = "gcloud compute ssh ${module.node.instance_name} --zone ${module.node.zone} --project ${var.project_id} --tunnel-through-iap"
}

output "node_service_account" {
  description = "Conta de serviço da VM do nó."
  value       = module.node.service_account_email
}

output "node_service_account_unique_id" {
  description = "ID único da conta de serviço do nó: o NodeServiceAccountId do papel de leitura na AWS."
  value       = module.node.service_account_unique_id
}

output "nat_ip" {
  description = "IP de saída fixo do nó (Cloud NAT). Vai no node.conf como NODE_EGRESS_IPS=<ip>/32 e é o NodeEgressIps do papel de leitura na AWS."
  value       = module.node.nat_ip
}

output "pubsub_subscriptions" {
  description = "Assinatura dos logs de segurança de cada projeto, monitorado ou de cliente (campo \"Assinatura do Pub/Sub\" no painel)."
  value       = module.node.pubsub_subscriptions
}

output "backups_bucket" {
  description = "Bucket dos backups do banco do nó."
  value       = module.node.backups_bucket
}

output "secrets" {
  description = "Segredos a preencher com o gcloud (passo 7 do guia)."
  value       = module.node.secrets
}

output "node_written_secrets" {
  description = "Segredos que a própria VM grava: a chave do cofre de credenciais e a senha temporária do primeiro admin."
  value       = module.node.node_written_secrets
}

output "images_repository" {
  description = "Registro das imagens do nó (IMAGES_REPOSITORY no node.conf)."
  value       = "${var.images_location}-docker.pkg.dev/${var.images_project_id}/${var.images_repository_id}"
}

output "wazuh_agents" {
  description = "Agentes do Wazuh (wazuh_agents): IP fixo de entrada (WAZUH_AGENTS_ADDRESS no node.conf) e faixas liberadas (WAZUH_AGENTS_SOURCES). Nulo com o interruptor desligado."
  value       = module.node.wazuh_agents
}

output "cell" {
  description = "A célula para o plano de controle: o registro `cells/<id>` (CE-15), o canal (CE-05 e CE-06) e o que o envs/cell-tenant de cada cliente recebe (CE-07). Nada aqui é segredo. Os nomes do canal são nulos sem `control_plane_project_id`."
  value = {
    id                   = var.cell_id
    project_id           = var.project_id
    region               = var.region
    nat_ips              = module.node.nat_ip == null ? [] : ["${module.node.nat_ip}/32"]
    node_service_account = module.node.service_account_email
    exports_bucket       = google_storage_bucket.exports.name
    exports_prefix       = "${var.cell_id}/"
    commands_topic       = local.cell_channel ? google_pubsub_topic.commands[0].id : null
    # A assinatura que o worker da célula lê (CELL_COMMANDS_SUBSCRIPTION no node.conf, CE-05).
    commands_subscription = local.cell_channel ? google_pubsub_subscription.commands[0].id : null
    # O tópico em que o worker da célula publica (CELL_REPORTS_TOPIC no node.conf, CE-05).
    reports_topic = local.cell_channel ? google_pubsub_topic.reports[0].id : null
    # O CE-06: o `run.invoker` desta conta no cp-worker e o e-mail aceito na rota dos relatórios.
    reports_push_service_account = local.cell_channel ? google_service_account.reports_push[0].email : null
    reports_push_endpoint        = local.cell_channel ? local.reports_endpoint : null
    backup_retention_days        = var.backup_retention_days
  }
}
