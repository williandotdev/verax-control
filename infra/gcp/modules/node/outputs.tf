output "instance_name" {
  description = "Nome da VM do nó."
  value       = google_compute_instance.node.name
}

output "zone" {
  description = "Zona da VM do nó."
  value       = google_compute_instance.node.zone
}

output "service_account_email" {
  description = "Conta de serviço da VM do nó."
  value       = google_service_account.node.email
}

output "service_account_unique_id" {
  description = "ID único (21 dígitos) da conta de serviço do nó: o NodeServiceAccountId do papel de leitura na AWS do cliente (infra/cloudformation/verax-control-reader.yaml). Não é segredo e só muda se a conta for recriada."
  value       = google_service_account.node.unique_id
}

output "monitored_projects" {
  description = "Projetos com o coletor de logs de segurança apontando para o nó."
  value       = keys(google_logging_project_sink.security)
}

output "pubsub_subscriptions" {
  description = "Assinatura dos logs de segurança de cada projeto, monitorado ou de cliente (`customer_projects`)."
  value       = { for project, subscription in google_pubsub_subscription.security_logs : project => subscription.id }
}

output "backups_bucket" {
  description = "Bucket dos backups do banco do nó."
  value       = google_storage_bucket.backups.name
}

output "secrets" {
  description = "Segredos que você preenche com o gcloud (passo 7 do guia)."
  value       = { for key, secret in google_secret_manager_secret.node : key => secret.secret_id }
}

output "node_written_secrets" {
  description = "Segredos que a própria VM grava: a chave do cofre de credenciais e as senhas temporárias do primeiro admin e, com `support_bootstrap_secret`, da conta de suporte."
  value       = { for key, secret in google_secret_manager_secret.node_written : key => secret.secret_id }
}

output "install_metadata" {
  description = "Metadados da VM para a instalação sem operador e para o plano de controle: as chaves `verax-*` (com `install_config`: as de `install_metadata` e as que o módulo acrescenta) e o `enable-guest-attributes` de `guest_attributes` (node.tf). Vazio com os dois desligados. Sem o script de boot e sem as chaves de segurança, que todo nó tem."
  value       = merge(var.install_metadata, local.node_derived_metadata, local.guest_attributes_metadata)
}

output "nat_ip" {
  description = "IP de saída fixo do nó (Cloud NAT), no perfil standard. É o único IP de que o papel de leitura da AWS do cliente aceita o nó (NodeEgressIps; NODE_EGRESS_IPS no node.conf, com /32). Nulo no lean, que usa o IP automático do NAT."
  value       = local.static_nat_ip ? google_compute_address.nat[0].address : null
}

output "wazuh_agents" {
  description = "Agentes do Wazuh (wazuh_agents): o IP fixo de entrada (WAZUH_AGENTS_ADDRESS no node.conf, sem máscara) e as faixas liberadas (WAZUH_AGENTS_SOURCES, separadas por vírgula). `allowlist_pending` é verdadeiro sem faixa nenhuma: as portas ficam fechadas. Nulo com o interruptor desligado."
  value = var.wazuh_agents ? {
    address           = google_compute_address.agents[0].address
    sources           = var.wazuh_agents_sources
    allowlist_pending = length(var.wazuh_agents_sources) == 0
  } : null
}
