# Estado do plano de controle (plano, seção 3): o banco `(default)` do Firestore, o único gratuito por projeto, em
# modo nativo e na região. Nunca guarda segredo, senha nem cartão.

resource "google_firestore_database" "default" {
  name                        = "(default)"
  location_id                 = var.region
  type                        = "FIRESTORE_NATIVE"
  concurrency_mode            = "OPTIMISTIC"
  app_engine_integration_mode = "DISABLED"

  # O banco não sai por engano: a proteção da GCP (que o console também respeita) e, no Terraform, `destroy` só o
  # tira do estado.
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"

  # Desligado por padrão: o armazenamento do PITR é cobrado à parte, sem nível gratuito (variables.tf).
  point_in_time_recovery_enablement = var.firestore_pitr ? "POINT_IN_TIME_RECOVERY_ENABLED" : "POINT_IN_TIME_RECOVERY_DISABLED"

  depends_on = [google_project_service.apis]
}

# Regras de segurança do Firestore: nada para os SDKs de cliente (web e celular). Só os serviços chegam ao banco, pelo
# IAM (`datastore.user`, identities.tf), que as regras não limitam. Sem uma release, um projeto do Firebase pode ter
# regras abertas ou de teste de outra época; esta nega tudo, explicitamente.
resource "google_firebaserules_ruleset" "firestore_deny_all" {
  source {
    files {
      name    = "firestore.rules"
      content = <<-EOT
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /{document=**} {
              allow read, write: if false;
            }
          }
        }
      EOT
    }
  }

  depends_on = [google_firestore_database.default, google_project_service.apis]
}

# A release do banco `(default)` sempre se chama `cloud.firestore`. Uma regra nova é um ruleset novo e uma release
# nova (`replace_triggered_by`), como no exemplo do provider.
resource "google_firebaserules_release" "firestore" {
  name         = "cloud.firestore"
  ruleset_name = "projects/${var.project_id}/rulesets/${google_firebaserules_ruleset.firestore_deny_all.name}"

  lifecycle {
    replace_triggered_by = [google_firebaserules_ruleset.firestore_deny_all]
  }
}

# Prazos (TTL): o Firestore apaga sozinho, em até 72 h depois da data, todo documento destas coleções cujo campo
# `expiresAt` (timestamp) já passou. Um documento sem o campo nunca expira. O app (CP-02) grava `expiresAt` assim:
#   - slugs: só na reserva (`reserved`, 2 h 30); `taken` fica sem o campo;
#   - stripeEvents: 90 dias depois de recebido;
#   - statusTokens: 7 dias (cookie) ou 24 h (link do e-mail);
#   - rateLimits: o fim da janela do balde;
#   - provisioningRuns e steps (o grupo de coleções `steps`, uma subcoleção por execução): 180 dias depois de
#     terminar. O TTL não desce para subcoleções: cada passo leva o próprio `expiresAt`;
#   - auditLog: 24 meses;
#   - quotes: 24 h, a validade da cotação do site (preço configurável);
#   - adminSessions: 12 h, o prazo absoluto da sessão do console do responsável (a inatividade de 30 min o app confere);
#   - adminLoginThrottle: o fim da janela de 15 min das falhas de login ou do bloqueio;
#   - adminEnrollments: 10 min, o cadastro do TOTP pendente (primeiro cadastro ou troca do aplicativo).
# `adminAccounts` e `adminSetup` (a conta do responsável e o marcador do primeiro cadastro) não têm prazo.
# `tenants`, `transitions` e `invoices` não têm prazo (5 anos de faturas e a identificação fiscal ficam), nem as
# tabelas de preços e de custos (`pricingTables`, `costModels`), que são o histórico do que foi vendido.
resource "google_firestore_field" "ttl" {
  for_each = toset(["slugs", "stripeEvents", "statusTokens", "rateLimits", "provisioningRuns", "steps", "auditLog", "quotes", "adminSessions", "adminLoginThrottle", "adminEnrollments"])

  database   = google_firestore_database.default.name
  collection = each.key
  field      = "expiresAt"

  ttl_config {}
}

# Índices compostos de `tenants` (plano, seção 3): os varridos pelo `tick` e pelo `reconcile`, sempre por estado e
# uma data. O provider acrescenta `__name__` no fim de cada um.
resource "google_firestore_index" "tenants" {
  for_each = {
    "state-grace"          = "billing.graceUntil"
    "state-delete"         = "lifecycle.deleteAfter"
    "state-crypto-destroy" = "lifecycle.cryptoDestroyAfter"
    "state-updated"        = "stateUpdatedAt"
  }

  database    = google_firestore_database.default.name
  collection  = "tenants"
  query_scope = "COLLECTION"

  fields {
    field_path = "state"
    order      = "ASCENDING"
  }

  fields {
    field_path = each.value
    order      = "ASCENDING"
  }
}
