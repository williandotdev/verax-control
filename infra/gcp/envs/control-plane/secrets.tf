# Os segredos do plano de controle (plano, seção 2.1): os cinco montados nos serviços e a senha da caixa de envio dos
# nós. O Terraform cria só o "cofre" vazio de cada um: o valor é gravado por você com o gcloud (GUIA, plano de
# controle, passo 4) e nunca passa pelo Terraform nem pelo estado dele. Nenhum recurso de versão de segredo (regional ou
# não) existe neste ambiente, de propósito: o iac.yml confere a declaração.
#
# Cada serviço lê só os seus, cada um individualmente (plano, seção 2.2); a permissão vale só no segredo, nunca no
# projeto. As chaves de teste e de produção da Stripe são valores diferentes do mesmo segredo, trocados por versão
# (CP-13).
#
# `env = null`: o segredo não é montado como variável (run.tf). É o caso da senha da caixa de envio dos nós: o cp-worker
# a lê pela API do Secret Manager só na hora de copiá-la para o cofre de cada nó (o passo `secrets.smtp_password` e a
# recópia da troca de senha), sempre a versão `latest`, sem precisar de uma revisão nova do serviço; e o cofre pode
# ficar vazio (o Cloud Run recusa subir com um segredo montado sem versão), com os nós nascendo sem e-mail.

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
    # Uma caixa à parte da do plano de controle: a senha vai para o cofre de cada nó de cliente (a VM a lê), e um nó
    # comprometido não deve levar a caixa que manda a cobrança e o plano B da revelação.
    "cp-nodes-smtp-password" = {
      description = "Senha da caixa de envio comum aos nós de clientes (avisos e redefinição de senha): o cp-worker a copia para o cofre smtp-password de cada nó. Opcional: vazio, os nós nascem sem e-mail."
      readers     = ["worker"]
      env         = null
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

# Logs de auditoria de acesso a dados do Secret Manager no projeto inteiro: quem leu qual versão (DATA_READ), quem
# gravou ou destruiu (DATA_WRITE) e quem olhou a política (ADMIN_READ). Os de administração (criar, apagar, mudar a
# política) o Google grava sempre. Volume de KB por mês, dentro do nível gratuito do Logging. O recurso é a
# configuração inteira deste serviço no projeto: se já houver uma feita à mão, importe antes do `apply`.
resource "google_project_iam_audit_config" "secretmanager" {
  project = var.project_id
  service = "secretmanager.googleapis.com"

  audit_log_config {
    log_type = "ADMIN_READ"
  }

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }
}
