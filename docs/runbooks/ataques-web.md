# Ataques web pelos logs do ALB: ligar, acompanhar e desligar

A leitura dos logs de acesso dos balanceadores de aplicação (ALB) da AWS do cliente, para detectar varredura, força bruta e
acesso depois de muitas falhas. Como funciona: `docs/ARQUITETURA.md`, "Logs de acesso do ALB".

## Os três portões

1. **O nó:** `AWS_WEB_LOGS_ENABLED`, o mesmo valor na API e no worker. Sozinho, não lê log nenhum.
2. **O balanceador:** alguém do cliente autoriza cada um no painel (Contas cloud), vendo antes a estimativa de volume.
3. **O modo:** todo balanceador começa só observando, por 72 horas. Depois, alguém decide quando começa a alertar.

## Antes de ligar num nó

- O nó e o painel já passaram por **uma versão inteira** com os contratos (a PR-3) antes desta. O nó que voltar para antes
  dela, com alertas `alb` já gravados, não os entende: depois de ligar, não volte além dela.
- O contrato com o cliente diz que a Verax trata os endereços IP de quem visita a aplicação, para detectar ataques; que analisa
  todas as linhas e não guarda nenhuma; e que guarda só a evidência mascarada (amostras e indicações, 30 dias).
- O nó é dedicado, com a identidade na AWS. Na célula, não liga.

## Ligar

- **Nó com acesso (o da Verax, homologação, VM própria do cliente):** `AWS_WEB_LOGS_ENABLED=true` em `/etc/verax/node.conf` e
  `sudo systemctl restart verax-node`. Só ponha a linha com o nó já numa versão que a conhece.
- **Nó gerenciado:** ninguém edita o `node.conf` dele, e a atualização da frota não o reescreve. Quem liga é o padrão da versão:
  disponível desde a 1.5.0, sem ler nada até alguém do cliente autorizar um balanceador.

Depois, no painel: Contas cloud, a conta AWS, "Fontes de log", pedir a estimativa do balanceador, conferir e autorizar.

## O balanceador com o log desligado

O painel mostra "Ligar logs" no ALB sem log ("Não habilitadas na AWS"). Funciona só com a pilha do papel de leitura com
`EnableAlbAccessLogs=true` (o padrão é não), que cria um bucket para o log dos ALB **da região da pilha** e deixa o papel mudar
os atributos de um ALB dessa região. O nó só muda o log de acesso, e só se ele estiver desligado. Como funciona:
`docs/ARQUITETURA.md`, "Ligar o log de acesso do ALB pelo painel".

| Resultado               | O que houve                                                                     | O que fazer                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `enabled`               | Ligado no bucket da pilha; a descoberta da conta foi pedida                     | Esperar o balanceador aparecer em "Disponíveis", pedir a estimativa e autorizar                         |
| `already_enabled`       | O log já gravava em outro bucket; nada mudou                                    | Descobrir de novo; se o papel não lê esse bucket, o balanceador aparece em "Precisam de permissão"      |
| `stack_update_required` | A pilha não tem a opção (ou a conta usa a chave de um usuário de leitura)       | O cliente atualiza a pilha com o arquivo que o painel baixa (`EnableAlbAccessLogs=true`) e pede de novo |
| `permission_denied`     | A AWS negou a mudança                                                           | Pilha atual? Então uma SCP da organização nega `ModifyLoadBalancerAttributes`                           |
| `other_region`          | O bucket da pilha é de outra região                                             | O cliente liga pelos comandos ("Prefere fazer você mesmo?"), ou cria a pilha na região do balanceador   |
| `bucket_rejected`       | A AWS não gravou o arquivo de teste no bucket (a política dele mudou, ou sumiu) | Atualizar a pilha; conferir a política do bucket `AlbLogsBucketName`                                    |
| `released`              | No desligar: alguém mudou o log fora do painel; nada mudou                      | Nada: a partir daí, o log é do cliente                                                                  |

Os pedidos e os resultados ficam na trilha do cliente (`web_logs.alb_logging_enable`, `web_logs.alb_logging_disable` e
`web_logs.alb_logging_result`, este com os atributos de antes e de depois).

## O que o painel diz

| Código                   | O que houve                                                                                        | O que fazer                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `web_gap`                | Nas últimas 24 h, arquivos com mais de um dia ficaram sem leitura (parado, ou volume além do teto) | Ver o intervalo em "Ataques web". A leitura de agora segue; o intervalo não volta, e o aviso sai em um dia |
| `web_unread`             | Há arquivo novo no bucket, e nada é lido há mais de 2 h                                            | "Tentar de novo" no painel (confere a permissão); se continuar, os logs do worker                          |
| `web_quarantined`        | Nas últimas 24 h, um arquivo foi recusado (quebrado, grande demais, Glacier, data absurda)         | O trecho lido antes da recusa segue na detecção, como mínimo; conferir o bucket                            |
| `web_prefix_unsupported` | O prefixo do log no bucket tem um caractere que a leitura não aceita                               | Tirar o prefixo na configuração do balanceador (o painel mostra o comando) e descobrir de novo             |

Um balanceador recriado com o mesmo nome é outro: a observação de 72 horas recomeça.

## Desligar

- **O log que a Verax ligou:** tire a autorização do balanceador e clique em "Desligar log". O nó manda só
  `access_logs.s3.enabled=false`, e só se o log ainda estiver no bucket da pilha; os arquivos ficam no bucket, pela retenção.
  Desligar a opção da pilha não desliga o log de nenhum ALB: o bucket e a política dele ficam na conta.

- **Um balanceador:** tire a autorização no painel. Para na passagem seguinte, e os alertas já abertos ficam.
- **Parar de alertar sem parar de ler:** "Voltar a observar".
- **O nó inteiro (com acesso):** `AWS_WEB_LOGS_ENABLED=false` e o restart. As rotas respondem 404 na hora, e o painel some com
  as telas. Religado depois de mais de 24 h, o intervalo parado vira lacuna (`web_gap`).
- **O nó gerenciado:** uma versão nova com o padrão desligado. Enquanto ela não chega, tirar as autorizações tem o mesmo efeito.
