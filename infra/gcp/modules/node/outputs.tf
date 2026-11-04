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
  description = "Segredos que a própria VM grava (chave do cofre de credenciais e senha temporária do primeiro admin)."
  value       = { for key, secret in google_secret_manager_secret.node_written : key => secret.secret_id }
}

output "nat_ip" {
  description = "IP de saída fixo do nó (Cloud NAT), no perfil standard. É o IP que a política IAM da AWS do cliente libera (NODE_EGRESS_IPS no node.conf, com /32). Nulo no lean, que usa o IP automático do NAT."
  value       = local.static_nat_ip ? google_compute_address.nat[0].address : null
}
