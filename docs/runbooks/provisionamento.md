# Provisionamento que parou (`provisioning_failed`)

O que fazer quando um cliente pago não chega sozinho a `waiting_customer_connection` (fase 3, CP-07). O desenho está em
`docs/ARQUITETURA.md` ("Provisionamento: os passos e o executor Terraform") e a configuração em `infra/gcp/GUIA.md`
("O provisionamento (CP-07)"). Nada aqui pede SSH na VM do cliente, nem leitura de dado do cliente.

**Regra de ouro:** nada é desfeito numa falha. O cliente fica parado no passo que falhou, com o código, e o `resume`
recomeça do `preflight` com outra execução: cada passo reconhece o que já existe (o túnel pelo nome, o site, o domínio,
os registros, o estado do Terraform) e só faz o que falta. Não apague recurso à mão para "tentar de novo".

## 1. Achar o cliente, o passo e o código

- **O alerta:** no log do `cp-worker`, `jsonPayload.event="provisioning_failed"` com `tenantId`, `step` e `code` (nunca
  e-mail, nome ou token). Um passo que só está repetindo deixa `event="provisioning_step_retry"` com o motivo curto.
- **No Firestore:** `tenants/<id>`: `state = provisioning_failed`, `provisioning.step` (onde parou),
  `provisioning.lastError.code` e `provisioning.runId`. Em `provisioningRuns/<runId>/steps/<passo>`: `attempts`,
  `errorCode` e, no `terraform.apply`/`terraform.wait`, `outputs.execution` (a execução do Job).
- **O cliente vê** "Estamos finalizando seu ambiente manualmente" na página de status, nunca o código.

## 2. O que cada código pede

| Código                                                                                                           | O que aconteceu                                                                                                                                                                                                                               | O que fazer                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provisioning_disabled`                                                                                          | `PROVISIONING_ENABLED` desligado ou o grupo incompleto (o log `provisioning_unconfigured` cita os nomes que faltam)                                                                                                                           | Configure (GUIA, "O que você configura"), aplique o `envs/control-plane` e chame o `resume`                                                                                                                                                                                                                          |
| `configuration_unsupported`                                                                                      | Vendido algo que o `envs/tenant` não cria (outro modo, porte M/G, agentes, limites fora das faixas)                                                                                                                                           | Decisão sua: provisionar à mão, ajustar o que foi vendido (com o cliente) ou reembolsar. O `resume` só adianta depois de o código saber criar isso                                                                                                                                                                   |
| `admin_email_invalid`, `tenant_name_invalid`                                                                     | O e-mail do admin igual ao da conta de suporte, ou fora do formato do nó; ou a razão social acima de 120 caracteres (só num cliente gravado antes desse limite: o checkout e o `customer.updated` recusam desde então, e nada é cortado)      | Corrigir o cadastro com o cliente (o e-mail pelo Portal da Stripe e a razão social, de até 120 caracteres, no Customer da Stripe; o `customer.updated` sincroniza os dois) e `resume`                                                                                                                                |
| `access_email_unconfigured`                                                                                      | Cliente de contrato direto sem o e-mail "ambiente pronto": falta o SMTP do `cp-worker` ou `SITE_SUCCESS_URL` (o único caminho do acesso dele)                                                                                                 | Configure o SMTP (GUIA, passo 4 e `worker_env`) e `resume`. Nada foi criado fora do Firestore                                                                                                                                                                                                                        |
| `release_manifest_missing`, `release_manifest_invalid`                                                           | O manifesto de `NODE_RELEASE` não está no bucket de releases, ou a assinatura não fecha                                                                                                                                                       | Copie de novo o release para o bucket (GUIA, passo 2) e confira com o `verify-release.sh`. Assinatura que não fecha com o arquivo do GitHub é incidente: não force                                                                                                                                                   |
| `panel_bundle_missing`, `panel_bundle_sha256_mismatch`, `panel_bundle_invalid`                                   | O manifesto não tem o bundle do painel (CP-09), ou o arquivo no bucket não é o do manifesto                                                                                                                                                   | Uma versão com o bundle (CP-09), copiada para o bucket; `NODE_RELEASE` nela; `resume`. SHA-256 diferente é arquivo trocado no bucket: investigue antes                                                                                                                                                               |
| `smtp_password_missing`, `smtp_password_invalid`                                                                 | Com o e-mail dos nós ligado (`SMTP_HOST_NODES`), o cofre `cp-nodes-smtp-password` não tem versão habilitada, ou a senha está fora do que o nó aceita (vazia, mais de 512 caracteres, espaço, aspa simples, acento ou quebra de linha no meio) | Grave a senha certa (GUIA, passo 4 do plano de controle) e `resume`. Para provisionar sem e-mail, tire `SMTP_HOST_NODES` e `SMTP_USER_NODES` de `worker_env`, aplique e `resume` (o nó nasce sem e-mail e não o ganha depois). No passo `secrets.smtp_password`, é a versão desativada entre o `preflight` e a cópia |
| `firebase_pool_full`                                                                                             | Todos os projetos de `firebase_panel_projects` têm 36 sites                                                                                                                                                                                   | Crie mais um projeto do Firebase para os painéis, acrescente na lista (Terraform) e `resume`                                                                                                                                                                                                                         |
| `firebase_site_conflict`                                                                                         | Três ids de site sorteados já eram de outros projetos (muito improvável)                                                                                                                                                                      | `resume` (sorteia de novo)                                                                                                                                                                                                                                                                                           |
| `cloudflare_denied`, `firebase_denied`, `run_denied`, `storage_denied`, `secretmanager_denied`, `compute_denied` | O serviço recusou a credencial (401/403)                                                                                                                                                                                                      | O token do Cloudflare (validade, permissões, zona) ou o papel do `cp-worker` naquele recurso (Terraform). Corrija e `resume`                                                                                                                                                                                         |
| `<serviço>_rejected`, `<serviço>_not_found`                                                                      | O serviço recusou o pedido (outro 4xx)                                                                                                                                                                                                        | Leia o log da requisição pelo `requestId`; geralmente configuração (id da zona, nome do Job, bucket)                                                                                                                                                                                                                 |
| `executor_input_invalid`                                                                                         | Uma variável do cliente fora do formato do executor (o log cita só o nome)                                                                                                                                                                    | Corrija o dado (normalmente o cadastro) e `resume`                                                                                                                                                                                                                                                                   |
| `terraform_refused:node_sa_replacement`                                                                          | O plano do `envs/tenant` apagaria ou recriaria a conta de serviço do nó                                                                                                                                                                       | **Não force.** A conta recriada ganha outro ID, e a AWS do cliente deixa de aceitar o nó. Investigue o que mudou (`slug`, `project_id`, uma mudança no módulo) num `plan` à mão com o estado do cliente (GUIA, `plan` de aceite, com `prefix=tenants/<slug>`)                                                        |
| `terraform_refused:input_invalid`, `terraform_refused:action_refused`, `terraform_refused:plan_unreadable`       | O executor recusou a entrada ou o plano antes do `apply`                                                                                                                                                                                      | O log da execução do Job (`gcloud run jobs executions logs read <execução> --region southamerica-east1`) diz qual variável, sem o valor                                                                                                                                                                              |
| `terraform_failed`                                                                                               | O `apply` falhou duas vezes (uma repetição automática)                                                                                                                                                                                        | O log da execução mostra só as linhas `Error:`; com isso, corrija (cota de redes, IPs ou CPUs; API desligada; permissão) e `resume`. O estado do Terraform está no bucket: o `apply` seguinte continua de onde parou                                                                                                 |
| `terraform_outputs_missing`, `terraform_outputs_invalid`                                                         | O `apply` terminou, mas o `outputs.json` não chegou ou não é deste cliente                                                                                                                                                                    | `gsutil ls gs://<projeto-dos-nos>-tfstate/runs/<slug>/<runId>/`; o `result.json` diz o desfecho. `resume`                                                                                                                                                                                                            |
| `node_error:smtp_password_missing`                                                                               | A instalação esperou 60 min a senha da caixa no `vx-<slug>-smtp-password` e não achou (o passo `secrets.smtp_password` não gravou, ou a VM não lê o cofre)                                                                                    | `gcloud secrets versions list vx-<slug>-smtp-password --project <projeto-dos-nos>` (tem de ter uma versão habilitada). Sem versão, o `resume` grava de novo; com versão, a leitura da VM (a saída serial mostra o erro do gcloud). Depois, reinicie a VM e `resume`                                                  |
| `node_error:<código>`                                                                                            | A instalação na VM gravou `verax/error` (a tabela dos códigos está na ARQUITETURA, "Instalação sem operador")                                                                                                                                 | Saída serial: `gcloud compute instances get-serial-port-output vx-<slug> --zone <zona> \| grep 'verax-boot:'`. Corrija a causa, reinicie a VM (`gcloud compute instances reset`) e chame o `resume` (a VM já criada é reconhecida)                                                                                   |
| `ready_timeout`                                                                                                  | 90 min sem `verax/ready` nem `verax/error`                                                                                                                                                                                                    | A mesma saída serial. Se a VM ficou pronta depois, só o `resume`                                                                                                                                                                                                                                                     |
| `health_failed`                                                                                                  | A API pelo túnel ou o painel no `<site>.web.app` não responderam em 5 min                                                                                                                                                                     | `curl -i https://api-<slug>.<domínio>/health`; o túnel no painel do Cloudflare (conectado?); o cofre do túnel com versão. `resume`                                                                                                                                                                                   |
| `domain_timeout`                                                                                                 | O certificado do domínio do painel não saiu em 24 h                                                                                                                                                                                           | No console do Firebase (Hosting, domínios do site): os registros pedidos estão no Cloudflare, sem proxy? Um registro antigo conflitando? Corrija e `resume`                                                                                                                                                          |
| `bootstrap_missing`                                                                                              | A VM ficou pronta, mas a senha do primeiro admin não está no `admin-bootstrap`                                                                                                                                                                | `systemctl status verax-customer-bootstrap` pelo IAP, ou o runbook de onboarding (item 7). Depois, `resume`                                                                                                                                                                                                          |
| `retries_exhausted`                                                                                              | Um erro repetível (rede, 5xx, 429, a trava de outra execução) durou as 8 tentativas da fila                                                                                                                                                   | O `errorCode` em `steps/<passo>` diz qual (`cloudflare_503`, `lock_held`, ...). Quando o serviço voltar, `resume`                                                                                                                                                                                                    |
| `run_state_invalid`                                                                                              | A execução perdeu um dado que um passo anterior gravou (não deveria acontecer)                                                                                                                                                                | `resume` (recomeça do `preflight`)                                                                                                                                                                                                                                                                                   |

## 3. Retomar (`resume`)

Pelo console do responsável: **Clientes** → o cliente → **Retomar provisionamento…**, com o subdomínio digitado para
confirmar (`docs/runbooks/console-do-responsavel.md`, seção 7). O console chama o `cp-worker` com a conta dele e o seu
e-mail do IAP. Sem o console, direto:

```bash
# Um token de identidade com aud = WORKER_URL de uma conta em owner_principals (veja o GUIA, "Operações do
# responsável no cp-worker"; um token de usuário do gcloud tem outro aud e é recusado).
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$WORKER_URL/internal/tenants/<tenantId>/resume"
```

A resposta traz o `runId` novo e o passo (`preflight`). O cliente volta a `provisioning`; tasks da execução anterior
que ainda chegarem são ignoradas (`stale_run`). O `resume` também tira do lugar um cliente parado em `provisioning`
(por exemplo, os que o webhook deixou no `preflight` antes de existir o worker). Num cliente fora de
`provisioning_failed` e `provisioning`, responde 409.

**A versão do nó não muda num `resume` depois de um `apply`:** o `terraform.apply` prende a versão no cliente
(`provisioning.nodeVersion` e `nodeVersionPinnedAt`) antes de disparar o Job, porque a VM pode existir mesmo com o
`apply` falhando. Trocar `NODE_RELEASE` e retomar não muda a versão desse cliente (o log diz `node_release_pinned`);
a atualização de um nó já criado é pelo `deploy.sh` (onboarding, item 8). Só um cliente que parou antes de qualquer
`apply` (no `preflight`, no túnel ou no bundle do painel) recebe a versão nova.

## 4. Trocar a senha do e-mail dos nós

A caixa de envio comum aos nós de clientes (`SMTP_*_NODES`, senha em `cp-nodes-smtp-password`; ARQUITETURA, "O e-mail
dos nós de clientes"). O nó lê a senha do cofre dele na partida, então a troca tem uma janela em que as duas valem:

1. **No provedor**, crie a senha nova (uma senha de aplicativo nova, uma chave nova) **sem revogar a antiga**.
2. **No plano de controle**, grave a nova como versão do segredo (no Git Bash, sem eco e sem histórico):

   ```bash
   read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add cp-nodes-smtp-password --project <projeto-da-verax> --data-file=- && unset VALOR
   ```

3. **Copie para os nós** (o mesmo token do `resume`, acima), até a resposta dizer `"complete": true`:

   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$WORKER_URL/internal/nodes/smtp-password/sync"
   # Com "next" na resposta, o tempo da chamada acabou com clientes pela frente: continue de onde parou.
   curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$WORKER_URL/internal/nodes/smtp-password/sync?after=<next>"
   ```

   O cp-worker varre todos os clientes em páginas, pelo subdomínio (uma ordem que não muda no meio da varredura), e
   para cada chamada em cerca de 10 minutos, abaixo do prazo do Cloud Run. A resposta traz `updated` (quantos cofres
   receberam a senha nova nesta chamada), `failed` (os ids dos clientes cujo cofre recusou; o log
   `node_smtp_password_sync_failed` diz o motivo de cada um), `skipped` (os já excluídos), `complete` e, quando há
   clientes pela frente, `next` (o `after` da chamada seguinte). **`complete` só é `true` quando a varredura chegou ao
   fim e nenhum cofre recusou**: com `next` ou com `failed`, a troca está pela metade (corrija o motivo e chame de novo
   do começo, sem `after`; repetir é seguro, grava a mesma `latest`). Um erro (5xx, a conexão caiu) também é troca pela
   metade. Responde 409 com `node_mail_disabled` (sem `SMTP_HOST_NODES`) ou `smtp_password_missing` (o cofre sem versão
   habilitada) e 400 com um `after` fora do formato; a senha nunca sai na resposta nem no log. Cada cliente atualizado
   ganha `resources.nodeMailPasswordAt` novo e um registro na trilha com `owner:<e-mail>`.

4. **Reinicie os nós** numa hora calma: o `start.sh` só lê o cofre na partida. Sem SSH,
   `gcloud compute instances reset vx-<slug> --zone <zona> --project <projeto-dos-nos>` (a VM volta em minutos, e o
   Wazuh em até 40); um deploy de versão nova também reinicia. Até lá, o nó continua com a senha antiga, que ainda vale.
5. **Revogue a antiga** no provedor só depois de uma recópia com `"complete": true` e de todos os nós reiniciarem, e
   desative as versões antigas do segredo (`gcloud secrets versions disable <n> --secret cp-nodes-smtp-password`).

Só a senha chega aos nós que já existem: um servidor, uma porta ou um usuário novos (`SMTP_*_NODES`) valem só para os
nós criados depois. Num nó existente, isso é o caminho de atualização (o `deploy.sh` com o `node.conf` ajustado).
Uma senha vazada num nó: troque como acima e revogue a antiga logo que os nós reiniciarem (ou antes, aceitando que os
avisos falhem até o reinício).

## 5. O que nunca fazer

- Mudar `tenants/<id>` à mão para "pular" um passo: os passos seguintes dependem do que os anteriores gravaram.
- Disparar o Job `cp-terraform` à mão com variáveis digitadas: o executor confere tudo, mas o dado certo está no
  Firestore; use o `resume`.
- Apagar o túnel, o site ou o estado do Terraform de um cliente que vai continuar: o `resume` os reaproveita.
- Copiar para o bucket de releases um manifesto que o `verify-release.sh` não aceita.
- Gravar a senha da caixa de envio direto no cofre de um nó à mão, fora da recópia: o próximo `sync` a troca pela do
  `cp-nodes-smtp-password`.
