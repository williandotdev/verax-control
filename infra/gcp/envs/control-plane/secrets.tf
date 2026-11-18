# Os segredos do plano de controle (plano, seção 2.1): os cinco montados nos serviços, a senha da caixa de envio dos
# nós e os do console do responsável (a chave do TOTP, a chave da entrada única, a chave secreta do Turnstile do login e
# o antigo token do primeiro cadastro, aposentado). O
# Terraform cria só o
# "cofre" vazio de cada um: o valor é gravado por você com o gcloud (GUIA, plano de
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
# ficar vazio (o Cloud Run recusa subir com um segredo montado sem versão), com os nós nascendo sem e-mail. É também o
# caso das chaves do console (`readers = ["admin"]`): o cp-admin as lê pela API na hora do uso
# (`ADMIN_SECRETS_PROJECT_ID`, admin.tf), e sobe com elas vazias (só o login, ou a função daquela chave, responde 503).
# O cofre existe sempre, para o responsável gravar o valor antes de ligar o console; a leitura só é concedida à conta
# cp-admin, que só existe com `admin_enabled` (o cadastro pela linha de comando lê a chave do TOTP com as credenciais
# de dono do projeto).

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
    # A chave mestra do console: 32 bytes aleatórios em base64. O app deriva dela (HKDF) a chave AES-256-GCM que cifra o
    # segredo do TOTP no Firestore e a chave HMAC dos códigos de recuperação. Não se troca depois do cadastro: o segredo
    # do TOTP gravado deixaria de abrir (o caminho é refazer o cadastro pela linha de comando, como no runbook).
    "cp-admin-totp-key" = {
      description = "Chave mestra do console do responsável (32 bytes em base64): cifra o segredo do TOTP no Firestore e assina os códigos de recuperação. Não trocar depois do cadastro."
      readers     = ["admin"]
      env         = null
    }
    # A chave de assinatura da entrada única no SIEM da Verax (admin.tf, SSO_ISSUER): Ed25519 em PEM (PKCS #8), gerada
    # pelo responsável direto no cofre (runbook do console). Só o cp-admin lê, pela API, como a chave do console; a parte
    # pública sai em /sso/jwks e fica fixada no node.conf da célula. Nenhum nó, nenhuma célula e nenhum outro serviço lê.
    "cp-admin-sso-signing-key" = {
      description = "Chave privada Ed25519 (PEM, PKCS #8) que assina os tokens da entrada única no SIEM da Verax. Só o cp-admin lê. Trocar invalida a chave fixada na célula: troque as duas juntas (runbook do console)."
      readers     = ["admin"]
      env         = null
    }
    # A chave secreta do Cloudflare Turnstile do login do console (admin.tf, admin_turnstile_site_key): a do widget cuja
    # chave do site o cp-admin recebe em ADMIN_TURNSTILE_SITE_KEY. Só o cp-admin lê, pela API, e só a manda ao
    # siteverify da Cloudflare. Vazia, com a chave do site definida, o login responde 503 (fecha); sem a chave do site,
    # ninguém a lê.
    "cp-admin-turnstile-key" = {
      description = "Chave secreta do Cloudflare Turnstile do login do console (o widget da chave do site admin_turnstile_site_key). Só o cp-admin lê."
      readers     = ["admin"]
      env         = null
    }
    # APOSENTADO: o token da antiga tela de cadastro (`/configurar`), que saiu do console (a conta nasce pela linha de
    # comando, `cadastro-responsavel`). Ninguém lê mais (`readers = []`: a leitura do cp-admin sai). O cofre continua
    # aqui só por enquanto, para não apagar nada no mesmo apply; destrua as versões (runbook) e tire este bloco depois.
    "cp-admin-setup-token" = {
      description = "Aposentado: token da antiga tela de cadastro do console (/configurar), que não existe mais. Ninguém lê; destrua as versões."
      readers     = []
      env         = null
    }
  }

  # Quem lê cada segredo: as contas de execução de identities.tf e, com o console, a cp-admin (admin.tf). A cp-admin
  # fica fora de `runtime_members` de propósito: aquele mapa também dá `actAs` na cp-invoker, que o console não tem.
  secret_reader_members = merge(
    local.runtime_members,
    { for account in google_service_account.admin : "admin" => "serviceAccount:${account.email}" },
  )

  secret_readers = {
    for pair in flatten([
      for id, secret in local.secrets : [
        for reader in secret.readers : { key = "${id}/${reader}", secret = id, reader = reader }
        if reader != "admin" || var.admin_enabled
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
  member    = local.secret_reader_members[each.value.reader]
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
