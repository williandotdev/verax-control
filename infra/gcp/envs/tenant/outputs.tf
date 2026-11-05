# As saídas vão para o `outputs.json` de cada execução (`runs/<slug>/<runId>/`, que o cp-worker lê): nenhuma tem
# segredo nem dado pessoal (o e-mail do admin fica nos metadados da VM, fora daqui).

output "name_prefix" {
  description = "Prefixo de todos os recursos do nó: vx-<slug>."
  value       = local.name_prefix
}

output "instance_name" {
  description = "Nome da VM do nó (o que o cpNodeLifecycle para, liga e lê)."
  value       = module.node.instance_name
}

output "zone" {
  description = "Zona da VM do nó."
  value       = module.node.zone
}

output "nat_ip" {
  description = "IP de saída fixo do nó (Cloud NAT): o NodeEgressIps do papel de leitura na AWS do cliente, com /32. Não vai para os metadados da VM (modules/node/node.tf explica): a instalação o descobre pela própria saída ou o recebe daqui."
  value       = module.node.nat_ip
}

output "service_account_email" {
  description = "Conta de serviço da VM do nó."
  value       = module.node.service_account_email
}

output "service_account_unique_id" {
  description = "ID único da conta de serviço do nó: o NodeServiceAccountId do papel de leitura na AWS do cliente. Só muda se a conta for recriada, o que o executor recusa fora da exclusão do cliente."
  value       = module.node.service_account_unique_id
}

output "secrets" {
  description = "Os cofres do nó, pelo nome curto (o ID no Secret Manager do projeto dos nós): os que vêm de fora (`cloudflare-tunnel-token`, gravado pelo cp-worker; `smtp-password`) e os que a VM grava (`credentials-key`, `admin-bootstrap` e `support-bootstrap`)."
  value       = tomap(merge(module.node.secrets, module.node.node_written_secrets))
}

output "backups_bucket" {
  description = "Bucket dos backups do banco do nó (a exportação sob pedido e a Exclusão 2 usam)."
  value       = module.node.backups_bucket
}
