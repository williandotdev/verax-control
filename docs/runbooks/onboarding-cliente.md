# Onboarding de um cliente

Roteiro da equipe da Verax para colocar um cliente novo em monitoramento. Vale para qualquer cliente e não depende de
nenhuma ferramenta além deste repositório. As etapas marcadas como _em construção_ entram com as próximas entregas da
arquitetura (`docs/ARQUITETURA.md`).

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
  para criar, copiar, guardar ou trocar, nem ExternalId. O papel lê só os buckets S3 do CloudTrail, do export do
  GuardDuty e, se o cliente quiser, do WAF.
- O CloudWatch Logs, o Security Hub e o Inspector ficam fora da v1, inclusive no que o diagnóstico (seção 2) mostrar
  deles. Não há venda assistida: a primeira venda só acontece depois do provisionamento automático (fase 3).

Na reunião:

- Confirme a lista final de fontes: os buckets do CloudTrail, do export do GuardDuty e do WAF, e as chaves KMS deles.
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
   cliente. Sem o `NODE_EGRESS_IPS`, a conferência diária de permissão demais fica de fora. O IP de saída também entra
   nas regras locais do Wazuh do nó (a leitura do próprio nó não vira alerta; a mesma sessão de outro IP vira nível
   12), e o audience é o que o host pede ao Google a cada 10 min. Depois do deploy, no nó, o `verax-aws-token.timer` e
   o `verax-wazuh-apply.timer` aparecem em `systemctl list-timers`, e o `verax-wazuh-apply.path` está ativo.
3. Crie os registros no Cloudflare (túnel da API) e o site do painel no Firebase Hosting.
4. Cadastre o cliente no painel, em **Clientes → Novo cliente**, já com o primeiro administrador (nome e e-mail).
   A conta nasce junto com o cliente, como administrador do cliente, com uma senha temporária que aparece **uma
   única vez**, na tela do cadastro: copie e repasse à pessoa por um canal seguro, de preferência fora do e-mail
   (pessoalmente, por telefone ou por mensageiro com criptografia de ponta a ponta). A senha vale por 72 horas; no
   primeiro login, a pessoa troca a senha e cadastra o MFA. Se a senha se perder ou vencer, selecione o cliente no
   seletor do topo e gere outra em Usuários.
5. Com o cliente selecionado, cadastre as contas cloud e os demais usuários (cada um também nasce com uma senha
   temporária, repassada do mesmo jeito). O próprio administrador do cliente pode criar os usuários dele.

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

6. **Conta AWS (Contas cloud → Cadastrar conta → AWS):** o ID da conta, as regiões e os **buckets de log** (opcionais
   no cadastro): um por fonte, o da trilha do CloudTrail, o do export do GuardDuty e o do WAF (`aws-waf-logs-*`, exigência
   da AWS), pelo nome ou pelo ARN (`arn:aws:s3:::<nome>`, como as saídas `TrailBucketArn` e `GuardDutyBucketArn` da
   pilha). O painel confere as regras de nome do S3 e recusa um bucket que já é de outro cliente. Depois do cadastro,
   a lista muda no detalhe da conta, em **Buckets de log** (quem só lê vê a lista, sem o formulário). O detalhe mostra
   o passo a passo que o administrador do cliente segue no console da AWS dele (`infra/cloudformation/README.md`):
   - **Baixar o template:** o painel serve o próprio `verax-control-reader.yaml` do repositório, sem nada preenchido;
   - no CloudFormation, _Create stack_ → _Upload a template file_, a pilha `verax-control-reader` com os três valores
     do nó que a tela mostra (o ID da conta de serviço, o IP de saída e o audience, que já vem preenchido), o
     `LogBucketArns` com os ARNs dos buckets cadastrados e as chaves KMS em `LogKmsKeyArns`; a tela também traz o
     comando da CLI, que cria a pilha ou atualiza a que já existe;
   - **Verificar conexão:** o painel pede ao worker do nó que entre no papel, confira a conta e leia 1 byte de um
     objeto de cada bucket (o que prova também a chave KMS). Na mesma verificação, ele confere se uma trilha ligada
     grava no bucket do CloudTrail, se o GuardDuty exporta para o bucket dele e se o papel não ganhou permissão além
     da leitura. A resposta chega em até 30 s; se o papel recém-criado ainda não valer no IAM, o worker tenta de novo,
     espaçado, por até 10 min. Cada erro diz o que conferir (pilha ainda não criada, valor errado, papel feito pelo
     assistente "Web identity → Google" do console, SCP ou RCP, bucket sem acesso, com qual fonte, ou chave KMS).
   - **Depois de conectada,** o worker confere sozinho a cada 15 min, e as conferências da trilha, do export e da
     permissão demais uma vez por dia. Trilha parada, export ausente, permissão demais ou STS da região desligado
     aparecem como **aviso**: a conta continua conectada e a coleta segue. Um erro (papel recusado, bucket sem acesso)
     aparece na conta, e ela volta a conectada sozinha quando o cliente corrige.

   **Mudar os buckets depois:** salve a lista nova em **Buckets de log**. Se os nomes mudaram, o painel avisa que falta
   atualizar a pilha (o `LogBucketArns` e o comando da CLI já trazem a lista nova; um bucket novo com SSE-KMS pede
   também a chave em `LogKmsKeyArns`), a conexão volta a "Aguardando" e um "Verificar" pendente é descartado. Nada é
   conferido na AWS sozinho enquanto a conta aguarda: depois de atualizar a pilha, o cliente clica em **Verificar
   conexão**, e a conferência de 15 em 15 min volta com a conta conectada. Trocar só a fonte de um bucket (os mesmos
   nomes) não mexe na pilha nem na conexão.

   Cada conferência aparece no CloudTrail do cliente: uma entrada `AssumeRoleWithWebIdentity` por hora (com o ID da
   conta de serviço do nó) e as leituras da sessão `verax-control-reader/verax-control-worker`, todas de leitura.

   **Coleta (PR-V4'):** na primeira verificação bem-sucedida, a conta entra no Wazuh do nó em até 1 min (só o manager
   reinicia; o painel segue no ar), lendo os logs desde o dia anterior. Editar os buckets não tira a conta do Wazuh: o
   bucket novo entra em seguida, e um bucket cadastrado depois é lido desde esse mesmo dia (avise o cliente se o bucket
   novo tiver meses de log, porque a leitura conta no medidor do plano). No CloudTrail do cliente, a coleta aparece
   como a sessão `verax-control-reader/verax-control-wazuh`. No nó, `journalctl -u verax-wazuh-apply` mostra cada
   aplicação e `cat /run/verax/wazuh-signal/applied` o último resultado. No painel, o estado da coleta aparece ao lado
   da conexão, e os dois avisos dele são do nó, não da conta do cliente: `aws_token_stale` (o nó não renova o token do
   Google; veja o journal do `verax-aws-token`) e `wazuh_apply_failed` (a configuração nova não subiu, e o manager
   segue com a anterior; veja o do `verax-wazuh-apply`).
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

   **Desconectar:** desative o monitoramento da conta no painel; o cliente usa "Revoke active sessions" no papel (corta
   as sessões já emitidas, de até 1 hora) e apaga a pilha. Não há chave para apagar.

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
  depois destrói (plano de controle, CP-05);
- `vx-<slug>-support-bootstrap`: a da conta de suporte, que **só o responsável** lê.

A VM só acrescenta versões nesses dois segredos e não lê nenhum deles de volta. Nenhuma senha aparece na tela, no
journal ou na auditoria. Da segunda partida em diante, nada muda e nenhuma senha nova é gerada.

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
`admin-bootstrap` só chega ao cliente se a revelação ainda não aconteceu; depois dela, o caminho é o "Esqueci minha
senha" do painel ou uma senha temporária gerada pela conta de suporte em Usuários).

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

## Publicar uma versão nova do diagnóstico

1. Altere o script, os testes e a constante `VERSION` em `infra/diagnostico/diagnostico_aws.py`, num PR.
2. Depois do merge, crie a tag `diagnostico-vX.Y.Z` (igual à `VERSION`) na `main`: `git tag diagnostico-vX.Y.Z` e
   `git push origin diagnostico-vX.Y.Z`.
3. O workflow `Publicar diagnóstico` roda os testes, confere a versão e publica a release com o script, o guia e o
   `SHA256SUMS`, além do atestado de procedência.
