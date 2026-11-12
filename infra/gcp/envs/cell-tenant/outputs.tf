# As saídas vão para o `outputs.json` de cada execução (`runs/<slug>/<runId>/`, que o cp-worker lê; a lista fixa do
# entrypoint.sh): nenhuma tem segredo nem dado pessoal.

output "tenant_service_account_email" {
  description = "Conta de serviço do cliente (vxt-<slug>): a que a célula personifica para a AWS dele e o cp-worker desativa na suspensão."
  value       = google_service_account.tenant.email
}

output "tenant_service_account_unique_id" {
  description = "ID único da conta de serviço do cliente: o NodeServiceAccountId da pilha do papel de leitura na AWS dele (TenantCloudIdentity na célula). Só muda se a conta for recriada, o que o executor recusa fora da exclusão do cliente."
  value       = google_service_account.tenant.unique_id
}

output "admin_bootstrap_secret" {
  description = "O cofre da senha temporária do primeiro admin do cliente (o ID no Secret Manager do projeto da célula)."
  value       = google_secret_manager_secret.admin_bootstrap.secret_id
}

output "gcp_sources" {
  description = "Tópico e assinatura de cada conta GCP do cliente, pelo UUID da conta: o comando do sink que o painel mostra e a assinatura que o worker da célula lê."
  value = {
    for id, topic in google_pubsub_topic.gcp_source : id => {
      topic        = topic.id
      subscription = google_pubsub_subscription.gcp_source[id].id
    }
  }
}
