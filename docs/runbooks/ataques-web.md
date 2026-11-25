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
- **Nó gerenciado:** ninguém edita o `node.conf` dele, e a atualização da frota não o reescreve. Quem liga é o padrão da versão.

Depois, no painel: Contas cloud, a conta AWS, "Fontes de log", pedir a estimativa do balanceador, conferir e autorizar.

## O que o painel diz

| Código                   | O que houve                                                                                        | O que fazer                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `web_gap`                | Nas últimas 24 h, arquivos com mais de um dia ficaram sem leitura (parado, ou volume além do teto) | Ver o intervalo em "Ataques web". A leitura de agora segue; o intervalo não volta, e o aviso sai em um dia |
| `web_unread`             | Há arquivo novo no bucket, e nada é lido há mais de 2 h                                            | "Tentar de novo" no painel (confere a permissão); se continuar, os logs do worker                          |
| `web_quarantined`        | Nas últimas 24 h, um arquivo foi recusado (quebrado, grande demais, Glacier, data absurda)         | O trecho lido antes da recusa segue na detecção, como mínimo; conferir o bucket                            |
| `web_prefix_unsupported` | O prefixo do log no bucket tem um caractere que a leitura não aceita                               | Tirar o prefixo na configuração do balanceador (o painel mostra o comando) e descobrir de novo             |

Um balanceador recriado com o mesmo nome é outro: a observação de 72 horas recomeça.

## Desligar

- **Um balanceador:** tire a autorização no painel. Para na passagem seguinte, e os alertas já abertos ficam.
- **Parar de alertar sem parar de ler:** "Voltar a observar".
- **O nó inteiro (com acesso):** `AWS_WEB_LOGS_ENABLED=false` e o restart. As rotas respondem 404 na hora, e o painel some com
  as telas. Religado depois de mais de 24 h, o intervalo parado vira lacuna (`web_gap`).
- **O nó gerenciado:** uma versão nova com o padrão desligado. Enquanto ela não chega, tirar as autorizações tem o mesmo efeito.
