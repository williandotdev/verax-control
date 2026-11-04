output "node_instance" {
  description = "Nome da VM do nó de homologação."
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

output "nat_ip" {
  description = "IP de saída fixo do nó (Cloud NAT). Vai no node.conf como NODE_EGRESS_IPS=<ip>/32 e é o IP que a política IAM da AWS de teste libera."
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
