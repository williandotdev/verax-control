# Ciclo de vida do cliente: suspensão, reativação, cancelamento e exclusão

O que fazer quando o relógio do plano de controle (o `tick`) ou uma operação do responsável não chega aonde devia (fase
3, CP-11). O desenho está em `docs/ARQUITETURA.md` ("Ciclo de vida depois da venda" e "Exclusão em dois tempos"); a
configuração, em `infra/gcp/GUIA.md` ("O ciclo de vida (CP-11)"). Nada aqui pede SSH na VM do cliente nem leitura de
dado do cliente.

**Regra de ouro:** a exclusão só existe a partir de `canceled`. Nunca mude `state` à mão para `canceled` ou `deleted`
para "adiantar" uma exclusão, e nunca apague à mão recurso `vx-<slug>` de um cliente: os passos reconhecem o que já foi
apagado e o `delete-now` recomeça de onde der.

## 1. Onde olhar

- **Log do `cp-worker`:** `jsonPayload.event` com `tick` (o resumo de cada hora: quantos em cada parte e `failed`),
  `tick_section_failed` (uma parte falhou; as outras rodaram), `node_power_failed` (a VM não parou ou não ligou: o
  código diz por quê), `node_power_slow`, `deletion_failed` (`tenantId`, `kind`, `step`, `code`), `deletion_step_retry`,
  `deletion_record_unsent`, `backups_bucket_not_empty`, `credentials_key_destroyed`, `tenant_deleted`, `tenant_purged`,
  `export_link_created`. Nunca e-mail, nome, token ou link.
- **No Firestore:** `tenants/<id>`: `state`, `billing` (`mode`, `graceUntil`, `unpaidSince`, `suspendedReason`),
  `lifecycle` (`canceledAt`, `deleteAfter`, `cryptoDestroyAfter`, `nodeStoppedAt`, `cancelScheduledFor`, `run` com o
  passo e o `lastError`, `deletedAt`, `cryptoDestroyedAt`, `purgedAt`). `provisioningRuns/<runId>/steps/<passo>` (as
  execuções da exclusão usam a mesma coleção, com `kind` `delete` ou `crypto_destroy`).
- **Auditoria:** `auditLog` com `tenant.delete_now_requested`, `tenant.delete_now_refused`, `tenant.deletion_completed`,
  `tenant.crypto_destroyed`, `tenant.purged`, `tenant.export_link_created` e `tenant.contract_*`, com quem agiu
  (`owner:<e-mail>` ou `system`).

## 2. Operações do responsável

Pelo console do responsável (os botões chamam o `cp-worker` com a conta do `cp-admin` e o seu e-mail do IAP). Sem o
console, direto, com um token de identidade de uma conta em `owner_principals` e `aud = WORKER_URL` (o GUIA, "Operações
do responsável no `cp-worker`"):

```bash
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"confirmSlug":"<slug>"}' "$WORKER_URL/internal/tenants/<tenantId>/delete-now"
```

| Operação     | Corpo                                  | Quando                                                                                  | Recusa                                                                                  |
| ------------ | -------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `delete-now` | `{confirmSlug}`                        | Cliente `canceled` que pediu a eliminação antes de D+30; repetir uma exclusão que parou | 409 `not_canceled` (qualquer outro estado); 400 `confirmation_mismatch`                 |
| `export`     | `{object: "postgres/verax-...Z.dump"}` | Cliente `canceled` dentro de 30 dias: o link de 24 h de um backup                       | 409 fora da janela ou não cancelado; 404 backup inexistente; 503 sem a conta que assina |
| `cancel`     | `{confirmSlug, at?}`                   | Contrato direto: agora, ou na data do fim do contrato (futura, até 2 anos)              | 409 `stripe_managed` (cliente da Stripe: cancele a assinatura); 400 data no passado     |
| `suspend`    | `{confirmSlug}`                        | Contrato direto: suspender (a VM para)                                                  | 409 `stripe_managed`; 409 `not_allowed` fora de `active`/`waiting`/`past_due`           |
| `reactivate` | `{confirmSlug}`                        | Contrato direto suspenso pelo responsável                                               | 409 `stripe_managed`; 409 `not_allowed`                                                 |
| `resume`     | `{}`                                   | Provisionamento parado (`docs/runbooks/provisionamento.md`)                             | 409 `not_resumable`                                                                     |

Qual backup exportar: liste você mesmo, com as suas permissões (o plano de controle nunca lista o bucket):
`gcloud storage ls gs://<projeto-dos-nos>-vx-<slug>-backups/postgres/ --project <projeto-dos-nos>`. Mande o link ao
cliente por um canal seguro; ele vale 24 h e baixa só aquele objeto.

## 3. O que cada código da exclusão pede

| Código                                                                       | O que aconteceu                                                                                        | O que fazer                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug_not_owned`                                                             | `slugs/<slug>` aponta para outro cliente: o nome `vx-<slug>` pode ser de outro                         | **Não force.** Investigue como o subdomínio mudou de dono; os recursos deste cliente, se existirem, saem à mão, um a um, conferindo o dono                             |
| `provisioning_disabled`                                                      | A configuração do provisionamento sumiu (a exclusão usa o Cloudflare, o Firebase e o Job)              | Configure de novo (GUIA) e `delete-now`                                                                                                                                |
| `release_manifest_missing`, `node_version_unknown`, `executor_input_invalid` | O `destroy` precisa das variáveis do cliente (a versão do nó e o manifesto dela no bucket de releases) | Copie de volta o release da versão presa (`provisioning.nodeVersion`) para o bucket de releases; um dado do cadastro fora do formato pede correção; então `delete-now` |
| `terraform_refused:destroy_plan_unexpected`                                  | O plano da exclusão criaria ou mudaria algo, ou apagaria o que saiu do estado                          | **Não force.** Um `plan -destroy` à mão com o estado do cliente (GUIA, `prefix=tenants/<slug>`) mostra o quê                                                           |
| `terraform_refused:state_not_empty`                                          | A Exclusão 2 achou o estado ainda com recursos                                                         | A Exclusão 1 não terminou: veja o `run` dela; `delete-now` recomeça a fase que parou                                                                                   |
| `terraform_failed`                                                           | O Job falhou duas vezes (o `cleanup_failed` e os `*_delete_failed` também acabam aqui)                 | O log da execução do Job (só linhas `Error:` e os HTTP das APIs); corrija (permissão, cota) e `delete-now`                                                             |
| `backups_bucket_not_empty`                                                   | 14 dias depois de D+97, o bucket de backups ainda tem objetos                                          | `gcloud storage ls --all-versions gs://<bucket>/postgres/`: a regra de idade do bucket mudou? Com ela de volta, `delete-now`                                           |
| `cloudflare_denied`, `firebase_denied`, `secretmanager_denied`, `run_denied` | Credencial ou permissão                                                                                | O token do Cloudflare, o `firebasehosting.admin` no projeto do pool, o `cpSecretVersionDestroyer` no `credentials-key`; corrija e `delete-now`                         |
| `firebase_site_not_owned`                                                    | O id de site gravado não é `vxc-<slug>-<hex>` ou o projeto saiu do pool                                | Confira no console do Firebase; com o projeto de volta à lista, `delete-now`                                                                                           |
| `retries_exhausted`                                                          | Um erro repetível durou as 8 tentativas da fila                                                        | O `errorCode` do passo diz qual; quando o serviço voltar, `delete-now`                                                                                                 |

Um passo em andamento sem erro volta à fila sozinho a cada hora (`deletion_redrive`). Uma VM que não parou
(`node_power_failed`) é pedida de novo a cada hora: com `compute_denied`, confira o `cpNodeLifecycle` no projeto dos nós.

## 4. Aceite (manual, num projeto de teste, com um cliente de teste)

Pré-requisitos: o provisionamento do CP-07 no ar e um cliente de teste provisionado (`vx-<slug>`), cancelado no sandbox
da Stripe (Dashboard: cancelar a assinatura) ou, se for contrato direto, pelo `cancel` do console.

1. Confira a VM parada: `gcloud compute instances describe vx-<slug> --zone <zona> --project <projeto-dos-nos>
--format='value(status)'` → `TERMINATED` (em até uma hora, se o webhook não pediu antes).
2. Exclusão 1 agora: `delete-now` com o subdomínio (pelo console). No log, `deletion_started` e, minutos depois,
   `tenant_deleted`; o e-mail "Registro de exclusão" chega ao admin de teste.
3. Some do projeto dos nós (nenhuma linha em cada um):
   ```bash
   gcloud compute instances list --project <projeto-dos-nos> --filter="name~^vx-<slug>$"
   gcloud compute disks list --project <projeto-dos-nos> --filter="name~^vx-<slug>$"
   gcloud compute snapshots list --project <projeto-dos-nos> --filter="sourceDisk~/disks/vx-<slug>$"
   gcloud compute addresses list --project <projeto-dos-nos> --filter="name~^vx-<slug>-"
   gcloud compute networks list --project <projeto-dos-nos> --filter="name~^vx-<slug>"
   gcloud iam service-accounts list --project <projeto-dos-nos> --filter="email~^vx-<slug>@"
   gcloud pubsub topics list --project <projeto-dos-nos> --filter="name~vx-<slug>"
   gcloud secrets list --project <projeto-dos-nos> --filter="name~vx-<slug>-"   # só o credentials-key
   ```
   Ficam só `vx-<slug>-credentials-key` e o bucket `gs://<projeto-dos-nos>-vx-<slug>-backups` (Exclusão 2).
4. Some do Cloudflare: no painel da zona, DNS, nenhum registro `api-<slug>` nem `<slug>.control` (nem
   `_acme-challenge.<slug>.control`); em Zero Trust, Redes, Túneis, nenhum `vx-<slug>`.
5. Some do Firebase: `firebase hosting:sites:list --project <projeto-do-pool>` sem `vxc-<slug>-...`; no console, o
   domínio `<slug>.control...` não aparece.
6. Exclusão 2 sem esperar 97 dias (só no teste): no Firestore do projeto de teste, mude `lifecycle.cryptoDestroyAfter`
   do cliente para um instante passado e espere o `tick` (ou chame `POST /internal/tick` com o token da cp-invoker, o
   mesmo do Scheduler: `gcloud scheduler jobs run tick --location <região>`). No log, `credentials_key_destroyed` e,
   depois, `tenant_purged` (ou `backups_bucket_not_empty`, se o bucket ainda tiver backups recentes: no teste, apague-os
   à mão antes, com as suas permissões).
7. A cripto-destruição: antes de o executor apagar o cofre, `gcloud secrets versions list vx-<slug>-credentials-key
--project <projeto-dos-nos>` mostra todas as versões `DESTROYED` (rode logo depois da linha `credentials_key_destroyed`,
   enquanto o Job do `purge` ainda executa, de 1 a 2 min; o `auditLog`, `tenant.crypto_destroyed`, guarda quantas
   versões havia). Depois
   do `purge`, `gcloud secrets describe vx-<slug>-credentials-key` responde NOT_FOUND, o bucket de backups não existe e
   `gs://<projeto-dos-nos>-tfstate/tenants/<slug>/default.tfstate` não está mais lá (só a versão antiga, por 30 dias).
8. No Firestore, `tenants/<id>`: `state = deleted`, sem `adminEmail`, `access`, `resources`, `provisioning` e `billing`
   (só `billing.mode` num contrato direto), com `lifecycle.deletedAt`, `cryptoDestroyedAt` e `purgedAt`; as faturas em
   `tenants/<id>/invoices` continuam.
9. Nada sensível no log do `cp-worker` e do Job: nenhum token, link assinado, e-mail ou nome do cliente.
