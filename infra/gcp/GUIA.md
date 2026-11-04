# Guia: os nós do Verax Control na GCP com Terraform

Este guia sobe ou altera a infraestrutura dos nós na GCP. Há dois ambientes, cada um com o próprio estado:

- **`envs/verax`:** o SOC da própria Verax, no perfil `lean`. A primeira subida foi feita em 03/11/2026, quando o
  código ainda ficava direto em `infra/gcp`. Está no ar.
- **`envs/homolog-sp`:** o nó de homologação em São Paulo, no perfil `standard`, igual ao que um nó de cliente vai
  ter. Fica no projeto dos nós de clientes, separado do projeto da Verax. Ainda não foi aplicado.

Os dois chamam o mesmo módulo, `modules/node`. Na fase 3, cada cliente ganha um ambiente igual ao de homologação.

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
└── envs/homolog-sp/       nó de homologação em São Paulo (standard): APIs, orçamento e o módulo
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

O IP fixo existe porque a chave de leitura da AWS do cliente só funciona a partir dele: se ele mudasse, a coleta
pararia.

Todo nó criado pelo módulo, nos dois perfis, também tem:

- **swap cifrado** de 2 GB, com chave aleatória nova a cada boot (script de boot do módulo);
- **Pub/Sub só na região** do nó (`message_storage_policy`);
- os cofres que a própria VM grava: **`credentials-key`** (a chave do cofre de credenciais; a VM grava e lê, e a
  permissão vale só nesse cofre) e **`admin-bootstrap`** (a senha temporária do primeiro admin; a VM grava e não lê);
- o **alerta de fila parada**: uma assinatura com mensagem sem leitura há mais de 24 h (`stalled_subscription_hours`)
  abre um incidente no Cloud Monitoring e manda e-mail para `alert_email`, se preenchido.

O `envs/verax/main.tf` desliga esses quatro só para o nó da Verax, que já está no ar, não mudar nada neste PR (veja
"O nó da Verax ainda usa o script antigo"). Os três últimos são só um `true` no `main.tf` quando você quiser.

## O nó da Verax: o que tem

O nó da Verax monitora só a GCP e o Cloudflare. Para isso não precisa do Wazuh, que pede 8 GB de memória. O worker
lê os logs direto do Pub/Sub e aplica as próprias regras de detecção. Tudo cabe numa **e2-micro**, que é gratuita em
us-east1.

| Recurso                                     | Para quê                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Rede `verax-node-vpc`, sub-rede, Cloud NAT  | Rede própria. A VM não tem IP público: sai para a internet pelo NAT e ninguém entra. |
| 2 regras de firewall                        | SSH só pelo IAP do Google; todo o resto que chega é recusado e registrado.           |
| VM `verax-node` (e2-micro, 1 GB, Debian 12) | Onde rodam API, worker, banco e o túnel do Cloudflare. Tem 2 GB de memória de troca. |
| Disco `verax-node` (30 GB padrão)           | Sistema e dados. Fica se a VM for apagada. Snapshot semanal guardado por 4 semanas.  |
| Conta de serviço `verax-node`               | Identidade da VM, sem chave JSON. Só lê os logs e os segredos do nó.                 |
| Sink em cada projeto monitorado             | Copia os logs de auditoria e os bloqueios do Cloud Armor para o tópico do nó.        |
| Tópico e assinatura por projeto monitorado  | Fila dos logs. Guarda as mensagens por 7 dias se o nó parar.                         |
| 2 segredos no Secret Manager (vazios)       | Senha do e-mail (Zoho) e token do túnel do Cloudflare. Gravados no passo 7.          |
| Registro de imagens `verax-control`         | Imagens da API e das migrations, publicadas pelo GitHub Actions sem chave.           |
| Bucket `<projeto>-verax-node-backups`       | Backups do banco. Privado e versionado; a VM cria e lê, mas não apaga.               |
| Orçamento (opcional)                        | E-mail em 50%, 90% e 100% do valor do mês.                                           |

**Custo estimado:** de R$ 5 a 15 por mês, mais o IP do Cloud NAT (cerca de R$ 20 por mês, a conferir na fatura). A
e2-micro, os 30 GB de disco padrão, o Pub/Sub, os segredos e 5 GB do bucket ficam no nível gratuito da GCP em
us-east1, que vale para uma e2-micro por conta de faturamento. Sobram o Cloud NAT e centavos de snapshot.

## O nó de homologação: o que muda

Os mesmos recursos do nó, com o prefixo `verax-homolog`, no perfil `standard` e com o que a seção "Os perfis" lista
para todo nó criado pelo módulo, mais:

- o **IP de saída reservado** (`verax-homolog-nat-ip`), com o NAT em modo manual. Ele aparece em
  `terraform output nat_ip` e vai no `node.conf` como `NODE_EGRESS_IPS=<ip>/32`;
- a **leitura do registro de imagens** do projeto da Verax, só para a conta da VM de homologação.

Não há registro de imagens nem publicação no projeto dos nós: a VM baixa as mesmas imagens do registro da Verax.

Fora do projeto dos nós de clientes, este ambiente cria só três coisas: essa leitura no registro da Verax; em cada
projeto de `monitored_projects`, um sink que só copia (`verax-homolog-security`, com a própria identidade de escrita,
criada pela GCP); e, com `billing_account_id` preenchido, o orçamento na conta de faturamento. Liste em
`monitored_projects` só projetos de teste.

**Custo estimado:** cerca de R$ 613 por mês ligada o mês todo (VM, 60 GB de disco, snapshots, NAT, IP e o resto).
Parada, cerca de R$ 70 (disco e IP). Ligue só nas janelas de teste:

```bash
gcloud compute instances stop verax-homolog --zone southamerica-east1-b --project PROJETO_DOS_NOS
gcloud compute instances start verax-homolog --zone southamerica-east1-b --project PROJETO_DOS_NOS
```

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

É o único recurso criado fora do Terraform: ele precisa existir antes de o Terraform começar.

## Passo 3: as variáveis

Dentro da pasta do ambiente, copie o exemplo e preencha:

```bash
cd infra/gcp/envs/verax        # ou infra/gcp/envs/homolog-sp
cp terraform.tfvars.example terraform.tfvars
```

- **`envs/verax`:** `project_id` e `monitored_projects`, os mesmos da primeira subida. Se você já tinha o
  `infra/gcp/terraform.tfvars`, mova o arquivo para `infra/gcp/envs/verax/terraform.tfvars`, sem mudar nada nele.
- **`envs/homolog-sp`:** `project_id` (projeto dos nós de clientes) e `images_project_id` (projeto da Verax, onde
  está o registro das imagens). O resto tem padrão e está explicado no arquivo e em `variables.tf`.

O `terraform.tfvars` fica só na sua máquina: o `.gitignore` não deixa ele entrar no repositório.

> **Orçamento:** para o alerta, preencha `billing_account_id` (em Faturamento, no console) e `monthly_budget`,
> na moeda da conta. É preciso ser administrador da conta de faturamento; se não for, deixe vazio.

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

**No nó da Verax, o primeiro `plan` depois da mudança de pasta** tem de terminar com:

```
Plan: 0 to add, 0 to change, 0 to destroy.
```

e mostrar 30 linhas `has moved to`, uma por recurso que passou para o módulo (por exemplo,
`# google_compute_instance.node has moved to module.node.google_compute_instance.node`). Os blocos `moved` de
`envs/verax/main.tf` dizem ao Terraform que só o endereço mudou. Confira:

1. **Nenhum `must be replaced`, `forces replacement` ou `will be destroyed`.** Se aparecer, pare: um bloco `moved`
   ou um valor do perfil `lean` está errado, e o `apply` tentaria recriar algo. A VM tem proteção contra exclusão e
   o disco tem `prevent_destroy`, mas não conte com isso para os outros recursos. A proteção da VM nem impede tudo:
   ela só é conferida na hora de apagar a VM, e antes disso o `apply` já apagou os acessos dos operadores nela (veja
   "Mudar ou desfazer"). Foi conferido com um `plan` só de leitura contra o estado real em 04/11/2026: 47 recursos,
   nenhuma mudança, 30 movidos.
2. **Nenhum `will be updated in-place`** no nó da Verax. Uma mudança no lugar não derruba nada, mas este PR não
   pretende mudar nada nele.
3. Se o seu `terraform.tfvars` não for o mesmo da primeira subida, o `plan` mostra a diferença: compare antes de
   seguir.

O `apply` desse plano só grava os endereços novos no estado; nada muda na GCP. Depois dele, o `plan` seguinte mostra
`No changes.`, e os blocos `moved` podem ficar (não atrapalham) ou sair.

**Na homologação, numa subida do zero,** a última linha é **`Plan: 39 to add, 0 to change, 0 to destroy.`**, sem
orçamento e sem e-mail de alerta (41 com os dois), mais 5 por projeto monitorado e 4 por pessoa em `operators` (mais
1 papel na primeira). Todos os nomes começam com `verax-homolog`, menos a permissão de leitura no registro de imagens
do projeto da Verax.

## Passo 6: `terraform apply`

```bash
terraform apply plano.tfplan
```

Leva de 3 a 5 minutos numa subida do zero. No fim, aparecem as saídas (_outputs_): o comando de SSH, a assinatura do
Pub/Sub, os nomes dos segredos e, na homologação, o `nat_ip`. Para vê-las de novo depois, use `terraform output`.

**Se der erro de API "has not been used in project ... or it is disabled":** o Terraform acabou de ligar a API e
a GCP ainda não propagou. Espere 1 ou 2 minutos e rode o `plan` e o `apply` de novo. O Terraform continua de onde
parou; o novo `plan` mostra só o que faltou. Foi o que aconteceu na primeira subida.

## Passo 7: gravar os segredos

Os valores nunca passam pelo Terraform. No **Git Bash**, cole o valor quando ele pedir; nada aparece na tela nem
fica no histórico (troque o prefixo `verax-node` por `verax-homolog` e acrescente `--project PROJETO_DOS_NOS` na
homologação):

```bash
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-smtp-password --data-file=- && unset VALOR
read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-cloudflare-tunnel-token --data-file=- && unset VALOR
```

- **Senha do e-mail (opcional):** o nó funciona sem e-mail, porque as contas nascem com senha temporária. Só com
  `MAIL_TRANSPORT=smtp` grave aqui a senha de aplicativo da caixa `nao-responda@` no Zoho (Minha conta → Segurança →
  Senhas específicas de aplicativo); a redefinição de senha pelo link sai por ela.
- **Token do túnel:** no Cloudflare, em Zero Trust → Networks → Tunnels, crie um túnel com o nome do nó e copie
  o token do comando de instalação (o texto longo depois de `--token`).

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
a mensagem: ela volta para a fila e o nó vai lê-la depois.

**Pub/Sub só na região** (homologação, com um projeto monitorado):

```bash
gcloud pubsub topics describe verax-homolog-security-PROJETO_MONITORADO --project PROJETO_DOS_NOS \
  --format='value(messageStoragePolicy.allowedPersistenceRegions)'   # southamerica-east1
```

**Testar o alerta de fila parada:** com a VM parada e um projeto monitorado, use `stalled_subscription_hours = 1` no
`terraform.tfvars`, faça o `apply`, gere um log (o `sinks update` acima) e espere pouco mais de 1 hora: o incidente
abre no Cloud Monitoring (Alertas) e o e-mail chega. Depois, volte para 24 e faça o `apply` de novo.

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

5. A VM nova gerou chaves de SSH (do servidor) novas. O `gcloud compute ssh` confere a chave sozinho, mas o
   `deploy.sh` guarda a da VM antiga em `~/.ssh/known_hosts_verax-node` e recusaria a próxima conexão com
   `REMOTE HOST IDENTIFICATION HAS CHANGED`. Apague a chave antiga; o próximo `deploy.sh` registra a nova, como na
   primeira vez. Se quiser conferir antes, as chaves que a VM nova publicou estão em
   `gcloud compute instances get-guest-attributes verax-node --zone us-east1-b --query-path=hostkeys/`.

   ```bash
   ssh-keygen -R verax-node -f ~/.ssh/known_hosts_verax-node
   ```

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
     `modules/node/network.tf` só na sua cópia, para essa vez.
  3. O bucket de backups só é apagado vazio.
  4. Depois disso, `terraform destroy` mostra o que vai apagar e pede confirmação. As APIs continuam ligadas e o
     bucket do estado fica.

## Escolhas de segurança desta base

- **Sem IP público e sem porta aberta.** SSH só pelo IAP, com a conta Google. O painel e a API chegam ao nó pelo
  túnel do Cloudflare, que é uma conexão de saída.
- **Sem chave de conta de serviço.** A VM usa a própria identidade, e nenhuma chave JSON é criada.
- **Mínimo de permissão.** A VM lê só a assinatura e os seus dois segredos, cria e lê backups (sem apagar) e
  manda os próprios logs. Nos cofres que são dela, grava versões; ler, só a chave do cofre de credenciais. A
  permissão de leitura da configuração dos projetos, para a postura, vem na etapa da postura.
- **Logs só copiados.** Os sinks novos copiam; nenhum log, sink ou retenção existente muda.
- **Swap cifrado nos nós novos.** O que vai da memória para o disco (a chave do cofre, a chave da AWS, a memória do
  worker e do manager) chega ao disco e ao snapshot só cifrado, com uma chave que some a cada boot.
- **Criptografia do Google** no disco, no tópico e no bucket (AES-256). Chave própria (CMEK) fica como reforço
  futuro; ela não muda o risco principal, que é quem controla a VM. Os verificadores (checkov e Trivy) registram
  isso como exceção justificada.

## Próximos passos

Com a base no ar, o próximo passo é o pacote do nó (`infra/node/`): instalar a API, o banco e o túnel na VM. O
roteiro está em `docs/runbooks/no-verax.md`; no `node.conf`, `NODE_PROFILE` é o perfil do ambiente (`lean` no nó da
Verax, `standard` na homologação). Cada projeto monitorado entra em Contas cloud com a assinatura que aparece em
`terraform output pubsub_subscriptions`.
