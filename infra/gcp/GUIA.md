# Guia: os nós e o plano de controle do Verax Control na GCP com Terraform

Este guia sobe ou altera a infraestrutura dos nós e do plano de controle na GCP. Há seis ambientes, cada um com o
próprio estado:

- **`envs/verax`:** o SOC da própria Verax, no perfil `lean`. A primeira subida foi feita em 03/11/2026, quando o
  código ainda ficava direto em `infra/gcp`. Está no ar.
- **`envs/homolog-sp`:** o nó de homologação em São Paulo, no perfil `standard`, igual ao que um nó de cliente vai
  ter. Fica no projeto dos nós de clientes, separado do projeto da Verax. Ainda não foi aplicado.
- **`envs/control-plane`:** o plano de controle da fase 3 (checkout, webhook da Stripe, página de status e
  provisionamento dos nós de clientes), no projeto da Verax que hospeda o Firebase dos painéis. Ainda não foi
  aplicado. Tem a própria seção, "O plano de controle", no fim deste guia.
- **`envs/release`:** a chave de release do nó no Cloud KMS, que assina o manifesto de cada versão (preparação do
  modo próprio, fase 3, SH-02), e a federação que só deixa o workflow `Versão do nó` usá-la. Fica no projeto do nó da
  Verax, nunca no do plano de controle. Ainda não foi aplicado. O passo a passo está em `docs/runbooks/versao-no.md`.
- **`envs/nodes-platform`:** o que vale para o projeto dos nós de clientes inteiro (fase 3, CP-06): as APIs, o
  orçamento, o bucket do estado e as permissões do plano de controle nesse projeto. Aplicado por você, uma vez. Ainda
  não foi aplicado. Tem a própria seção, "O projeto dos nós e o nó de cada cliente".
- **`envs/tenant`:** o nó de um cliente, um estado por cliente, aplicado pelo plano de controle (o executor
  Terraform). Você só roda o `plan` de aceite num projeto de teste (mesma seção).

`envs/verax`, `envs/homolog-sp` e `envs/tenant` chamam o mesmo módulo, `modules/node`. Na fase 3, cada cliente ganha
um `envs/tenant` igual à homologação (perfil `standard`), aplicado pelo plano de controle.

## Antes de começar: 5 ideias do Terraform

- **Código descreve o que deve existir.** Os arquivos `.tf` dizem quais recursos o projeto precisa ter (rede, VM,
  tópico...). O Terraform compara isso com o que existe e faz só a diferença.
- **Provider** é o "tradutor" para uma nuvem. Aqui é o `hashicorp/google`, na versão fixa 8.9.0 (`versions.tf` de
  cada ambiente).
- **Estado** (_state_) é a memória do Terraform: a lista do que ele criou. Fica num bucket do Cloud Storage
  (passo 2), não no seu computador. Cada ambiente tem o seu.
- **Módulo** é um pedaço de código reaproveitado. O `modules/node` descreve um nó; cada ambiente diz qual projeto,
  região e perfil usar.
- **`plan` antes de `apply`.** O `plan` mostra o que vai acontecer, sem mudar nada. O `apply` executa. Leia
  sempre o `plan`.

## Como a pasta está organizada

```
infra/gcp/
├── modules/node/          o nó: rede, NAT, VM, disco, snapshot, segredos, logs, backups e alerta
│   └── startup.sh.tftpl   script de boot dos nós novos (swap cifrado e, no standard, ajustes do kernel)
├── envs/verax/            nó da Verax (lean): APIs, orçamento, registro das imagens e o módulo
│   └── startup.sh         script de boot de antes do módulo, que o nó da Verax continua usando
├── envs/homolog-sp/       nó de homologação em São Paulo (standard): APIs, orçamento e o módulo
├── envs/control-plane/    plano de controle (fase 3): Cloud Run, Firestore, filas, relógio, segredos, Hosting e
│                          federação com o GitHub, sem módulo (veja "O plano de controle")
├── envs/release/          chave de release do nó (Cloud KMS) e a federação do workflow Versão do nó, sem módulo
│                          (docs/runbooks/versao-no.md)
├── envs/nodes-platform/   projeto dos nós de clientes: APIs, orçamento, bucket do estado e as permissões do plano de
│                          controle, sem módulo (veja "O projeto dos nós e o nó de cada cliente")
└── envs/tenant/           o nó de um cliente (standard, prefixo vx-<slug>), aplicado pelo plano de controle
```

O que vale para o projeto inteiro fica no ambiente: as APIs, o orçamento e, no da Verax, o registro das imagens e a
conta que o GitHub Actions usa para publicar. O resto é do nó e fica no módulo.

## Os perfis

O perfil (`node_profile` no Terraform, `NODE_PROFILE` no `node.conf`) define a máquina:

|                   | `lean`                                | `standard`                                               |
| ----------------- | ------------------------------------- | -------------------------------------------------------- |
| Uso               | nó da Verax                           | homologação e nós de clientes                            |
| VM                | e2-micro (1 GB), gratuita em us-east1 | e2-standard-2 (2 vCPU, 8 GB); e2-standard-4 é o plano B  |
| Disco             | 30 GB pd-standard                     | 60 GB pd-balanced                                        |
| Snapshot          | semanal, guardado por 28 dias         | diário, guardado por 7 dias                              |
| IP de saída (NAT) | automático                            | reservado e fixo (`nat_ip`), protegido contra `destroy`  |
| Kernel            | sem ajuste                            | `vm.max_map_count=262144` e `vm.swappiness=1`, no boot   |
| Memória no pacote | a de sempre (Postgres 256m, API 320m) | Postgres 512m, API 384m e worker 512m, com heaps maiores |
| Wazuh             | não                                   | sim, a partir do PR-W1                                   |

O IP fixo existe porque o papel de leitura na AWS do cliente só aceita o nó a partir dele: se ele mudasse, a coleta
pararia. A conta de serviço do nó pesa do mesmo jeito: o papel confia no ID único dela (saída
`service_account_unique_id` do módulo), e uma conta recriada, mesmo com o mesmo nome, ganha outro ID, que o papel de
nenhum cliente aceita. Ela não tem `prevent_destroy`, porque a homologação é destruída entre as janelas de teste e a
exclusão do cliente destrói tudo; o que a recriaria (`account_id` e `project`) sai só do `name_prefix` e do
`project_id`, e o teste `tests/conta_de_servico.tftest.hcl` confere que as mudanças de rotina não a recriam. **Num nó
de cliente, um `plan` que recrie ou apague `module.node.google_service_account.node` fora da exclusão do cliente é
erro: pare.**

Todo nó criado pelo módulo, nos dois perfis, também tem:

- **swap cifrado** de 2 GB, com chave aleatória nova a cada boot (script de boot do módulo);
- **Pub/Sub só na região** do nó (`message_storage_policy`);
- os cofres que a própria VM grava: **`credentials-key`** (a chave do cofre de credenciais; a VM grava e lê, e a
  permissão vale só nesse cofre) e **`admin-bootstrap`** (a senha temporária do primeiro admin; a VM grava e não lê);
- o **alerta de fila parada**: uma assinatura com mensagem sem leitura há mais de 24 h (`stalled_subscription_hours`)
  abre um incidente no Cloud Monitoring e manda e-mail para `alert_email`, se preenchido.

O `envs/verax/main.tf` desliga esses quatro só para o nó da Verax, que já está no ar, não mudar nada neste PR (veja
"O nó da Verax ainda usa o script antigo"). Os três últimos são só um `true` no `main.tf` quando você quiser.

Quatro interruptores do módulo existem só para o nó de cliente e ficam desligados no nó da Verax e na homologação (os
padrões não mudam nada): o cofre **`support-bootstrap`** (`support_bootstrap_secret`: a senha temporária da conta de
suporte da Verax, que a VM grava e só você lê), os **atributos de convidado** (`guest_attributes`: a VM publica o
próprio estado no espaço `verax/`), a **configuração do nó nos metadados** (`install_config` com `install_metadata`:
as chaves `verax-*` que a instalação sem operador lê) e a **instalação sem operador** (`unattended_install`: o script
de boot instala o nó a partir do release assinado da versão nos metadados e grava `verax/ready`; desligada, o script de
boot é o de sempre, byte a byte). O `envs/tenant` liga os quatro; `docs/ARQUITETURA.md` ("O nó de cada cliente" e
"Instalação sem operador") tem a lista das chaves e o que a instalação confere.

## O nó da Verax: o que tem

O nó da Verax monitora só a GCP e o Cloudflare. Para isso não precisa do Wazuh, que pede 8 GB de memória. O worker
lê os logs direto do Pub/Sub e aplica as próprias regras de detecção. Tudo cabe numa **e2-micro**, que é gratuita em
us-east1.

| Recurso                                     | Para quê                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rede `verax-node-vpc`, sub-rede, Cloud NAT  | Rede própria. A VM não tem IP público: sai para a internet pelo NAT e ninguém entra.                                                                                     |
| 2 regras de firewall                        | SSH só pelo IAP do Google; todo o resto que chega é recusado e registrado.                                                                                               |
| VM `verax-node` (e2-micro, 1 GB, Debian 12) | Onde rodam API, worker, banco e o túnel do Cloudflare. Tem 2 GB de memória de troca.                                                                                     |
| Disco `verax-node` (30 GB padrão)           | Sistema e dados. Fica se a VM for apagada. Snapshot semanal guardado por 4 semanas.                                                                                      |
| Conta de serviço `verax-node`               | Identidade da VM, sem chave JSON. Só lê os logs e os segredos do nó.                                                                                                     |
| Sink em cada projeto monitorado             | Copia os logs de auditoria e os bloqueios do Cloud Armor para o tópico do nó.                                                                                            |
| Tópico e assinatura por projeto monitorado  | Fila dos logs. Guarda as mensagens por 7 dias se o nó parar.                                                                                                             |
| 2 segredos no Secret Manager (vazios)       | Senha do e-mail (Zoho) e token do túnel do Cloudflare. Gravados no passo 7. Com `turnstile_secret = true`, um terceiro: a chave secreta do Turnstile (desafio no login). |
| Registro de imagens `verax-control`         | Imagens da API e das migrations, publicadas pelo GitHub Actions sem chave.                                                                                               |
| Bucket `<projeto>-verax-node-backups`       | Backups do banco. Privado e versionado; a VM cria e lê, mas não apaga.                                                                                                   |
| Orçamento (opcional)                        | E-mail em 50%, 90% e 100% do valor do mês.                                                                                                                               |

**Custo estimado:** de R$ 5 a 15 por mês, mais o IP do Cloud NAT (cerca de R$ 20 por mês, a conferir na fatura). A
e2-micro, os 30 GB de disco padrão, o Pub/Sub, os segredos e 5 GB do bucket ficam no nível gratuito da GCP em
us-east1, que vale para uma e2-micro por conta de faturamento. Sobram o Cloud NAT e centavos de snapshot. O registro
das imagens guarda a versão no ar (tag `no-<vm>`, gravada pelo `deploy.sh`) e as 3 versões mais recentes de cada
imagem, e apaga o resto depois de 30 dias, para ficar perto dos 0,5 GB gratuitos.

## O nó de homologação: o que muda

Os mesmos recursos do nó, com o prefixo `verax-homolog`, no perfil `standard` e com o que a seção "Os perfis" lista
para todo nó criado pelo módulo, mais:

- o **IP de saída reservado** (`verax-homolog-nat-ip`), com o NAT em modo manual. Ele aparece em
  `terraform output nat_ip` e vai no `node.conf` como `NODE_EGRESS_IPS=<ip>/32`;
- a saída **`node_service_account_unique_id`**, o ID único da conta de serviço do nó: com o `nat_ip`, é o que o
  papel de leitura sem chave pede na AWS de teste (`infra/cloudformation/README.md`). A cada janela de teste com
  `apply` depois de um `destroy`, a conta é nova e o ID muda: atualize o parâmetro `NodeServiceAccountId` da pilha na
  AWS de teste antes de testar (o IP do NAT também é novo);
- a **leitura do registro de imagens** do projeto da Verax, só para a conta da VM de homologação.

Não há registro de imagens nem publicação no projeto dos nós: a VM baixa as mesmas imagens do registro da Verax.

Fora do projeto dos nós de clientes, este ambiente cria só três coisas: essa leitura no registro da Verax; em cada
projeto de `monitored_projects`, um sink que só copia (`verax-homolog-security`, com a própria identidade de escrita,
criada pela GCP); e, com `billing_account_id` preenchido, o orçamento na conta de faturamento. Liste em
`monitored_projects` só projetos de teste.

O projeto dos nós ganha as APIs, o bucket do estado e o próprio orçamento pelo `envs/nodes-platform` (seção "O projeto
dos nós e o nó de cada cliente"). Com o orçamento lá, deixe vazio o `billing_account_id` da homologação: os dois
vigiariam o mesmo projeto.

**Custo:** o de um nó `standard` ligado o mês todo (VM, 60 GB de disco, snapshots, NAT, IP e o resto; estime na
[calculadora da Google Cloud](https://cloud.google.com/products/calculator)). Parada, sobram o disco, os snapshots e o
IP reservado. Ligue só nas janelas de teste:

```bash
gcloud compute instances stop verax-homolog --zone southamerica-east1-b --project PROJETO_DOS_NOS
gcloud compute instances start verax-homolog --zone southamerica-east1-b --project PROJETO_DOS_NOS
```

## Projeto de cliente: o sink é do cliente

O módulo aceita dois tipos de projeto, com o mesmo tópico e a mesma assinatura (`<prefixo>-security-<projeto>`, no
projeto do nó):

- **`monitored_projects`:** projetos de que você é dono (os da Verax e os de teste). O Terraform cria o sink neles.
- **`customer_projects`:** projetos de clientes. **A Verax não recebe nenhum papel no projeto do cliente**, e o
  Terraform não cria nada lá. O próprio cliente cria o sink com o comando pronto de Contas cloud (que aponta para o
  tópico do nó) e cola no painel a identidade do sink, que a GCP criou para ele
  (`serviceAccount:service-<número do projeto>@gcp-sa-logging.iam.gserviceaccount.com`). Essa identidade vai para o
  `terraform.tfvars`:

  ```hcl
  customer_projects = {
    "projeto-do-cliente-123" = { writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com" }
  }
  ```

  Para cada projeto, o `plan` mostra quatro recursos, todos no projeto do nó: o tópico, a assinatura, a publicação no
  tópico (`roles/pubsub.publisher`) só para essa identidade e a leitura da assinatura (`roles/pubsub.subscriber`) pela
  conta de serviço do nó. É só isso que o módulo cria; o teste na homologação (abaixo) confirma que basta. O módulo
  recusa qualquer outra identidade (uma conta de serviço comum, uma pessoa, a identidade compartilhada antiga
  `cloud-logs@system`, o agente de uma pasta ou organização), a mesma identidade em dois projetos (daria ao sink de um
  a publicação no tópico do outro, e o `apply` passaria) e um projeto que esteja nas duas listas. A API aceita a mesma
  regra no campo "Identidade do sink" e também recusa a identidade repetida entre as contas do cliente; um teste da
  API confere que as duas continuam iguais, e que o filtro do comando do painel é o `security_log_filter` de `logs.tf`
  sem a exclusão das leituras do nó.

O roteiro inteiro, do cadastro no painel à assinatura informada, está em `docs/runbooks/onboarding-cliente.md`
(seção 5). O que conferir depois do `apply`, com um projeto de teste de **outra organização** na homologação (é o teste
do "sem papel para a Verax"), em três partes; o desenho só está validado com as três:

1. **O log de erro do sink no projeto do cliente, sem `PERMISSION_DENIED`.** A documentação da Google para sinks
   ("Configure and manage sinks", em _Set destination permissions_, e "Route logs to Pub/Sub", passo 7) pede, para a
   identidade do sink no destino, `roles/pubsub.publisher` **e** `roles/logging.logWriter` (pela permissão
   `logging.logEntries.route`). O módulo concede só o `pubsub.publisher`, no tópico, e não dá para confirmar sem a
   GCP se um destino em outro projeto exige o segundo. Quando o Cloud Logging não consegue entregar, ele registra o
   motivo no projeto do cliente, no log `logging.googleapis.com/sink_error`. Peça ao dono do projeto uma ação de
   administração qualquer (ou o `sinks update` abaixo), espere um minuto e leia esse log (quem roda é o dono do
   projeto; a Verax não tem acesso):

   ```bash
   gcloud logging read 'logName="projects/PROJETO_DO_CLIENTE/logs/logging.googleapis.com%2Fsink_error"' \
     --project PROJETO_DO_CLIENTE --freshness=1h --limit=20 --format=json
   ```

   A saída tem de ser `[]`. Uma entrada com `PERMISSION_DENIED` quer dizer que a publicação no tópico não basta, e o
   desenho não está validado: veja "Se o `logWriter` for exigido", abaixo. (Entradas de antes do `apply` são
   esperadas: o sink foi criado antes do tópico existir; por isso o `--freshness=1h`, e a ação depois do `apply`.)

2. **A mensagem na assinatura**, lida um minuto depois da ação.
3. **Só a identidade do sink publica no tópico.**

```bash
# No projeto do cliente (quem roda é o dono dele; a Verax não tem acesso):
gcloud logging sinks update verax-control-security --project PROJETO_DO_CLIENTE \
  --description="Eventos de segurança para o Verax Control (só cópia; os logs originais não mudam)."
# No projeto dos nós:
gcloud pubsub subscriptions pull verax-homolog-security-PROJETO_DO_CLIENTE --project PROJETO_DOS_NOS --limit=3
gcloud pubsub topics get-iam-policy verax-homolog-security-PROJETO_DO_CLIENTE --project PROJETO_DOS_NOS \
  --format='value(bindings)'   # só roles/pubsub.publisher para serviceAccount:service-...@gcp-sa-logging...
```

**Se o `logWriter` for exigido** (o passo 1 mostra `PERMISSION_DENIED`), a decisão já está tomada aqui, antes da
primeira venda, para não ser improvisada num onboarding: o módulo passa a conceder `roles/logging.logWriter` no
**projeto do nó** à identidade do sink do cliente, restrito por uma condição do IAM ao tópico daquele projeto
(`resource.name == "projects/PROJETO_DOS_NOS/topics/<prefixo>-security-<projeto>"`), se a condição valer para a
permissão `logging.logEntries.route` (o mesmo teste diz: com a condição, o erro some). Se não valer, o papel entra sem
condição, por uma variável própria do módulo, desligada por padrão, e o custo fica registrado neste guia e em
`docs/ARQUITETURA.md`: a identidade do sink de cada cliente passa a poder gravar logs no projeto do nó
(`logging.logEntries.create`), e só isso; ela continua sem ler nada no projeto do nó, e a Verax continua sem papel no
projeto do cliente. Até o teste, não há concessão no nível do projeto.

A permissão fica no projeto do nó, para uma identidade de fora da organização da Verax: se a organização da Verax
ligar a restrição de domínio (_Domain Restricted Sharing_, `iam.allowedPolicyMemberDomains`), é esse `apply` que
falha, e o projeto dos nós precisa de exceção. A restrição do lado do cliente não interfere: nada é concedido lá. Para
encerrar um cliente, tire o projeto de `customer_projects` e aplique: o tópico e a assinatura somem, com as mensagens
que ainda não foram lidas.

## Passo 1: ferramentas e login

No terminal (Git Bash ou PowerShell), confira as versões:

```bash
terraform version   # precisa ser 1.11 ou mais nova
gcloud version
```

Entre com a sua conta Google duas vezes: uma para o `gcloud` e outra para o Terraform, que usa as
"credenciais padrão do aplicativo".

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project SEU_PROJETO
gcloud auth application-default set-quota-project SEU_PROJETO
```

Troque `SEU_PROJETO` pelo ID do projeto do ambiente: o da Verax para `envs/verax`, o dos nós de clientes para
`envs/homolog-sp`. Para seguir, você precisa ser **Proprietário** (Owner) desse projeto e dos projetos monitorados.
O projeto precisa ter faturamento ligado, mesmo no nível gratuito. Na homologação, você também precisa poder dar
acesso ao registro de imagens no projeto da Verax (o dono do projeto pode).

> **Limite de projetos por conta de faturamento.** Uma conta nova liga até 5 projetos. Se der
> `Cloud billing quota exceeded` ao ligar o faturamento, use um projeto que já tenha faturamento ou peça
> aumento de cota ao Google.

## Passo 2: o bucket do estado

O Terraform guarda o estado aqui. O versionamento deixa voltar a uma versão anterior se algo der errado. Cada
projeto tem o seu bucket; o do nó da Verax já existe desde 03/11/2026 e continua o mesmo.

```bash
# Só para a homologação (projeto dos nós de clientes), uma vez:
gcloud storage buckets create gs://PROJETO_DOS_NOS-tfstate --project PROJETO_DOS_NOS \
  --location=southamerica-east1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://PROJETO_DOS_NOS-tfstate --versioning
```

É o único recurso criado fora do Terraform: ele precisa existir antes de o Terraform começar. No projeto dos nós, o
`envs/nodes-platform` o adota no primeiro `apply` e passa a manter as configurações dele (seção "O projeto dos nós e
o nó de cada cliente"); os comandos acima continuam sendo o jeito de criá-lo.

## Passo 3: as variáveis

Dentro da pasta do ambiente, copie o exemplo e preencha:

```bash
cd infra/gcp/envs/verax        # ou infra/gcp/envs/homolog-sp
cp terraform.tfvars.example terraform.tfvars
```

- **`envs/verax`:** todas as variáveis da primeira subida, com os mesmos valores, porque o estado já tem o que elas
  criaram: `project_id`, `monitored_projects`, `billing_account_id` e `monthly_budget` (o nó da Verax tem orçamento)
  e, se a primeira subida mudou o padrão deles, `operators`, `region` e `zone`. Uma variável que falte vira mudança
  no `plan`: sem o `billing_account_id`, o `plan` apaga o alerta de orçamento do projeto. Se você já tinha o
  `infra/gcp/terraform.tfvars`, mova o arquivo para `infra/gcp/envs/verax/terraform.tfvars`, sem mudar nada nele. Se
  a primeira subida foi por `-var`, sem arquivo, tire os valores do próprio estado depois do `init` (passo 4):
  `terraform state list` mostra os projetos monitorados nos sinks (`google_logging_project_sink.security["PROJETO"]`)
  e os operadores nos acessos da VM, e `terraform state show 'google_billing_budget.project[0]'` mostra a conta
  (`billing_account`) e o valor (`units`).
- **`envs/homolog-sp`:** `project_id` (projeto dos nós de clientes) e `images_project_id` (projeto da Verax, onde
  está o registro das imagens). O resto tem padrão e está explicado no arquivo e em `variables.tf`; um projeto de
  cliente entra em `customer_projects` (seção "Projeto de cliente: o sink é do cliente").

O `terraform.tfvars` fica só na sua máquina: o `.gitignore` não deixa ele entrar no repositório.

> **Orçamento:** para o alerta, preencha `billing_account_id` (em Faturamento, no console) e `monthly_budget`,
> na moeda da conta. Num ambiente novo, é preciso ser administrador da conta de faturamento; se não for, deixe vazio.
> No `envs/verax`, o orçamento já existe: preencha os dois com os valores do estado.

## Passo 4: `terraform init`

Na pasta do ambiente:

```bash
# envs/verax: o mesmo bucket de sempre; o prefixo `verax-node` está no versions.tf
terraform init -backend-config="bucket=PROJETO_DA_VERAX-tfstate"

# envs/homolog-sp: o bucket do passo 2; o prefixo `homolog-sp` está no versions.tf
terraform init -backend-config="bucket=PROJETO_DOS_NOS-tfstate"
```

O `init` baixa o provider da Google e o confere contra os hashes do arquivo `.terraform.lock.hcl`, que garante a
mesma versão em qualquer máquina. Depois, liga o Terraform ao bucket do estado. Termina com
`Terraform has been successfully initialized!`.

A pasta `infra/gcp/.terraform` da raiz antiga e qualquer `*.tfplan` que tenha ficado em `infra/gcp` podem ser
apagados: a raiz agora é `envs/verax`.

## Passo 5: `terraform plan` (só olha, não muda nada)

```bash
terraform plan -out=plano.tfplan
```

O `-out=plano.tfplan` grava exatamente esse plano, para o `apply` fazer só isso.

**No nó da Verax, o próximo `plan`** tem de terminar com:

```
Plan: 0 to add, 1 to change, 0 to destroy.
```

A única mudança é no registro das imagens, `google_artifact_registry_repository.node will be updated in-place`:
`~ immutable_tags = true -> false` dentro de `docker_config`; na política de limpeza `manter-recentes`, o bloco
`cleanup_policies` saindo (`-`, com `keep_count = 10`) e voltando (`+`, com `keep_count = 3`), porque é um conjunto; e
um bloco novo (`+`), a política `manter-no-ar`, que guarda toda versão com tag `no-` (a versão no ar: o `deploy.sh`
grava `no-<vm>` nas imagens que instala). Nada mais muda, e nenhuma imagem é apagada pelo `apply`: a limpeza roda num
job do próprio Artifact Registry, mais ou menos uma vez por dia. Logo depois do `apply`, grave a tag na versão que o nó
já roda (as próximas vêm do `deploy.sh`), com os digests que o último `deploy.sh` mostrou:
`gcloud artifacts docker tags add REGISTRO/api@DIGEST_DA_API REGISTRO/api:no-verax-node` e o mesmo para `migrate`. O motivo está no `envs/verax/images.tf`: com tags imutáveis, o Artifact Registry não apaga
nenhuma versão com tag, e toda imagem do nó tem a tag do commit, então a política de limpeza nunca apagava nada. A
tag mutável não muda o risco, porque o nó instala pelo digest conferido contra a atestação (`deploy.sh`), nunca pela
tag. É uma atualização no lugar, não uma recriação (o provider só recria o registro por lugar, nome, formato, modo ou
chave); o teste `envs/verax/tests/imagens.tftest.hcl` fixa isso.

Se o `plan` da mudança de pasta ainda não foi aplicado, o mesmo `plan` mostra também 30 linhas `has moved to`, uma
por recurso que passou para o módulo (por exemplo,
`# google_compute_instance.node has moved to module.node.google_compute_instance.node`). Os blocos `moved` de
`envs/verax/main.tf` dizem ao Terraform que só o endereço mudou. Confira:

1. **Nenhum `must be replaced`, `forces replacement` ou `will be destroyed`.** Se aparecer, pare: falta uma variável
   da primeira subida no `terraform.tfvars` (sem o `billing_account_id`, aparece
   `google_billing_budget.project[0] will be destroyed`), ou um bloco `moved` ou um valor do perfil `lean` está
   errado, e o `apply` apagaria ou recriaria algo. A VM tem proteção contra exclusão e o disco tem `prevent_destroy`,
   mas não conte com isso para os outros recursos. A proteção da VM nem impede tudo: ela só é conferida na hora de
   apagar a VM, e antes disso o `apply` já apagou os acessos dos operadores nela (veja "Mudar ou desfazer"). Foi
   conferido com um `plan` só de leitura contra o estado real em 04/11/2026: 47 recursos (o orçamento é um deles),
   nenhuma mudança, 30 movidos.
2. **Só um `will be updated in-place`**, o do registro das imagens, acima. Uma mudança no lugar não derruba nada,
   mas qualquer outra não é deste PR.
3. Se o seu `terraform.tfvars` não for o mesmo da primeira subida, o `plan` mostra a diferença: compare antes de
   seguir.

O `apply` desse plano muda o registro no lugar (a VM, o banco e as imagens não são tocados) e, se for o caso, grava
os endereços novos no estado. Depois dele, o `plan` seguinte mostra `No changes.`, e os blocos `moved` podem ficar
(não atrapalham) ou sair. Se, em vez disso, ele insistir em `+ docker_config { + immutable_tags = false }`, é uma
quirk conhecida do serviço (hashicorp/terraform-provider-google#14846: o Artifact Registry guarda a mesma coisa para
"falso" e "sem valor" e pode devolver o bloco vazio); o registro já está como se quer, e a saída é tirar o bloco
`docker_config` do `images.tf` (sem valor é o mesmo que falso) e ajustar o teste.

**Na homologação, numa subida do zero,** a última linha é **`Plan: 39 to add, 0 to change, 0 to destroy.`**, sem
orçamento e sem e-mail de alerta (41 com os dois), mais 5 por projeto monitorado, 4 por projeto de cliente e 4 por
pessoa em `operators` (mais 1 papel na primeira). Todos os nomes começam com `verax-homolog`, menos a permissão de
leitura no registro de imagens do projeto da Verax.

Nesse primeiro `plan`, aparece também `data.google_project.this will be read during apply` e, com orçamento, o
projeto dele como `(known after apply)`. É de propósito: ler o projeto usa a API do Resource Manager, que vem
desligada num projeto novo e só o `apply` liga. Depois, isso só volta quando a lista do `apis.tf` mudar, e aí o
orçamento aparece como `update in-place` só por isso: o projeto continua o mesmo.

## Passo 6: `terraform apply`

```bash
terraform apply plano.tfplan
```

Leva de 3 a 5 minutos numa subida do zero. No fim, aparecem as saídas (_outputs_): o comando de SSH, a assinatura do
Pub/Sub, os nomes dos segredos e, na homologação, o `nat_ip`. Para vê-las de novo depois, use `terraform output`.

**Se o `apply` der erro de API "has not been used in project ... or it is disabled":** o Terraform acabou de ligar a
API e a GCP ainda não propagou. Espere 1 ou 2 minutos e rode o `plan` e o `apply` de novo. O Terraform continua de
onde parou; o novo `plan` mostra só o que faltou. Foi o que aconteceu na primeira subida do nó da Verax.

Se o mesmo erro vier no `plan`, a causa depende de algum `apply` já ter rodado no projeto:

- **Depois de um `apply`, mesmo um que parou com esse erro:** é a mesma propagação. O `apply` ligou as APIs e as
  gravou no estado; com elas lá, o `plan` volta a ler o projeto e os recursos que já existem, e a leitura esbarra na
  API que ainda não propagou (a própria mensagem diz _wait a few minutes_). Confira com
  `gcloud services list --enabled --project PROJETO` que a API está ligada, espere mais alguns minutos e rode o
  `plan` de novo. Se ela não estiver na lista, ligue-a como no caso abaixo.
- **Antes do primeiro `apply` no projeto:** esperar não resolve, porque nada ligou essa API ainda, e todo `plan` para
  no mesmo ponto. Ligue a API que a mensagem cita, no projeto que ela cita
  (`gcloud services enable NOME.googleapis.com --project PROJETO`), e rode o `plan` de novo. Na homologação, isso
  não deve acontecer: antes do primeiro `apply`, o `plan` de um projeto novo não depende de nenhuma API que só o
  `apply` liga.

## Passo 7: gravar os segredos

Os valores nunca passam pelo Terraform. No **Git Bash**, cole o valor quando ele pedir; nada aparece na tela nem
fica no histórico (troque o prefixo `verax-node` por `verax-homolog` e acrescente `--project PROJETO_DOS_NOS` na
homologação):

```bash
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-smtp-password --data-file=- && unset VALOR
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-cloudflare-tunnel-token --data-file=- && unset VALOR
# Só com `turnstile_secret = true` no main.tf (a homologação); sem o cofre, o comando falha e nada muda.
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-turnstile-secret-key --data-file=- && unset VALOR
```

- **Senha do e-mail (opcional):** o nó funciona sem e-mail, porque as contas nascem com senha temporária. Só com
  `MAIL_TRANSPORT=smtp` grave aqui a senha de aplicativo da caixa `nao-responda@` no Zoho (Minha conta → Segurança →
  Senhas específicas de aplicativo); a redefinição de senha pelo link sai por ela.
- **Token do túnel:** no Cloudflare, em Zero Trust → Networks → Tunnels, crie um túnel com o nome do nó e copie
  o token do comando de instalação (o texto longo depois de `--token`).
- **Chave secreta do Turnstile (opcional; só com `turnstile_secret = true` no `main.tf`):** no Cloudflare, em
  Turnstile → Add widget, modo Managed, com o hostname do painel. A chave do site (pública) vai no `node.conf`
  (`TURNSTILE_SITE_KEY`), e é ela que liga o desafio no nó; o roteiro completo está em `docs/runbooks/no-verax.md`.
  O nó da Verax ainda não tem o cofre: ligar é uma mudança no lugar (o `plan` mostra só o cofre e a permissão).

Se ainda não tiver algum deles, deixe para depois: o nó só precisa deles na instalação do pacote. Os cofres
`credentials-key` e `admin-bootstrap` da homologação ficam vazios: quem grava neles é a própria VM.

## Passo 8: conferir que funcionou

**Entrar na VM** (o comando também está em `terraform output ssh_command`):

```bash
gcloud compute ssh verax-node --zone us-east1-b --tunnel-through-iap
```

Lá dentro, confira o disco, a memória de troca e a saída para a internet, e saia:

```bash
df -h /                         # 30 GB no lean, 60 GB no standard
cat /proc/swaps                 # lean: /swapfile com 2 GB; nó novo: /dev/dm-0 (o swap cifrado) com 2 GB
curl -sI https://deb.debian.org/ | head -1    # HTTP 200: a saída pelo NAT funciona
exit
```

Num nó criado pelo módulo (a homologação), confira também:

```bash
sudo cryptsetup status verax-swap          # type: PLAIN, cipher: aes-xts-plain64, keysize: 512 bits
sysctl vm.max_map_count vm.swappiness      # standard: 262144 e 1
curl -s https://ifconfig.me; echo          # o mesmo IP de `terraform output nat_ip`
sudo journalctl -u google-startup-scripts --no-pager | tail   # o script de boot terminou sem erro
```

**Ver os logs chegando ao Pub/Sub.** Uma ação de administração num projeto monitorado gera um log de auditoria.
Uma forma inofensiva é "atualizar" o próprio sink com a mesma descrição, e ler a assinatura um minuto depois:

```bash
gcloud logging sinks update verax-node-security --project PROJETO_MONITORADO \
  --description="Eventos de segurança para o nó do Verax Control (só cópia; os logs originais não mudam)."
gcloud pubsub subscriptions pull verax-node-security-PROJETO_MONITORADO --limit=3
```

Deve aparecer uma mensagem com `cloudaudit.googleapis.com` e `UpdateSink`. O `pull` sem `--auto-ack` não consome
a mensagem: ela volta para a fila e o nó vai lê-la depois. Na homologação, os nomes e o projeto da assinatura mudam
(veja o teste do alerta, abaixo).

**Pub/Sub só na região** (homologação, com um projeto monitorado):

```bash
gcloud pubsub topics describe verax-homolog-security-PROJETO_MONITORADO --project PROJETO_DOS_NOS \
  --format='value(messageStoragePolicy.allowedPersistenceRegions)'   # southamerica-east1
```

**Testar o alerta de fila parada** (só na homologação: o nó da Verax não tem o alerta): com a VM parada e um projeto
monitorado, use `stalled_subscription_hours = 1` no `terraform.tfvars` e faça o `apply`. Gere um log com o sink da
homologação, que fica no projeto monitorado, e confira que ele chegou à assinatura, que fica no projeto dos nós:

```bash
gcloud logging sinks update verax-homolog-security --project PROJETO_MONITORADO \
  --description="Eventos de segurança para o nó do Verax Control (só cópia; os logs originais não mudam)."
gcloud pubsub subscriptions pull verax-homolog-security-PROJETO_MONITORADO --project PROJETO_DOS_NOS --limit=3
```

Espere pouco mais de 1 hora: o incidente abre no Cloud Monitoring (Alertas) e o e-mail chega. Depois, volte para 24 e
faça o `apply` de novo.

## O nó da Verax ainda usa o script antigo (pendência)

O swap cifrado com chave aleatória a cada boot está no script do módulo, que vale para todo nó novo. O nó da Verax
continua com o `envs/verax/startup.sh`, idêntico ao aplicado em 03/11/2026, com o swap em claro. O motivo: no
provider da Google, mudar o `metadata_startup_script` (ou tirá-lo para usar a chave `startup-script`) **recria a
VM**. Por isso este PR não mexe no script do nó da Verax.

Não há passo manual seguro enquanto o script antigo estiver na VM: no boot seguinte, ele recolocaria a linha do swap
em claro no `fstab` e falharia ao ligar o swap, e a e2-micro ficaria sem swap. A troca é uma **manutenção
planejada**, com alguns minutos do nó fora do ar:

1. Escolha uma janela. O disco fica (é um recurso à parte, com `prevent_destroy` e `auto_delete = false`) e os dados
   continuam nele; só a VM é recriada. Confira que o disco tem 3 GB livres (`df -h /`, coluna `Avail`): o swap
   cifrado usa um arquivo novo de 2 GB, que convive com o antigo até ele sair, e o script só cria o arquivo se ainda
   sobrar 1 GB para o banco e o resto do nó.
2. Em `envs/verax/main.tf`, acrescente `deletion_protection = false` na chamada do módulo e faça o `plan` e o
   `apply`: só essa proteção muda, no lugar.
3. Tire a linha `deletion_protection = false` e a linha `legacy_startup_script = ...` e faça o `plan`. Ele mostra:
   - `module.node.google_compute_instance.node must be replaced` (por causa do `metadata_startup_script`), e dentro
     dela `deletion_protection = false -> true`. Essa linha é a prova de que o passo 2 foi aplicado: sem ela, **pare
     e volte ao passo 2**. Com a proteção ainda ligada na VM, o `apply` apagaria primeiro os acessos dos operadores
     na VM no ar e só depois esbarraria na proteção (veja "Mudar ou desfazer");
   - para cada pessoa em `operators`, os dois acessos dela na VM (`google_compute_instance_iam_member.operators` e
     `google_iap_tunnel_instance_iam_member.operators`) com `will be replaced due to changes in replace_triggered_by`.
     A política de IAM da VM some com ela; o Terraform grava os acessos de novo, já na VM nova;
   - mais nada. No resumo, `to destroy` é 1 (a VM) mais 2 por pessoa em `operators`.

   Faça o `apply`: a VM nasce de novo com o mesmo disco, com a proteção ligada e com o script do módulo. No primeiro
   boot, o script instala o `cryptsetup`, liga o swap cifrado no arquivo novo (`/var/lib/verax-swap.img`) e só então
   desliga o swap antigo (o que estava nele passa para o cifrado). Depois sobrescreve o `/swapfile` com zeros, tira a
   linha do `fstab` e apaga o arquivo. O serviço `verax-node` sobe sozinho.

4. Confira na VM:

   ```bash
   sudo journalctl -u google-startup-scripts --no-pager | tail   # o script de boot terminou sem erro
   sudo cryptsetup status verax-swap    # type: PLAIN, cipher: aes-xts-plain64, keysize: 512 bits
   cat /proc/swaps                      # só /dev/dm-0 (o swap cifrado), com 2 GB
   ls /swapfile; grep swapfile /etc/fstab   # o arquivo não existe, e o fstab não tem a linha
   ```

5. A VM nova gerou chaves de SSH (do servidor) novas. O `deploy.sh` guarda a da VM antiga em
   `~/.ssh/known_hosts_verax-node` e recusaria a próxima conexão com `REMOTE HOST IDENTIFICATION HAS CHANGED`. Apague
   a chave antiga:

   ```bash
   ssh-keygen -R verax-node -f ~/.ssh/known_hosts_verax-node
   ```

   O próximo `deploy.sh` aceita a chave nova sem perguntar e a guarda (`StrictHostKeyChecking=accept-new`), como na
   primeira vez, e as conexões seguintes a conferem. Não há uma fonte à parte para conferir a chave nova antes: a VM
   só publicaria as chaves nos atributos de convidado (_guest attributes_), que o módulo não liga. O
   `gcloud compute ssh` também não confere: a VM nova tem outro ID, e ele aceita a chave na primeira conexão. As duas
   conexões só passam pelo túnel do IAP, que o Google autentica e que leva só a essa VM. Para comparar depois do
   `deploy.sh`: a impressão digital que ele guardou sai em `ssh-keygen -lF verax-node -f ~/.ssh/known_hosts_verax-node`,
   e a da VM, dentro dela (passo 8), em `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`; as duas têm de ser iguais.

6. Deixe o repositório igual ao nó, num commit só (o `main.tf` já está sem as duas linhas do passo 3):
   - apague o `envs/verax/startup.sh`;
   - em `modules/node/tests/lean_verax.tftest.hcl`, tire a linha `legacy_startup_script` do bloco `variables` do
     topo e o `run "vm_e_script_de_boot"`, que conferem o script antigo. O `run "apos_a_manutencao_do_swap"` já
     confere a VM como ela ficou. Sem isso, o teste do módulo procura o arquivo apagado e o check obrigatório do
     Terraform no CI falha.

**Se o script parar no meio**, a VM nunca fica sem swap, e a linha do `fstab` só sai depois de o arquivo estar zerado:

- **Sem o `cryptsetup`:** cada uma das 5 tentativas, com 20 s entre elas, baixa a lista do apt de novo e tenta
  instalar; a trava do apt (o `apt-daily` no boot) é esperada por até 2 minutos em cada uma. Se as 5 falharem (rede
  fora do ar o tempo todo, por exemplo), o script para antes de mexer em qualquer swap. O swap antigo continua
  ligado, como antes da manutenção, e nada foi apagado. Veja o erro no log do passo 4, resolva e rode o script de
  novo com `sudo google_metadata_script_runner startup` (ou reinicie a VM).
- **Sem espaço no disco:** com menos de 3 GB livres, o script para antes de criar o arquivo do swap cifrado. Se o
  disco encher durante a criação, o arquivo incompleto é apagado na hora e o espaço volta. Nos dois casos, nenhum
  swap mudou. Libere espaço e rode o script de novo, como acima. Um arquivo do swap com o tamanho errado que tenha
  sobrado é refeito.
- **Parou depois de ligar o swap cifrado** (a VM reiniciou no meio da limpeza, por exemplo): a linha do `fstab` ou o
  arquivo antigo continuam lá, e a próxima execução (o mesmo comando, ou o boot seguinte) repete a limpeza do
  começo. Um arquivo meio zerado perde a assinatura de swap: o systemd só registra que não conseguiu ligá-lo.

Os snapshots tirados antes da troca (até 28 dias) guardam o swap antigo, que pode ter páginas em claro, até
expirarem.

## Mudar ou desfazer

- **Mudar algo** (incluir um projeto monitorado, dar acesso a alguém): edite o `terraform.tfvars` do ambiente e
  repita os passos 5 e 6. O `plan` mostra só a diferença.
- **Aumentar o disco:** mude `disk_gb` no `terraform.tfvars` (nos dois ambientes; sem a linha, vale o do perfil: 30
  GB no lean, 60 no standard) e repita os passos 5 e 6. A GCP aumenta o disco com a VM ligada; reinicie a VM
  (`sudo reboot` dentro dela) e o serviço `google-disk-expand` da imagem do Debian estende a partição e o sistema de
  arquivos no boot. Confira com `df -h /`. Disco não diminui: para menos espaço, só criando outro.
- **Trocar o tamanho da VM** (plano B da homologação, e2-standard-4): mude `machine_type` e repita os passos 5 e 6.
  A VM para, muda e volta (`allow_stopping_for_update`).
- **Algo que recria a VM** (o `plan` mostra `module.node.google_compute_instance.node must be replaced`): nunca
  aplique com a proteção ligada. O Terraform apaga primeiro os acessos dos operadores na VM, que ainda está no ar, e
  só ao tentar apagar a VM esbarra na proteção: o `apply` falha, a VM continua rodando, e quem está em `operators` (e
  não é dono do projeto) perde o SSH. Faça como na manutenção do swap: primeiro um `apply` só com
  `deletion_protection = false`, depois o da mudança. Se já aconteceu, volte o `main.tf` para como estava antes da
  mudança e faça o `plan` e o `apply`: os acessos saíram do estado, e o Terraform os grava de novo na mesma VM.
- **Desfazer tudo:** existe atrito de propósito, para nada sumir por engano.
  1. A VM tem proteção contra exclusão: acrescente `deletion_protection = false` na chamada do módulo, no `main.tf`
     do ambiente, e faça o `apply`.
  2. O disco e o IP fixo do NAT têm `prevent_destroy`: remova esse bloco `lifecycle` em `modules/node/node.tf` e
     `modules/node/network.tf` só na sua cópia, para essa vez. A conta de serviço não tem, mas num nó de cliente
     apagá-la desliga a AWS do cliente: o papel de leitura confia no ID único dela, e uma conta nova tem outro.
  3. O bucket de backups só é apagado vazio.
  4. Depois disso, `terraform destroy` mostra o que vai apagar e pede confirmação. As APIs continuam ligadas e o
     bucket do estado fica.

## O plano de controle (`envs/control-plane`)

O plano de controle é a parte da fase 3 que vende e provisiona: o site chama `POST /v1/public/checkout`, a Stripe
avisa pelo webhook, e um worker executa o provisionamento do nó do cliente passo a passo (plano da fase 3, documento
interno).
Este ambiente cria a infraestrutura dele na GCP; o código do serviço (`apps/control-plane`) vem nos PRs CP-01 em
diante. Fica no **projeto da Verax que hospeda o Firebase dos painéis**: o rewrite do Hosting para o Cloud Run exige o
mesmo projeto, e o Firestore gratuito é um banco por projeto. Tudo o que é da Verax fica no nível gratuito: Cloud Run
sem instância mínima, sem Cloud SQL, sem IP reservado e sem NAT.

**Custo estimado:** R$ 0 com 0 clientes, cerca de R$ 1 com 5 e R$ 2 a 8 com 20 (plano, seção 6: Cloud Run, Firestore,
Cloud Tasks e Scheduler no nível gratuito; sobram centavos de Secret Manager e Artifact Registry). O orçamento do
projeto é de R$ 15. A recuperação pontual (PITR) do Firestore fica **desligada**: a GCP cobra o armazenamento dela à
parte, sem nível gratuito e com no mínimo 1 dia cobrado (preços do Firestore, 04/11/2026); `firestore_pitr = true`
liga, se um dia valer o custo.

### O que ele cria

| Recurso                                                   | Para quê                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16 APIs                                                   | Cloud Run, Cloud Tasks, Cloud Scheduler, Firestore e as regras dele, Secret Manager, Artifact Registry, Firebase Hosting, federação (iam, iamcredentials, sts), orçamento, logs e alertas. Nenhuma é desligada no destroy.                                                                                                                                                                                                                     |
| Firestore `(default)`                                     | Modo nativo, em São Paulo, protegido contra exclusão. Regras de segurança que negam tudo aos SDKs de cliente (só os serviços chegam, pelo IAM). Prazos (TTL em `expiresAt`) nas coleções com retenção do plano e os 4 índices compostos de `tenants`.                                                                                                                                                                                          |
| 5 contas de serviço                                       | `cp-public`, `cp-worker`, `cp-terraform`, `cp-invoker` e `cp-deployer`, com os papéis da seção 2.2 do plano, cada um no menor recurso possível (a fila, o segredo, o Job). A `cp-invoker` é só o token das tasks e do Scheduler para chamar o `cp-worker`: ninguém age como o `cp-worker` além de quem implanta. O papel personalizado `cpJobRunner`; os agentes de serviço do Cloud Tasks e do Cloud Scheduler criados antes do primeiro uso. |
| Pool e provedor de federação `cp-github`                  | O GitHub Actions implanta sem chave: só o token do environment `control-plane` do repositório, pelos IDs fixos do repositório e do dono, vindo de um `push` ou de um disparo manual na `main`, vira `cp-deployer`.                                                                                                                                                                                                                             |
| 5 segredos, vazios                                        | `cp-stripe-secret-key`, `cp-stripe-webhook-secret`, `cp-cloudflare-api-token`, `cp-smtp-password`, `cp-cookie-key`. Gravados no passo 4, só na região. Logs de auditoria de acesso a dados do Secret Manager ligados no projeto (quem leu, gravou ou consultou a política de qual segredo).                                                                                                                                                    |
| Registro de imagens `verax-control-plane`                 | Imagens dos serviços e do executor Terraform, neste projeto e nesta região; `cp-deployer` publica. Ficam as 3 versões mais recentes de cada imagem (mais as publicadas nos últimos 30 dias). Tags mutáveis de propósito: com tags imutáveis, a limpeza não apaga versão com tag, e o registro cresceria sem limite.                                                                                                                            |
| Cloud Run `cp-public`, `cp-worker` e o Job `cp-terraform` | Só com `services_enabled = true` (passo 5). 1 vCPU e 512 MiB, 0 a 2 e 0 a 1 instâncias, sonda de partida em `/health`; o Job com 2 GiB, 30 min e 1 tentativa. O worker só recebe tráfego de dentro do projeto, e só com token.                                                                                                                                                                                                                 |
| Filas `provisioning` e `lifecycle`                        | 8 tentativas com recuo de 30 s a 10 min, 2 despachos ao mesmo tempo.                                                                                                                                                                                                                                                                                                                                                                           |
| Scheduler `tick` e `reconcile`                            | A cada hora e às 3 h de São Paulo, chamando o `cp-worker` com o token da `cp-invoker`, com o mesmo prazo do worker (15 min).                                                                                                                                                                                                                                                                                                                   |
| Site do Hosting `verax-conta` e o domínio                 | `conta.veraxsistemas.com.br` com o rewrite `/**` para o `cp-public`. Os registros de DNS saem numa saída (passo 6).                                                                                                                                                                                                                                                                                                                            |
| Console do responsável `cp-admin` (opcional)              | Só com `admin_enabled = true` (passo 8): o terceiro serviço da mesma imagem (`ROLE=admin`), com o IAP ligado direto no Cloud Run, 0 a 1 instância; a conta `cp-admin` só com o Firestore e sem segredo; só o agente do IAP invoca, e só `owner_principals` passa pelo IAP. Mais os alertas de margem e de acessos recusados.                                                                                                                   |
| 5 alertas por log                                         | Provisionamento com falha, assinatura inválida no webhook, teto diário do Checkout, evento da Stripe que pede decisão (fraude, pagamento sem cliente, troca de preço...) e falha ao processar evento da Stripe, por e-mail (`alert_email`).                                                                                                                                                                                                    |
| Orçamento (opcional)                                      | R$ 15 por mês, com e-mail em 50%, 90% e 100%.                                                                                                                                                                                                                                                                                                                                                                                                  |

Fora deste projeto, só quando as variáveis forem preenchidas (`cross_project.tf`): a gravação da política do
registro de imagens do nó (`images_project_id`), a leitura do bucket de releases (`release_bucket`) e o
`firebasehosting.admin` nos projetos do pool dos painéis dos clientes (`firebase_panel_projects`; nunca neste
projeto). As permissões no projeto dos nós de clientes (os papéis do `cp-terraform`, o ciclo de vida das VMs para o
`cp-worker` e o bucket do estado) ficam no `envs/nodes-platform` desde o CP-06; aqui, `nodes_project_id` só vira as
variáveis dos serviços e do Job.

### Passo 1: login, projeto e bucket do estado

O mesmo login do passo 1 dos nós, com `SEU_PROJETO` = o projeto do Firebase dos painéis. Você precisa ser
**Proprietário** dele, e ele precisa estar no plano **Blaze** do Firebase (o rewrite do Hosting para o Cloud Run
exige; o Terraform não muda o plano). O estado vai para o bucket que já existe (passo 2 dos nós, o do nó da Verax),
com o prefixo `control-plane` do `versions.tf`; qualquer bucket em que você grave serve.

### Passo 2: as variáveis

```bash
cd infra/gcp/envs/control-plane
cp terraform.tfvars.example terraform.tfvars
```

Só `project_id` é obrigatório. Preencha também `owner_principals` (quem opera, para chamar o `cp-worker`),
`alert_email` e, se for administrador da conta de faturamento, `billing_account_id`. O resto está explicado no
arquivo e em `variables.tf`; `services_enabled` fica `false` nesta primeira subida.

### Passo 3: primeira subida (sem os serviços)

```bash
terraform init -backend-config="bucket=PROJETO_DA_VERAX-tfstate"
terraform plan -out=plano.tfplan
terraform apply plano.tfplan
```

A última linha do `plan` é **`Plan: 74 to add, 0 to change, 0 to destroy.`** (75 com orçamento, 76 com e-mail de
alerta), sem nada para mudar ou destruir, e `data.google_project.this will be read during apply` (como na homologação:
a leitura do projeto espera as APIs). Os serviços ficam para o passo 5: o Cloud Run recusa subir com um segredo sem
versão, e os cinco nascem vazios. Erro de API "has not been used in project": a mesma propagação do passo 6 dos nós;
espere 1 ou 2 minutos e repita o `plan` e o `apply`. Se o projeto já tiver logs de auditoria de acesso a dados do
Secret Manager configurados à mão, importe antes (`terraform import google_project_iam_audit_config.secretmanager
"SEU_PROJETO secretmanager.googleapis.com"`): o recurso é a configuração inteira desse serviço.

### Passo 4: gravar os segredos

No **Git Bash**, cole o valor quando ele pedir; nada aparece na tela nem fica no histórico. A chave do cookie é
gerada, não digitada:

```bash
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add cp-stripe-secret-key --data-file=- && unset VALOR
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add cp-stripe-webhook-secret --data-file=- && unset VALOR
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add cp-cloudflare-api-token --data-file=- && unset VALOR
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add cp-smtp-password --data-file=- && unset VALOR
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add cp-cookie-key --data-file=-
```

- **Chave da Stripe:** uma chave **restrita** (não a `sk_`), com escrita em Checkout Sessions, Customers,
  Subscriptions, Tax IDs e Billing Portal e leitura em Invoices, Charges, Disputes, Radar (Early Fraud Warnings) e
  Events (o webhook relê cada objeto antes de decidir, CP-04); a do sandbox primeiro (plano, seção 9, item 6). Trocar
  para produção é gravar uma versão nova (CP-13).
- **Segredo do webhook:** o endpoint `https://conta.veraxsistemas.com.br/v1/stripe/webhook` com os 13 eventos da
  seção 4(b) do plano, formato _snapshot_ (item 7), pode ser cadastrado antes de o serviço existir. Duas formas: no
  Workbench da Stripe, gravando o segredo de assinatura com a linha acima; ou pelo `stripe-setup` (CP-04), que cria o
  endpoint e manda o segredo direto para `gcloud secrets versions add cp-stripe-webhook-secret --data-file=-`, sem
  mostrá-lo (`--webhook-url=... --webhook-secret-name=cp-stripe-webhook-secret`; no WSL ou no Cloud Shell, porque no
  Windows o Node não executa o `gcloud.cmd` sem shell; detalhes no cabeçalho do script).
- **Token do Cloudflare:** só `Account > Cloudflare Tunnel > Edit` e `Zone > DNS > Edit`, restrito à zona
  `veraxsistemas.com.br`, validade de 1 ano (item 13). Os IDs da conta e da zona vão no `terraform.tfvars`
  (`cloudflare_account_id`, `cloudflare_zone_id`), não são segredo.
- **Senha do SMTP:** a senha de aplicativo da caixa de envio no Zoho, como no passo 7 dos nós.

Todos os cinco precisam ter versão antes do passo 5, mesmo que o provisionamento ainda esteja desligado: o Cloud Run
monta os cinco na partida.

### Passo 5: segunda subida (os serviços)

Mude `services_enabled = true` no `terraform.tfvars` e repita o `plan` e o `apply`. O `plan` mostra
**`Plan: 13 to add`** (mais 1 por pessoa em `owner_principals`): os dois serviços com a imagem de exemplo do Google,
o Job, os acessos deles, os dois jobs do Scheduler e a versão do Hosting com o rewrite. Faça isso **antes** da
primeira execução do workflow de implantação (CP-01): o `gcloud run deploy` criaria os serviços por fora do
Terraform, e o `apply` seguinte pararia em "already exists".

Depois da primeira implantação pelo workflow, rode o `plan`: tem de dar `No changes.`. A imagem, o tráfego (o workflow
sobe a revisão candidata sem tráfego, com a etiqueta `candidato`, e só a promove depois do `/health`), o `client` e o
`client_version` que o gcloud grava estão em `ignore_changes` (`run.tf`); se aparecer outra diferença, ela entra na
mesma lista. O resto (tamanhos, prazos, sonda de partida, variáveis e segredos) é do Terraform: o workflow só troca a
imagem. Uma revisão criada pelo Terraform (uma mudança em `service_env`, por exemplo) recebe o tráfego porque o
workflow deixa o serviço apontando para a revisão mais recente ao promover.

### Passo 6: o domínio no Cloudflare

```bash
terraform output cloudflare_dns_records
```

Crie cada registro na zona `veraxsistemas.com.br` com o proxy **desligado** ("DNS only"): o Firebase emite e renova o
certificado, e com o proxy ligado não consegue. Lista vazia: o Firebase ainda não respondeu; `terraform refresh` e
`terraform output` de novo. Minutos a horas depois, confira:

```bash
terraform refresh
terraform state show google_firebase_hosting_custom_domain.conta | grep -E 'host_state|state '   # HOST_ACTIVE e CERT_ACTIVE
curl -sI https://conta.veraxsistemas.com.br/health | head -1                                        # HTTP 200 depois do CP-01
```

### Passo 7: o environment `control-plane` no GitHub

Em Settings → Environments, crie `control-plane`, restrito à `main` (deployment branches), e preencha as variáveis
(não são segredos) com `terraform output github_environment`. A restrição à `main` no GitHub é uma segunda tranca: o
provedor de identidade (`identities.tf`) já recusa qualquer token que não venha de um `push` ou de um disparo manual
na `main`, mesmo que o environment fique aberto por engano.

| Variável do environment | Saída do Terraform                        | O que é                                                           |
| ----------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `GCP_WIF_PROVIDER`      | `github_environment.GCP_WIF_PROVIDER`     | o provedor `github` do pool `cp-github` deste projeto             |
| `GCP_DEPLOYER_SA`       | `github_environment.GCP_DEPLOYER_SA`      | `cp-deployer@<projeto>.iam.gserviceaccount.com`                   |
| `GCP_PROJECT_ID`        | `github_environment.GCP_PROJECT_ID`       | o projeto                                                         |
| `GCP_PROJECT_NUMBER`    | `github_environment.GCP_PROJECT_NUMBER`   | o número do projeto                                               |
| `GCP_REGION`            | `github_environment.GCP_REGION`           | `southamerica-east1`                                              |
| `CP_IMAGES_REPOSITORY`  | `github_environment.CP_IMAGES_REPOSITORY` | `southamerica-east1-docker.pkg.dev/<projeto>/verax-control-plane` |
| `CP_PUBLIC_SERVICE`     | `github_environment.CP_PUBLIC_SERVICE`    | `cp-public`                                                       |
| `CP_WORKER_SERVICE`     | `github_environment.CP_WORKER_SERVICE`    | `cp-worker`                                                       |
| `CP_TERRAFORM_JOB`      | `github_environment.CP_TERRAFORM_JOB`     | `cp-terraform`                                                    |
| `CP_ADMIN_SERVICE`      | `github_environment.CP_ADMIN_SERVICE`     | `cp-admin` (só com `admin_enabled`; sem ela, o console fica fora) |

### Passo 8: o console do responsável (`cp-admin`)

O console das tabelas de preço, dos modelos de custo e do simulador de DRE. O passo a passo inteiro, do cliente OAuth
do IAP à primeira publicação, está em `docs/runbooks/console-do-responsavel.md`; aqui, só o Terraform:

1. Num projeto **sem organização**, crie antes o cliente OAuth do IAP (seção 1 do runbook): não há API para isso, e o
   segredo dele nunca passa pelo Terraform.
2. Preencha `owner_principals` (a validação recusa `admin_enabled` sem ela) e mude `admin_enabled = true`. O `plan`
   mostra **11 recursos a criar, mais 1 por pessoa em `owner_principals`**: a API do IAP, a conta `cp-admin`, o
   `datastore.user` dela, o agente de serviço do IAP, o serviço `cp-admin` (com a imagem de exemplo do Google), o
   `run.invoker` do agente, o `iap.httpsResourceAccessor` de cada responsável, o `run.developer` e o `actAs` de quem
   implanta, o alerta de margem e a métrica e o alerta dos acessos recusados.
3. `terraform output admin` traz o endereço e o `aud` do IAP (`/projects/<número>/locations/<região>/services/cp-admin`,
   que o Terraform já passa ao serviço em `IAP_AUDIENCE`).
4. Acrescente `CP_ADMIN_SERVICE` ao environment `control-plane` (passo 7) e rode o workflow: ele implanta o `cp-admin`
   junto, sem tráfego, e só o promove com a revisão pronta (a sonda de partida em `/health` não passa pelo IAP).

### O que continua manual

Do que a seção 9 do plano lista, o Terraform faz os itens 8 a 12 (APIs, banco, contas, federação, segredos vazios,
filas, relógio, site, domínio, rewrite, orçamento e canal de alerta). Ficam com você:

- **Stripe** (itens 1 a 7): produto e preços (`lookup_key` `verax_control_essencial_mensal` e
  `verax_control_profissional_mensal`; os valores ficam fora do repositório público), cupons, se houver (termos também
  fora do repositório), cartão e boleto com validade de 3 dias, o link hospedado
  para confirmação, Smart Retries com "marcar como não paga", dados públicos, Portal do cliente, a chave restrita e o
  webhook. O catálogo e o endpoint do webhook saem do `apps/control-plane/scripts/stripe-setup.ts` (CP-03 e CP-04); o
  resto não tem API, e a chave e o segredo do webhook entram no passo 4.
- **Firebase:** o plano Blaze neste projeto (passo 1; só o rewrite do Hosting para o Cloud Run exige) e, na primeira
  venda, um projeto **só para os painéis dos clientes** em `firebase_panel_projects` (item 14), e mais um a cada 36
  clientes. Esse projeto fica no plano Spark: site estático com domínio próprio não precisa de faturamento. O
  `cp-worker` é `firebasehosting.admin` só lá, nunca aqui: o site `conta.veraxsistemas.com.br` e os sites do Painel
  que já existem neste projeto ficam fora do alcance dele.
- **Cloudflare:** o token (passo 4) e os registros de DNS (passo 6); conferir a cota de registros da zona (item 13).
- **GitHub:** o environment (passo 7).
- **Serviços:** `service_env` (os dois serviços) com as versões dos aceites, a URL do Portal e, se o app exigir,
  `TRUST_PROXY_HOPS` (o Terraform não decide quantos proxies o serviço confia; é do app, CP-01); `worker_env` (só o
  `cp-worker`) com o remetente e o usuário do SMTP; na primeira venda, `nodes_project_id`, `images_project_id`,
  `release_bucket` e, em `worker_env`, `NODE_RELEASE` e `PROVISIONING_ENABLED = "true"` (itens 15 a 17; o projeto dos
  nós, o bucket do estado dele e as permissões lá vêm do `envs/nodes-platform`, aplicado com
  `control_plane_project_id` depois deste ambiente). As chaves que o Terraform deriva de outras variáveis, os
  segredos, `ROLE` e `NODE_ENV` são recusados nos dois mapas; `SMTP_*` e `MAIL_FROM*` só entram em `worker_env`.

### Operações do responsável no `cp-worker`

Por padrão o `cp-worker` só recebe tráfego de dentro do projeto (Cloud Tasks e Cloud Scheduler), além do IAM. Para
chamar `resume`, `delete-now` ou `export` da sua máquina (CP-11), mude `worker_ingress = "INGRESS_TRAFFIC_ALL"` no
`terraform.tfvars` e faça o `apply` (uma mudança no lugar); o IAM continua exigindo o token de identidade de quem está
em `owner_principals`. Volte para `INGRESS_TRAFFIC_INTERNAL_ONLY` depois. O `aud` de um token de usuário do gcloud não
é a URL do serviço: como o worker aceita o responsável (impersonação de uma conta de serviço com `--audiences`, por
exemplo) é decisão do CP-11.

### Revelação da senha e a entrada do `cp-worker` (decisão pendente, CP-05)

A senha temporária do primeiro admin fica no segredo `vx-<slug>-admin-bootstrap` do projeto dos nós, e só o
`cp-worker` tem acesso a ele (por tenant, concedido pelo `envs/tenant`: `secretAccessor` e `secretVersionManager` para
a conta em `CP_WORKER_SA`). Na revelação, o `cp-public` (que atende o site) chama
`POST <WORKER_URL>/internal/access/reveal` com o token de identidade da própria conta, e o `cp-worker` marca, lê,
enfileira a destruição da versão e devolve a senha. Para isso o `cp-public` tem `run.invoker` no `cp-worker` (run.tf), e
o worker só aceita o token dele nessa rota.

Essa chamada sai de um serviço do Cloud Run pela internet. Com `worker_ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"` (o
padrão) a entrada do `cp-worker` a recusa, e a revelação responde 503 ao site. Há duas saídas, e a escolha é sua:

1. **`worker_ingress = "INGRESS_TRAFFIC_ALL"`:** o `cp-worker` fica alcançável pela internet, mas só com token de
   identidade do Google de quem tem `run.invoker` nele (cp-invoker, cp-public e `owner_principals`); qualquer outra
   chamada é recusada pelo Cloud Run antes de chegar ao contêiner, e o app ainda confere `aud`, prazo e o e-mail por
   rota. É o desenho da seção 2.1 do plano ("não é alcançável pela internet sem token de identidade do Google") e não
   custa nada. Perde-se a camada de rede que hoje se soma ao IAM.
2. **Manter `INGRESS_TRAFFIC_INTERNAL_ONLY` e dar ao `cp-public` saída por uma rede VPC** (Direct VPC egress com todo o
   tráfego pela VPC e Cloud NAT para a Stripe): a chamada passa a contar como interna. Sai do nível gratuito (NAT) e
   acrescenta rede, sub-rede e NAT a este ambiente.

Enquanto nenhuma das duas for aplicada, o resto da página de status funciona (claim, estado, boleto) e a revelação
responde 503 com o código `reveal_unavailable`.

### Quem pode o quê (a fronteira de confiança)

- **`cp-invoker`** só chama o `cp-worker`. É o e-mail que o worker aceita no token (`WORKER_SA_EMAIL` e
  `SCHEDULER_SA_EMAIL`, além de `OWNER_PRINCIPALS`) nos passos, no `tick` e no `reconcile`, e o `cp-public` e o
  `cp-worker` agem como ela ao enfileirar.
- **`cp-public`** também chama o `cp-worker` com a própria conta, mas o worker só aceita esse token em
  `POST /internal/access/reveal` (`PUBLIC_SA_EMAIL`): um `cp-public` comprometido pode pedir a revelação (que marca a
  senha como mostrada uma vez por cliente, fica na auditoria e destrói a versão: o cliente veria "senha já mostrada"),
  mas não dispara passo nenhum e não lê o segredo por conta própria.
- **`cp-terraform`** não lê segredo nem backup de tenant nenhum: no projeto dos nós (`envs/nodes-platform`), cria
  cofres e buckets (`cpSecretsProvisioner`, `cpBucketsProvisioner`) sem acesso ao conteúdo. Com o `projectIamAdmin`
  ele ainda poderia se conceder a leitura; é o que o alerta em `SetIamPolicy` do CP-12 (no projeto dos nós, pelo
  `envs/nodes-platform`) vigia.
- **`cp-admin`** (com `admin_enabled`) só lê e grava o Firestore: nenhum segredo, nem a chave da Stripe, e nenhum
  token para chamar o `cp-worker`. Só o agente do IAP o invoca, e só quem está em `owner_principals` passa pelo IAP;
  o app ainda confere o JWT do IAP em toda requisição, inclusive nas telas.
- **`cp-deployer`** é `run.developer` nos dois serviços e no Job: além de publicar revisões, muda qualquer atributo
  deles, apaga-os e executa o Job. Não há papel predefinido mais estreito que sirva ao `gcloud run deploy`. Na
  prática, quem controla a `main` com o environment `control-plane` controla a imagem do `cp-worker` e, por ele, o
  Job, que roda como `cp-terraform` no projeto dos nós. É a fronteira aceita: a `main` é protegida por ruleset sem
  exceção, e o environment e o provedor de identidade só aceitam a `main`.

### Mudar ou desfazer

- **Mudar algo:** edite o `terraform.tfvars` e repita o `plan` e o `apply`. Trocar uma variável dos serviços
  (`service_env` ou `worker_env`) cria uma revisão nova de cada um, com a imagem que está no ar.
- **Rotação de um segredo:** grave uma versão nova (passo 4) e implante de novo pelo workflow (ou mude qualquer
  `service_env`): a instância lê `latest` na partida.
- **Desfazer tudo:** os dois serviços e o Job têm `deletion_protection` (mude para `false` no `run.tf` só na sua
  cópia, para essa vez); o banco do Firestore tem a proteção da GCP e, no Terraform, só sai do estado
  (`deletion_policy = "ABANDON"`): para apagá-lo, desligue a proteção no console e apague por lá. As APIs continuam
  ligadas e o bucket do estado fica.

## O projeto dos nós e o nó de cada cliente (`envs/nodes-platform` e `envs/tenant`)

Na fase 3, cada cliente tem o próprio nó no projeto dos nós de clientes (o mesmo projeto da homologação), criado pelo
plano de controle sem operador. São dois ambientes:

- **`envs/nodes-platform`**, um só, aplicado por você: o que vale para o projeto inteiro.
- **`envs/tenant`**, um por cliente, com o estado em `tenants/<slug>/` no bucket do estado, aplicado pelo executor
  Terraform do plano de controle (o Job `cp-terraform`). Você não aplica nenhum `envs/tenant` à mão: só roda o `plan`
  de aceite, num projeto de teste.

O desenho completo (as variáveis, as permissões do `cp-worker` em cada cofre e os contratos com a instalação sem
operador: o cofre da conta de suporte, os atributos de convidado e as chaves `verax-*` dos metadados da VM) está em
`docs/ARQUITETURA.md`, "O nó de cada cliente".

### O que o `envs/nodes-platform` cria

| Recurso                                     | Para quê                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 11 APIs                                     | As mesmas da homologação, que os nós usam. O executor não liga API nenhuma. Nenhuma é desligada no destroy.                                                                                                                                                                                                                                                                                                  |
| Bucket `<projeto>-tfstate`                  | O do passo 2, adotado no primeiro `apply` (o bloco `import` de `state.tf`): acesso uniforme (a concessão condicionada do `cp-worker` exige), sem acesso público, versionado, versões anteriores apagadas 30 dias depois e os `outputs.json` de `runs/` depois de 180 dias. Protegido contra `destroy`.                                                                                                       |
| Orçamento (opcional)                        | O projeto inteiro (todos os nós e a homologação), com e-mail em 50%, 90% e 100% e na previsão de 100%.                                                                                                                                                                                                                                                                                                       |
| Permissões do plano de controle (opcionais) | Só com `control_plane_project_id`: os 12 papéis do `cp-terraform` (10 predefinidos, `cpSecretsProvisioner` e `cpBucketsProvisioner`), o `objectAdmin` dele no bucket do estado, o `cpNodeLifecycle` do `cp-worker` (parar, ligar e ler os atributos só das VMs `vx-*`), a leitura dele em `runs/` e o papel `cpSecretVersionDestroyer`, que cada tenant concede ao `cp-worker` só no `credentials-key` dele. |

Até o CP-06, essas permissões ficavam no `envs/control-plane` (`cross_project.tf`). Se você já aplicou o
`envs/control-plane` com `nodes_project_id` preenchido, o próximo `plan` dele mostra os papéis e as concessões do
projeto dos nós saindo (`to destroy`): é a mudança para cá. Aplique primeiro o `envs/control-plane` e só depois o
`envs/nodes-platform`: um papel personalizado apagado fica 7 dias como "excluído", e o provider o recupera ao criar de
novo com o mesmo nome; na ordem inversa, o `apply` daqui para com `already exists and must be imported`. Se o
`envs/control-plane` nunca foi aplicado com `nodes_project_id`, não há nada para mover.

### Passo a passo

1. **Antes:** o projeto dos nós existe, com faturamento, e o bucket do estado foi criado (passo 2). Para as
   permissões do plano de controle, o `envs/control-plane` já foi aplicado (as contas `cp-terraform` e `cp-worker`
   precisam existir). O mesmo login do passo 1, com `SEU_PROJETO` = o projeto dos nós.
2. **Variáveis:**

   ```bash
   cd infra/gcp/envs/nodes-platform
   cp terraform.tfvars.example terraform.tfvars
   ```

   `project_id` é obrigatório; `control_plane_project_id` liga as permissões do plano de controle; `billing_account_id`
   e `monthly_budget`, o orçamento. Com o orçamento aqui, deixe vazio o `billing_account_id` da homologação: os dois
   vigiariam o mesmo projeto, e o aviso chegaria duas vezes (se a homologação já tiver o dela, o `plan` dela mostra o
   orçamento saindo, e é isso mesmo).

3. **`init`, `plan` e `apply`:**

   ```bash
   terraform init -backend-config="bucket=PROJETO_DOS_NOS-tfstate"
   terraform plan -out=plano.tfplan
   terraform apply plano.tfplan
   ```

   O primeiro `plan` mostra `google_storage_bucket.tfstate will be imported` e também `updated in-place` (os rótulos e
   as regras de retenção, que o passo 2 não cria), e termina com
   `Plan: 1 to import, 11 to add, 1 to change, 0 to destroy.` (12 a adicionar com orçamento; 19 a mais com
   `control_plane_project_id`), com `data.google_project.this will be read during apply` enquanto alguma API for
   ligada. Nada para destruir: um
   `must be replaced` no bucket (a região dele diferente de `region`) é erro, e o `prevent_destroy` para o `apply`. Um
   bucket que não existe faz o `plan` parar no `import`: crie-o (passo 2) e repita.

4. **Conferir:**

   ```bash
   gcloud storage buckets describe gs://PROJETO_DOS_NOS-tfstate \
     --format="value(uniform_bucket_level_access,versioning_enabled)"   # True e True
   gcloud iam roles list --project PROJETO_DOS_NOS --format="value(name)"   # os quatro cp*
   ```

### O nó de cada cliente (`envs/tenant`)

O executor Terraform roda, para cada cliente, o `init` com
`-backend-config="bucket=<projeto-dos-nos>-tfstate" -backend-config="prefix=tenants/<slug>"` e o `plan`/`apply` com as
variáveis dele (CP-07). O ambiente cria o nó no perfil `standard` com o prefixo `vx-<slug>` em todo recurso, liga o
cofre da conta de suporte, os atributos de convidado, a configuração nos metadados da VM e a instalação sem operador,
dá à conta da VM a leitura do registro das imagens e dá ao `cp-worker` só o que ele faz nos cofres daquele nó. As
variáveis recusam o que estiver fora do formato antes de criar qualquer coisa.

O script de boot leva o instalador, o verificador do manifesto e as chaves públicas de release de `infra/node` (o
módulo os lê no `plan`): o executor precisa do repositório com `infra/node` ao lado de `infra/gcp`, não só da pasta
do Terraform.

**`plan` de aceite num projeto de teste** (o aceite do CP-06; nunca no projeto dos nós com clientes): com o
`envs/nodes-platform` aplicado nesse projeto de teste (as APIs e o bucket do estado),

```bash
cd infra/gcp/envs/tenant
cp terraform.tfvars.example terraform.tfvars   # o projeto de teste, a conta cp-worker e o projeto das imagens
terraform init -backend-config="bucket=PROJETO_DE_TESTE-tfstate" -backend-config="prefix=tenants/demo-a"
terraform plan
```

O `plan` termina com `Plan: 34 to add, 0 to change, 0 to destroy.`: 29 recursos `module.node.*` e 5 permissões (4 do
`cp-worker` nos cofres e a leitura do registro das imagens). Todo nome que aparece começa com `vx-demo-a` (o bucket de
backups é `PROJETO_DE_TESTE-vx-demo-a-backups`), os metadados da VM têm `enable-guest-attributes` e as chaves `verax-*`,
e nenhum recurso fica fora do prefixo. Não aplique: o `plan` só olha. Depois, apague o `terraform.tfvars` e a pasta
`.terraform`.

**Aceite da instalação sem operador (PR-N7)**, num projeto de teste com o `envs/nodes-platform` e o
`envs/control-plane` aplicados (a conta `cp-worker` precisa existir) e um release `node-vX.Y.Z` promovido (Actions →
Versão do nó). O nó nasce só com o `terraform apply`, sem SSH:

1. **A versão e o SHA-256**, conferidos como em `docs/runbooks/versao-no.md` ("Conferir uma versão à mão"): baixe o
   manifesto e a assinatura do release, rode o `infra/node/bin/verify-release.sh` (tem de dizer `OK`) e use o
   `package.sha256` dele. A imagem da API e a das migrations desse release precisam estar no Artifact Registry
   (`gcloud artifacts docker images list <registro>/api --include-tags`): a limpeza apaga as versões com mais de 30
   dias que não estão entre as 3 mais recentes (`docs/ARQUITETURA.md`, "Instalação sem operador").
2. **O `terraform.tfvars`** do `envs/tenant` com um slug de teste (`homolog`, por exemplo), `node_version` e
   `node_package_sha256` do passo 1, e-mails e nome fictícios do cliente e o seu e-mail de suporte. Depois,
   `terraform init` (como no `plan` de aceite, acima, com `prefix=tenants/homolog`), `terraform plan`
   (`Plan: 34 to add`, a chave `startup-script` com o texto do `unattended.sh.tftpl`) e `terraform apply`.
3. **O token do túnel**, em até 60 minutos depois do `apply` (é o que o passo `secrets.tunnel_token` do plano de
   controle faz): crie um túnel de teste no Cloudflare apontando `api-homolog` para `http://api:3000` e grave o token
   com `printf '%s' "$TOKEN" | gcloud secrets versions add vx-homolog-cloudflare-tunnel-token --data-file=-`.
4. **Espere `verax/ready`** (até cerca de 40 minutos; o Wazuh é o mais demorado):

   ```bash
   gcloud compute instances get-guest-attributes vx-homolog --zone southamerica-east1-b --query-path=verax/
   gcloud compute instances get-serial-port-output vx-homolog --zone southamerica-east1-b | grep 'verax-boot:'
   ```

   O primeiro mostra `verax/ready` com a versão (ou `verax/error` com o código; a tabela está na ARQUITETURA). O
   segundo é o diagnóstico sem SSH: cada passo da instalação, sem nenhum valor pessoal.

5. **Confira, ainda sem SSH:** `gcloud secrets versions list vx-homolog-admin-bootstrap` e
   `... vx-homolog-support-bootstrap` com uma versão cada; `curl https://api-homolog.<domínio>/health` pelo túnel;
   `verax/version` (o commit do manifesto) e os outros atributos do worker em até 5 minutos.
6. **Reinicie** (`gcloud compute instances reset vx-homolog --zone southamerica-east1-b`): `verax/ready` volta com a
   mesma versão, e a saída serial não mostra `Baixando` (nada baixado nem instalado de novo). Troque a `node_version`
   e o `node_package_sha256` por outros no `terraform.tfvars`, aplique (`1 to change`, só os metadados) e reinicie: a
   saída serial avisa que a atualização não é automática, e o `verax/ready` continua o de antes.
7. **Desfaça** como na Exclusão 1 do cliente (`docs/ARQUITETURA.md`, "Exclusão em dois tempos"), num teste sem dado a
   guardar:

   ```bash
   # deletion_protection = false no terraform.tfvars, e então:
   terraform apply
   terraform state rm module.node.google_compute_disk.node 'module.node.google_compute_address.nat[0]'
   gcloud storage rm --recursive 'gs://PROJETO_DE_TESTE-vx-homolog-backups/**'   # se o nó já gravou um backup
   terraform destroy
   gcloud compute disks delete vx-homolog --zone southamerica-east1-b
   gcloud compute addresses delete vx-homolog-nat-ip --region southamerica-east1
   ```

   O disco e o IP do NAT têm `prevent_destroy` e saem à mão, depois. Por fim, apague o túnel de teste no Cloudflare.

**Mudanças de rotina** (versão nova, outro plano, outros limites, o nome do cliente) são `update in-place` na VM
(metadados). Um `plan` de tenant que recrie ou apague `module.node.google_service_account.node` fora da exclusão do
cliente é erro: a AWS do cliente deixaria de aceitar o nó, e o executor recusa (CP-07). Uma `node_version` nova não é
instalada sozinha num nó que já existe: a atualização é pelo `deploy.sh`, com o `/etc/verax/node.conf` que a
instalação escreveu (`docs/runbooks/onboarding-cliente.md`, item 8).

**Exclusão do cliente:** o disco e o IP do NAT têm `prevent_destroy`, e o `credentials-key` e o bucket de backups
ficam até a Exclusão 2. O que o executor faz antes do `destroy` (desligar a proteção da VM e tirar esses endereços do
estado) está em `docs/ARQUITETURA.md`, "Exclusão em dois tempos".

**Cotas:** cada nó tem a própria rede VPC, roteador, NAT e IP externo reservado. Num projeto novo, as cotas de redes
VPC por projeto, de endereços IP externos estáticos e de CPUs em `southamerica-east1` são pequenas e acabam antes de
qualquer outra coisa. Na primeira venda, confira no console (IAM e administrador, Cotas, filtrando pelo projeto dos
nós) e peça aumento antes de chegar perto do limite, contando a homologação.

### Mudar ou desfazer

- **Mudar algo** no `envs/nodes-platform`: edite o `terraform.tfvars` e repita o `plan` e o `apply`.
- **Desfazer:** o bucket do estado tem `prevent_destroy` e guarda o estado de todos os clientes: nunca o apague com
  clientes no ar. As APIs continuam ligadas depois de um `destroy`. Um `envs/tenant` só é desfeito pelo plano de
  controle, na exclusão do cliente.

## Escolhas de segurança desta base

- **Sem IP público e sem porta aberta.** SSH só pelo IAP, com a conta Google. O painel e a API chegam ao nó pelo
  túnel do Cloudflare, que é uma conexão de saída.
- **Sem chave de conta de serviço.** A VM usa a própria identidade, e nenhuma chave JSON é criada.
- **Mínimo de permissão.** A VM lê só a assinatura e os seus dois segredos, cria e lê backups (sem apagar) e
  manda os próprios logs. Nos cofres que são dela, grava versões; ler, só a chave do cofre de credenciais. A
  permissão de leitura da configuração dos projetos, para a postura, vem na etapa da postura.
- **Logs só copiados.** Os sinks novos copiam; nenhum log, sink ou retenção existente muda.
- **Swap cifrado nos nós novos.** O que vai da memória para o disco (a chave do cofre, o token de 1 hora para a AWS,
  a memória do worker e do manager) chega ao disco e ao snapshot só cifrado, com uma chave que some a cada boot.
- **Criptografia do Google** no disco, no tópico e no bucket (AES-256). Chave própria (CMEK) fica como reforço
  futuro; ela não muda o risco principal, que é quem controla a VM. Os verificadores (checkov e Trivy) registram
  isso como exceção justificada.

## Próximos passos

Com a base no ar, o próximo passo é o pacote do nó (`infra/node/`): instalar a API, o banco e o túnel na VM. O
roteiro está em `docs/runbooks/no-verax.md`; no `node.conf`, `NODE_PROFILE` é o perfil do ambiente (`lean` no nó da
Verax, `standard` na homologação) e `VERAX_SECRET_PREFIX` é o `name_prefix` do ambiente (`verax-node` e
`verax-homolog`). Essa igualdade é uma premissa operacional: o `start.sh` monta com o prefixo o tópico do sink de
projeto de cliente que o painel mostra, e o teste de contrato da API prende o painel ao Terraform, não ao `node.conf`
instalado. Na homologação, `CREDENTIALS_VAULT=true` liga o cofre de credenciais: na primeira instalação, o
`install.sh` gera a chave do cofre na VM e a grava como versão 1 do `credentials-key`. No nó da Verax, que não tem
esse cofre, a linha fica `false` (ou ausente). Cada projeto, monitorado ou de cliente, entra em Contas cloud com a
assinatura que aparece em `terraform output pubsub_subscriptions`.
