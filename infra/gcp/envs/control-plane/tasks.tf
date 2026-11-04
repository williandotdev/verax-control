# Filas do Cloud Tasks e relógio do Cloud Scheduler (plano, seção 2.1). Cada passo do provisionamento é uma task HTTP
# com o token de identidade da cp-invoker (identities.tf); o prazo de despacho (15 min) é de cada task e fica no app,
# não na fila.

resource "google_cloud_tasks_queue" "cp" {
  for_each = toset(["provisioning", "lifecycle"])

  name     = each.key
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 2
  }

  # Nova tentativa com recuo: 30 s, 60 s, 2 min, 4 min, 8 min e depois 10 min, até 8 tentativas. Erro definitivo não
  # chega aqui: o app responde 200 e marca `provisioning_failed`.
  retry_config {
    max_attempts  = 8
    min_backoff   = "30s"
    max_backoff   = "600s"
    max_doublings = 4
  }

  depends_on = [google_project_service.apis]
}

# Quem enfileira: o cp-public (o primeiro passo, depois do `invoice.paid`) e o cp-worker (o passo seguinte e o ciclo de
# vida), nas duas filas.
resource "google_cloud_tasks_queue_iam_member" "enqueuers" {
  for_each = {
    for pair in setproduct(["provisioning", "lifecycle"], ["public", "worker"]) :
    "${pair[0]}/${pair[1]}" => { queue = pair[0], account = pair[1] }
  }

  name     = google_cloud_tasks_queue.cp[each.value.queue].name
  location = var.region
  role     = "roles/cloudtasks.enqueuer"
  member   = local.runtime_members[each.value.account]
}

# O relógio: `tick` a cada hora (carências, exclusões, estado dos nós) e `reconcile` às 3 h (assinaturas da Stripe
# contra os tenants). Os dois chamam o cp-worker com o token de identidade da cp-invoker (plano, seção 9, item 10, com
# a conta de token da revisão no lugar da do próprio worker); 2 dos 3 jobs gratuitos. O prazo de cada tentativa é o
# mesmo da requisição no cp-worker (900 s, run.tf): o Scheduler não desiste antes de o worker terminar.
resource "google_cloud_scheduler_job" "cp" {
  for_each = var.services_enabled ? {
    tick = {
      schedule    = "0 * * * *"
      path        = "/internal/tick"
      description = "Plano de controle: carências, exclusões e estado dos nós, a cada hora."
    }
    reconcile = {
      schedule    = "0 3 * * *"
      path        = "/internal/reconcile"
      description = "Plano de controle: assinaturas da Stripe contra os tenants, às 3 h."
    }
  } : {}

  name             = each.key
  region           = var.region
  description      = each.value.description
  schedule         = each.value.schedule
  time_zone        = "America/Sao_Paulo"
  attempt_deadline = "900s"

  http_target {
    http_method = "POST"
    uri         = "${local.worker_url}${each.value.path}"

    oidc_token {
      service_account_email = google_service_account.invoker.email
      audience              = local.worker_url
    }
  }

  depends_on = [
    google_cloud_run_v2_service.worker,
    google_service_account_iam_member.invoker_token_users,
    google_project_service.apis,
  ]
}
