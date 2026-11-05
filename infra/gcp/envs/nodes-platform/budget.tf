# Alerta de orçamento do projeto dos nós de clientes: um e-mail aos administradores da conta de faturamento em 50%, 90%
# e 100% do valor do mês, e quando a previsão do mês passar de 100%. Só é criado se `billing_account_id` estiver
# preenchido. É só aviso: o Google não para nenhum serviço quando o orçamento estoura. Vigia o projeto inteiro (todos
# os nós e a homologação); o orçamento do envs/homolog-sp fica vazio quando este existe, para não chegar o mesmo aviso
# duas vezes.

resource "google_billing_budget" "project" {
  count = var.billing_account_id == "" ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = "Nós de clientes (projeto dos nós)"

  budget_filter {
    projects        = ["projects/${data.google_project.this.number}"]
    calendar_period = "MONTH"
  }

  amount {
    specified_amount {
      units = tostring(var.monthly_budget)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  depends_on = [google_project_service.apis]
}
