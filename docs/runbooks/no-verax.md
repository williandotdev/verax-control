# Nó da Verax (SOC na GCP): instalação e operação

O SOC da própria Verax roda numa VM e2-micro da GCP (`infra/gcp/envs/verax/`, perfil `lean`), sem Wazuh. O painel
fica em `verax.control.veraxsistemas.com.br` (Firebase Hosting, `docs/runbooks/painel.md`) e fala com a API em
`api-verax.veraxsistemas.com.br`, que chega à VM pelo túnel do Cloudflare. Nos comandos abaixo, `PROJETO_DO_NO` é o
projeto da GCP onde está a VM, e `PROJETO_MONITORADO` é cada projeto vigiado. Os valores reais ficam fora do
repositório.

## O que roda na VM

`infra/node/compose.yaml`, ligado pelo serviço `verax-node` do systemd:

| Contêiner                 | Para quê                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `postgres`                | Banco, só pela rede interna e só por TLS (CA própria do nó, gerada na instalação).                   |
| `db-bootstrap`, `migrate` | Papéis do banco com permissão mínima e migrations, a cada partida (a mesma sequência testada no CI). |
| `api`                     | API do painel. Sem porta aberta: o túnel chega até ela.                                              |
| `worker`                  | Lê a auditoria da GCP das assinaturas do Pub/Sub e transforma o que é suspeito em achados.           |
| `cloudflared`             | Túnel do Cloudflare: conexão de saída da VM até o Cloudflare.                                        |

Todos rodam com a raiz só leitura, sem capabilities e com limite de memória. Só o worker alcança o servidor de
metadados da GCP, que entrega o token da VM: uma regra no `DOCKER-USER`, aplicada antes de o Docker subir
(`verax-metadata-guard`, que o Docker exige) e reafirmada a cada partida, bloqueia os outros contêineres. A guarda não
aceita `systemctl stop` nem `restart` (como o Docker a exige, levaria o Docker e o nó junto): para reaplicar as regras,
`sudo systemctl restart verax-node`. Se o script dela falhar no boot, o Docker não sobe e nenhum contêiner fica no ar
sem a guarda; é de propósito, e `systemctl status verax-metadata-guard` mostra o motivo. O backup do banco sai todo dia
para o bucket de backups (`verax-backup.timer`).

## Antes de instalar (uma vez)

1. **Infraestrutura.** Aplique o Terraform de `infra/gcp/envs/verax/` (guia em `infra/gcp/GUIA.md`). Ele cria uma
   assinatura do Pub/Sub por projeto monitorado, os cofres dos segredos e o registro das imagens.
2. **Túnel do Cloudflare.**
   - Em Zero Trust → Networks → Tunnels, crie um túnel `verax-node` do tipo Cloudflared.
   - Na tela de instalação, copie só o token, o texto longo depois de `--token`.
   - Em Public Hostnames, crie `api-verax.veraxsistemas.com.br` com o serviço `HTTP` e a URL `api:3000`.
   - Grave o token no cofre:

     ```bash
     read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-cloudflare-tunnel-token \
       --project PROJETO_DO_NO --data-file=- && unset VALOR
     ```

3. **Imagens.** O workflow `Imagens do nó` publica a API e as migrations a cada merge na `main` que mexa na API. Ele
   usa o environment `imagens` do GitHub, que só aceita a `main`, com três variáveis:
   - `IMAGES_REPOSITORY` e `GCP_IMAGES_SA`: valores em `terraform output images_repository` e `images_publisher`;
   - `GCP_WIF_PROVIDER`: o mesmo provedor do Painel.

   A versão de cada publicação é o commit, que aparece no resumo da execução. Depois, outro job do mesmo workflow
   copia as duas imagens, com o mesmo digest, para o registro público do GitHub (GHCR), para os nós na nuvem do
   cliente (`docs/runbooks/versao-no.md`). O nó da Verax não usa essa cópia, e uma falha nela não afeta o Artifact
   Registry nem o `deploy.sh`.

O nó não precisa de e-mail (`MAIL_TRANSPORT=none` no `node.conf`): toda conta nasce com uma senha temporária,
entregue a quem a criou. Para ligar também a redefinição de senha pelo link, use `MAIL_TRANSPORT=smtp` com os dados
da caixa de envio e grave a senha dela no cofre `verax-node-smtp-password`.

Com `MAIL_TRANSPORT=smtp`, o worker também envia os avisos por e-mail (PR-16): incidente alto ou crítico aberto,
incidente que sobe para alto ou crítico e achado crítico fora de incidente, para os administradores e analistas do
cliente (ativos, com MFA e sem troca de senha pendente); e 80% e 100% do volume mensal do plano, só para os
administradores (o plano `interno` não tem limite e não avisa). O `start.sh` escreve no `worker.env` o mesmo bloco de
e-mail da API e o `WEB_ORIGIN` (o link do aviso); sem o SMTP, o `worker.env` fica como antes, e os avisos ficam na
fila como `skipped` (ligar o e-mail depois não dispara os antigos). O e-mail não leva IP, usuário, chave, recurso nem
conta: só o tipo, a severidade e o link do painel.

Nos nós de clientes criados pelo plano de controle, ninguém edita o `node.conf`: o e-mail vem da caixa comum aos nós
(`SMTP_*_NODES` e o segredo `cp-nodes-smtp-password` do plano de controle), que a instalação sem operador escreve no
`node.conf` e cuja senha o plano de controle grava no `vx-<slug>-smtp-password` (`infra/gcp/GUIA.md`, "O provisionamento
(CP-07)", item 3; a troca da senha em `docs/runbooks/provisionamento.md`).

Cada pessoa escolhe, em Minha conta (no cabeçalho do painel), se recebe os avisos de incidente por e-mail; a lista de
Usuários mostra a escolha na coluna "Recebe alertas", só para ler (PR-17'). Os avisos do volume do plano não dependem
dela. Cada pessoa recebe até 5 e-mails avulsos por hora: do 6º aviso da hora em diante, eles chegam num resumo só,
quando a hora fecha (até 10 itens e "e mais N"). Aviso com mais de 24 horas na fila (o worker parado, o e-mail
falhando) não sai sozinho: vem no resumo de retomada.

O plano do nó também fica no `node.conf`: o da Verax é `PLAN=interno`, sem limite. A instalação recusa um `node.conf`
sem `PLAN`, e a API e o worker não sobem sem ele. Um `node.conf` de antes do plano precisa ganhar a linha
`PLAN=interno` antes do próximo deploy. O bootstrap grava o rótulo do plano no cadastro do cliente do nó.

O perfil do nó (`NODE_PROFILE`) define a memória do banco, da API e do worker. O da Verax é `lean`, com os mesmos
limites de antes; sem a linha no `node.conf`, vale `lean`, então o `node.conf` atual não precisa mudar.

No perfil `standard` (homologação e nós de clientes), o mesmo pacote sobe também o Wazuh (manager e indexer, sem
dashboard), num serviço próprio, o `verax-wazuh`, depois do `verax-node`: o `deploy.sh` leva junto a configuração de
`infra/wazuh`, o `install.sh` gera as cinco senhas dele em `/var/lib/verax/secrets` (num nó de antes do PR-V6, a quinta,
`wazuh-api-stats`, nasce no próximo deploy; sem ela, o `start.sh` para e aponta o `install.sh`), e o serviço espera o Wazuh ficar
saudável (alguns minutos, mais na primeira vez, que baixa as imagens); uma falha dele não derruba a aplicação nem o
backup. O que roda, como conferir e como ler os alertas estão em `infra/wazuh/README.md`, seção "Nó de cliente". Nesse
perfil, use `SYNC_SOURCES=gcp,wazuh` no `node.conf`. O nó da Verax (`lean`) não recebe nada disso.

O prefixo dos cofres (`VERAX_SECRET_PREFIX`) é o `name_prefix` do ambiente do Terraform (`verax-node` no nó da Verax,
`verax-homolog` na homologação). Essa igualdade é uma premissa operacional, não algo que o nó confira: o `start.sh`
monta com ela, para a API, o tópico do sink de um projeto de cliente que o painel mostra
(`projects/<VERAX_GCP_PROJECT>/topics/<prefixo>-security-`), e o teste de contrato da API prende o painel ao
Terraform, não ao `node.conf` instalado. Com outro prefixo, o `start.sh` já não acharia os cofres, e o painel
mostraria um tópico que não existe. A instalação recusa o projeto e o prefixo fora do formato do módulo; se o
`node.conf` for editado depois e sair dele, a API sobe sem o tópico e o painel mostra o comando com o tópico a
preencher.

O cofre de credenciais (`CREDENTIALS_VAULT`, para o token do Cloudflare colado no painel) fica
desligado no nó da Verax: sem a linha no `node.conf`, vale `false`, nada é lido do Secret Manager e a API e o worker
sobem como antes. Ligar pede, nesta ordem: o segredo `verax-node-credentials-key` (`credentials_vault = true` em
`infra/gcp/envs/verax/main.tf` e um `apply`), `CREDENTIALS_VAULT=true` no `node.conf` e um deploy. Na instalação, o
`install.sh` gera a chave na VM e a grava direto no segredo; a cada partida, o `start.sh` entrega a chave pública à API
e as privadas ao worker, num arquivo em memória (`/run/verax/vault/worker-keys`, numa pasta montada só leitura nele),
nunca por variável de ambiente (o Docker grava o ambiente dos contêineres no disco). A parada (`start.sh down`) apaga
a pasta.

### Coleta do Cloudflare (auditoria da conta e eventos de segurança)

O coletor da auditoria do Cloudflare roda no worker e lê o token guardado no cofre, então pede o cofre ligado (acima).
Para ligar, acrescente `cloudflare` às fontes do `node.conf` (`SYNC_SOURCES=gcp,cloudflare` no nó da Verax,
`SYNC_SOURCES=gcp,wazuh,cloudflare` num nó de cliente) e faça um deploy. Com a fonte e sem o cofre, o worker não sobe
(a mensagem cita `SYNC_SOURCES`). Depois, em Contas cloud, cadastre a conta do Cloudflare e cole o token pelo link
do painel (só leitura; filtro de IP do token com o IP de saída do nó).

- **Conferir:** no journal, a tarefa `cloudflare` conclui a cada minuto com `report` (`accounts`, `pages`, `read`,
  `created`, `blocked`...); a conta fica "Conectada" na primeira leitura bem-sucedida, mesmo sem evento, e a "Última
  coleta" anda a cada 5 minutos (o padrão de `CLOUDFLARE_AUDIT_INTERVAL_SECONDS`, aceito de 60 a 3600 no worker; o
  `start.sh` não escreve essa variável, então no nó vale o padrão).
- **Coleta parada por causa do token** (`credential_rejected`, `credential_forbidden`, `credential_expired`,
  `credential_disabled` no cartão): o worker não chama mais o Cloudflare com aquele token. Nada a fazer no nó: o
  admin do cliente cola outro token (ou o mesmo, depois de corrigir permissão, filtro de IP ou validade no Cloudflare),
  e a coleta volta na volta seguinte do worker.
- **`credential_unreadable`:** o worker não abriu o token guardado (versão da chave desativada antes da recifragem,
  por exemplo). Reative a versão (seção abaixo) ou peça para colarem o token de novo.
- **`rate_limited`:** o Cloudflare limitou o token (1200 requisições a cada 5 minutos, somando tudo que usa o mesmo
  token); o coletor espera o `retry-after`. Se repetir, confira se o mesmo token não está em uso em outro lugar.
- **Eventos de segurança (GraphQL, PR-13):** rodam na mesma tarefa, sem configuração a mais. No `report`,
  `securityWindows` (janelas de 15 min lidas), `securityQueries` (consultas GraphQL; o coletor gasta no máximo 250 a
  cada 5 min por token, e `budgetWaits` conta as vezes que parou nesse limite) e `securitySkippedZones`. No cartão,
  `security_events_forbidden` (o token sem `Analytics: Read`), `security_events_not_entitled` (nenhuma zona com os
  eventos no plano) e `zones_forbidden` (sem `Zone: Read`) não param a auditoria, e o fluxo confere de novo a cada
  hora. Nada a fazer no nó: o admin do cliente ajusta o token no Cloudflare (o link do painel já marca as três
  permissões) e cola de novo, se preciso.

### Chave do cofre: trocar, reativar ou gravar de novo

Cada versão do segredo `<prefixo>-credentials-key` é uma versão da chave; o `start.sh` lê todas as ativas e cifra
com a mais alta. O `install.sh` só gera chave quando o segredo nunca teve versão (a versão 1 decide); depois disso,
toda mudança é uma versão feita de propósito.

**Trocar a chave.** Na VM, porque a chave nasce lá e vai direto para o Secret Manager (a identidade da VM só
acrescenta versões a esse segredo):

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 | gcloud secrets versions add PREFIXO-credentials-key --data-file=-
sudo systemctl restart verax-node
```

O log do worker mostra `vaultKeyVersion` com a versão nova, e a tarefa `credential-rekey` (na partida e uma vez por
dia) recifra as linhas antigas. Só depois disso, do seu computador, desative a antiga (desativar, não destruir:
destruir é o passo da saída do cliente):

```bash
gcloud secrets versions disable N --secret PREFIXO-credentials-key --project PROJETO
```

**A partida para numa versão que não é chave** (RSA de 3072 a 4096 bits em PEM): a mensagem diz qual; desative-a e
reinicie. O `start.sh` confere todas as versões ativas, porque o worker recusaria qualquer uma e cairia em laço.

**Nenhuma versão ativa** (o nó sobe sem o cofre, com aviso): o aviso diz qual é o caso, porque o Secret Manager
informa o estado de cada versão. Se há versão desativada, reative a mais recente delas (`gcloud secrets versions
enable N ...`, com o `N` do aviso) e reinicie; se todas foram destruídas, grave uma chave nova como na troca (o que
estava cifrado com as destruídas se perdeu: os admins colam as credenciais de novo). Só um segredo recriado, sem versão
nenhuma, volta a ganhar chave pelo `install.sh` (um deploy).

### Turnstile: o desafio "não sou um robô" no login (opcional)

O Cloudflare Turnstile protege o login e o "esqueci minha senha" do painel (`docs/ARQUITETURA.md`, "Proteções do
login"). Fica desligado até você fazer os quatro passos abaixo; enquanto isso, nada muda no nó.

1. **Cofre.** Em `infra/gcp/envs/verax/main.tf`, acrescente `turnstile_secret = true` ao `module "node"` e aplique
   (`infra/gcp/GUIA.md`): o `plan` mostra só o cofre `verax-node-turnstile-secret-key` e a permissão de leitura da VM
   nele, nada mais. A homologação já nasce com o cofre.
2. **Widget.** No Cloudflare, em Turnstile → Add widget: nome `verax-control`, hostname `veraxsistemas.com.br` (um
   hostname cobre os subdomínios: o painel da Verax e os de clientes), modo **Managed**. Ele mostra a chave do site
   (`0x...`, pública) e a chave secreta.
3. **Chave secreta no cofre** (no Git Bash; cole o valor quando ele pedir, nada aparece na tela):

   ```bash
   read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-turnstile-secret-key \
     --project PROJETO_DO_NO --data-file=- && unset VALOR
   ```

4. **Chave do site no `node.conf`** (`TURNSTILE_SITE_KEY=0x...`) e reinicie: `sudo systemctl restart verax-node`,
   ou o próximo `deploy.sh` com o `node.conf` novo. A chave do site é o interruptor: só com ela o `start.sh` lê o
   cofre. Se o cofre ainda estiver vazio, o nó sobe sem o desafio e avisa no journal; grave a chave e reinicie.

Para conferir: abra o painel, saia e entre de novo. O widget aparece abaixo da senha; o botão "Entrar" só liga depois
dele. No journal da API, sem `Turnstile desligado` na partida.

## Instalar ou atualizar

Do seu computador, na raiz do repositório, com o `gcloud` e o `gh` logados, o Docker instalado (o `gh` lê a imagem
no registro com as credenciais dele) e o OpenSSH (`ssh`, `scp` e `ssh-keygen`; vêm com o Git for Windows, o macOS e o
Linux). O arquivo `node.conf` segue `infra/node/node.conf.example`, com os valores reais. Ele não é segredo, mas fica
fora do repositório.

```bash
infra/node/bin/deploy.sh COMMIT caminho/para/node.conf
```

`COMMIT` é o commit da `main` cujas imagens você quer rodar; ele aparece no resumo do workflow `Imagens do nó`. Para
atualizar, repita com o commit novo; para voltar, repita com o anterior. O registro guarda a versão no ar, as 3
versões mais recentes de cada imagem e tudo o que tem menos de 30 dias; para voltar mais longe, reverta o commit na
`main`, que publica uma imagem nova. O `deploy.sh` faz quatro coisas:

1. **Confere as imagens.** Com `gh attestation verify`, confere a assinatura da atestação de origem de cada imagem e
   quem a assinou: o workflow `Imagens do nó` deste repositório, na `main`, nesse commit, num executor do GitHub.
2. **Copia o pacote para a VM** pelo IAP, sem porta aberta: um túnel até a porta 22 e uma chave SSH criada só para
   esta execução (vale 1 hora no OS Login e é removida no fim). A chave do servidor fica em
   `~/.ssh/known_hosts_verax-node`: a primeira execução a registra, e as seguintes a conferem. Uma VM recriada (a
   manutenção do swap no `infra/gcp/GUIA.md`) tem chaves novas, e a conexão para com
   `REMOTE HOST IDENTIFICATION HAS CHANGED`: depois de uma recriação planejada, apague a chave antiga com
   `ssh-keygen -R verax-node -f ~/.ssh/known_hosts_verax-node` e rode de novo. Fora disso, a mensagem é um alerta:
   não apague a chave sem entender por que ela mudou.
3. **Instala pelo digest conferido.** A VM nunca confia em tag do registro.
4. **Marca a versão no ar.** Grava a tag `no-verax-node` nas duas imagens instaladas (ela sai da versão anterior). A
   limpeza do registro guarda toda versão com tag `no-`, por mais antiga que seja: o nó pode ficar meses numa versão
   enquanto a `main` publica outras, e cada partida dele baixa as imagens de novo (`compose pull`). Se essa etapa
   falhar, o nó já está instalado: o erro mostra o comando para gravar a tag à mão.

A instalação instala o Docker pelo repositório oficial, com a chave conferida. Na primeira vez, também gera a CA e o
certificado do banco e as senhas internas. Em todas as vezes, (re)inicia o serviço.

## Primeiro acesso: administrador e cliente Verax

Uma vez, depois da primeira instalação. Pode repetir sem duplicar nada. Entre na VM e rode o comando lá dentro, para
as aspas chegarem inteiras:

```bash
gcloud compute ssh verax-node --zone us-east1-b --tunnel-through-iap
```

Já na VM:

```bash
sudo BOOTSTRAP_ADMIN_EMAIL='SEU_EMAIL'   BOOTSTRAP_ADMIN_NAME='Seu nome'   BOOTSTRAP_TENANT_NAME='Verax Sistemas'   BOOTSTRAP_GCP_ACCOUNTS='PROJETO_A=projects/PROJETO_DO_NO/subscriptions/verax-node-security-PROJETO_A,PROJETO_B=projects/PROJETO_DO_NO/subscriptions/verax-node-security-PROJETO_B'   /opt/verax/bin/start.sh bootstrap
```

O que esse comando faz:

1. Cria você como `admin_verax`, com uma senha temporária que vale 72 horas.
2. Grava essa senha em `/root/verax-senha-temporaria`, que só o root lê. Ela não aparece na tela nem no log.
3. Cria o cliente com as contas da GCP, cada uma com a sua assinatura.

Ainda na VM, leia a senha e apague o arquivo:

```bash
sudo cat /root/verax-senha-temporaria && sudo rm /root/verax-senha-temporaria
```

No primeiro login, o painel pede uma senha nova e depois o cadastro do MFA. Se a temporária vencer ou se perder,
rode o mesmo comando de novo: enquanto você não trocar a senha, ele gera outra e a anterior deixa de valer.

**Esqueceu a senha depois de já ter entrado?** Sem e-mail no nó, não há link de redefinição. Na VM, como root:

```bash
sudo BOOTSTRAP_ADMIN_EMAIL='SEU_EMAIL' BOOTSTRAP_RENEW_ADMIN_PASSWORD=true /opt/verax/bin/start.sh bootstrap
```

Sai uma senha temporária nova no mesmo arquivo. A anterior e as sessões abertas deixam de valer, e o MFA continua: no
login, você usa o código do aplicativo (ou um código de recuperação) e depois troca a senha. A ação fica na auditoria.

As outras contas, você cria no painel, em Usuários: a senha temporária aparece uma única vez, para você repassar à
pessoa por um canal seguro. Quem esquecer a senha recebe outra pelo mesmo menu (Gerar senha temporária).

## Conferir

- `curl -s https://api-verax.veraxsistemas.com.br/health` responde `{"status":"ok"}`.
- No painel, a Torre do cliente Verax mostra as duas contas. Depois do primeiro evento de auditoria de um projeto, a
  conta passa a mostrar o último evento.
- Na VM, o estado e os logs (sem segredos):

  ```bash
  sudo docker compose --project-directory /opt/verax -f /opt/verax/compose.yaml --env-file /etc/verax/images.env ps
  sudo docker compose --project-directory /opt/verax -f /opt/verax/compose.yaml --env-file /etc/verax/images.env logs --tail 50 worker
  ```

- A guarda do servidor de metadados, depois de um deploy ou de um reboot: `systemctl status verax-metadata-guard`
  (ativa, `exited`, antes do Docker) e `sudo iptables -S DOCKER-USER` (o salto `-d 169.254.169.254/32 -j VERAX-METADATA`
  antes do `RETURN` do Docker, sem nenhuma regra com `-s`).

## Backups e restauração

- Todo dia, `pg_dump` vai para `gs://BUCKET_DE_BACKUPS/postgres/`. A VM cria e lê, mas não apaga; a retenção é do
  bucket. As 2 cópias mais recentes ficam também em `/var/lib/verax/backups`.
- O disco tem snapshot semanal. Ele guarda `/var/lib/verax/secrets`, com as senhas internas e a chave que cifra o
  segredo do MFA. Sem essa chave, todos precisam cadastrar o MFA de novo.
- Para restaurar o banco a partir de um dump:

  ```bash
  sudo docker compose ... exec -T postgres pg_restore -U verax -d verax --clean --if-exists < ARQUIVO.dump
  ```

  Rode com a API e o worker parados (`docker compose ... stop api worker`) e reinicie o serviço depois:
  `sudo systemctl restart verax-node`.

## Expurgo diário do histórico

- O worker apaga do banco, uma vez por dia depois das 04:00 UTC (01:00 de Brasília), o que passou do prazo do plano
  (tarefa `retention`; regras em `docs/ARQUITETURA.md`, seção "Expurgo do histórico"). Só o banco do nó: nada na
  nuvem do cliente nem no índice do Wazuh.
- No nó da Verax (`PLAN=interno`, sem limite), os achados, os incidentes, a postura e a auditoria ficam. Saem só o
  inventário com mais de 30 dias (o retrato mais recente de cada conta fica), a fila sem dono com mais de 90 dias, os
  avisos por e-mail já resolvidos com mais de 90 dias e as sessões, links e tentativas de login vencidos.
- Para conferir a execução do dia, no log do worker (`logs --tail 200 worker`): a linha `tarefa concluída` com
  `"task":"retention"` e o relatório (`done`, ou `partial` quando parou nos 10 minutos e o resto fica para o dia
  seguinte; `waiting` e `already_ran` são as conferências de cada 15 minutos). Cada cliente ganha um `retention.purge`
  na tela Auditoria, com os cortes e as contagens.
- Ao trocar o plano por um de prazo menor, o prazo anterior continua valendo por 30 dias (carência para o cliente
  exportar); o `retention.purge` mostra até quando.
- Uma restauração de dump antigo traz de volta o que já tinha saído; o expurgo do dia seguinte apaga de novo.

## Problemas comuns

- **Login com a senha temporária volta para a tela de entrada.** A senha venceu (72 horas): gere outra, pelo
  `start.sh bootstrap` (o administrador) ou pelo menu Usuários (as outras contas).
- **Com `MAIL_TRANSPORT=smtp`, o link de redefinição não chega.**
  - Veja o log da API: `logs --tail 100 api`.
  - "535 Authentication Failed" é senha errada ou revogada: grave outra no cofre e reinicie com
    `sudo systemctl restart verax-node`.
  - O remetente (`MAIL_FROM`) precisa ser a caixa autenticada ou um alias dela.
- **O aviso de incidente não chega.**
  - No log do worker (`logs --tail 100 worker`), a tarefa `notifications` roda a cada minuto e mostra só as contagens
    (`sent`, `retrying`, `failed`, `skipped`), nunca o endereço. O `mailTransport` do "worker iniciado" precisa ser
    `smtp`.
  - A situação de cada aviso fica na tabela `Notification`, com o tipo do último erro em `lastError` (`skipped` com
    `mail_disabled` é o nó sem e-mail; com `no_recipients`, ninguém do cliente com o papel, ativo e com MFA; com
    `opted_out`, havia quem recebesse, mas todos desligaram os avisos de incidente em Minha conta). Na VM:
    `sudo docker compose ... exec -T postgres psql -U verax -d verax -c 'SELECT kind, status, attempts, "lastError", cardinality("deliveredUserIds") AS avulsos, cardinality("digestedUserIds") AS no_resumo, "createdAt" FROM "Notification" ORDER BY "createdAt" DESC LIMIT 20'`.
  - Aviso `sent` com a pessoa em `digestedUserIds` não saiu avulso: entrou no resumo da hora (a pessoa já tinha 5
    e-mails nela) ou no de retomada (o aviso tinha mais de 24 horas). O resumo sai quando a hora fecha; a situação
    dele fica na tabela `NotificationDigest` (`status` nulo é a hora só com a contagem dos avulsos):
    `... -c 'SELECT "hourStart", "individualSent", cardinality("noticeIds") AS reunidos, "catchUp", status, attempts, "lastError" FROM "NotificationDigest" WHERE status IS NOT NULL ORDER BY "hourStart" DESC LIMIT 20'`.
    `skipped` com `no_recipients` é a pessoa que perdeu o acesso antes do envio; com `no_items`, ela desligou os avisos
    de incidente antes de a hora fechar. Nenhuma das duas tabelas guarda o endereço de e-mail.
  - Quem diz que não recebe: confira em Usuários se a coluna "Recebe alertas" está "Sim" (o papel, a escolha da
    pessoa), se a conta está ativa e com o MFA cadastrado. Só a própria pessoa religa os avisos, em Minha conta.
  - Uma falha do servidor volta depois de 1, 5, 15 e 60 min; na quinta, o aviso (ou o resumo) fica `failed` e não sai
    mais. Corrija o SMTP (senha, remetente) como acima: os próximos avisos saem normalmente, e os que ficaram presos
    mais de 24 horas chegam juntos, no resumo de retomada.
- **A API não sobe por causa de um segredo.** `systemctl status verax-node` diz qual cofre está vazio. Grave o valor
  e reinicie.
- **Sem o token do túnel.** Enquanto o cofre não tiver valor, o nó sobe sem o `cloudflared`: banco, API e coleta
  rodam, e o primeiro acesso (bootstrap) já pode ser feito, mas o painel não alcança a API. O aviso aparece no fim do
  `deploy.sh` e em `journalctl -u verax-node`. Grave o token e rode `sudo systemctl restart verax-node`. Outro erro na
  leitura do cofre (permissão, rede) para a partida, com o motivo do gcloud no journal.
- **IP de quem acessou, na auditoria.** A API confia em um proxy na frente, o Cloudflare (`TRUST_PROXY_HOPS=1`).
  Depois do primeiro login, confira na tela de Auditoria se aparece o seu IP, e não um do Cloudflare.
- **O login diz "A verificação de segurança não foi concluída".** A API tem o Turnstile ligado e o token não chegou
  ou foi recusado. Recarregar a página resolve o caso comum (token vencido). Se persistir: a chave do site no
  `node.conf` e a secreta no cofre precisam ser do mesmo widget, e o hostname do widget precisa cobrir o domínio do
  painel. Com "Serviço temporariamente indisponível", o `siteverify` da Cloudflare não respondeu: o log da API traz o
  motivo (`siteverify do Turnstile`), nunca a chave.
- **O widget não aparece e o botão "Entrar" fica desligado.** O navegador não carregou
  `challenges.cloudflare.com` (bloqueio de rede ou de extensão). A tela mostra "Carregando verificação…" ou o aviso
  de erro; sem o widget, não há token, e a API recusaria o login de qualquer jeito.
