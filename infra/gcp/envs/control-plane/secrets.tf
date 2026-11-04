# Os cinco segredos do plano de controle (plano, seção 2.1). O Terraform cria só o "cofre" vazio de cada um: o valor
# é gravado por você com o gcloud (GUIA, plano de controle, passo 4) e nunca passa pelo Terraform nem pelo estado
# dele. Nenhum `google_secret_manager_secret_version` existe neste ambiente, de propósito (o CI confere).
#
# Cada serviço lê só os seus, cada um individualmente (plano, seção 2.2); a permissão vale só no segredo, nunca no
# projeto. As chaves de teste e de produção da Stripe são valores diferentes do mesmo segredo, trocados por versão
# (CP-13).

locals {
  # Cada segredo: a descrição, quem lê e o nome da variável de ambiente em que o Cloud Run o monta (run.tf).
  secrets = {
    "cp-stripe-secret-key" = {
      description = "Chave restrita da Stripe (não a sk_): Checkout, Customers, Subscriptions, Tax IDs e Portal; leitura de Invoices e Events."
      readers     = ["public", "worker"]
      env         = "STRIPE_SECRET_KEY"
    }
    "cp-stripe-webhook-secret" = {
      description = "Segredo de assinatura do endpoint do webhook da Stripe (Workbench)."
      readers     = ["public"]
      env         = "STRIPE_WEBHOOK_SECRET"
    }
    "cp-cloudflare-api-token" = {
      description = "Token da API do Cloudflare restrito à zona veraxsistemas.com.br: Tunnel Write e DNS Write, validade de 1 ano."
      readers     = ["worker"]
      env         = "CLOUDFLARE_API_TOKEN"
    }
    "cp-smtp-password" = {
      description = "Senha de aplicativo da caixa de envio no Zoho: e-mails de ambiente pronto, cobrança e plano B da revelação."
      readers     = ["worker"]
      env         = "SMTP_PASSWORD"
    }
    "cp-cookie-key" = {
      description = "Chave HMAC (32 bytes ou mais) do cookie __session da página de status."
      readers     = ["public"]
      env         = "COOKIE_KEY"
    }
  }

  secret_readers = {
    for pair in flatten([
      for id, secret in local.secrets : [
        for reader in secret.readers : { key = "${id}/${reader}", secret = id, reader = reader }
      ]
    ]) : pair.key => pair
  }
}

resource "google_secret_manager_secret" "cp" {
  for_each = local.secrets

  secret_id = each.key
  labels    = { purpose = replace(trimprefix(each.key, "cp-"), "-", "_") }
  annotations = {
    description = each.value.description
  }

  # Guardado só na região do plano de controle.
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "readers" {
  for_each = local.secret_readers

  secret_id = google_secret_manager_secret.cp[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.runtime_members[each.value.reader]
}
