# Célula compartilhada (Plataforma): infraestrutura, troca de modo e primeiro acesso dos clientes

A célula é um nó `standard` que atende vários clientes da Plataforma (docs/ARQUITETURA.md, "Célula compartilhada
(Plataforma)"). A primeira, `verax-celula`, é o `infra/gcp/envs/celula`, no projeto do nó da Verax, e hoje roda o SOC
da própria Verax como nó dedicado (`NODE_MODE` ausente, `PLAN=interno`). Este roteiro diz o que aplicar, em que ordem, e
como trocar o nó no ar para o modo célula sem perder o cliente da Verax. Nos comandos, `PROJETO_DO_NO` é o projeto da
célula, `PROJETO_CP` o do plano de controle e `URL_DO_CP_WORKER` o endereço do serviço cp-worker no Cloud Run. Os
valores reais ficam fora do repositório.

## O que a célula tem além de um nó

| Peça                                                                           | Onde                                      | Quem aplica                          |
| ------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------ |
| O nó (VM, rede, NAT, cofres, backups de 85 dias)                               | `envs/celula` (módulo `node`)             | O responsável                        |
| Canal: comandos `vxc-<célula>-commands`                                        | `envs/celula/cell.tf`                     | O responsável                        |
| Canal: relatórios `vxc-<célula>-reports` e o push                              | `envs/celula/cell.tf`                     | O responsável                        |
| Exportações dos clientes (31 dias)                                             | `envs/celula/cell.tf`                     | O responsável                        |
| O que é de cada cliente (conta de serviço, cofre, tópicos), no projeto dos nós | `envs/cell-tenant`, um estado por cliente | O plano de controle (`cp-terraform`) |

- **Comandos:** só o cp-worker publica, e só a VM da célula lê (com ordem por cliente).
- **Relatórios:** só a VM da célula publica; a assinatura push entrega em `URL_DO_CP_WORKER/internal/cells/<célula>/reports`,
  com o token OIDC da conta `vxc-<célula>-push`, que não tem papel nenhum. A rota, o `run.invoker` dessa conta no
  cp-worker e a conferência de que cada cliente citado é desta célula são do lado do plano de controle (CE-06).
- **Exportações:** a VM só cria objetos, e só em `<célula>/...`; o ciclo de vida apaga tudo com 31 dias.
- **Backups:** 85 dias (o `envs/celula` recusa mais), para o último backup com um cliente expurgado sair até cerca de
  D+95.

## 1. Aplicar o canal e as exportações (CE-03)

No `terraform.tfvars` do `envs/celula` (fora do repositório), acrescente os dois juntos:

```hcl
control_plane_project_id = "PROJETO_CP"
control_plane_worker_url = "URL_DO_CP_WORKER"
```

Depois, como sempre (`infra/gcp/GUIA.md`): `terraform plan` e, lendo o plano, `terraform apply`. O plano esperado só
cria (os tópicos, as assinaturas, a conta do push, o bucket das exportações e as permissões) e muda no lugar o ciclo de
vida do bucket de backups (de 90 para 85 dias). Nada na VM, no disco, na rede ou nos cofres muda; se o plano recriar a
VM, pare e confira. A saída `cell` traz o que o plano de controle registra da célula (o registro `cells/<id>`) e o que o
CE-06 configura do lado dele (a conta do push e o endereço).

## 2. Trocar o nó no ar para o modo célula (CE-04)

O nó continua com o mesmo banco: o cliente da Verax ganha o endereço da equipe (`TenantHost`) e o plano `interno`
gravado (`TenantPlan`), pelos escritores do sistema, e a API passa a amarrar cada requisição ao cliente do endereço.

1. **Instale a versão com a célula ainda como dedicado** (o `node.conf` de hoje): `infra/node/bin/deploy.sh COMMIT
node.conf` (docs/runbooks/no-verax.md, "Instalar ou atualizar").
2. **Adote o cliente da Verax**, ainda no dedicado, na VM:

   ```bash
   sudo /opt/verax/bin/start.sh cell-adopt verax
   ```

   Grava o endereço `verax` e, se faltar, o plano `interno` do único cliente do nó. Só roda com um cliente só e com
   `PLAN=interno`; repetir não muda nada ("já estava gravado"). Assim a célula já sobe com o endereço da equipe.

3. **Troque o `node.conf`:** tire `PLAN` (e qualquer `PLAN_*`) e o `NODE_SA_UNIQUE_ID`, e acrescente:

   ```
   NODE_MODE=cell
   CELL_DOMAIN=veraxsistemas.com.br
   CELL_STAFF_SLUG=verax
   ```

   `CUSTOMER_MODE` e `WAZUH_AGENTS` ficam `false`, e `NODE_PROFILE=standard`. Instale de novo com esse `node.conf`
   (`deploy.sh`): o `install.sh` confere a combinação, instala o `compose.cell.yaml` e liga o
   `verax-tenant-bootstrap.path` e o `.timer`.

4. **Confira:** `https://api-verax.veraxsistemas.com.br/health/ready` responde, o login da equipe funciona no painel
   `verax.control...`, e `sudo /opt/verax/bin/start.sh cell-adopt` (sem argumento, o `CELL_STAFF_SLUG`) diz que o
   endereço e o plano já estavam gravados.

**Voltar atrás:** o `node.conf` de antes (com `PLAN=interno`, sem `NODE_MODE`) e o `deploy.sh` de novo. O endereço e o
plano gravados ficam e não mudam nada no nó dedicado (o plano volta a vir do `node.conf`).

O que muda no nó na célula: a API recebe `NODE_MODE=cell`, `CELL_DOMAIN` e `CELL_STAFF_SLUG` no lugar do plano; o
worker recebe o modo e as pastas dos pedidos do primeiro acesso; ficam de fora o tópico do sink pelo nome do projeto (o
tópico é de cada conta, `vxc-<célula>-gcp-<UUID da conta>`) e o `NODE_SA_UNIQUE_ID` (a identidade da AWS passa a ser
de cada cliente, CE-11). Os agentes do Wazuh ficam desligados na célula (v1).

## 3. O primeiro administrador de cada cliente

O cliente nasce na célula pelo comando do plano de controle (CE-05), com o endereço e o plano. O primeiro
`admin_cliente` sai assim, sem a senha passar pelo worker:

1. o worker grava o pedido em `/run/verax/tenant-bootstrap/<id do cliente>` (duas linhas, `slug=<subdomínio>` e
   `email=<e-mail do administrador>`; nada de segredo);
2. o `verax-tenant-bootstrap.path` vê a pasta com pedido e roda `start.sh tenant-bootstrap-pending`. Para cada pedido, o
   host confere o formato (arquivo comum, até 512 bytes, subdomínio e e-mail válidos), roda o bootstrap no modo
   `cell-tenant` (o contêiner confere no banco que o cliente existe, está ativo, tem esse subdomínio e já tem plano) e
   grava a senha temporária no cofre do cliente, `vxt-<subdomínio>-admin-bootstrap` (criado pelo `envs/cell-tenant`, só
   com a gravação da VM). O plano de controle a revela uma vez, como no nó dedicado;
3. a resposta vai para `/run/verax/tenant-bootstrap-status/<id>`: `ok` (o pedido sai da pasta) ou `error` (o pedido
   fica, e o timer tenta de novo a cada 10 min).

Para ver ou repetir:

```bash
journalctl -u verax-tenant-bootstrap --since today
sudo /opt/verax/bin/start.sh tenant-bootstrap ID_DO_CLIENTE
# Senha nova a pedido (com um pedido na pasta):
sudo BOOTSTRAP_RENEW_ADMIN_PASSWORD=true /opt/verax/bin/start.sh tenant-bootstrap ID_DO_CLIENTE
```

Uma senha que não chegou ao cofre (o Secret Manager fora do ar, sem permissão) fica em
`/run/verax/tenant-bootstrap-payloads/<id>/` (tmpfs, só root) e vai antes de tudo na tentativa seguinte, para o cofre do
subdomínio que o host guardou. Nenhuma senha aparece na tela nem no journal.

## 4. O que é de cada cliente (envs/cell-tenant, CE-07)

Cada cliente da célula tem um estado próprio, `cells/<célula>/tenants/<slug>` no bucket do estado do projeto dos nós,
aplicado pelo executor Terraform do plano de controle (o Job `cp-terraform`). Os recursos do cliente ficam no **projeto
dos nós de clientes** (o do `envs/nodes-platform`), e não no da célula; a VM da célula recebe, de outro projeto, a
permissão em cada um deles:

- a conta de serviço `vxt-<slug>`: a identidade do cliente na AWS. A VM da célula só emite o token OIDC dela, e o
  cp-worker só a desativa e reativa (a suspensão), cada permissão só nessa conta. O executor recusa um plano que a
  apague ou recrie fora do expurgo do cliente (`tenant_sa_replacement`);
- o cofre `vxt-<slug>-admin-bootstrap`: a VM só grava, o cp-worker lê uma vez e destrói a versão;
- os tópicos e as assinaturas `vxc-<célula>-gcp-<UUID da conta>`, um por conta GCP do cliente: só a identidade do sink
  dele publica, só a VM lê. O nome nunca volta depois de uma exclusão.

Os tipos de execução são `cell_provision` e `cell_sources` (`apply`) e `cell_delete` (`destroy`, o expurgo, que só
apaga). As variáveis vêm do registro da célula (o `cell_id`, o projeto, a região e a conta da VM, da saída `cell`) e das
contas GCP do cliente (`GCP_SOURCES`, em JSON), conferidas pelo cp-worker, pelo executor e pelo próprio ambiente.

**Por que no projeto dos nós.** Criar a conta `vxt-<slug>` e dar à VM da célula o token dela exige
`iam.serviceAccounts.setIamPolicy`, e dar a publicação no tópico exige `pubsub.topics.setIamPolicy`. A GCP não aceita
condição do IAM pelo nome de uma conta de serviço nem de um tópico do Pub/Sub (só alguns tipos de recurso passam o nome
à condição), então essas permissões valeriam para o projeto inteiro. No projeto da célula (o do nó da Verax), isso
alcançaria a conta que assina as versões do nó (`verax-release-signer`), a da publicação das imagens e a da própria VM
(que lê o cofre de credenciais): o cp-terraform poderia se dar o token de qualquer uma. No projeto dos nós, o
cp-terraform já administra contas, cofres e Pub/Sub para os nós dedicados (`envs/nodes-platform`), e nada da Verax
mora lá. Por isso o cp-terraform não tem permissão nenhuma no projeto da célula, e o único papel novo é o
`cpTenantSaToggle` do cp-worker, criado no projeto dos nós e concedido só na conta de cada cliente. Um projeto só das
células (o desenho original) fica para quando a cota de contas de serviço do projeto dos nós (cerca de 100, entre nós
dedicados e clientes da célula) ou o limite de projetos com faturamento pedir.

**Risco que fica:** o cp-terraform, já administrador do projeto dos nós, alcança as contas dos clientes da célula como
alcança as dos nós dedicados: poderia se dar o token de um cliente. O papel da AWS do cliente só aceita a sessão vinda
do IP da célula, e o alerta de `SetIamPolicy` do cp-terraform fora da lista (CP-12) é o que torna isso visível.

**Plano de aceite** (sem aplicar), com um `terraform.tfvars` do `terraform.tfvars.example` e as suas credenciais:

```bash
terraform -chdir=infra/gcp/envs/cell-tenant init -backend=false
terraform -chdir=infra/gcp/envs/cell-tenant plan
```

## Ordem para aplicar e configurar

1. `envs/control-plane` aplicado (as contas `cp-worker` e `cp-terraform` existem) e o `envs/nodes-platform` com
   `control_plane_project_id` (o bucket do estado, as permissões do cp-terraform no projeto dos nós e o papel
   `cpTenantSaToggle`).
2. `envs/celula` com `control_plane_project_id` e `control_plane_worker_url` (passo 1 deste roteiro): o canal, as
   exportações e os backups de 85 dias.
3. A imagem nova do executor Terraform (com o `envs/cell-tenant`) publicada no Job `cp-terraform`.
4. A versão do nó com o modo célula instalada, o `cell-adopt` e a troca do `node.conf` (passo 2).
5. Depois, com o canal do lado do plano de controle (CE-05 e CE-06) e o provisionamento na célula (CE-15): o
   `envs/cell-tenant` do cliente da Verax, no projeto dos nós.

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
