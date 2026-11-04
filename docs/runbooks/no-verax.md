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

   A versão de cada publicação é o commit, que aparece no resumo da execução.

O nó não precisa de e-mail (`MAIL_TRANSPORT=none` no `node.conf`): toda conta nasce com uma senha temporária,
entregue a quem a criou. Para ligar também a redefinição de senha pelo link, use `MAIL_TRANSPORT=smtp` com os dados
da caixa de envio e grave a senha dela no cofre `verax-node-smtp-password`.

O plano do nó também fica no `node.conf`: o da Verax é `PLAN=interno`, sem limite. A instalação recusa um `node.conf`
sem `PLAN`, e a API e o worker não sobem sem ele. Um `node.conf` de antes do plano precisa ganhar a linha
`PLAN=interno` antes do próximo deploy. O bootstrap grava o rótulo do plano no cadastro do cliente do nó.

O perfil do nó (`NODE_PROFILE`) define a memória do banco, da API e do worker. O da Verax é `lean`, com os mesmos
limites de antes; sem a linha no `node.conf`, vale `lean`, então o `node.conf` atual não precisa mudar.

No perfil `standard` (homologação e nós de clientes), o mesmo pacote sobe também o Wazuh (manager e indexer, sem
dashboard), num serviço próprio, o `verax-wazuh`, depois do `verax-node`: o `deploy.sh` leva junto a configuração de
`infra/wazuh`, o `install.sh` gera as quatro senhas dele em `/var/lib/verax/secrets`, e o serviço espera o Wazuh ficar
saudável (alguns minutos, mais na primeira vez, que baixa as imagens); uma falha dele não derruba a aplicação nem o
backup. O que roda, como conferir e como ler os alertas estão em `infra/wazuh/README.md`, seção "Nó de cliente". Nesse
perfil, use `SYNC_SOURCES=gcp,wazuh` no `node.conf`. O nó da Verax (`lean`) não recebe nada disso.

## Instalar ou atualizar

Do seu computador, na raiz do repositório, com o `gcloud` e o `gh` logados, o Docker instalado (o `gh` lê a imagem
no registro com as credenciais dele) e o OpenSSH (`ssh`, `scp` e `ssh-keygen`; vêm com o Git for Windows, o macOS e o
Linux). O arquivo `node.conf` segue `infra/node/node.conf.example`, com os valores reais. Ele não é segredo, mas fica
fora do repositório.

```bash
infra/node/bin/deploy.sh COMMIT caminho/para/node.conf
```

`COMMIT` é o commit da `main` cujas imagens você quer rodar; ele aparece no resumo do workflow `Imagens do nó`. Para
atualizar, repita com o commit novo. O `deploy.sh` faz três coisas:

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

## Problemas comuns

- **Login com a senha temporária volta para a tela de entrada.** A senha venceu (72 horas): gere outra, pelo
  `start.sh bootstrap` (o administrador) ou pelo menu Usuários (as outras contas).
- **Com `MAIL_TRANSPORT=smtp`, o link de redefinição não chega.**
  - Veja o log da API: `logs --tail 100 api`.
  - "535 Authentication Failed" é senha errada ou revogada: grave outra no cofre e reinicie com
    `sudo systemctl restart verax-node`.
  - O remetente (`MAIL_FROM`) precisa ser a caixa autenticada ou um alias dela.
- **A API não sobe por causa de um segredo.** `systemctl status verax-node` diz qual cofre está vazio. Grave o valor
  e reinicie.
- **Sem o token do túnel.** Enquanto o cofre não tiver valor, o nó sobe sem o `cloudflared`: banco, API e coleta
  rodam, e o primeiro acesso (bootstrap) já pode ser feito, mas o painel não alcança a API. O aviso aparece no fim do
  `deploy.sh` e em `journalctl -u verax-node`. Grave o token e rode `sudo systemctl restart verax-node`. Outro erro na
  leitura do cofre (permissão, rede) para a partida, com o motivo do gcloud no journal.
- **IP de quem acessou, na auditoria.** A API confia em um proxy na frente, o Cloudflare (`TRUST_PROXY_HOPS=1`).
  Depois do primeiro login, confira na tela de Auditoria se aparece o seu IP, e não um do Cloudflare.
