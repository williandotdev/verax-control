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

# Prazos (TTL): o Firestore apaga sozinho, em até 72 h depois da data, todo documento destas coleções cujo campo
# `expiresAt` (timestamp) já passou. Um documento sem o campo nunca expira. O app (CP-02) grava `expiresAt` assim:
#   - slugs: só na reserva (`reserved`, 2 h 30); `taken` fica sem o campo;
#   - stripeEvents: 90 dias depois de recebido;
#   - statusTokens: 7 dias (cookie) ou 24 h (link do e-mail);
#   - rateLimits: o fim da janela do balde;
#   - provisioningRuns e steps (o grupo de coleções `steps`, uma subcoleção por execução): 180 dias depois de
#     terminar. O TTL não desce para subcoleções: cada passo leva o próprio `expiresAt`;
#   - auditLog: 24 meses.
# `tenants`, `transitions` e `invoices` não têm prazo (5 anos de faturas e a identificação fiscal ficam).
resource "google_firestore_field" "ttl" {
  for_each = toset(["slugs", "stripeEvents", "statusTokens", "rateLimits", "provisioningRuns", "steps", "auditLog"])

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
