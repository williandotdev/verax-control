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

> **Desatualizado (seções 3 e 4).** Estas seções seguem o desenho de 02/11/2026: nó na AWS, na conta do cliente ou da
> Verax, conector com papel e ExternalId e leitura do CloudWatch Logs. A revisão de 04/11/2026 em
> `docs/ARQUITETURA.md` substituiu esse desenho, e o roteiro será reescrito com o template do usuário de leitura e a
> chave no painel (fase 2). Até lá, **não peça ao cliente a pilha do conector nem a do nó na AWS** e siga a
> arquitetura:
>
> - todo nó de cliente roda na GCP da Verax, em São Paulo (southamerica-east1), criado pelo Terraform de `infra/gcp/`;
> - a AWS do cliente é lida por um usuário IAM de leitura com chave restrita ao IP do nó, só nos buckets S3 do
>   CloudTrail, do export do GuardDuty e, se o cliente quiser, do WAF;
> - o CloudWatch Logs, o Security Hub e o Inspector ficam fora da v1, inclusive no que o diagnóstico (seção 2) mostrar
>   deles;
> - não há venda assistida: a primeira venda só acontece depois do provisionamento automático (fase 3).

- Confirme a lista final de fontes, a região do nó (a mesma dos logs) e quem hospeda o nó: a conta do cliente ou a
  da Verax.
- Colete o fluxo de escalonamento (quem recebe Critical, High, Medium e Low, e por qual canal) e a baseline de rede:
  portas publicadas e tráfego interno esperado. As duas coisas evitam o ruído que mais incomoda o cliente.
- Combine o subdomínio do painel: `<cliente>.control.veraxsistemas.com.br`.

## 4. Conector, nó e painel _(em construção)_

> **Desatualizado:** veja o aviso no início da seção 3. Os passos 1 e 2 abaixo descrevem o desenho substituído e não
> devem ser seguidos.

1. O cliente cria a pilha do conector na conta monitorada (`infra/cloudformation/README.md`). Ela cria só o papel
   somente leitura, que só o papel do nó pode assumir, com o ExternalId. Passe ao cliente:
   - a conta onde o nó vai rodar;
   - o ExternalId gerado pelo painel;
   - os ARNs das fontes aprovadas no passo 3: grupos do CloudWatch Logs, buckets e as chaves KMS deles.

   O papel só lê o conteúdo desses logs e tem negação explícita para apagar, alterar ou desviar logs.

2. Crie a pilha do nó na conta escolhida e na região dos logs (`infra/cloudformation/GUIA-NO.md`), grave o token do
   túnel no parâmetro indicado e passe ao conector as saídas `NodeAccountId` e `NodeRoleName`.
3. Crie os registros no Cloudflare (túnel da API) e o site do painel no Firebase Hosting.
4. Cadastre o cliente no painel, em **Clientes → Novo cliente**, já com o primeiro administrador (nome e e-mail).
   A conta nasce junto com o cliente, como administrador do cliente, com uma senha temporária que aparece **uma
   única vez**, na tela do cadastro: copie e repasse à pessoa por um canal seguro, de preferência fora do e-mail
   (pessoalmente, por telefone ou por mensageiro com criptografia de ponta a ponta). A senha vale por 72 horas; no
   primeiro login, a pessoa troca a senha e cadastra o MFA. Se a senha se perder ou vencer, selecione o cliente no
   seletor do topo e gere outra em Usuários.
5. Com o cliente selecionado, cadastre as contas cloud e os demais usuários (cada um também nasce com uma senha
   temporária, repassada do mesmo jeito). O próprio administrador do cliente pode criar os usuários dele.

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

## Publicar uma versão nova do diagnóstico

1. Altere o script, os testes e a constante `VERSION` em `infra/diagnostico/diagnostico_aws.py`, num PR.
2. Depois do merge, crie a tag `diagnostico-vX.Y.Z` (igual à `VERSION`) na `main`: `git tag diagnostico-vX.Y.Z` e
   `git push origin diagnostico-vX.Y.Z`.
3. O workflow `Publicar diagnóstico` roda os testes, confere a versão e publica a release com o script, o guia e o
   `SHA256SUMS`, além do atestado de procedência.
