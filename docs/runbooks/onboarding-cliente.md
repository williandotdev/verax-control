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
4. Cadastre o cliente, a conta e os usuários no painel. Cada usuário nasce com uma senha temporária, que aparece
   uma vez: repasse por um canal seguro. No primeiro login, a pessoa troca a senha e cadastra o MFA.

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
   ambiente (`infra/gcp/envs/<ambiente>`), e rode `plan` e `apply`. O plano cria só três coisas, todas no projeto do
   nó: o tópico, a assinatura e a permissão de publicar no tópico, só para essa identidade. Nada no projeto do
   cliente (`infra/gcp/GUIA.md`, "Projeto de cliente: o sink é do cliente").
4. **Informe a assinatura no painel:** `terraform output pubsub_subscriptions` mostra
   `projects/<projeto-do-nó>/subscriptions/<prefixo>-security-<projeto>`; cole no campo "Assinatura do Pub/Sub" da
   conta. A conexão muda para "Conectada" quando o primeiro evento chegar.
5. **Confira:** uma ação de administração no projeto do cliente aparece na assinatura em um minuto, e
   `gcloud pubsub topics get-iam-policy` do tópico mostra só a identidade do sink como publicadora (comandos no GUIA).

A permissão fica no projeto do nó, para uma identidade de fora dele: se a organização da Verax tiver restrição de
domínio (_Domain Restricted Sharing_), é ela que precisa de exceção, nunca a do cliente. Para encerrar, tire o projeto
de `customer_projects` e aplique (o tópico e a assinatura somem, com as mensagens que ainda não foram lidas) e desative
a conta no painel; o cliente apaga o sink quando quiser (`gcloud logging sinks delete verax-control-security`).

## Publicar uma versão nova do diagnóstico

1. Altere o script, os testes e a constante `VERSION` em `infra/diagnostico/diagnostico_aws.py`, num PR.
2. Depois do merge, crie a tag `diagnostico-vX.Y.Z` (igual à `VERSION`) na `main`: `git tag diagnostico-vX.Y.Z` e
   `git push origin diagnostico-vX.Y.Z`.
3. O workflow `Publicar diagnóstico` roda os testes, confere a versão e publica a release com o script, o guia e o
   `SHA256SUMS`, além do atestado de procedência.
