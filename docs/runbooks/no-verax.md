# Nó da Verax (SOC na GCP): instalação e operação

O SOC da própria Verax roda numa VM e2-micro da GCP (`infra/gcp/`), sem Wazuh. O painel fica em
`verax.control.veraxsistemas.com.br` (Firebase Hosting, `docs/runbooks/painel.md`) e fala com a API em
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
metadados da GCP, que entrega o token da VM: uma regra no `DOCKER-USER`, aplicada a cada partida, bloqueia os outros
contêineres. O backup do banco sai todo dia para o
bucket de backups (`verax-backup.timer`).

## Antes de instalar (uma vez)

1. **Infraestrutura.** Aplique o Terraform de `infra/gcp/` (guia em `infra/gcp/GUIA.md`). Ele cria uma assinatura do
   Pub/Sub por projeto monitorado, os cofres dos segredos e o registro das imagens.
2. **E-mail (Zoho).** O domínio já usa o Zoho Mail, com SPF e DKIM.
   - Crie a caixa `nao-responda@veraxsistemas.com.br` (ou um alias de uma caixa existente).
   - Gere uma senha de aplicativo: no Zoho, em Minha conta → Segurança → Senhas específicas de aplicativo.
   - Grave a senha no cofre. Cole quando o terminal pedir; nada aparece na tela:

     ```bash
     read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-smtp-password \
       --project PROJETO_DO_NO --data-file=- && unset VALOR
     ```

3. **Túnel do Cloudflare.**
   - Em Zero Trust → Networks → Tunnels, crie um túnel `verax-node` do tipo Cloudflared.
   - Na tela de instalação, copie só o token, o texto longo depois de `--token`.
   - Em Public Hostnames, crie `api-verax.veraxsistemas.com.br` com o serviço `HTTP` e a URL `api:3000`.
   - Grave o token no cofre:

     ```bash
     read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add verax-node-cloudflare-tunnel-token \
       --project PROJETO_DO_NO --data-file=- && unset VALOR
     ```

4. **Imagens.** O workflow `Imagens do nó` publica a API e as migrations a cada merge na `main` que mexa na API. Ele
   usa o environment `imagens` do GitHub, que só aceita a `main`, com três variáveis:
   - `IMAGES_REPOSITORY` e `GCP_IMAGES_SA`: valores em `terraform output images_repository` e `images_publisher`;
   - `GCP_WIF_PROVIDER`: o mesmo provedor do Painel.

   A versão de cada publicação é o commit, que aparece no resumo da execução.

## Instalar ou atualizar

Do seu computador, na raiz do repositório, com o `gcloud` e o `gh` logados e o Docker instalado (o `gh` lê a
imagem no registro com as credenciais dele). O arquivo `node.conf` segue
`infra/node/node.conf.example`, com os valores reais. Ele não é segredo, mas fica fora do repositório.

```bash
infra/node/bin/deploy.sh COMMIT caminho/para/node.conf
```

`COMMIT` é o commit da `main` cujas imagens você quer rodar; ele aparece no resumo do workflow `Imagens do nó`. Para
atualizar, repita com o commit novo. O `deploy.sh` faz três coisas:

1. **Confere as imagens.** Com `gh attestation verify`, confere a assinatura da atestação de origem de cada imagem e
   quem a assinou: o workflow `Imagens do nó` deste repositório, na `main`, nesse commit, num executor do GitHub.
2. **Copia o pacote para a VM** pelo IAP, sem porta aberta.
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

1. Cria você como `admin_verax`, sem senha.
2. Envia o convite por e-mail. O link vale 60 minutos.
3. Cria o cliente com as contas da GCP, cada uma com a sua assinatura.

Pelo link, você define a senha. No primeiro login, cadastra o MFA. Se o link vencer, rode o mesmo comando de novo:
ele reenvia o convite enquanto a conta não estiver ativa.

## Conferir

- `curl -s https://api-verax.veraxsistemas.com.br/health` responde `{"status":"ok"}`.
- No painel, a Torre do cliente Verax mostra as duas contas. Depois do primeiro evento de auditoria de um projeto, a
  conta passa a mostrar o último evento.
- Na VM, o estado e os logs (sem segredos):

  ```bash
  sudo docker compose --project-directory /opt/verax -f /opt/verax/compose.yaml --env-file /etc/verax/images.env ps
  sudo docker compose --project-directory /opt/verax -f /opt/verax/compose.yaml --env-file /etc/verax/images.env logs --tail 50 worker
  ```

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

- **O convite não chega.**
  - Veja o log da API: `logs --tail 100 api`.
  - "535 Authentication Failed" é senha de aplicativo errada ou revogada: grave outra no cofre e reinicie com
    `sudo systemctl restart verax-node`.
  - O remetente (`MAIL_FROM`) precisa ser a caixa autenticada ou um alias dela.
- **A API não sobe por causa de um segredo.** `systemctl status verax-node` diz qual cofre está vazio. Grave o valor
  e reinicie.
- **IP de quem acessou, na auditoria.** A API confia em um proxy na frente, o Cloudflare (`TRUST_PROXY_HOPS=1`).
  Depois do primeiro login, confira na tela de Auditoria se aparece o seu IP, e não um do Cloudflare.
