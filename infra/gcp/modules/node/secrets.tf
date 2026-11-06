# Segredos que vêm de fora e o nó lê na hora de subir. O Terraform cria só o "cofre" vazio de cada um: o valor é
# gravado por você com o gcloud (passo 7 do guia) e nunca passa pelo Terraform nem pelo estado dele. Os demais
# segredos (senhas do banco e do Wazuh, chaves da API) são gerados dentro da própria VM na instalação.

locals {
  node_secrets = merge(
    {
      "smtp-password"           = "Senha de aplicativo da caixa de envio no Zoho: convites e redefinição de senha."
      "cloudflare-tunnel-token" = "Token do túnel do Cloudflare (cloudflared): o painel chega à API sem porta aberta."
    },
    # O cofre do Turnstile entra por variável: o nó da Verax, já no ar, só o ganha numa mudança no lugar (um
    # `apply` que cria o cofre e a permissão, sem tocar em mais nada).
    var.turnstile_secret ? {
      "turnstile-secret-key" = "Chave secreta do Cloudflare Turnstile: o desafio no login e na redefinição de senha do painel."
    } : {},
  )

  # Cofres que a própria VM grava. A chave do cofre de credenciais (o par RSA que cifra a chave da AWS e o token do
  # Cloudflare) nasce na VM, na instalação, e nunca sai da GCP. A senha temporária do primeiro admin, numa instalação
  # sem SSH, vai para o `admin-bootstrap`, de onde quem opera a lê. A da conta de suporte da Verax (CP-10) vai para o
  # `support-bootstrap`, num cofre à parte: a revelação ao cliente (CP-05) mostra a versão `latest` do
  # `admin-bootstrap`, e a senha de outra conta ali seria mostrada a ele. No `support-bootstrap` a VM só grava (a
  # permissão abaixo), e este Terraform não dá acesso a mais ninguém: quem lê é o responsável, com as permissões dele
  # no projeto.
  node_written_secrets = merge(
    var.credentials_vault ? {
      "credentials-key" = "Chave privada do cofre de credenciais do nó (RSA), gerada na VM. Perder a chave obriga a colar as credenciais de novo."
    } : {},
    var.bootstrap_secret ? {
      "admin-bootstrap" = "Senha temporária do primeiro admin, gravada pela VM na instalação sem SSH."
    } : {},
    var.support_bootstrap_secret ? {
      "support-bootstrap" = "Senha temporária da conta de suporte da Verax, gravada pela VM na instalação sem SSH. Só o responsável lê."
    } : {},
  )
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
}

# Só a VM do nó lê esses segredos, cada um individualmente.
resource "google_secret_manager_secret_iam_member" "node" {
  for_each = google_secret_manager_secret.node

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.node_member
}

resource "google_secret_manager_secret" "node_written" {
  for_each = local.node_written_secrets

  secret_id = "${var.name_prefix}-${each.key}"
  labels    = { purpose = replace(each.key, "-", "_") }
  annotations = {
    description = each.value
  }

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

# A VM grava versões nos cofres que são dela. Ler, só a chave do cofre de credenciais (o worker decifra com ela); as
# senhas temporárias (do admin e da conta de suporte) a VM grava e não lê de volta. A permissão vale só para cada
# cofre, nunca para o projeto.
resource "google_secret_manager_secret_iam_member" "node_written_adder" {
  for_each = google_secret_manager_secret.node_written

  secret_id = each.value.id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = local.node_member
}

resource "google_secret_manager_secret_iam_member" "credentials_key_accessor" {
  count = var.credentials_vault ? 1 : 0

  secret_id = google_secret_manager_secret.node_written["credentials-key"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.node_member
}
