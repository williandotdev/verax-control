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
| Backups do banco                                         | bucket de backups do nó | 90 dias, mais 7 de exclusão reversível                                                                                    | `infra/gcp/modules/node/backups.tf`                                               |
| Snapshots do disco                                       | projeto do nó           | 7 dias                                                                                                                    | perfil `standard` em `infra/gcp/modules/node/node.tf`                             |
| Cópias locais do backup                                  | disco do nó             | 2 dias                                                                                                                    | `infra/node/bin/backup.sh`                                                        |

As telas seguem o mesmo histórico: os filtros de período de achados, auditoria e relatórios vão até o histórico do
plano (12 meses no Profissional), e o detalhe do achado avisa "Evento bruto do log disponível por 30 dias".

## Eliminação nos backups: D + 97

Frase para a Privacidade e o DPA:

> Os dados apagados da plataforma, como os que passam do prazo de histórico do plano, são eliminados também dos
> backups em até D + 97 dias, sendo D o dia em que saíram da base de dados.

De onde sai o prazo, com D o dia em que o dado saiu do banco do nó:

- o último backup com o dado é o daquele dia ou do anterior (um por dia, às 06:30 UTC, `verax-backup.timer`);
- o bucket apaga o backup quando ele faz 90 dias (`lifecycle_rule` com `age = 90`). O bucket é versionado: o
  backup vira versão não corrente, e a mesma regra de idade, que vale para todas as versões, a apaga na passada
  seguinte do ciclo de vida;
- o objeto apagado fica 7 dias na exclusão reversível (`soft_delete_policy`, 604.800 s) e então some: 90 + 7 = 97;
- antes disso já venceram os snapshots do disco (7 dias no nó de cliente) e as cópias locais (2 dias).

O ciclo de vida do Cloud Storage roda de forma assíncrona (o Google fala em até 24 horas depois de a condição valer),
então D + 97 é o prazo com pouca folga. O ensaio geral (PR-21) confere no bucket de homologação, com
`gcloud storage ls --all-versions --soft-deleted gs://<bucket>/postgres/`, que nenhum backup passa desse prazo. A
seção "Exclusão em dois tempos" de `ARQUITETURA.md` conta mais 30 dias para a versão não corrente (a regra
`days_since_noncurrent_time = 30`); se o ensaio mostrar a versão ficando esses 30 dias, muda a frase (D + 127) ou a
regra do bucket, antes de a frase ir para o site.

Fora desta frase:

- **Cancelamento do cliente:** segue a "Exclusão em dois tempos" (`ARQUITETURA.md`), com os prazos de lá, contados
  do cancelamento; o esvaziamento do bucket de backups nesse caminho ainda é decisão do CP-11;
- **Logs na origem:** o que fica na nuvem do cliente (CloudTrail, buckets, auditoria da GCP, do Cloudflare) segue a
  retenção configurada pelo próprio cliente; o nó só lê.
