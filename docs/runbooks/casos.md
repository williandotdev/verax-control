# Casos: ligar, acompanhar e desligar

Um caso reúne os alertas com a mesma origem e o mesmo alvo, para a equipe tratar muitos de uma vez, com desfazer. Como funciona:
`docs/ARQUITETURA.md`, "Casos".

## Os modos (`CASES_MODE`, o mesmo valor na API e no worker)

| Modo     | O que faz                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `off`    | Nada: a tela e os e-mails de sempre                                                                                     |
| `shadow` | Os casos são calculados, e só a equipe da Verax os vê, sem tratar. Para conferir os números. Os e-mails não mudam       |
| `on`     | Todos veem os casos do próprio cliente, quem faz triagem trata em massa, e os e-mails dos alertas passam a ser por caso |

## Onde se liga

- **Nó com acesso (o da Verax, homologação, VM própria do cliente):** `CASES_MODE` em `/etc/verax/node.conf` e
  `sudo systemctl restart verax-node`. Só ponha a linha com o nó já numa versão que a conhece.
- **Nó gerenciado:** ninguém edita o `node.conf` dele, e a atualização da frota não o reescreve. Quem liga é o padrão da versão.

## O caminho

1. `shadow` por 48 horas. O portão para o `on`: até 50 casos novos por dia depois do primeiro dia (fora da fila de
   vulnerabilidades), nenhum alerta alto ou crítico sem caso há mais de 10 min, nenhuma correção de contagem na conferência semanal,
   e os coletores no tempo de antes. Os números estão no log das tarefas `case-assign`, `case-watch` e `case-reconcile` (só
   contagens).
2. `on`. Na primeira partida, o que já foi avisado por e-mail não é avisado de novo; o que estava na fila vira um aviso por caso.

## O que acompanhar

- `SyncState` de `case-assign`, `case-reconcile`, `triage-ops` e `notifications`: `lastError` vazio. `CaseNoticesFailed` é a decisão
  dos avisos falhando para um cliente: os alertas altos e críticos dele avisam um a um depois de 10 min, e o log diz qual.
- "alertas sem caso há mais de 10 min": a atribuição está atrasada. Os alertas altos e críticos avisam um a um enquanto isso.

## Voltar

- De `on` para `shadow` ou `off`, com o restart: o que chegou com os avisos por caso e ainda não tinha sido avisado entra na fila,
  uma vez. Nada se perde: os casos ficam parados no tempo, e ligar de novo continua de onde estavam.
- Para a versão anterior do nó: na parada, o worker faz uma última passagem (até 5 s). Só uma queda sem parada, seguida da versão
  anterior, deixa sem e-mail os alertas do último minuto, até os casos voltarem.
