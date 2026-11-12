# O lado do plano de controle do canal da célula (CE-06; docs/ARQUITETURA.md, "Canal entre o plano de controle e a
# célula"): o `run.invoker` no cp-worker da conta de push de cada célula e a lista dessas contas para o app. A assinatura
# push, a conta que assina o token de cada entrega (`vxc-<célula>-push`) e os tópicos ficam no ambiente da célula
# (envs/celula, CE-03, saída `cell`), no projeto dela. Sem `cell_push_service_accounts` (o padrão), nada daqui existe e a
# rota dos relatórios recusa tudo.
#
# Contrato com o app (`internal/worker-caller.ts`, grupo `cell-push`): o token de cada entrega leva `aud == WORKER_URL`
# (a audiência da assinatura no envs/celula) e o e-mail de uma das contas daqui (`CELL_PUSH_SA_EMAILS`, que o Terraform
# deriva), e esse token só vale na rota dos relatórios. A rota ainda confere, pelo registro `cells/{id}` no Firestore, que
# a conta é a da célula do caminho, que a assinatura citada na entrega é a dela e que todo cliente citado está nela.

locals {
  cell_push_members = { for cell, email in var.cell_push_service_accounts : cell => "serviceAccount:${email}" }
}

# A conta de push de cada célula só chama o cp-worker: `run.invoker` nele e nenhum outro papel neste projeto.
resource "google_cloud_run_v2_service_iam_member" "cell_push_invoker" {
  for_each = var.services_enabled ? local.cell_push_members : {}

  name     = google_cloud_run_v2_service.worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.value
}
