output "node_instance" {
  description = "Nome da VM do nó."
  value       = google_compute_instance.node.name
}

output "ssh_command" {
  description = "Como entrar na VM (pelo IAP, sem porta aberta)."
  value       = "gcloud compute ssh ${google_compute_instance.node.name} --zone ${var.zone} --tunnel-through-iap"
}

output "node_service_account" {
  description = "Conta de serviço da VM do nó."
  value       = google_service_account.node.email
}

output "monitored_projects" {
  description = "Projetos com o coletor de logs de segurança apontando para o nó."
  value       = keys(google_logging_project_sink.security)
}

output "pubsub_subscription" {
  description = "Assinatura dos logs de segurança: é o valor do campo \"Assinatura do Pub/Sub\" ao cadastrar o projeto no painel."
  value       = google_pubsub_subscription.security_logs.id
}

output "backups_bucket" {
  description = "Bucket dos backups do banco do nó."
  value       = google_storage_bucket.backups.name
}

output "secrets" {
  description = "Segredos a preencher com o gcloud (passo 7 do guia)."
  value       = { for key, secret in google_secret_manager_secret.node : key => secret.secret_id }
}
