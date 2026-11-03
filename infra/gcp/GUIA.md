# Guia: a base do nó da Verax na GCP com Terraform

Este guia sobe ou altera a infraestrutura do SOC da própria Verax na GCP. A primeira subida foi feita em
03/11/2026; repita os passos para mudar algo ou para subir de novo noutro projeto.

## Antes de começar: 4 ideias do Terraform

- **Código descreve o que deve existir.** Os arquivos `.tf` desta pasta dizem quais recursos o projeto precisa
  ter (rede, VM, tópico...). O Terraform compara isso com o que existe e faz só a diferença.
- **Provider** é o "tradutor" para uma nuvem. Aqui é o `hashicorp/google`, na versão fixa 8.9.0 (`versions.tf`).
- **Estado** (_state_) é a memória do Terraform: a lista do que ele criou. Fica num bucket do Cloud Storage
  (passo 2), não no seu computador.
- **`plan` antes de `apply`.** O `plan` mostra o que vai acontecer, sem mudar nada. O `apply` executa. Leia
  sempre o `plan`.

## O desenho: um nó enxuto

O nó da Verax monitora só a GCP e o Cloudflare. Para isso não precisa do Wazuh, que pede 16 GB de memória e
custaria uns R$ 1.000 por mês. A API do Verax Control lê os logs direto do Pub/Sub e aplica as próprias regras de
detecção. Tudo cabe numa **e2-micro**, que é gratuita em us-east1.

| Recurso                                     | Para quê                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Rede `verax-node-vpc`, sub-rede, Cloud NAT  | Rede própria. A VM não tem IP público: sai para a internet pelo NAT e ninguém entra. |
| 2 regras de firewall                        | SSH só pelo IAP do Google; todo o resto que chega é recusado e registrado.           |
| VM `verax-node` (e2-micro, 1 GB, Debian 12) | Onde vão rodar API, banco e o túnel do Cloudflare. Tem 2 GB de memória de troca.     |
| Disco `verax-node` (30 GB padrão)           | Sistema e dados. Fica se a VM for apagada. Snapshot semanal guardado por 4 semanas.  |
| Conta de serviço `verax-node`               | Identidade da VM, sem chave JSON. Só lê os logs e os segredos do nó.                 |
| Sink em cada projeto monitorado             | Copia os logs de auditoria e os bloqueios do Cloud Armor para o tópico do nó.        |
| Tópico e assinatura por projeto monitorado  | Fila dos logs. Guarda as mensagens por 7 dias se o nó parar.                         |
| 2 segredos no Secret Manager (vazios)       | Senha do e-mail (Zoho) e token do túnel do Cloudflare. Gravados no passo 7.          |
| Registro de imagens `verax-control`         | Imagens da API e das migrations, publicadas pelo GitHub Actions sem chave.           |
| Bucket `<projeto>-verax-node-backups`       | Backups do banco. Privado e versionado; a VM cria e lê, mas não apaga.               |
| Orçamento (opcional)                        | E-mail em 50%, 90% e 100% do valor do mês.                                           |

**Custo estimado:** de R$ 5 a 15 por mês. A e2-micro, os 30 GB de disco padrão, o Pub/Sub, os segredos e 5 GB do
bucket ficam no nível gratuito da GCP em us-east1, que vale para uma e2-micro por conta de faturamento. Sobram o
Cloud NAT (uns R$ 6) e centavos de snapshot.

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

Troque `SEU_PROJETO` pelo ID do projeto onde o nó fica. Para seguir, você precisa ser **Proprietário** (Owner)
desse projeto e dos projetos monitorados. O projeto do nó precisa ter faturamento ligado, mesmo no nível gratuito.

> **Limite de projetos por conta de faturamento.** Uma conta nova liga até 5 projetos. Se der
> `Cloud billing quota exceeded` ao ligar o faturamento, use um projeto que já tenha faturamento ou peça
> aumento de cota ao Google.

## Passo 2: o bucket do estado

O Terraform guarda o estado aqui. O versionamento deixa voltar a uma versão anterior se algo der errado.

```bash
gcloud storage buckets create gs://SEU_PROJETO-tfstate \
  --location=us-east1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://SEU_PROJETO-tfstate --versioning
```

É o único recurso criado fora do Terraform: ele precisa existir antes de o Terraform começar.

## Passo 3: as variáveis

Dentro desta pasta (`infra/gcp`), copie o exemplo e preencha:

```bash
cp terraform.tfvars.example terraform.tfvars
```

Preencha `project_id` (onde o nó fica) e `monitored_projects` (os projetos cujos logs vão para o nó, que podem
incluir o próprio). Os outros campos são opcionais e estão explicados no arquivo e em `variables.tf`. O
`terraform.tfvars` fica só na sua máquina: o `.gitignore` não deixa ele entrar no repositório.

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

1. Numa subida do zero, a última linha é parecida com **`Plan: 38 to add, 0 to change, 0 to destroy.`**: 34
   recursos com o orçamento, mais 2 (sink e permissão dele) por projeto monitorado e mais 3 por pessoa em
   `operators`. Sem orçamento, 1 a menos.
2. **`0 to change, 0 to destroy`** na primeira vez. Se aparecer alguma coisa para mudar ou destruir, pare: algo do
   projeto seria alterado.
3. Todos os nomes começam com `verax-node`.

O `-out=plano.tfplan` grava exatamente esse plano, para o `apply` fazer só isso.

## Passo 6: `terraform apply`

```bash
terraform apply plano.tfplan
```

Leva de 3 a 5 minutos. No fim, aparecem as saídas (_outputs_): o comando de SSH, a assinatura do Pub/Sub e os
nomes dos segredos. Para vê-las de novo depois, use `terraform output`.

**Se der erro de API "has not been used in project ... or it is disabled":** o Terraform acabou de ligar a API e
a GCP ainda não propagou. Espere 1 ou 2 minutos e rode o `plan` e o `apply` de novo. O Terraform continua de onde
parou; o novo `plan` mostra só o que faltou. Foi o que aconteceu na primeira subida.

## Passo 7: gravar os segredos

Os valores nunca passam pelo Terraform. No **Git Bash**, cole o valor quando ele pedir; nada aparece na tela nem
fica no histórico:

```bash
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-smtp-password --data-file=- && unset VALOR
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-cloudflare-tunnel-token --data-file=- && unset VALOR
```

- **Senha do e-mail:** a senha de aplicativo da caixa `nao-responda@` no Zoho (Minha conta → Segurança → Senhas
  específicas de aplicativo). Os convites e as redefinições de senha saem por ela.
- **Token do túnel:** no Cloudflare, em Zero Trust → Networks → Tunnels, crie um túnel chamado `verax-node` e copie
  o token do comando de instalação (o texto longo depois de `--token`).

Se ainda não tiver algum deles, deixe para depois: o nó só precisa deles na instalação do pacote.

## Passo 8: conferir que funcionou

**Entrar na VM** (o comando também está em `terraform output ssh_command`):

```bash
gcloud compute ssh verax-node --zone us-east1-b --tunnel-through-iap
```

Lá dentro, confira o disco, a memória de troca e a saída para a internet, e saia:

```bash
df -h /                         # 30 GB
cat /proc/swaps                 # /swapfile com 2 GB
curl -sI https://deb.debian.org/ | head -1    # HTTP 200: a saída pelo NAT funciona
exit
```

**Ver os logs chegando ao Pub/Sub.** Uma ação de administração num projeto monitorado gera um log de auditoria.
Uma forma inofensiva é "atualizar" o próprio sink com a mesma descrição, e ler a assinatura um minuto depois:

```bash
gcloud logging sinks update verax-node-security --project PROJETO_MONITORADO \
  --description="Eventos de segurança para o nó do Verax Control (só cópia; os logs originais não mudam)."
gcloud pubsub subscriptions pull verax-node-security-PROJETO_MONITORADO --limit=3
```

Deve aparecer uma mensagem com `cloudaudit.googleapis.com` e `UpdateSink`. O `pull` sem `--auto-ack` não consome
a mensagem: ela volta para a fila e o nó vai lê-la depois.

## Mudar ou desfazer

- **Mudar algo** (incluir um projeto monitorado, dar acesso a alguém): edite o `terraform.tfvars` e repita os
  passos 5 e 6. O `plan` mostra só a diferença.
- **Aumentar o disco:** mude `disk_gb` e repita os passos 5 e 6. A GCP aumenta o disco com a VM ligada; reinicie a
  VM (`sudo reboot` dentro dela) e o serviço `google-disk-expand` da imagem do Debian estende a partição e o sistema
  de arquivos no boot. Confira com `df -h /`. Disco não diminui: para menos espaço, só criando outro.
- **Desfazer tudo:** existe atrito de propósito, para nada sumir por engano.
  1. A VM tem proteção contra exclusão: em `node.tf`, troque `deletion_protection = true` por `false` e faça o
     `apply`.
  2. O disco tem `prevent_destroy`: remova esse bloco `lifecycle` em `node.tf`.
  3. O bucket de backups só é apagado vazio.
  4. Depois disso, `terraform destroy` mostra o que vai apagar e pede confirmação. As APIs continuam ligadas e o
     bucket do estado fica.

## Escolhas de segurança desta base

- **Sem IP público e sem porta aberta.** SSH só pelo IAP, com a conta Google. O painel e a API vão chegar ao nó
  pelo túnel do Cloudflare, que é uma conexão de saída.
- **Sem chave de conta de serviço.** A VM usa a própria identidade, e nenhuma chave JSON é criada.
- **Mínimo de permissão.** A VM lê só a assinatura e os seus dois segredos, cria e lê backups (sem apagar) e
  manda os próprios logs. A permissão de leitura da configuração dos projetos, para a postura, vem na etapa da
  postura.
- **Logs só copiados.** Os sinks novos copiam; nenhum log, sink ou retenção existente muda.
- **Criptografia do Google** no disco, no tópico e no bucket (AES-256). Chave própria (CMEK) fica como reforço
  futuro; ela não muda o risco principal, que é quem controla a VM. Os verificadores (checkov e Trivy) registram
  isso como exceção justificada.

## Próximos passos

Com a base no ar, o próximo passo é o pacote do nó (`infra/node/`): instalar a API, o banco e o túnel na VM. O
roteiro está em `docs/runbooks/no-verax.md`. Cada projeto monitorado entra em Contas cloud com a assinatura que
aparece em `terraform output pubsub_subscriptions`.
