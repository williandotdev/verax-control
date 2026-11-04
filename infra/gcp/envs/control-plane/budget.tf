# Alerta de orçamento do projeto: um e-mail aos administradores da conta de faturamento em 50%, 90% e 100% do valor do
# mês (R$ 15 por padrão: o plano de controle fica abaixo disso até 20 clientes), e quando a previsão do mês passar de
# 100%. Só é criado se `billing_account_id` estiver preenchido. É só aviso: o Google não para nenhum serviço quando o
# orçamento estoura. O projeto também hospeda o Firebase dos painéis: o orçamento vale para o projeto inteiro.

resource "google_billing_budget" "project" {
  count = var.billing_account_id == "" ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = "Plano de controle do Verax Control"

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
