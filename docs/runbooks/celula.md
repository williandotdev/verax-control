# Célula compartilhada (Plataforma)

## Canal com o plano de controle (CE-05 e CE-06)

O canal leva os comandos do plano de controle à célula e os relatórios da célula ao plano de controle, pelo Pub/Sub
(`docs/ARQUITETURA.md`, "Canal entre o plano de controle e a célula"). Nada aqui pede SSH nem leitura de dado de
cliente: os comandos e os relatórios só levam ids, o estado desejado e agregados.

### Ligar

1. **Ambiente da célula** (`infra/gcp/envs/celula`, CE-03) com o canal ligado. Da saída `cell`, anote
   `commands_topic`, `commands_subscription`, `reports_topic`, `reports_push_service_account` e o id da célula.
2. **Plano de controle** (`infra/gcp/envs/control-plane`): em `terraform.tfvars`,

   ```hcl
   cell_push_service_accounts = {
     "<id da célula>" = "<reports_push_service_account da saída cell>"
   }
   ```

   e `terraform apply`. A conta ganha `run.invoker` só no cp-worker, e o cp-worker passa a receber
   `CELL_PUSH_SA_EMAILS`. Sem isso, a rota dos relatórios responde 403 a toda entrega, e o Pub/Sub guarda os relatórios
   por até 7 dias.

3. **Registro da célula** no Firestore, `cells/<id da célula>` (pelo console, quando o CE-15 trouxer a tela; até lá, à
   mão no console do Firestore, com os tipos certos): `state` (`open`), `region`, `project`, `natIps`, `commandsTopic`
   (o `commands_topic`), `reportsSubscription` (a assinatura push `vxc-<célula>-reports-push`, no formato
   `projects/<projeto>/subscriptions/<nome>`), `pushServiceAccount` (o `reports_push_service_account`), `createdAt` e
   `updatedAt`. Um campo fora do formato faz a leitura falhar: o log do cp-worker diz o campo.
4. **Nó da célula** (`node.conf`, CE-04): `CELL_ID`, `CELL_COMMANDS_SUBSCRIPTION` (o `commands_subscription`) e
   `CELL_REPORTS_TOPIC` (o `reports_topic`), os três juntos e só com `NODE_MODE=cell`. O worker sobe com as tarefas
   `cell-commands`, `cell-reports` e `cell-tenant-status` (o log `worker iniciado` lista as tarefas e o `cellId`). Sem
   as três, o log avisa que o canal está desligado.

### Conferir

- **Do lado da célula:** no log do worker, `event="cell_command"` com o `kind`, o `commandId`, o cliente (id do plano de
  controle) e o `outcome` (`applied`, `duplicate`, `stale` ou `refused` com o `code`). No banco:
  `SELECT "controlPlaneId", generation, "appliedAt" FROM "CellTenantState"` e
  `SELECT kind, "publishedAt", attempts FROM "CellReport" ORDER BY "createdAt" DESC LIMIT 20`.
- **Do lado do plano de controle:** no log do cp-worker, `event="cell_report"` (o `outcome`); em `tenants/<id>.cell`,
  `desiredGeneration` e `appliedGeneration` (iguais quando a célula está em dia), `accountsConnected` e
  `statusReportedAt` (a cada 5 min); em `cellReports`, cada relatório recebido.

### Quando algo não chega

| Sinal                                                               | O que é                                                                             | O que fazer                                                                                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event="cell_command_invalid"` no worker da célula                  | Uma mensagem fora do contrato (outra versão, campo a mais): confirmada e descartada | Confira se o plano de controle e a célula estão na mesma versão do contrato (`CELL_PROTOCOL_VERSION`). O log diz só os caminhos dos campos                           |
| `event="cell_command_foreign"`                                      | Um comando de outra célula na assinatura desta                                      | Os tópicos estão trocados no registro `cells/<id>.commandsTopic` ou no `node.conf`: corrija o que diverge da saída `cell`                                            |
| `outcome=refused` com `slug_conflict` ou `identity_conflict`        | O subdomínio ou a conta de serviço já é de outro cliente da célula                  | Nada foi aplicado. Investigue antes de reenviar: um endereço ou uma conta nunca muda de cliente sozinho                                                              |
| `outcome=refused` com `transition_refused`                          | O estado pedido não sai do atual (cancelado não volta a ativo)                      | Confira o estado do cliente no plano de controle; a célula guarda o espelho                                                                                          |
| `outcome=refused` com `export_unavailable` ou `purge_unavailable`   | A exportação e o expurgo na célula ainda não existem (CE-16); as guardas passaram   | Até o CE-16, a exportação e o expurgo de um cliente da célula são manuais. O estado do cliente não mudou                                                             |
| `event="cell_tenant_bootstrap_failed"` no worker da célula          | A entrega do pedido do primeiro administrador ao host falhou (a pasta do CE-04)     | O pedido fica no banco e sai na passagem seguinte. Confira as pastas `TENANT_BOOTSTRAP_DIR` e `TENANT_BOOTSTRAP_STATUS_DIR` no `worker.env` e as montagens do worker |
| `event="cell_report_publish_failed"` no worker da célula            | O Pub/Sub recusou a publicação: os relatórios ficam e saem 1 min depois             | Confira o papel `pubsub.publisher` da VM no tópico de relatórios (`envs/celula`). Nada se perde: a caixa de saída guarda                                             |
| 403 `push_account_mismatch` ou `subscription_mismatch` no cp-worker | A entrega veio com a conta de push ou a assinatura de outra célula                  | Confira `cells/<id>.pushServiceAccount` e `reportsSubscription` contra a saída `cell`. Se estiverem certos, é tentativa de falar por outra célula: incidente         |
| 404 `cell_unknown`                                                  | A célula do caminho não está no registro                                            | Grave `cells/<id>` (passo 3). O Pub/Sub repete por até 7 dias                                                                                                        |
| `cell.report_refused` com `foreign_tenant` na auditoria             | A célula falou de um cliente que não é dela (ou que não existe)                     | Uma célula em dia nunca faz isso: confira o `placement` do cliente e, se estiver certo, trate a célula como comprometida                                             |
| `cell.report_refused` com `generation_unknown`                      | A célula disse ter aplicado uma geração que o plano de controle nunca mandou        | Mesmo tratamento do anterior                                                                                                                                         |
