# Guia: subir a base do nó da Verax na GCP com Terraform

Este guia sobe a infraestrutura do SOC da própria Verax na GCP. Você executa cada passo; nada aqui roda sozinho.
São uns 30 minutos na primeira vez.

## Antes de começar: 4 ideias do Terraform

- **Código descreve o que deve existir.** Os arquivos `.tf` desta pasta dizem quais recursos o projeto precisa
  ter (rede, VM, tópico...). O Terraform compara isso com o que existe e faz só a diferença.
- **Provider** é o "tradutor" para uma nuvem. Aqui é o `hashicorp/google`, na versão fixa 8.9.0 (`versions.tf`).
- **Estado** (_state_) é a memória do Terraform: a lista do que ele criou. Fica num bucket do Cloud Storage
  (passo 2), não no seu computador.
- **`plan` antes de `apply`.** O `plan` mostra o que vai acontecer, sem mudar nada. O `apply` executa. Leia
  sempre o `plan`.

## O que vai ser criado

Tudo com o prefixo `verax-node`. Nada que já existe no projeto é alterado.

| Recurso                                    | Para quê                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Rede `verax-node-vpc`, sub-rede, Cloud NAT | Rede própria. A VM não tem IP público: sai para a internet pelo NAT e ninguém entra. |
| 2 regras de firewall                       | SSH só pelo IAP do Google; todo o resto que chega é recusado e registrado.           |
| VM `verax-node` (4 vCPU, 16 GB, Debian 12) | Onde vão rodar Wazuh, API e banco. Por enquanto, só com o disco de dados preparado.  |
| Disco `verax-node-data` (100 GB)           | Dados do nó, separado do sistema. Snapshot diário guardado por 14 dias.              |
| Conta de serviço `verax-node`              | Identidade da VM, sem chave JSON. Só lê os logs e os segredos do nó.                 |
| Sink, tópico e assinatura do Pub/Sub       | Copiam os logs de auditoria e os bloqueios do Cloud Armor para o nó ler.             |
| 2 segredos no Secret Manager (vazios)      | Chave do Resend e token do túnel do Cloudflare. Você grava os valores no passo 7.    |
| Bucket `<projeto>-verax-node-backups`      | Backups do banco. Privado e versionado; a VM cria e lê, mas não apaga.               |
| Orçamento (opcional)                       | E-mail em 50%, 90% e 100% do valor do mês.                                           |

**Custo estimado:** cerca de US$ 170 a 200 por mês em São Paulo. A VM é quase tudo; discos, NAT, snapshots e
Pub/Sub somam uns US$ 25. Outras regiões (como `us-east1`) saem uns 30% mais baratas. Confira na
[calculadora do Google](https://cloud.google.com/products/calculator).

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

Troque `SEU_PROJETO` pelo ID do projeto da Verax, o que aparece no seletor de projetos do console. Para seguir,
você precisa ser **Proprietário** (Owner) do projeto.

## Passo 2: o bucket do estado

O Terraform guarda o estado aqui. O versionamento deixa voltar a uma versão anterior se algo der errado.

```bash
gcloud storage buckets create gs://SEU_PROJETO-tfstate \
  --location=southamerica-east1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://SEU_PROJETO-tfstate --versioning
```

É o único recurso criado fora do Terraform: ele precisa existir antes de o Terraform começar.

## Passo 3: as variáveis

Dentro desta pasta (`infra/gcp`), copie o exemplo e preencha:

```bash
cp terraform.tfvars.example terraform.tfvars
```

Abra o `terraform.tfvars` e preencha pelo menos o `project_id`. Os outros campos são opcionais e estão
explicados no próprio arquivo e em `variables.tf`. Esse arquivo fica só na sua máquina: o `.gitignore` não deixa
ele entrar no repositório.

> **Orçamento:** para o alerta, preencha `billing_account_id` (em Faturamento, no console) e `monthly_budget`,
> na moeda da conta. É preciso ser administrador da conta de faturamento; se não for, deixe vazio.

## Passo 4: `terraform init`

```bash
terraform init -backend-config="bucket=SEU_PROJETO-tfstate"
```

O `init` baixa o provider da Google e o confere contra os hashes do arquivo `.terraform.lock.hcl`, que garante a
mesma versão em qualquer máquina. Depois, liga o Terraform ao bucket do estado. Termina com
`Terraform has been successfully initialized!`.

## Passo 5: `terraform plan` (só olha, não muda nada)

```bash
terraform plan -out=plano.tfplan
```

O que conferir no resultado:

1. A última linha deve ser parecida com **`Plan: 35 to add, 0 to change, 0 to destroy.`** São mais 1 com
   orçamento e mais 3 por pessoa em `operators`.
2. **`0 to change, 0 to destroy`** na primeira vez. Se aparecer alguma coisa para mudar ou destruir, pare: algo do
   projeto seria alterado. Me mande o trecho do plano.
3. Todos os nomes começam com `verax-node`.

O `-out=plano.tfplan` grava exatamente esse plano, para o `apply` fazer só isso.

## Passo 6: `terraform apply`

```bash
terraform apply plano.tfplan
```

Leva de 3 a 5 minutos. No fim, aparecem as saídas (_outputs_): o comando de SSH, a assinatura do Pub/Sub e os
nomes dos segredos. Para vê-las de novo depois, use `terraform output`.

Se der erro de API "não habilitada", espere 1 ou 2 minutos e rode o `plan` e o `apply` de novo: a GCP às vezes
demora para ligar uma API. O Terraform continua de onde parou.

## Passo 7: gravar os segredos

Os valores nunca passam pelo Terraform. No **Git Bash**, cole o valor quando ele pedir; nada aparece na tela nem
fica no histórico:

```bash
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-resend-api-key --data-file=- && unset VALOR
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-cloudflare-tunnel-token --data-file=- && unset VALOR
```

- **Chave do Resend:** no painel do Resend, em API Keys, crie uma com permissão só de envio ("Sending access").
- **Token do túnel:** no Cloudflare, em Zero Trust → Networks → Tunnels, crie um túnel chamado `verax-node` e copie
  o token do comando de instalação (o texto longo depois de `--token`).

Se ainda não tiver algum deles, deixe para depois: o nó só precisa deles na instalação do pacote.

## Passo 8: conferir que funcionou

**Entrar na VM** (o comando também está em `terraform output ssh_command`):

```bash
gcloud compute ssh verax-node --zone southamerica-east1-a --tunnel-through-iap
```

Lá dentro, confira o disco de dados montado e saia:

```bash
df -h /var/lib/verax    # deve mostrar uns 98 GB livres
exit
```

**Ver os logs chegando ao Pub/Sub.** Faça uma ação qualquer de administração, por exemplo pôr e tirar um rótulo
no bucket de backups, e leia a assinatura:

```bash
gcloud storage buckets update gs://SEU_PROJETO-verax-node-backups --update-labels=teste=1
gcloud storage buckets update gs://SEU_PROJETO-verax-node-backups --remove-labels=teste
gcloud pubsub subscriptions pull verax-node-security-logs --limit=3
```

Deve aparecer pelo menos uma mensagem com `cloudaudit.googleapis.com`. O `pull` sem `--auto-ack` não consome a
mensagem: ela volta para a fila e o nó vai lê-la depois.

## Mudar ou desfazer

- **Mudar algo** (tamanho do disco, quem tem acesso): edite o `terraform.tfvars` e repita os passos 5 e 6. O
  `plan` mostra só a diferença.
- **Desfazer tudo:** existe atrito de propósito, para nada sumir por engano.
  1. A VM tem proteção contra exclusão: em `node.tf`, troque `deletion_protection = true` por `false` e faça o
     `apply`.
  2. O disco de dados tem `prevent_destroy`: remova esse bloco `lifecycle` em `node.tf`.
  3. O bucket de backups só é apagado vazio.
  4. Depois disso, `terraform destroy` mostra o que vai apagar e pede confirmação. As APIs continuam ligadas e o
     bucket do estado fica.

## Escolhas de segurança desta base

- **Sem IP público e sem porta aberta.** SSH só pelo IAP, com a conta Google. O painel e a API vão chegar ao nó
  pelo túnel do Cloudflare, que é uma conexão de saída.
- **Sem chave de conta de serviço.** A VM usa a própria identidade, e nenhuma chave JSON é criada.
- **Mínimo de permissão.** A VM lê só a assinatura e os seus dois segredos, cria e lê backups (sem apagar) e
  manda os próprios logs. A permissão de leitura da configuração do projeto, para a postura, vem na etapa da
  postura.
- **Logs só copiados.** O sink novo copia; nenhum log, sink ou retenção existente muda.
- **Criptografia do Google** em discos, tópico e bucket (AES-256). Chave própria (CMEK) fica como reforço futuro;
  ela não muda o risco principal, que é quem controla a VM. Os verificadores (checkov e Trivy) registram isso
  como exceção justificada.

## Próximos passos (comigo)

Com a base no ar, o próximo passo é o pacote do nó: instalar Wazuh, API, worker, banco e o túnel na VM.
Depois, no painel, você cadastra o projeto em Contas cloud, com a assinatura que aparece em
`terraform output pubsub_subscription`.
