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
     aparecer. Além disso, nega explicitamente as ações que apagariam, desligariam ou desviariam logs, o que vale
     mesmo que a AWS amplie as políticas gerenciadas;
   - o Wazuh fica com `remove_from_bucket` e `remove_log_streams` desligados explicitamente. A segunda, se ligada,
     apagaria os log streams do CloudWatch depois de lidos;
   - o WAF aceita um só destino de log por Web ACL: o Verax lê de onde o log já está e nunca troca o destino.

## Componentes de um nó

```
Navegador
 ├─ <cliente>.control.veraxsistemas.com.br ──► GCP (Firebase Hosting, projeto da Verax): só o painel estático
 └─ api-<cliente>.veraxsistemas.com.br ──► Cloudflare ──► túnel (conexão de saída do nó; nenhuma porta aberta)
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

## Painel e destinos

O painel é estático, no Firebase Hosting do projeto `verax-control-prod` (GCP), um site por destino. Roteiro em
`docs/runbooks/painel.md`.

- `control.veraxsistemas.com.br`: **demonstração comercial**, com dados fictícios simulados no navegador, sem API e
  com aviso em toda tela.
- `verax.control.veraxsistemas.com.br`: **SOC da própria Verax**. Monitora a infraestrutura da Verax na GCP e no
  Cloudflare.
- `<cliente>.control.veraxsistemas.com.br`: um por cliente.

A API de cada destino fica em `api-<cliente>.veraxsistemas.com.br` (a da Verax, em `api-verax`), e não em
`api.<cliente>.control...`. Ela passa pelo túnel do Cloudflare, que exige o proxy ligado e, portanto, o certificado do
Cloudflare. O certificado gratuito dele cobre só um nível de subdomínio (`*.veraxsistemas.com.br`), e o de mais níveis
custaria cerca de US$ 10 por mês (decisão de 02/11/2026). Os painéis não têm esse limite: ficam com o proxy desligado
e o certificado é do Firebase.

## Contas monitoradas por provedor

O cadastro de contas (Contas cloud) aceita três provedores. Nenhum guarda credencial:

| Provedor   | Identificador                            | Origem dos logs                      | Como o nó lê                                   |
| ---------- | ---------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| AWS        | ID da conta (12 dígitos)                 | Buckets e CloudWatch Logs            | Papel `VeraxControlReadOnly` com ExternalId    |
| GCP        | ID do projeto                            | Assinatura do Pub/Sub ligada ao sink | Identidade da VM do nó, sem chave              |
| Cloudflare | ID da conta (32 caracteres hexadecimais) | Zonas (domínios) monitoradas         | Token só de leitura no cofre de segredos do nó |

Cada origem de log (bucket, assinatura ou zona) pertence a um só cliente, como já valia para os buckets: é o que
permite atribuir cada alerta ao cliente certo.

## SOC da própria Verax (fontes da GCP)

A base do nó da Verax na GCP está em `infra/gcp/`, com o passo a passo em `infra/gcp/GUIA.md`, e foi aplicada em
03/11/2026. É um **nó enxuto**: como ele monitora só a GCP e o Cloudflare, não usa o Wazuh. A API lê os logs direto
do Pub/Sub e aplica regras próprias. Tudo roda numa e2-micro do nível gratuito em us-east1, com custo de R$ 5 a 15
por mês. Os nós que monitoram contas AWS de clientes continuam com o Wazuh.

O pacote do nó está em `infra/node/`, com o roteiro em `docs/runbooks/no-verax.md`. Ele roda numa VM só, sem porta
aberta: Postgres com TLS, papéis e migrations, API, worker e o túnel do Cloudflare. As imagens vêm do registro do
projeto, fixadas pelo digest. O nó não depende de e-mail: toda conta nasce com uma senha temporária, que a pessoa
troca no primeiro login antes de cadastrar o MFA (decisão de 03/11/2026). Se o e-mail for ligado (SMTP com TLS), ele
serve só para a redefinição de senha pelo link.

A infraestrutura da Verax roda na GCP. O nó da Verax coleta:

- **Cloud Logging:** auditoria (Admin Activity e acesso a dados, onde estiver ligado), requisições das APIs (Cloud
  Run e balanceador) e, se existir, o WAF (Cloud Armor). A entrega é feita por um _sink_ de log para um tópico do
  Pub/Sub, só com o filtro de segurança. O nó lê a assinatura com uma identidade sem chave: a conta da VM, se o nó
  rodar na GCP, ou federação de identidade, se rodar fora. Nenhuma chave JSON de conta de serviço é criada.
- **Cloudflare:** como na seção abaixo.

## Logs do Cloudflare

Para clientes que usam o Cloudflare (WAF, DNS, proxy), o nó também recebe os eventos dele no Wazuh, com decoders e
regras próprios. A forma depende do que a conta do cliente oferece:

1. **Logpush (preferida).** Segundo a documentação atual do Cloudflare, está disponível em todos os planos, e os
   eventos de firewall podem ser configurados uma vez para a conta inteira. O destino é o bucket do próprio nó (S3),
   nunca um recurso do cliente. O Wazuh lê esse bucket como os outros. Não precisa de porta de entrada.
2. **API GraphQL de analytics (alternativa).** Um coletor no nó consulta os eventos de segurança
   (`firewallEventsAdaptive`) em intervalos, com um token **somente leitura**, e grava num arquivo que o Wazuh lê. O
   Cloudflare guarda pelo menos 31 dias desses eventos, então uma parada do nó não perde dados.

O token do Cloudflare fica no nó (Secrets Manager da conta que hospeda), nunca no repositório. O diagnóstico e a
configuração do Cloudflare entram numa próxima etapa.

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

1. Diagnóstico somente leitura da conta monitorada (`infra/diagnostico/`), publicado por release e com roteiro de
   onboarding (`docs/runbooks/onboarding-cliente.md`). **Feito.**
2. Conector revisado: só o papel de leitura, que só o papel do nó assume, com leitura do CloudWatch Logs, dos buckets
   e das chaves informados, findings do Inspector e do Access Analyzer e negação explícita de escrita. Sem trilha,
   bucket ou log do WAF criados pelo conector. **Feito.**
3. Pilha do nó (`infra/cloudformation/verax-control-node.yaml`): VPC isolada sem porta de entrada, VM, disco de dados,
   bucket, papel com negação explícita, snapshots, alarmes, orçamento e instalação pelo State Manager conferida por
   SHA-256. **Feito** (a instalação espera o pacote do passo 4).
4. Docker Compose do nó: instalação, atualização por versão fixada e backup (`infra/node/`). **Feito** para o nó
   da Verax na GCP.
5. Painel no Firebase Hosting, com os cabeçalhos de segurança, e publicação pelo GitHub Actions.
6. Remoção do que deixou de ser usado (E8 e a rede do E4).
7. Integração do E5 e telas do E7, sem mudança por causa desta decisão.
