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

output "pubsub_subscriptions" {
  description = "Assinatura dos logs de segurança de cada projeto: é o valor do campo \"Assinatura do Pub/Sub\" ao cadastrar o projeto no painel."
  value       = { for project, subscription in google_pubsub_subscription.security_logs : project => subscription.id }
}

output "backups_bucket" {
  description = "Bucket dos backups do banco do nó."
  value       = google_storage_bucket.backups.name
}

output "secrets" {
  description = "Segredos a preencher com o gcloud (passo 7 do guia)."
  value       = { for key, secret in google_secret_manager_secret.node : key => secret.secret_id }
}

output "images_repository" {
  description = "Registro das imagens do nó (o prefixo das imagens da API e das migrations)."
  value       = "${google_artifact_registry_repository.node.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.node.repository_id}"
}

output "images_publisher" {
  description = "Conta que o GitHub Actions usa para publicar as imagens (variável GCP_IMAGES_SA do environment imagens)."
  value       = google_service_account.images_publisher.email
}
