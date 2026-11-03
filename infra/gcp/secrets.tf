# Segredos que vêm de fora e o nó lê na hora de subir. O Terraform cria só o "cofre" vazio de cada um: o valor é
# gravado por você com o gcloud (passo 7 do guia) e nunca passa pelo Terraform nem pelo estado dele. Os demais
# segredos (senhas do banco e do Wazuh, chaves da API) são gerados dentro da própria VM na instalação.

locals {
  node_secrets = {
    "smtp-password"           = "Senha de aplicativo da caixa de envio no Zoho: convites e redefinição de senha."
    "cloudflare-tunnel-token" = "Token do túnel do Cloudflare (cloudflared): o painel chega à API sem porta aberta."
  }
}

resource "google_secret_manager_secret" "node" {
  for_each = local.node_secrets

  secret_id = "${var.name_prefix}-${each.key}"
  labels    = { purpose = replace(each.key, "-", "_") }
  annotations = {
    description = each.value
  }

  # Guardado só na região do nó.
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.apis]
}

# Só a VM do nó lê esses segredos, cada um individualmente.
resource "google_secret_manager_secret_iam_member" "node" {
  for_each = google_secret_manager_secret.node

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.node_member
}
