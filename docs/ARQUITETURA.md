# Arquitetura de implantação (decisão de 02/11/2026)

Substitui a plataforma central na AWS do E8 (ECS, RDS, CloudFront, ALB, NAT e endpoints privados), cara para o
estágio atual. O código da aplicação (API, painel, autenticação, isolamento entre clientes) não muda.

## Princípios

1. **Simples e replicável.** Cada implantação é um **nó**: uma VM com tudo dentro, criada por uma pilha do
   CloudFormation. Subir um cliente novo é criar a pilha e dois registros de DNS.
2. **Hospedagem indiferente.** O nó pode rodar na conta AWS do cliente (que paga a infraestrutura) ou numa conta da
   Verax. Nos dois casos ele lê os dados do cliente **pela API, como se estivesse fora**: assumindo um papel de
   leitura (`VeraxControlReadOnly`) com ExternalId, criado pelo conector na conta monitorada. A conta que hospeda o
   nó não ganha nenhum acesso especial aos dados.
3. **Nada no ambiente do cliente é alterado.** A pilha do nó só cria recursos novos (prefixo `verax-`), numa rede
   própria. O conector só cria o papel de leitura. Nenhuma trilha, destino de log, assinatura, bucket ou política
   existente é modificado.
4. **Nenhum log é apagado ou sobrescrito.** Em três camadas:
   - o papel de leitura não tem nenhuma ação de escrita ou exclusão, e o teste do conector falha se alguma
     aparecer;
   - o Wazuh fica com `remove_from_bucket` e `remove_log_streams` desligados explicitamente. A segunda, se ligada,
     apagaria os log streams do CloudWatch depois de lidos;
   - o WAF aceita um só destino de log por Web ACL: o Verax lê de onde o log já está e nunca troca o destino.

## Componentes de um nó

```
Navegador
 ├─ <cliente>.control.veraxsistemas.com.br ──► GCP (Firebase Hosting, projeto da Verax): só o painel estático
 └─ api.<cliente>.control.veraxsistemas.com.br ──► Cloudflare ──► túnel (conexão de saída do nó; nenhuma porta aberta)
                                                                     │
Conta AWS que hospeda o nó (do cliente ou da Verax) — pilha "verax-control-node"
  rede própria (VPC isolada), na mesma região dos logs monitorados
   └─ VM (16 GB) com Docker
       ├─ Wazuh (manager, indexer, dashboard interno): coleta e correlação
       ├─ API, worker e PostgreSQL
       ├─ Prowler agendado (postura)
       └─ cloudflared (túnel)
  bucket da Verax: backup do banco e relatórios do Prowler
                │ AssumeRole + ExternalId (somente leitura)
Conta(s) monitorada(s) — pilha do conector: papel VeraxControlReadOnly
   CloudWatch Logs, buckets de log, GuardDuty, Security Hub, Inspector, Access Analyzer (leitura)
```

- **Fontes de log:**
  - CloudWatch Logs (CloudTrail, WAF, VPC Flow Logs, RDS, API Gateway, Route53 e aplicações), pelo serviço
    `cloudwatchlogs` do Wazuh;
  - buckets S3 (CloudTrail e findings exportados de GuardDuty e Security Hub);
  - Inspector.

  A coleta lê pela API (`DescribeLogStreams` e `GetLogEvents`), com intervalo conservador: os limites de chamadas
  por segundo são da conta e são divididos com qualquer outra ferramenta que já leia os mesmos logs.

- **Região:** o nó fica na região dos logs, para a leitura não pagar transferência entre regiões.
- **Acesso:**
  - o painel e a API saem pelo túnel do Cloudflare, com login, MFA e as proteções do E2. Equipe remota sem IP fixo
    acessa sem VPN;
  - a operação da VM é pelo SSM Session Manager, sem SSH;
  - o dashboard do Wazuh fica interno ou atrás do Cloudflare Access, só para a Verax.
- **Disponibilidade:** uma VM só, sem alta disponibilidade. Se ela parar, os logs continuam onde estão e o Wazuh
  retoma de onde parou. Tem backup diário do banco e snapshot do disco.

## Custo estimado por nó

Estimativa, a conferir na calculadora da AWS:

| Item                                   | Custo/mês                               |
| -------------------------------------- | --------------------------------------- |
| VM `t3a.xlarge` (4 vCPU, 16 GB)        | cerca de US$ 150–170, conforme a região |
| Disco gp3                              | US$ 10–15                               |
| Bucket, snapshots e IP público         | alguns dólares                          |
| Túnel do Cloudflare e Firebase Hosting | sem custo nesta escala                  |

A leitura de logs pela API não gera transferência entre regiões quando o nó fica na região dos logs.

## Ordem de execução

1. Diagnóstico somente leitura da conta monitorada (`infra/diagnostico/`). **Feito.**
2. Conector revisado:
   - leitura do CloudWatch Logs, Inspector e Access Analyzer;
   - negação explícita de escrita;
   - sem a opção de ligar o log do WAF.
3. Pilha do nó (VPC isolada, VM, bucket, papéis com negação explícita, snapshots e alarme de custo).
4. Docker Compose do nó: instalação, atualização por versão fixada e backup.
5. Painel no Firebase Hosting, com os cabeçalhos de segurança, e publicação pelo GitHub Actions.
6. Remoção do que deixou de ser usado (E8 e a rede do E4).
7. Integração do E5 e telas do E7, sem mudança por causa desta decisão.
