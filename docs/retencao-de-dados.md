# Retenção de dados: prazos e o texto da Privacidade e do DPA

_(fase 2, PR-20.)_ Apoio para quem escreve as páginas de Privacidade e o DPA do site, que ficam no repositório do site,
fora deste. Os prazos abaixo são os do código e da infraestrutura deste repositório; quando um deles mudar, este
arquivo muda junto. O desenho do expurgo está em [`ARQUITETURA.md`](ARQUITETURA.md), "Expurgo do histórico".

## Prazos de um nó de cliente

| Dado                                                     | Onde fica               | Prazo                                                                                                                     | De onde vem                                                                       |
| -------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Achados, incidentes, comentários e postura (o histórico) | banco do nó             | o histórico do plano: 90 dias no Essencial, 365 no Profissional, o contratado no Enterprise; contados da última atividade | `packages/shared/src/plans.ts` e o expurgo diário (`apps/api/src/retention/`)     |
| Evento bruto do log (o detalhe do achado)                | índice do Wazuh no nó   | 30 dias                                                                                                                   | política ISM (`ALERT_RETENTION_DAYS`, `infra/wazuh/scripts/configure-indexer.sh`) |
| Trilha de auditoria                                      | banco do nó             | 13 meses, ou o histórico do plano se for maior                                                                            | expurgo diário                                                                    |
| Inventário (retratos das contas)                         | banco do nó             | 30 dias; o retrato mais recente de cada conta fica                                                                        | expurgo diário                                                                    |
| Sessões, links de acesso e tentativas de login           | banco do nó             | um dia depois de vencidos                                                                                                 | expurgo diário                                                                    |
| Backups do banco                                         | bucket de backups do nó | 90 dias, mais 7 de exclusão reversível e o assíncrono do ciclo de vida (até cerca de 99 dias; seção abaixo)               | `infra/gcp/modules/node/backups.tf`                                               |
| Snapshots do disco                                       | projeto do nó           | 7 dias                                                                                                                    | perfil `standard` em `infra/gcp/modules/node/node.tf`                             |
| Cópias locais do backup                                  | disco do nó             | 2 dias                                                                                                                    | `infra/node/bin/backup.sh`                                                        |

As telas seguem o mesmo histórico: os filtros de período de achados, auditoria e relatórios vão até o histórico do
plano (12 meses no Profissional), e o detalhe do achado avisa "Evento bruto do log disponível por 30 dias".

## Eliminação nos backups: o prazo real e a frase do site

_(revisto no CP-11, que resolveu a contradição com `ARQUITETURA.md` que o PR-20 deixou anotada.)_

De onde sai o prazo, com D o dia em que o dado saiu do banco do nó:

- o último backup com o dado é o daquele dia ou do anterior (um por dia, às 06:30 UTC, `verax-backup.timer`); cada
  backup é um objeto novo (`postgres/verax-<data>.dump`), nunca sobrescrito;
- o bucket apaga o backup quando ele faz 90 dias (`lifecycle_rule` com `age = 90`). O bucket é versionado: o backup vira
  versão não corrente, e a mesma regra a apaga na passada seguinte do ciclo de vida, porque ela não tem `with_state`
  (vale para a versão viva e para a não corrente) e a idade conta da criação (a documentação do Cloud Storage: "the age
  of an object is unaffected by the object becoming a noncurrent version");
- a regra `days_since_noncurrent_time = 30` não é a que vale aqui: ela só pegaria um objeto sobrescrito, e mesmo então
  só encurtaria. Por isso a conta de "cerca de 120 dias" que estava em `ARQUITETURA.md` estava errada, e o texto de lá
  foi corrigido;
- o objeto apagado fica 7 dias na exclusão reversível (`soft_delete_policy`, 604.800 s) e então some;
- o ciclo de vida do Cloud Storage é assíncrono e o Google não garante prazo ("your applications shouldn't rely on
  lifecycle actions occurring within a certain amount of time"); na prática, até cerca de um dia por passada, e são
  duas (a versão viva vira não corrente; a não corrente é apagada).

**Prazo real: 90 + 7 dias, mais o atraso do ciclo de vida: cerca de D + 99, nunca D + 120.** D + 97 é o valor nominal,
sem folga nenhuma. Antes disso já venceram os snapshots do disco (7 dias no nó de cliente) e as cópias locais (2 dias).

Frase recomendada para a Privacidade e o DPA (com folga sobre o assíncrono do Google):

> Os dados apagados da plataforma, como os que passam do prazo de histórico do plano, são eliminados também dos
> backups em até 100 dias, contados do dia em que saíram da base de dados.

Se a Verax preferir manter "D + 97" no site, a saída é encurtar a regra do bucket para `age = 88` (88 + 7 + 2 = 97), o
que muda a retenção de backups de todo nó que usa o módulo (inclusive o da Verax e a homologação) e precisa de um PR
próprio; o CP-11 não mudou a retenção. O ensaio geral (PR-21) confere no bucket de homologação, com
`gcloud storage ls --all-versions --soft-deleted gs://<bucket>/postgres/`, quanto tempo o ciclo de vida leva de fato.

## Cancelamento do cliente

Segue a "Exclusão em dois tempos" de `ARQUITETURA.md`, com os prazos contados do cancelamento (D):

| Quando                      | O que sai                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D (cancelamento)            | A VM para (o banco, o Wazuh e o túnel saem do ar; nada mais é coletado nem guardado em backup)                                                                                                                                                                                         |
| até D + 30                  | Exportação sob pedido: o responsável gera um link de 24 h para um backup                                                                                                                                                                                                               |
| D + 30 (ou antes, a pedido) | Exclusão 1: a VM, o disco (o banco), os snapshots do disco, o índice do Wazuh, o túnel, o painel, os cofres de senha; o e-mail do admin sai do cadastro do plano de controle. Fica o bucket de backups (só os backups do banco, que vencem sozinhos) e a chave do cofre de credenciais |
| D + 97                      | Exclusão 2: a chave do cofre de credenciais é destruída (as credenciais da nuvem do cliente que estiverem num backup não se abrem mais) e o bucket de backups é apagado, se a retenção já o esvaziou (senão, uma tentativa por dia)                                                    |
| até cerca de D + 99         | As últimas cópias dos backups saem da exclusão reversível do bucket (o último backup é do dia do cancelamento: 90 + 7 dias, mais o assíncrono do ciclo de vida)                                                                                                                        |
| 5 anos                      | Ficam no plano de controle, por obrigação fiscal: razão social, CNPJ, o identificador do cliente na Stripe, as faturas, o que foi contratado e o aceite dos Termos, da Privacidade e do DPA (versões e data)                                                                           |

O `delete-now` do responsável (o cliente pediu a eliminação antes) adianta a Exclusão 1, mas não a 2: os backups já
gravados saem pela retenção do bucket, contada do último backup. Se a VM não parar no cancelamento (uma falha que gera
alerta), a Exclusão 1 a destrói em D + 30, e o último backup pode ser de até D + 30.

Fora destas frases:

- **Logs na origem:** o que fica na nuvem do cliente (CloudTrail, buckets, auditoria da GCP, do Cloudflare) segue a
  retenção configurada pelo próprio cliente; o nó só lê.
