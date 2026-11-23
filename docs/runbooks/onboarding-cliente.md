# Onboarding de um cliente

Roteiro da equipe da Verax para colocar um cliente novo em monitoramento. Vale para qualquer cliente e não depende de
nenhuma ferramenta além deste repositório. As etapas marcadas como _em construção_ entram com as próximas entregas da
arquitetura (`docs/ARQUITETURA.md`). A conta AWS é conectada pelo próprio cliente, no painel (seção 4.1); o roteiro
para homologar esse fluxo numa conta AWS de teste é o `docs/runbooks/homologacao-onboarding-aws.md`.

## 1. Diagnóstico da conta (somente leitura)

1. Envie ao contato técnico do cliente o link do guia da versão mais recente do diagnóstico:
   `https://github.com/williandotdev/verax-control/releases`. Procure a release `diagnostico-vX.Y.Z` mais recente e
   envie o arquivo `GUIA-CLIENTE.md`. O guia já traz os comandos com a versão certa.
2. O cliente roda o diagnóstico no AWS CloudShell e devolve dois arquivos: `diagnostico-verax-<conta>.md` e `.json`.
3. Guarde os arquivos **fora do git**, na pasta privada do cliente. Eles trazem número de conta e nomes de recursos.

## 2. Leitura do relatório (`.md`)

- **Visão geral:** o que está ligado (CloudTrail, GuardDuty, Security Hub, Inspector) e o volume no CloudWatch Logs.
- **Fontes sugeridas:**
  - `sim`: fontes de segurança, que entram;
  - `avaliar`: decidir com o cliente (VPC Flow Logs, banco, DNS, logs de aplicação). Pese o volume por dia: alto
    volume pede filtro ou fica de fora no começo;
  - `não`: métricas de desempenho.
- **Pontos de atenção:** o que **não pode ser alterado** no ambiente do cliente. Exemplos: Web ACL que já envia log
  (o WAF aceita um só destino), GuardDuty que já exporta, log groups já no limite de subscription filters. A Verax lê
  de onde os logs já estão.
- **Limites de leitura:** são da conta e são divididos com qualquer outra ferramenta que já leia os mesmos logs. Uma
  coleta agressiva atrapalha as outras.

## 3. Reunião de definição com o cliente

O desenho é o da revisão de 04/11/2026 (`docs/ARQUITETURA.md`): **não peça ao cliente a pilha do conector antigo, com
ExternalId, nem a do nó na AWS**, que ficaram fora do caminho.

- Todo nó de cliente roda na GCP da Verax, em São Paulo (southamerica-east1), criado pelo Terraform de `infra/gcp/`.
- A AWS do cliente é lida por um **papel IAM de leitura sem chave** (`verax-control-reader`), que o próprio cliente
  cria com o template `infra/cloudformation/verax-control-reader.yaml`. Só o nó dele entra no papel, com um token de
  até 1 hora que o Google assina para a conta de serviço do nó, e só a partir do IP de saída do nó. Não existe chave
  para criar, copiar, guardar ou trocar, nem ExternalId.
- **Quem conecta é o cliente, pelo painel** (o onboarding self-service, seção 4.1): o botão "Conectar com AWS" baixa
  o template já preenchido e abre o CloudFormation; depois, o nó descobre sozinho as fontes de log da conta, e o
  cliente autoriza as que quer. Ele escolhe, na pilha, três autorizações: os logs que a AWS grava no S3 (CloudTrail,
  VPC Flow Logs, WAF e o export do GuardDuty), os achados de segurança (GuardDuty, Security Hub, Inspector e Access
  Analyzer, pelas APIs) e os grupos do CloudWatch Logs que ele marcar com uma tag. Ninguém digita bucket, ARN, região
  nem nome de grupo.
- A Verax nunca liga nem altera nada na conta do cliente. O que o diagnóstico (seção 2) mostrar desligado continua
  desligado até o cliente decidir, e ligar tem custo na AWS.
- Não há venda assistida: a primeira venda só acontece depois do provisionamento automático (fase 3).

Na reunião:

- Combine o que o cliente vai autorizar (as três autorizações e, depois da descoberta, as fontes): pese o volume dos
  flow logs e dos grupos de logs, e lembre que log de aplicação pode ter dado pessoal. Só os buckets fora do padrão
  `AWSLogs/<conta>/` (um prefixo próprio, um bucket central) precisam ser digitados, com as chaves KMS deles.
- Avise o que o cliente vai ver: o IAM Access Analyzer mostra o papel com acesso externo federado (esperado: papel com
  credencial temporária é o que a AWS recomenda), e o CloudTrail registra cada entrada (`AssumeRoleWithWebIdentity`)
  com o ID da conta de serviço do nó. Se a organização dele usa uma RCP de perímetro de dados que nega a federação de
  provedores fora de uma lista, ele inclui `accounts.google.com` nela ou marca o papel como exceção. A decisão é dele.
- Colete o fluxo de escalonamento (quem recebe Critical, High, Medium e Low, e por qual canal) e a baseline de rede:
  portas publicadas e tráfego interno esperado. As duas coisas evitam o ruído que mais incomoda o cliente.
- Combine o subdomínio do painel: `<cliente>.control.veraxsistemas.com.br`.

## 4. Nó, conta AWS e painel _(em construção)_

1. **Nó do cliente** no perfil `standard`, pelo Terraform de `infra/gcp/` (`infra/gcp/GUIA.md`). Anote o IP reservado
   do NAT (`terraform output nat_ip`) e o ID único da conta de serviço do nó, com 21 dígitos (a saída
   `service_account_unique_id` do módulo; na homologação, `terraform output node_service_account_unique_id`). Nenhum
   dos dois é segredo. Uma conta de serviço recriada ganha outro ID e quebra o papel do cliente até ele atualizar a
   pilha: pare diante de um `plan` que a recrie.
2. **No `node.conf` do nó** (o arquivo que o `deploy.sh` leva), os valores que o painel mostra para a pilha:
   ```sh
   NODE_EGRESS_IPS=<o nat_ip>/32
   NODE_SA_UNIQUE_ID=<o ID único da conta de serviço, 21 dígitos>
   # AWS_WEB_IDENTITY_AUDIENCE=https://control.veraxsistemas.com.br/aws-reader   # só para trocar o padrão
   ```
   Rode o `deploy.sh`. Sem as linhas, a tela da conta AWS pede os valores à Verax, e o worker não confere a conexão
   (o "Verificar" responde `check_unavailable`). Na partida, o worker confere que o token do Google do nó é dessa
   conta de serviço: se o log do worker disser que não é, corrija o `NODE_SA_UNIQUE_ID` antes de passar o valor ao
   cliente. Sem o `NODE_EGRESS_IPS`, a conferência diária de permissão demais fica de fora, e o painel não monta o
   arquivo da pilha do "Conectar com AWS". O IP de saída também entra
   nas regras locais do Wazuh do nó (a leitura do próprio nó não vira alerta; a mesma sessão de outro IP vira nível
   12), e o audience é o que o host pede ao Google a cada 10 min. Depois do deploy, no nó, o `verax-aws-token.timer`,
   o `verax-wazuh-apply.timer` e o `verax-wazuh-progress.timer` aparecem em `systemctl list-timers`, e o
   `verax-wazuh-apply.path` está ativo.
3. Crie os registros no Cloudflare (túnel da API) e o site do painel no Firebase Hosting.
4. Cadastre o cliente no painel, em **Clientes → Novo cliente**, já com o primeiro administrador (nome e e-mail).
   A conta nasce junto com o cliente, como administrador do cliente, com uma senha temporária que aparece **uma
   única vez**, na tela do cadastro: copie e repasse à pessoa por um canal seguro, de preferência fora do e-mail
   (pessoalmente, por telefone ou por mensageiro com criptografia de ponta a ponta). A senha vale por 72 horas; no
   primeiro login, a pessoa troca a senha e cadastra o MFA. Se a senha se perder ou vencer, selecione o cliente no
   seletor do topo e gere outra em Usuários.
5. Com o cliente selecionado, cadastre as contas cloud e os demais usuários (cada um também nasce com uma senha
   temporária, repassada do mesmo jeito). O próprio administrador do cliente pode criar os usuários dele. Os avisos
   por e-mail (incidente alto ou crítico, achado crítico e, só para administradores, 80% e 100% do volume do plano)
   chegam só a quem já trocou a senha e cadastrou o MFA, e só com o e-mail ligado no nó (`MAIL_TRANSPORT=smtp` no
   `node.conf`, com a senha da caixa no cofre `<prefixo>-smtp-password`); `leitura` não recebe. Cada pessoa pode
   desligar os avisos de incidente em **Minha conta** (no cabeçalho), e a coluna "Recebe alertas" de Usuários mostra
   quem recebe.

   **Contato de escalonamento (D8).** O contato do cadastro do cliente recebe só os avisos críticos (incidente crítico
   e achado crítico), e só depois de confirmar o endereço pelo link de um e-mail que o nó manda ao cadastrar ou trocar
   o endereço (o link vale 72 horas e uma vez). Cada aviso a ele traz o link para deixar de receber. A situação
   ("Aguardando confirmação", "Confirmado" ou "Descadastrado") aparece no cadastro do cliente, para a Verax, e em
   **Administração → Escalonamento**, para o administrador do cliente, que também troca o contato por ali; os dois têm
   "Reenviar confirmação" (o e-mail não chegou, o link venceu, ou o contato se descadastrou e pediu para voltar). Com o
   e-mail desligado no nó, o pedido de confirmação não sai, e a tela diz isso. Os contatos cadastrados antes deste
   controle começam aguardando a confirmação, sem e-mail: peça a confirmação pelo painel quando o SMTP estiver ligado.

   **Limites do plano.** O nó aplica o plano do `node.conf` (`PLAN` e os ajustes `PLAN_*`): contas cloud ativas e
   usuários convidados ou ativos (a equipe da Verax não conta). O uso aparece em **Administração → Plano e uso**, para
   os administradores. No limite:
   - o cadastro e a reativação de uma conta ou de um usuário são recusados com "Seu plano permite até N …" (409
     `PLAN_LIMIT_REACHED`), e a tentativa fica na auditoria do cliente;
   - o bootstrap do nó mostra `Conta GCP <projeto>: plan-limit.` para a conta que ficou de fora, e segue com o resto.

   O caminho é o cliente desativar uma conta ou um usuário (a vaga volta na hora) ou ampliar o plano: troque o ajuste
   no `node.conf` (`PLAN_MAX_CLOUD_ACCOUNTS` ou `PLAN_MAX_USERS`, de 1 a 1000) e rode o `deploy.sh`, porque a API lê o
   plano na partida. Uma conta da GCP que ficou de fora no bootstrap entra rodando o bootstrap de novo. Descer de plano
   não desativa nada: o painel mostra "acima do limite do plano", e só os próximos cadastros são recusados. O volume
   do mês acima do plano não bloqueia nada: a coleta continua e nenhum log é descartado.

6. **Conta AWS:** quem conecta é o cliente, pelo painel dele. O que ele faz, o que a Verax acompanha e como ler cada
   estado estão na seção 4.1, logo abaixo.

### 4.1 Conta AWS: o onboarding self-service

O desenho, as regras e os limites estão em `docs/ARQUITETURA.md` ("Onboarding AWS self-service"). O passo a passo do
cliente no console da AWS, com cada permissão explicada, é o `infra/cloudformation/README.md`. Nada disto foi
exercitado numa conta AWS de verdade antes da homologação (`docs/runbooks/homologacao-onboarding-aws.md`).

**Antes do cliente, no nó:** as linhas `NODE_EGRESS_IPS` e `NODE_SA_UNIQUE_ID` do `node.conf` (item 2). Sem elas, o
painel não monta o arquivo da pilha (a tela diz "peça à Verax") e o worker não confere a conexão.

#### O que o cliente faz

1. **Cadastra a conta**, em Contas cloud → Cadastrar conta → AWS: só o ID da conta (12 dígitos) e a região principal.
   Os buckets ficam recolhidos em "Avançado: buckets fora do padrão" e só servem para as exceções (abaixo).
2. **Escolhe o que autoriza**, em "O que você autoriza": a descoberta vale sempre, e as três autorizações vêm
   marcadas (os logs que a AWS grava no S3, os achados de segurança e os grupos do CloudWatch Logs que ele marcar). A
   escolha fica gravada: a tela recarregada devolve as mesmas caixas e o mesmo arquivo.
3. **Clica em "Conectar com AWS".** O painel abre o CloudFormation em outra aba e baixa o arquivo
   `verax-control-reader-<conta>.yaml`, já com os valores do nó e a escolha dele. O arquivo só sai depois de a
   escolha ser gravada: se a tela mostrar um erro no lugar, nenhum arquivo foi baixado, e é só clicar de novo. Lá no
   CloudFormation: _Create stack_ → _Upload a template file_, o nome `verax-control-reader`, avançar sem mudar os
   valores, marcar a confirmação de IAM e criar. Leva 1 ou 2 minutos.
4. **Espera, sem clicar em nada.** O nó tenta entrar no papel por até 60 min. Quando a pilha termina, a tela avança
   sozinha: a autenticação, a descoberta (segundos a poucos minutos) e a lista das fontes.
5. **Autoriza as fontes**, em "Fontes de log": marca as que quer e confirma. Os grupos do CloudWatch Logs são
   escolhidos um a um, com uma confirmação a mais (log de aplicação pode ter dado pessoal), e só aparecem como
   disponíveis depois de ele pôr a tag no grupo, com o comando que a tela mostra:
   `aws logs tag-resource --resource-arn '<arn do grupo>' --tags verax-control=leitura`. A coleta de cada fonte
   começa no dia da autorização, sem histórico.
6. **Acompanha**, em "Fontes autorizadas": o estado, o último evento, a última leitura, o atraso e o volume de cada
   fonte. "Revogar" tira uma fonte da coleta a qualquer momento.

O que avisar ao cliente antes: a Verax nunca liga nada na conta dele (GuardDuty, Security Hub, Inspector, uma trilha,
flow logs e o logging do WAF têm custo na AWS, e a decisão é dele); autorizar um Flow Log lê todos os Flow Logs
daquela conta e região que gravam no mesmo bucket; e flow logs e grupos de logs podem aumentar o volume do plano
(nada é bloqueado por plano, e nenhum log é descartado).

#### O que a Verax acompanha

O estado da conta aparece em "Situação da conexão" (o mesmo que `GET /v1/cloud-accounts/:id/aws/onboarding` devolve
em `state`). A tela nunca diz "tudo certo" com um passo pendente.

| Na tela                          | `state`                  | O que quer dizer                                                                                  | O que fazer                                                                                                          |
| -------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Não conectada                    | `not_started`            | Ninguém pediu a conexão (ou ela recomeçou: outra lista de buckets, a conta reativada)             | O cliente clica em "Conectar com AWS"; se a pilha já existe, em "Verificar conexão"                                  |
| Aguardando autorização na AWS    | `awaiting_authorization` | O nó está tentando entrar no papel. Ele não vê a pilha sendo criada: só sabe que ainda não entrou | Esperar. A tela mostra o tempo que falta da janela de 60 min                                                         |
| Tempo esgotado                   | `authorization_timeout`  | O papel não apareceu em 60 min                                                                    | Conferir no CloudFormation se a pilha terminou (ou falhou) e clicar em "Conectar de novo"                            |
| Desconectada                     | `disconnected`           | A AWS recusa a entrada (a pilha foi apagada ou alterada), ou o nó não consegue conferir           | Ver a conferência "Entrada no papel de leitura": o código diz o quê. As fontes e as autorizações continuam guardadas |
| Autenticação validada            | `authenticated`          | Entrou no papel; a descoberta ainda não terminou nenhuma vez (ou a primeira falhou inteira)       | Esperar a descoberta; se falhou, "Rodar a descoberta de novo"                                                        |
| Descoberta em andamento          | `discovering`            | A primeira descoberta está na fila ou rodando                                                     | Esperar                                                                                                              |
| Aguardando autorização de fontes | `awaiting_sources`       | A descoberta terminou, e nada está autorizado                                                     | O cliente escolhe e autoriza                                                                                         |
| Configurando coletores           | `configuring`            | Há fonte autorizada, e nenhuma coleta começou                                                     | Esperar: as fontes de bucket entram no manager em até 1 min, e as de achados são lidas em até 5 min                  |
| Coletando eventos                | `collecting`             | Toda fonte autorizada está sendo lida                                                             | Nada. Com "com pendências" no título, uma conferência ainda espera                                                   |
| Parcialmente operacional         | `partial`                | Só parte das fontes autorizadas está coletando                                                    | Ver quais em "Fontes autorizadas" (as conferências apontam a linha)                                                  |
| Erro de permissão                | `permission_error`       | Uma fonte autorizada (ou um bucket do cadastro) não pode ser lida                                 | A correção exata está na linha da fonte (tabela "Falta de permissão", abaixo)                                        |
| Falha de ingestão                | `ingestion_failure`      | A coleta de uma fonte falha, ou o nó não aplica a configuração da coleta                          | O motivo está na linha da fonte. `aws_token_stale` e `wazuh_apply_failed` são do nó, não da conta do cliente         |

**As nove conferências** ("Conferências da conexão"), cada uma com Certo, Pendente, Com problema ou Não se aplica, o
motivo e, quando há, o botão de tentar de novo. As cinco últimas trazem um link para a linha de cada fonte que as
segura, em "Fontes autorizadas" (a linha apontada fica em destaque):

| Conferência                      | `id`               | O que confere                                                    | Quando falha ou espera                                                                                                                                                                            |
| -------------------------------- | ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entrada no papel de leitura      | `assume_role`      | O `AssumeRoleWithWebIdentity` do nó no papel do cliente          | `awaiting_stack` (dentro da janela), `verifying` (um "Verificar" comum, até 10 min), ou o código da conexão: `trust_denied`, `token_invalid`, `authorization_timeout` (a lista dos erros, abaixo) |
| Conta e papel conferidos         | `identity`         | A sessão é da conta cadastrada e do papel `verax-control-reader` | `account_mismatch`: o ID cadastrado não é o da conta em que a pilha foi criada                                                                                                                    |
| Modelo da pilha e autorizações   | `template`         | As tags do papel: a versão do template e as autorizações         | `template_outdated` (pilha do modelo 1: "Atualize a pilha"), `template_unreadable` (a tag da versão não é um número)                                                                              |
| Descoberta das fontes            | `discovery`        | A última descoberta                                              | Certo com `partial`: alguma leitura ficou de fora ("O que encontramos" diz qual). Com problema: a descoberta inteira falhou                                                                       |
| Permissão das fontes autorizadas | `permission`       | A última sondagem de cada fonte autorizada                       | O motivo é o `permissionDetail` da fonte (tabela abaixo)                                                                                                                                          |
| Configuração dos coletores       | `collector_config` | As fontes entraram no coletor delas                              | `awaiting_collector` (ainda não entraram); `aws_token_stale` ou `wazuh_apply_failed` (o aviso do nó inteiro)                                                                                      |
| Chegada de eventos               | `events`           | Toda fonte autorizada está coletando                             | `waiting_events` (configurada, sem evento ainda); `stalled`/`no_progress` (a trilha ou os flow logs pararam); `throttled` ou o nome do erro da AWS (achados)                                      |
| Última leitura das fontes        | `last_sync`        | Toda fonte autorizada já foi lida, com o horário da mais antiga  | `no_data`: alguma ainda não foi lida                                                                                                                                                              |
| Atraso da coleta                 | `lag`              | Nenhuma fonte com mais de 2 horas de atraso                      | `stalled` (fonte contínua parada); `sync_delayed` (uma fonte de achados há mais de 2 h sem leitura que dê certo)                                                                                  |

**Erros da entrada no papel** (o texto de cada um está na tela; o que conferir):

- `trust_denied`: a pilha não existe, foi apagada, tem outro `NodeServiceAccountId`, outro audience ou outro
  `NodeEgressIps` (o IP de saída do nó é o `terraform output nat_ip`), ou o papel foi criado pelo assistente "Web
  identity → Google" do console (que grava o audience no lugar errado). Uma SCP ou uma RCP da organização que negue a
  federação do Google dá o mesmo erro: o cliente inclui `accounts.google.com` na RCP ou marca o papel como exceção.
- `token_invalid`: a AWS recusou o token do nó. Passa sozinho; se não passar, veja o `verax-aws-token` e o log do
  worker.
- `account_mismatch`: o ID cadastrado no painel não é o da conta em que a pilha foi criada.
- `region_disabled` (aviso): o STS da região da conta está desligado; o worker entrou por us-east-1, e o Wazuh usa o
  da região. O cliente religa em IAM → Account settings.
- `check_unavailable`, `metadata_unavailable`, `idp_unavailable`, `aws_unavailable`: do nó, do Google ou da AWS, e
  passam sozinhos; se não passarem, veja o log do worker.
- `bucket_denied:<fonte>`, `kms_denied:<fonte>`, `bucket_missing:<fonte>`: de um bucket do cadastro (fora do padrão).

#### Falta de permissão: a correção de cada motivo

O motivo fica na fonte (`permissionDetail`), e a tela mostra a correção na linha dela, com o botão "Verificar de
novo" (ou "Tentar de novo", nas autorizadas), que faz o nó ler a fonte na AWS na hora. Um pedido a cada 30 s por
fonte.

| `permissionDetail`               | O que aconteceu                                                                       | O que o cliente faz                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capability_off`                 | A autorização do tipo da fonte está desligada na pilha                                | Liga em "Pilha na AWS" → "Atualize a pilha" (abaixo) e clica em "Verificar de novo"                                                                                         |
| `tag_missing`                    | O grupo de logs não tem a tag `verax-control = leitura`                               | Roda o comando da tela (`aws logs tag-resource … --tags verax-control=leitura`) e clica em "Verificar de novo"                                                              |
| `kms_denied`                     | O papel lista o bucket, mas a chave KMS não decifra para ele                          | Inclui na política da chave a declaração que a tela mostra (`kms:Decrypt` para o papel, só pelo S3). Numa chave de outra conta, é a política dela que precisa citar o papel |
| `bucket_denied`                  | O bucket não deixa o papel listar nem ler (em geral, o bucket central de outra conta) | Inclui o papel (`arn:aws:iam::<conta>:role/verax/verax-control-reader`) na política do bucket                                                                               |
| `bucket_missing`                 | O bucket de destino não existe mais                                                   | Corrige o destino do log na AWS                                                                                                                                             |
| `outside_awslogs_prefix`         | Os objetos ficam atrás de um prefixo antes de `AWSLogs/`                              | Cadastra o bucket em "Avançado: buckets fora do padrão" e atualiza a pilha (o `LogBucketArns` sai com ele)                                                                  |
| `probe_failed`                   | A AWS não respondeu à sondagem                                                        | "Verificar de novo"; a descoberta seguinte também tenta                                                                                                                     |
| Uma ação do IAM (`serviço:Ação`) | A AWS negou essa ação                                                                 | Atualiza a pilha para o modelo atual; se já está atual, uma SCP da organização nega a ação (a decisão é dele)                                                               |
| _(vazio)_                        | A permissão ainda não foi conferida                                                   | "Verificar de novo"                                                                                                                                                         |

**Descoberta parcial.** "O que encontramos" lista cada leitura que ficou de fora (o serviço, a região e o motivo).
`AccessDenied`/`UnauthorizedOperation`: a pilha é de um modelo anterior, ou uma SCP nega o serviço ou a região.
`AuthFailure`/`UnrecognizedClientException`: a região está desligada ou fora do opt-in. `Truncated`: a conta passou
do teto de itens daquele tipo na região (500 flow logs, 500 grupos de logs, 200 Web ACLs, 100 load balancers). O
resto da conta foi lido; o que ficou de fora pode esconder uma fonte. Corrigido o motivo, "Descobrir de novo" (uma
manual a cada 5 min); a descoberta também roda sozinha uma vez por dia.

#### Atualizar a pilha: do modelo 1 para o 2, e ligar ou desligar uma autorização

Uma conta conectada antes do onboarding self-service tem a pilha do modelo 1: continua lendo os buckets do cadastro
como antes, e a tela mostra "Modelo: versão 1 (anterior)" e "Atualize a pilha". **Não há prazo:** o cliente só
precisa atualizar quando quiser a descoberta completa e as autorizações novas.

1. Em "Pilha na AWS", o cliente marca como a pilha deve ficar e clica em "Baixar o arquivo da pilha" (o modelo
   atual, com os valores do nó e a escolha).
2. No CloudFormation, abre a pilha `verax-control-reader` → _Update stack_ → _Replace existing template_ → _Upload a
   template file_ e envia o arquivo.
3. **Na tela dos parâmetros, confere o valor de cada autorização:** numa atualização, o console mantém o valor que a
   pilha já tinha, e não o do arquivo. A tela do painel diz como cada parâmetro deve ficar. Pela CLI, o comando de
   "Prefere a CLI?" já leva os valores (`aws cloudformation deploy … --parameter-overrides …`).
4. Marca a confirmação de IAM, envia e, quando a pilha terminar, clica em "Verificar de novo". O nó relê as tags do
   papel na hora e pede outra descoberta.

Se as tags lidas não forem a escolha do cliente, "Pilha na AWS" mostra o aviso "A pilha na AWS não está como você
escolheu aqui", dizendo o que a pilha concede a mais e o que está desligado. Vale sempre o que está na AWS: o nó só lê
o que a pilha permite. O cliente atualiza a pilha de novo (o bloco já vem com a escolha dele) ou, se a pilha está como
ele quer, marca as caixas como ela está e clica em "Verificar de novo".

Desligar uma autorização tira a permissão na hora: as fontes daquele tipo passam a "Erro de permissão"
(`capability_off`) na leitura seguinte e saem da coleta até a autorização voltar. Nada é apagado.

#### As fontes na coleta

Cada fonte de bucket ou do CloudWatch Logs que o cliente autoriza entra na lista do manager do Wazuh do nó em até
1 min (só o manager reinicia; o painel segue no ar) e começa a ser lida no dia da autorização. O estado de cada uma
sai dos marcadores do próprio Wazuh, que o host exporta a cada 5 min. As fontes de achados (GuardDuty, Security Hub,
Inspector e Access Analyzer) são lidas pelo worker, a cada 5 min, sem o Wazuh.

- "Aguardando o coletor iniciar" e "Configurando o coletor": a fonte está autorizada, e o coletor dela ainda não a
  leu. Numa fonte de bucket ou num grupo de logs, a lista ainda não foi aplicada no manager (`awaiting_apply`; veja o
  `verax-wazuh-apply`);
- "Configurada, ainda sem eventos": aplicada, e o Wazuh ainda não leu nada dela. Numa fonte nova, o marcador só
  aparece quando o módulo termina a primeira leitura do bucket;
- "Coletando": o Wazuh leu um objeto (ou um evento do grupo) desde a autorização. Numa fonte de achados, a última
  leitura deu certo, mesmo sem achado nenhum ("Sincronizada, sem achados novos");
- "Parada" (só a trilha e os flow logs): o bucket tem objeto novo há mais de 30 min, e o Wazuh não lê nada dela há
  mais de 2 horas. Veja o log do manager (`/var/ossec/logs/ossec.log`, linhas `wm_aws`) e a permissão da fonte
  ("Tentar de novo"). Uma fonte de achados nunca fica parada por não ter achado;
- "Erro de permissão": a tabela acima;
- "Falha de ingestão": o motivo vem junto. `aws_token_stale` e `wazuh_apply_failed` são do nó (abaixo); `throttled`
  ou o nome de um erro da AWS, numa fonte de achados, depois de três leituras seguidas com erro (o worker continua
  tentando, com recuo); os outros dizem por que a fonte ficou de fora da lista do Wazuh (`unsupported_name`,
  `region_unsupported`, `organization_id_unknown`, `custom_prefix_unsupported`, `source_limit`,
  `log_group_name_conflict`, `invalid_details`: o texto de cada um, com o que fazer, está na tela);
- "Não encontrada na conta": a fonte autorizada sumiu da conta (apagada, o serviço desligado). A linha e a
  autorização ficam; se a fonte voltar, "Tentar de novo".

**Grupos do CloudWatch Logs:** o evento de um grupo chega sem a conta e sem o grupo, e só vira achado do cliente com
a prova de que o manager só coletou grupos dele (um cliente só, numa conta só, na configuração aplicada). O achado
aparece pelo menos 10 min depois do alerta. Depois de o worker ficar mais de 5 min parado, de outro cliente autorizar
um grupo de logs no mesmo nó, de uma aplicação da configuração que derrubou o manager ou de duas aplicações seguidas
sem o worker ver, a prova recomeça: os alertas dos 15 min seguintes vão para a fila sem dono ("Origem em mais de um
cliente") e ficam lá. No log do worker, a tarefa `wazuh-config` diz o estado da prova a cada execução (`cloudWatch`:
`owner`, `empty` ou `unproven`); a regra inteira está em `docs/ARQUITETURA.md` ("Dono dos alertas do CloudWatch
Logs").

**Flow logs da VPC:** só o tráfego rejeitado é lido, e um registro sozinho nunca vira alerta. O que aparece no painel
são duas detecções, as duas contadas por conta e por endereço de origem: "Possível varredura de rede vinda do mesmo
endereço" (média: 40 registros rejeitados em 120 s) e "Insistência em porta de administração remota vinda do mesmo
endereço" (alta: 15 registros rejeitados em 120 s para a porta 22 ou 3389 do mesmo destino). Cada endereço dá no
máximo um achado em aberto por detecção; a rajada seguinte só vira outro achado depois de o primeiro ser triado. Os
limites, o que cada número quer dizer e como mudá-los estão em `infra/wazuh/README.md` ("Regras de Flow Logs").

**GuardDuty pelos dois caminhos:** a API é a forma recomendada, e o export para o S3 aparece como "coberto pela API".
Com os dois autorizados, o mesmo achado vira um só.

**No nó, onde olhar:**

- `journalctl -u verax-wazuh-apply` mostra cada aplicação da lista, e `sudo cat /run/verax/wazuh-signal/applied`, o
  último resultado: a geração, `ok` ou `error`, a hora e o número de sequência (`seq`), que aumenta a cada troca da
  configuração do manager (o contador fica em `/var/lib/verax/wazuh-apply/seq`; não o apague nem o edite: sem ele, a
  contagem recomeça da hora do nó, e a prova do dono dos alertas do CloudWatch Logs recomeça junto);
- `journalctl -u verax-wazuh-progress` mostra cada exportação dos marcadores, e
  `sudo cat /run/verax/wazuh-signal/progress`, o último retrato (por bucket, conta e região: o último objeto lido e
  quando; por grupo de logs: o último evento). Só nomes de bucket, de objeto e de grupo: nenhum conteúdo de log. Se o
  sinal parar de ser atualizado (o timer parado, o manager fora do ar), o painel deixa de mudar o estado das fontes
  depois de 20 min, sem marcar nenhuma como parada: `systemctl status verax-wazuh-progress.timer`;
- `aws_token_stale`: o nó não renova o token do Google (`journalctl -u verax-aws-token`); `wazuh_apply_failed`: a
  configuração nova não subiu, e o manager segue com a anterior (`journalctl -u verax-wazuh-apply`);
- o log do worker traz o relatório de cada tarefa, só com contagens e códigos: `aws-check`, `aws-discovery`,
  `aws-findings` e `wazuh-config`. No banco do nó, `AwsDiscoveryRun` (cada execução da descoberta, com o que ficou de
  fora), `AwsSource` (cada fonte, com o estado e a saúde) e `CollectorCursor` (os fluxos `aws_discovery` e
  `aws_findings_*`: `lastErrorKind`, `failures` e `nextRunAt`);
- no CloudTrail do cliente, tudo é leitura: uma entrada `AssumeRoleWithWebIdentity` por hora (com o ID da conta de
  serviço do nó), as leituras da sessão `verax-control-reader/verax-control-worker` (a conferência, a descoberta, as
  sondagens, os achados, o inventário e a postura) e as da `verax-control-reader/verax-control-wazuh` (a coleta).

#### Caminho manual: a CLI, o template sem preencher e os buckets fora do padrão

Continua valendo, para o cliente que cria a pilha fora do painel (pela CLI, pelo Terraform dele, numa esteira):

- em "Alternativa manual (sem o arquivo preenchido)", a tela mostra o link "Baixar o template" (o
  `verax-control-reader.yaml` do repositório, sem nada preenchido), os valores a digitar, com cópia (o ID da conta de
  serviço do nó, o IP de saída, o audience, as três autorizações e, se houver, o `LogBucketArns`), e o comando da CLI
  (`aws cloudformation deploy`), que cria a pilha ou atualiza a que já existe;
- criada a pilha, o cliente clica em "Já criei a pilha: conectar" (o nó passa a conferir sozinho, como no botão
  principal);
- no console do responsável (Fontes de log do cliente), o bloco "Papel de leitura da AWS (CloudFormation)" traz o
  mesmo modelo, os parâmetros, o comando e a mensagem pronta para mandar ao cliente
  (`docs/runbooks/console-do-responsavel.md`).

**Buckets fora do padrão** ("Avançado: buckets fora do padrão", no cadastro e no detalhe da conta): um por fonte, o
da trilha do CloudTrail, o do export do GuardDuty e o do WAF, pelo nome ou pelo ARN. Só para o que a AWS não grava em
`AWSLogs/<conta>/` (um prefixo antes de `AWSLogs/`, um bucket central com a pasta de várias contas, entregas do
Firehose): o resto o nó descobre sozinho. O painel confere as regras de nome do S3 e recusa um bucket que já é de
outro cliente. Cada bucket vira uma fonte "Cadastrada manualmente", já autorizada, lida desde a primeira verificação
da conta, e muda só por ali. Salvar outra lista de nomes volta a conexão para "Não conectada" e descarta um
"Verificar" pendente: o cliente atualiza a pilha (o `LogBucketArns` já sai com a lista nova; um bucket novo com
SSE-KMS pede também a chave em `LogKmsKeyArns`, quando a leitura dos logs da AWS está desligada) e clica em
"Verificar conexão". Um bucket incluído depois é lido desde o início da coleta da conta (avise o cliente se ele tiver
meses de log: a leitura conta no medidor do plano).

#### Na VM própria do cliente: a chave de leitura

Na VM própria (`NODE_PLATFORM=vm`), o nó não tem identidade do Google, e a conta continua lida com a chave de um
usuário IAM só de leitura, cifrada no cofre do nó (`docs/runbooks/instalacao-no-cliente.md`). Não há pilha nem
"Conectar com AWS": em "Chave de leitura e políticas do usuário", o cliente escolhe as mesmas três autorizações, cria
as duas políticas e o usuário com os comandos da tela, cola a chave e clica em "Verificar conexão". Dali em diante, a
descoberta, as fontes, a autorização e a saúde são as mesmas. Para mudar o que está autorizado, "Usuário de leitura
na AWS" → "Mudar o que está autorizado" traz a política nova e os comandos (uma versão nova da política e as tags do
usuário). A recomendação é trocar a chave a cada 90 dias.

#### Revogação

Tudo vale em instantes, também para a sessão que o nó já tem aberta (a AWS confere a política a cada chamada):

| O que o cliente quer tirar | Como                                                                                                                     | O que acontece no painel                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uma fonte                  | "Revogar", na linha dela em "Fontes autorizadas"                                                                         | A fonte sai da coleta (do manager, em até 1 min; dos achados, na leitura seguinte). O que já foi coletado fica, e nada é apagado na origem          |
| Um grupo de logs           | Tira a tag: `aws logs untag-resource --resource-arn <arn> --tag-keys verax-control`                                      | Na leitura seguinte, a fonte fica "Erro de permissão" (`tag_missing`) e sai da coleta                                                               |
| Uma autorização inteira    | Atualiza a pilha com o parâmetro dela em `false` ("Atualize a pilha")                                                    | As fontes daquele tipo ficam `capability_off` e saem da coleta; as outras seguem                                                                    |
| Um bucket fora do padrão   | Tira o bucket do cadastro e atualiza a pilha                                                                             | A fonte "Cadastrada manualmente" some                                                                                                               |
| Tudo                       | Desativa o monitoramento da conta no painel; no IAM, _Revoke active sessions_ no papel; no CloudFormation, apaga a pilha | A conta fica "Desconectada" (`trust_denied`). As fontes e as autorizações continuam guardadas, para uma reconexão; sem o papel, o nó não entra mais |

Na VM própria: desativar o monitoramento (a chave sai do cofre do nó) e desativar e apagar a chave no IAM.

#### Medidor, saúde, Ativos e Postura

**Medidor e saúde:** a cada 5 min, o worker lê os contadores do analysisd (usuário `verax_stats` da API do
manager, só leitura) e soma o volume no uso do cliente (fonte `aws`, a página Plano e uso). Com a conta conectada e os
eventos da AWS parados há mais de 2 h, a Torre do cliente mostra **Sem logs novos da AWS** e o administrador dele
recebe um e-mail (`aws_ingestion_stalled`, um por parada; os eventos de volta rearmam). O que conferir: a situação da conexão e o estado
de cada fonte no detalhe da conta, a trilha e o export ainda gravando no bucket (no console da AWS), e no nó as
linhas `aws-s3` do log do manager (como ler, em `infra/wazuh/README.md`, seção "Nó de cliente") e o log do worker
(`wazuh-usage` no relatório da tarefa: `read` diz se a API do manager respondeu). Um nó atende um cliente só: se a
Torre da equipe da Verax mostrar **Medidor da AWS parado neste nó**, há conta AWS ativa de mais de um cliente (ou os
agentes do Wazuh de outro cliente) no nó; tire a que sobra, e o medidor volta na leitura seguinte (o volume do
intervalo ambíguo não é medido para ninguém).

**Ativos (inventário):** depois da primeira verificação bem-sucedida, o worker faz o inventário da conta (usuários
IAM e chaves, buckets S3 e, nas regiões cadastradas, instâncias EC2 e security groups) em até 5 min, e depois uma
vez por dia, pela mesma sessão do papel (as leituras aparecem no CloudTrail na mesma sessão `verax-control-worker`,
na casa de uma centena por conta e por dia). A conta com erro na entrada do papel não é inventariada até voltar a
conectada; erro só de bucket não atrapalha. O que o operador vê:

- em **Ativos e identidades**, a faixa **Coleta parcial** diz que parte ficou de fora em qual conta e o código da
  AWS (`AccessDenied`, `UnauthorizedOperation`: a política do papel foi mexida ou uma SCP da organização nega o
  serviço ou a região; `AuthFailure`: região desligada ou fora do opt-in). O resto do inventário vale. Peça ao
  cliente para conferir a política do papel (a pilha atual) e as SCPs; a próxima coleta, em até 24 h, tenta de
  novo;
- inventário parado (a data "Inventário atualizado há…" fica velha): no banco do nó, `SyncState` com o nome
  `aws-inventory` (último erro da tarefa) e `CollectorCursor` do fluxo `aws_inventory` da conta (`lastErrorKind`,
  `failures` e `nextRunAt`). `aws_unavailable` é a AWS fora ou limitando (tenta de novo em 30 min, dobrando até
  6 h); `inventory_refused`, nenhuma parte lida (sessão revogada no console ou política sem as leituras de Ativos);
  um código de conexão (`trust_denied`, `token_invalid`) aparece também em Contas cloud;
- cliente sem conta AWS: Postura e Ativos mostram "em breve" (GCP e Cloudflare ainda não têm postura nem
  inventário).

**Postura (nativa):** sai da mesma coleta do inventário (a mesma tarefa, a mesma sessão, a mesma hora), com o
catálogo próprio de 18 checagens (IAM, política de senha, security groups, EC2 e EBS, S3, CloudTrail e GuardDuty).
Além do que o inventário já leu, são cerca de 10 leituras a mais por conta e por dia no CloudTrail do cliente
(`GetAccountPasswordPolicy`, `GetPublicAccessBlock` do S3 Control, `GetEbsEncryptionByDefault`, `ListDetectors`,
`GetDetector`, `DescribeTrails` e `GetTrailStatus`), todas já na política do papel. O que o operador vê:

- em **Postura cloud**, a nota de cada conta, a tabela **O que a nota confere** (cada checagem aprovada,
  reprovada, não lida ou não se aplica) e o que corrigir, com o comando da CLI já com o recurso;
- a faixa **Varredura parcial** diz que leitura a AWS recusou em qual conta (`AccessDenied`,
  `UnauthorizedOperation`: política do papel ou SCP; `AuthFailure`: região desligada). As checagens que dependem dela
  ficam **não lidas**: fora da nota e nunca aprovadas, então a nota não sobe por falta de leitura. Peça ao cliente
  para conferir a política do papel e as SCPs; a próxima varredura tenta de novo. Uma trilha da organização vista da
  conta-membro pode ter o estado recusado (`TrailNotFoundException` ou `AccessDeniedException`): sem outra trilha
  multirregião gravando na conta, a checagem do CloudTrail fica não lida, não reprovada. O código `truncated` é o
  teto de 1.000 itens por tipo (security groups de uma região, buckets, usuários, instâncias): os itens além dele não
  foram conferidos, e as checagens deles ficam não lidas (uma reprovação achada nos conferidos continua valendo);
- varredura parada: é a mesma tarefa e o mesmo cursor do inventário (acima). Uma falha passageira numa leitura da
  postura para a coleta inteira, sem gravar nem o retrato nem a varredura, e a tarefa recua do mesmo jeito;
- no relatório da tarefa (o log do worker), `postureScans` e `posturePartial` contam as varreduras gravadas e as
  parciais, sem nenhum dado da conta.

## 5. Projeto GCP do cliente (sem acesso ao projeto)

Um projeto da GCP entra sem que a Verax ganhe nenhum papel nele: o cliente cria um coletor de logs (_sink_) que só
copia os eventos de segurança para um tópico do Pub/Sub no projeto do nó, e o nó lê a assinatura desse tópico. Nenhuma
chave de conta de serviço é criada em lugar nenhum, e nada que já existe no projeto do cliente muda.

1. **No painel (Contas cloud), cadastre o projeto da GCP** pelo ID, com a assinatura em branco. O painel mostra o
   comando `gcloud logging sinks create` pronto, com o filtro de segurança e o tópico do nó
   (`projects/<projeto-do-nó>/topics/<prefixo>-security-<projeto>`). O tópico ainda não existe nesse momento; o sink
   pode ser criado antes dele.
2. **O cliente roda o comando** no Cloud Shell do projeto, como dono dele ou com `roles/logging.configWriter`. O
   gcloud responde com a identidade do sink (`serviceAccount:service-<número>@gcp-sa-logging.iam.gserviceaccount.com`);
   o segundo comando do painel a mostra de novo. Quem administra as contas cola a identidade no painel, no campo
   "Identidade do sink". Ela não é segredo: é só quem vai poder publicar no tópico.
3. **No Terraform do nó**, acrescente o projeto e a identidade em `customer_projects`, no `terraform.tfvars` do
   ambiente (`infra/gcp/envs/<ambiente>`), e rode `plan` e `apply`. O plano cria quatro recursos, todos no projeto do
   nó: o tópico, a assinatura, a publicação no tópico só para essa identidade e a leitura da assinatura pela conta de
   serviço do nó. Nada no projeto do cliente (`infra/gcp/GUIA.md`, "Projeto de cliente: o sink é do cliente"); o
   teste na homologação, abaixo, confirma que isso basta. A mesma identidade em dois projetos é recusada, pelo
   módulo e pelo painel: cada identidade é do sink de um projeto só.
4. **Informe a assinatura no painel:** `terraform output pubsub_subscriptions` mostra
   `projects/<projeto-do-nó>/subscriptions/<prefixo>-security-<projeto>`; cole no campo "Assinatura do Pub/Sub" da
   conta. A conexão muda para "Conectada" quando o primeiro evento chegar.
5. **Confira, nesta ordem** (os comandos estão no GUIA, "Projeto de cliente: o sink é do cliente"):
   1. o log `logging.googleapis.com/sink_error` do projeto do cliente, depois de uma ação de administração posterior
      ao `apply`, **sem `PERMISSION_DENIED`** (`gcloud logging read`, pelo dono do projeto). É o portão do desenho: a
      documentação da Google pede também `roles/logging.logWriter` para a identidade do sink no destino, e o módulo
      concede só a publicação no tópico. Enquanto esse passo não passar na homologação, o desenho não está validado
      e a decisão registrada no GUIA ("Se o `logWriter` for exigido") entra;
   2. a mesma ação aparece na assinatura em um minuto;
   3. `gcloud pubsub topics get-iam-policy` do tópico mostra só a identidade do sink como publicadora.

A permissão fica no projeto do nó, para uma identidade de fora dele: se a organização da Verax tiver restrição de
domínio (_Domain Restricted Sharing_), é ela que precisa de exceção, nunca a do cliente. Para encerrar, tire o projeto
de `customer_projects` e aplique (o tópico e a assinatura somem, com as mensagens que ainda não foram lidas) e desative
a conta no painel; o cliente apaga o sink quando quiser (`gcloud logging sinks delete verax-control-security`).

## 6. Agentes do Wazuh nas instâncias do cliente (opcional, desligado por padrão)

O cliente instala o agente do Wazuh nas VMs e EC2 dele, e os agentes falam com o manager do nó dedicado: integridade de
arquivos, inventário, vulnerabilidades e configuração das máquinas. Nada disso existe num nó até a Verax ligar, nó a
nó, com os IPs de saída que o cliente informa. O desenho está em `docs/ARQUITETURA.md`, "Agentes nas instâncias do
cliente".

Antes: o nó é `standard`, está no ar com o Wazuh e o cliente já tem o cadastro no painel (o id dele vai no
`node.conf`). Os agentes valem para esse cliente; para qualquer outro, a tela diz que não estão ligados.

1. **Peça ao cliente os IPs de saída** das instâncias que vão ter o agente: o NAT gateway ou os IPs elásticos da AWS, o
   Cloud NAT da GCP, o IP da rede dele. Faixas IPv4 de /16 a /32, no endereço da rede (`198.51.100.0/28`,
   `192.0.2.15/32`); nada mais largo é aceito.
2. **No Terraform do nó**, no `terraform.tfvars` do ambiente (`infra/gcp/envs/<ambiente>`): `wazuh_agents = true` e as
   faixas em `wazuh_agents_sources`. Rode `plan` e `apply`. O plano cria só o IP fixo de entrada, a regra de
   encaminhamento (TCP 1514 e 1515 para a VM) e, com faixas, a regra de firewall que libera as duas portas só para
   elas; a VM, o NAT e o resto não mudam (a VM continua sem IP externo, e a saída continua pelo IP do Cloud NAT). Sem
   faixa nenhuma, o IP nasce e as portas ficam fechadas: o painel diz ao cliente que a liberação está pendente.
3. **`terraform output wazuh_agents`** mostra o IP fixo (`address`) e as faixas (`sources`).
4. **No `node.conf` do nó** (o arquivo que o `deploy.sh` leva):
   ```sh
   WAZUH_AGENTS=true
   WAZUH_AGENTS_ADDRESS=<address do output, sem máscara>
   WAZUH_AGENTS_TENANT=<id do cliente, em Clientes no painel>
   WAZUH_AGENTS_SOURCES=<as mesmas faixas do Terraform, separadas por vírgula>
   # WAZUH_AGENTS_MAX=50   # limite de agentes do nó (padrão 50, até 500)
   ```
5. **Rode o `deploy.sh`** com a versão de sempre. O `install.sh` gera a senha de registro do nó
   (`/var/lib/verax/secrets/wazuh-agents-enrollment`, só na primeira vez) e o certificado do registro, com uma CA só
   dos agentes e o IP fixo no certificado (`/var/lib/verax/wazuh-agents`, refeito se o IP mudar); instala o terceiro
   arquivo do Compose (`compose.wazuh-agents.yaml`) e liga o `verax-wazuh-agents.timer`, que exporta a lista dos
   agentes a cada minuto. O smoke test do fim do `verax-wazuh` confere as duas portas publicadas (e nenhuma outra), o
   certificado com o IP e a recusa de uma senha errada.
6. **Confira no painel** (Administração → Agentes, com o cliente escolhido): a instalação guiada aparece com o IP, as
   faixas e a CA; a senha só para quem administra. Instale o agente numa VM de teste com o script da tela: em um
   minuto ela aparece na lista como "Conectado".

**Trocar a senha de registro** (vazou, ou o cliente pediu): apague `/var/lib/verax/secrets/wazuh-agents-enrollment` na
VM e rode o `deploy.sh` de novo (o `install.sh` gera outra). Os agentes já registrados seguem funcionando: a senha só
serve para registrar um agente novo.

**Faixas novas:** mude `wazuh_agents_sources` e `WAZUH_AGENTS_SOURCES` juntos (o Terraform abre a porta; o `node.conf`
só informa o painel), aplique e rode o `deploy.sh`.

**Desligar:** `WAZUH_AGENTS=false` no `node.conf` e `deploy.sh` (o manager volta a escutar só no loopback e o timer
para); depois `wazuh_agents = false` (e sem faixas) no Terraform e `apply`, que apaga a regra de firewall, a de
encaminhamento e o IP fixo: religar dá outro IP, e os agentes precisam ser reinstalados com ele. A senha de registro
fica no disco do nó e no volume `manager-etc` (`/var/ossec/etc/authd.pass`), sem uso; apague os dois se o desligamento
for definitivo. Os agentes das instâncias continuam instalados até o cliente desinstalá-los.

## 7. Nó criado pelo plano de controle: primeiro acesso e conta de suporte (fase 3)

No nó de cliente que o plano de controle cria (`CUSTOMER_MODE=true` no `node.conf`), o primeiro acesso não passa pelo
cadastro do item 4: o serviço `verax-customer-bootstrap` roda depois de cada partida do nó, lê dos metadados da VM o
nome do cliente (`verax-tenant-name`), o e-mail do administrador do cliente (`verax-admin-email`) e o da conta de
suporte da Verax (`verax-support-email`), cria o cliente com o plano do nó, o administrador do cliente e uma conta
`admin_verax` de suporte, cada conta com a sua senha temporária (72 horas; troca e MFA no primeiro login), e grava cada
senha como versão de um segredo do Secret Manager no projeto dos nós:

- `vx-<slug>-admin-bootstrap`: a do administrador do cliente, que a página de status revela **uma vez** ao cliente e
  depois destrói (plano de controle, CP-05). Essa revelação única também pode ser feita por você, no console (abaixo,
  "Mandar o acesso você mesmo");
- `vx-<slug>-support-bootstrap`: a da conta de suporte, que **só o responsável** lê.

A VM só acrescenta versões nesses dois segredos e não lê nenhum deles de volta. Nenhuma senha aparece na tela, no
journal ou na auditoria. Da segunda partida em diante, nada muda e nenhuma senha nova é gerada.

**Mandar o acesso você mesmo (a senha do administrador do cliente, pelo console):** quando for melhor você mandar
o acesso ao cliente (ele não achou o e-mail, prefere receber por outro canal, o contrato direto combinou assim), abra o
cliente no console (`/clientes/<id>`), no bloco "Acesso do administrador", e use **Mostrar senha inicial…**. O botão
só aparece com o cliente em "Esperando a conexão" e com a senha ainda não revelada. Digite o subdomínio para
confirmar. O console mostra o painel, o login, a senha temporária e a validade, cada um com um botão de copiar, e
**Copiar mensagem para o cliente**, que monta o texto pronto (o painel, o login, a senha, a validade e o aviso de que o
primeiro acesso pede a troca da senha e o MFA). Mande por um canal seguro.

Isso **é** a revelação única, não uma cópia:

- a senha aparece só nessa vez; ao fechar o bloco (ou sair da página) ela não volta;
- a versão do `admin-bootstrap` é destruída logo em seguida (o mesmo `secrets.destroy_bootstrap` da revelação do
  cliente);
- o link que o cliente recebeu por e-mail e a página de status passam a responder "senha já revelada";
- a auditoria registra `access.revealed` com você como autor (`owner:<seu e-mail>`, `via: owner`) e o pedido do
  console (`tenant.console_request`, `operation: reveal-access`), nunca a senha.

O que o console pode responder: **já revelada** (o cliente viu antes, ou outro responsável: daqui em diante, só o
"Esqueci minha senha" do painel ou uma senha temporária gerada pela conta de suporte em Usuários); **cliente fora da
espera** (ainda provisionando, ou já ativo); **senha vencida** (nada foi mostrado nem marcado: gere uma senha nova com a
renovação abaixo, `BOOTSTRAP_RENEW_ADMIN_PASSWORD=true`, e tente de novo); **subdomínio que não confere** (nada
marcado); **muitas operações** (o limite das operações do responsável, 20 por hora); **senha indisponível** ou
**cp-worker fora** (nada marcado: tente de novo).

**Ler a senha da conta de suporte** (o login é o `verax-support-email` do nó), com a sua conta de responsável:

```bash
gcloud secrets versions access latest --secret vx-<slug>-support-bootstrap --project <projeto-dos-nos>
```

A saída é o JSON `{"email": ..., "password": ..., "expiresAt": ...}`. Entre no painel do cliente com ela, troque a
senha e cadastre o MFA; depois **destrua** as versões, para a senha não ficar guardada fora do nó:

```bash
gcloud secrets versions list vx-<slug>-support-bootstrap --project <projeto-dos-nos> --filter='state!=DESTROYED'
gcloud secrets versions destroy <versão> --secret vx-<slug>-support-bootstrap --project <projeto-dos-nos>
```

A destruição é permanente (sem recuperação), e a VM continua podendo gravar uma versão nova. Um terminal compartilhado
ou gravado não é lugar para o primeiro comando: a senha aparece na tela de quem o roda.

**Senha nova** (vencida antes do primeiro login, ou perdida): entre na VM pelo IAP e rode, como root,

```bash
sudo BOOTSTRAP_RENEW_SUPPORT_PASSWORD=true /opt/verax/bin/start.sh customer-bootstrap
```

e leia a versão nova como acima. A senha anterior e as sessões abertas da conta deixam de valer; o MFA continua. A do
administrador do cliente segue o mesmo caminho com `BOOTSTRAP_RENEW_ADMIN_PASSWORD=true` (a versão nova de
`admin-bootstrap` só chega ao cliente se a revelação ainda não aconteceu, pela página de status, pelo link do e-mail
ou pelo "Mostrar senha inicial…" do console; depois dela, o caminho é o "Esqueci minha senha" do painel ou uma senha
temporária gerada pela conta de suporte em Usuários). É também o caminho quando o console responde "senha vencida".

**Quando o serviço falha** (`systemctl status verax-customer-bootstrap`, motivo no `journalctl -u
verax-customer-bootstrap`): ele tenta de novo a cada minuto, até dez vezes em uma hora. Os motivos esperados são um
metadado que falta na VM, a VM sem permissão no segredo (`PERMISSION_DENIED`: confira o Terraform do tenant) ou o
Secret Manager fora do ar. Uma senha já gerada que não chegou ao cofre fica em `/run/verax/customer-bootstrap` (memória,
só root) e vai antes de qualquer outra na próxima tentativa; se a VM reiniciar antes disso, ela se perde, e o caminho é
pedir a senha nova acima. Corrigido o motivo: `sudo systemctl restart verax-customer-bootstrap`.

**Estado do nó para o plano de controle:** no mesmo modo, o worker publica a cada 5 minutos, nos atributos de convidado
(_guest attributes_) da VM, `verax/version` (o commit instalado), `verax/accounts-connected` (contas ativas conectadas),
`verax/last-event-at` (o evento mais recente, em ISO 8601 UTC, ou `none`) e `verax/disk-free` (porcentagem livre do
disco de dados). Para conferir:

```bash
gcloud compute instances get-guest-attributes vx-<slug> --zone <zona> --project <projeto-dos-nos> --query-path=verax/
```

Com os atributos de convidado desligados na VM (`enable-guest-attributes`), o worker avisa uma vez no log e não publica
nada.

## 8. Nó criado pelo plano de controle: instalação sem operador (fase 3, PR-N7)

O nó de cliente se instala sozinho no primeiro boot: o script de boot baixa o release da versão dos metadados
(`verax-node-version`), confere a assinatura do manifesto e o SHA-256 do pacote, escreve o `node.conf` do modo cliente
com as chaves `verax-*`, roda o `install.sh` e espera o nó, o Wazuh, o primeiro acesso (item 7) e o túnel. Pronto, grava
`verax/ready=<versão>`; numa falha, `verax/error=<código>` (a tabela dos códigos está em `docs/ARQUITETURA.md`,
"Instalação sem operador"). O desenho e o aceite estão lá e no `infra/gcp/GUIA.md` ("O nó de cada cliente").

**Diagnóstico sem SSH:**

```bash
gcloud compute instances get-guest-attributes vx-<slug> --zone <zona> --project <projeto-dos-nos> --query-path=verax/
gcloud compute instances get-serial-port-output vx-<slug> --zone <zona> --project <projeto-dos-nos> | grep 'verax-boot:'
```

A saída serial tem cada passo da instalação e o motivo do erro, sem senha, e-mail ou nome do cliente. Os casos mais
prováveis:

- `release_download_failed` ou `package_sha256_mismatch`: a versão ou o SHA-256 do tenant não são os de um release
  promovido. Confira o release e o manifesto (`docs/runbooks/versao-no.md`) e corrija as variáveis do tenant;
- `release_signature_invalid`: o manifesto não fecha com as chaves de release do repositório (`infra/node/keys`) que o
  Terraform pôs no script de boot. Não instale: é o caso que a assinatura existe para barrar;
- `install_failed` com `manifest unknown` ou `not found` na saída serial: as imagens do release saíram do Artifact
  Registry pela limpeza de 30 dias (`docs/ARQUITETURA.md`, "Instalação sem operador", origem das imagens);
- `tunnel_token_missing`: o token do túnel não chegou ao cofre `vx-<slug>-cloudflare-tunnel-token` em 60 minutos.
  Grave-o e reinicie a VM;
- `smtp_password_missing`: com o e-mail do nó (as chaves `verax-smtp-*` nos metadados), a senha da caixa de envio não
  chegou ao cofre `vx-<slug>-smtp-password` em 60 minutos. O `resume` do provisionamento grava de novo
  (`docs/runbooks/provisionamento.md`); depois, reinicie a VM;
- `customer_bootstrap_failed`: o item 7 ("Quando o serviço falha").

**Tentar de novo:** corrigido o motivo (no Terraform do tenant ou no cofre), reinicie a VM
(`gcloud compute instances reset vx-<slug> --zone <zona> --project <projeto-dos-nos>`). Uma instalação que não terminou
é refeita do começo; uma que terminou não é refeita.

**Atualizar o nó:** a versão nova nos metadados não é instalada sozinha (o boot só avisa). A atualização é pelo
`deploy.sh` (`docs/runbooks/no-verax.md`), com o `node.conf` que a instalação escreveu: copie o `/etc/verax/node.conf`
da VM pelo IAP e passe-o ao `deploy.sh` como de costume. Depois dela, `verax/ready` passa a mostrar o commit instalado
(o `deploy.sh` não conhece a versão do release).

## Publicar uma versão nova do diagnóstico

1. Altere o script, os testes e a constante `VERSION` em `infra/diagnostico/diagnostico_aws.py`, num PR.
2. Depois do merge, crie a tag `diagnostico-vX.Y.Z` (igual à `VERSION`) na `main`: `git tag diagnostico-vX.Y.Z` e
   `git push origin diagnostico-vX.Y.Z`.
3. O workflow `Publicar diagnóstico` roda os testes, confere a versão e publica a release com o script, o guia e o
   `SHA256SUMS`, além do atestado de procedência.
