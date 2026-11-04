# Wazuh do Verax Control

Bundle do Wazuh single-node (manager e indexer 4.14.9, sem dashboard). Roda em dois lugares:

- **Nó de cliente na GCP (perfil `standard`, fase 2):** o caminho atual. O `infra/node/compose.wazuh.yaml` sobe o
  Wazuh no mesmo projeto do Compose da aplicação, com a configuração e os scripts daqui, que o `deploy.sh` do nó
  copia para o pacote e o `install.sh` instala em `/opt/verax/wazuh`. O `start.sh up` do nó faz a sequência (seção
  "Nó de cliente").
- **EC2 da AWS (legado):** `docker-compose.yml`, `scripts/deploy.sh` e `scripts/bootstrap-host.sh`, que o Terraform de
  `infra/terraform/modules/wazuh` envia por um bucket privado. Fora do caminho atual (`docs/ARQUITETURA.md`); as
  seções marcadas "EC2" valem só para ele.

| Arquivo                            | Papel                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `config/`                          | Configuração do manager (`ossec.conf` e regras locais) e do indexer.                    |
| `scripts/init-certs.sh`            | Emite os certificados TLS com uma CA própria, uma vez.                                  |
| `scripts/init-security.sh`         | Gera os usuários internos do indexer com o hash das senhas.                             |
| `scripts/security-admin.sh`        | Aplica a configuração de segurança no indexer (securityadmin).                          |
| `scripts/configure-indexer.sh`     | Retenção, 1 shard por índice de alertas e snapshot diário.                              |
| `scripts/render-manager-config.py` | Gera o `ossec.conf` do manager e os arquivos da AWS a partir das contas.                |
| `scripts/lib-passwords.sh`         | Formato, geração e conferência das senhas.                                              |
| `scripts/smoke-test.sh`            | Verificações de segurança, no fim de toda subida.                                       |
| `scripts/ci-test.sh`               | Teste de ponta a ponta do nó: instalação, rotação de senha, verificações e atualização. |
| `docker-compose.yml`               | EC2: os dois serviços, mais os jobs de inicialização. Imagens fixadas por digest.       |
| `scripts/deploy.sh`                | EC2: sobe ou reaplica a stack.                                                          |
| `scripts/bootstrap-host.sh`        | EC2: disco de dados, Docker, senhas do Secrets Manager e deploy.                        |

## O que muda em relação ao single-node oficial

- **Nenhuma senha padrão.** As senhas de `admin` (indexer), `wazuh_filebeat` (o filebeat do manager), `wazuh-wui`
  (API do manager) e `verax_api_read` (leitura da API do Verax Control) são geradas no nó pelo `install.sh` (no EC2,
  pelo Terraform, no Secrets Manager). Os usuários de demonstração do indexer (`kibanaro`, `logstash`, `readall`,
  `snapshotrestore`) não existem, e o outro usuário padrão da API (`wazuh`) recebe uma senha aleatória descartada.
- **O manager não tem a senha do admin.** O filebeat grava os alertas com o usuário `wazuh_filebeat`, que só faz o que
  o filebeat faz (`config/indexer/roles-verax.yml`): gravar pelo `_bulk` em `wazuh-alerts-*`, criar o índice do dia,
  instalar o template e o pipeline dele. Sem leitura, sem apagar índice ou documento, sem o índice de segurança: um
  manager comprometido (ele processa log de fora como root) não apaga nem lê o que já indexou. A conexão do próprio
  manager com o indexer (bloco `<indexer>` do `ossec.conf`) fica desligada; o harvester de inventário da 4.14.9 a
  ignora, sobe e tenta criar os templates `wazuh-states-inventory-*` com a credencial do filebeat, falha (um aviso por
  índice a cada partida, no `ossec.log`) e não indexa nada, porque o inventário e o FIM estão desligados; o
  `ci-test.sh` confere que a tentativa falha. A senha do `admin` só é usada pelo smoke test; o `securityadmin` e os
  scripts de retenção e restauração usam o certificado admin, que só o contêiner do indexer tem.
- **Sem dashboard** (fase 2, PR-W1): sem o contêiner, sem o par de certificados e sem o usuário de serviço dele
  (`kibanaserver`). A operação lê os alertas pelo próprio produto ou pela API do indexer, de dentro da VM (seção
  "Ler os alertas sem o dashboard").
- **Certificados próprios.** O gerador oficial baixa e executa um script da internet sem conferir checksum; aqui
  quem emite é o `init-certs.sh`, com openssl, sem rede. A chave da CA é apagada depois da emissão e cada contêiner
  monta só o próprio par de chaves.
- **TLS sempre ligado:** HTTPS no indexer (só TLS 1.2 com cifras ECDHE-GCM) e entre os componentes, com verificação
  completa do certificado (filebeat).
- **Nada exposto.** O manager não publica nenhuma porta; sem agentes, o registro (authd) fica desligado e o remoted
  escuta só no loopback do contêiner (sem o bloco `<remote>`, o Wazuh 4.14 não sobe nenhum daemon). No nó, o indexer
  também não publica porta; no EC2, só em `127.0.0.1` do host, até um security group da API ser autorizado.
- **Mapeamento de papéis mínimo.** Os mapeamentos de demonstração do indexer ficam de fora, inclusive o
  `own_index` para todos os usuários, que daria a qualquer usuário escrita num índice com o nome dele. A
  configuração de segurança é gerada inteira a cada subida (padrões da imagem + o bundle) e aplicada inteira.
- **Menos ruído e menos índice:** sem SCA, inventário e detecção de vulnerabilidades do próprio contêiner; só alertas
  de nível 5 para cima vão para o indexer, 1 shard por dia, guardados 30 dias.
- **Contêineres sem ganho de privilégio** (`no-new-privileges`). No nó, também sem capabilities (o manager recebe só
  as que o init da imagem usa), com limites de memória, CPU e processos e log com rotação.

## Nó de cliente (perfil `standard`)

Dois serviços do systemd: o `verax-node` (`start.sh up`: a guarda do metadata, os arquivos de ambiente e a pilha da
aplicação: banco, API, worker e túnel) e, depois dele, o `verax-wazuh` (`start.sh wazuh-up`), nesta ordem:
`certs-init`, `security-init`, o indexer (espera o healthcheck), o `security-admin.sh`, o `configure-indexer.sh`, o
`infra/node/bin/wazuh-apply.sh` (o `ossec.conf` do nó; no PR-W1, sem contas AWS), o manager (espera o healthcheck), o
`smoke-test.sh` e a conferência de que manager e indexer não alcançam o servidor de metadados da VM (sem isso, os dois
param e o serviço falha). Serviços separados de propósito: uma falha do Wazuh fica no `verax-wazuh`, e o banco, a API,
o worker, o túnel e o backup diário seguem no ar. `sudo systemctl restart verax-node` reinicia os dois e sobe o
`verax-wazuh` de novo mesmo quando ele tinha falhado (drop-in `verax-node.service.d/wazuh.conf`, com `Wants=`, que o
`install.sh` põe só no `standard`); `sudo systemctl restart verax-wazuh` reaplica só o Wazuh. A guarda do servidor de
metadados (`verax-metadata-guard`, antes do Docker e exigida por ele) não aceita `stop` nem `restart`: reaplique-a pelo
`restart` do `verax-node`.

- **Redes:** `wazuh` (interna, sem rota para fora) só com o indexer e o manager; `wazuh-read` (interna) com o
  indexer, a API e o worker; `wazuh-egress` só com o manager, para a saída ao S3 e ao STS. O manager não está na rede
  do banco nem divide rede com a API (numa rede só, ele chegaria à API por dentro, fora do Cloudflare, e forjaria o
  `X-Forwarded-For` em que ela confia). O `ci-test.sh` confere que o manager não alcança a `wazuh-read`.
- **Senhas:** em `/var/lib/verax/secrets` (`wazuh-indexer-admin`, `wazuh-indexer-filebeat`, `wazuh-api` e
  `wazuh-indexer-read`, 0600), geradas pelo `install.sh` no formato de `scripts/lib-passwords.sh` e conferidas pelo
  `start.sh` antes de escrever qualquer arquivo de ambiente (formato e senhas diferentes entre si; faltando alguma,
  o erro aponta para o `install.sh`). Cada contêiner recebe só as dele, por arquivos em `/run/verax` (memória, só
  root): o manager, a do `wazuh_filebeat` e a da API dele; o `security-init` (job, sem rede), as que transforma em
  hash. A do `admin` não fica em nenhum contêiner que fica no ar.
- **API e worker:** leem o indexer com `verax_api_read` (`INDEXER_AUTH=node` no `api.env` e no `worker.env`), pelo nome
  `wazuh.indexer`, com a CA do volume `certs-public`, montado só leitura em `/etc/verax/wazuh`.
- **Partida e parada:** o indexer e o manager têm `restart: unless-stopped` e 60 s para parar (`stop_grace_period`:
  o filebeat grava o registro do que já enviou e o indexer fecha o translog). As imagens, fixadas pelo digest, só são
  baixadas quando faltam: a lista vem de `compose config --images` com o perfil `setup` (o que exige todos os arquivos
  de ambiente, o `bootstrap.env` vazio incluído), `docker image inspect` decide antes do `pull`, e um erro na lista para
  a partida com o motivo no journal. A partida não depende do Docker Hub.
- **Credencial da AWS:** o diretório `/run/verax/wazuh-aws` (memória do host, só root), só leitura no manager em
  `/root/.aws`. Quem escreve nele é só o gerador (`manager-config`, sem rede).
- **Memória e CPU:** indexer com 3 GiB, heap de 1,5 GiB travado e 1,5 CPU; manager com 1,5 GiB e 1 CPU. Com a
  aplicação, a soma dos limites fica em cerca de 6 GiB, numa VM de 8 GB (o CI confere).
- **Alertas antigos:** o `verax-wazuh-alerts.timer` apaga todo dia os `logs/alerts/**/*.gz` do manager com mais de
  7 dias (o Wazuh os guarda sem prazo).

### Ler os alertas sem o dashboard

Na VM, como root, com o certificado admin do próprio indexer (nenhuma senha passa pelo terminal):

```sh
cd /opt/verax/wazuh && export COMPOSE_FILE=/opt/verax/compose.yaml:/opt/verax/compose.wazuh.yaml \
  COMPOSE_ENV_FILES=/etc/verax/images.env,/run/verax/memory.env
source scripts/lib-indexer.sh
indexer_admin GET '/wazuh-alerts-*/_search?size=5&sort=timestamp:desc' </dev/null && echo "$response_body"
```

As mesmas variáveis servem para `docker compose ps`, `logs` e `exec` do nó.

## Reaplicar a configuração (EC2)

Depois de mudar algo neste diretório e rodar `terraform apply` (que atualiza o bundle no S3):

```sh
aws ssm send-command --document-name <wazuh_apply_document> \
  --targets Key=InstanceIds,Values=<wazuh_instance_id>
```

O documento baixa o bundle, confere os checksums e roda o deploy, que termina com o smoke test. O resultado
fica no histórico do Run Command.

## Trocar as senhas

- **Nó:** troque o arquivo da senha em `/var/lib/verax/secrets` (no formato de `scripts/lib-passwords.sh`, ou apague-o
  e rode o `install.sh` de novo, que gera outro) e reinicie o nó (`sudo systemctl restart verax-node`, que reinicia o
  `verax-wazuh` junto). A partida aplica as senhas novas no indexer, recria o manager, a API e o worker e confere que
  as antigas deixaram de funcionar. O Wazuh fica fora do ar por 2 a 3 minutos.
- **EC2:** aumente `password_version` no módulo `wazuh` e rode `terraform apply`. A AWS gera as senhas novas (inclusive
  a do `wazuh_filebeat`, que não existia antes do PR-W1), gravadas direto no Secrets Manager, sem passar pelo state.
  Depois, rode o documento de reaplicação (seção anterior) e faça a API reler o segredo `<nome>/wazuh-api-read`.

## Acesso da API (usuário só leitura)

A API do Verax Control lê os alertas com o usuário `verax_api_read` (T4.8). No nó, o acesso é o da seção "Nó de
cliente"; no EC2:

- **Permissão:** `read` só em `wazuh-alerts-*`. Sem escrita, sem outros índices (estado de vulnerabilidades,
  segurança) e sem permissão de cluster. O smoke test confere cada uma dessas recusas em todo deploy.
- **Senha:** no segredo `<nome>/wazuh-api-read` (`username` e `password`), separado das senhas de administração.
  O papel da API recebe leitura só desse segredo.
- **Rede:** o indexer atende em `wazuh-indexer.<zona privada>:9200` (saída `indexer_endpoint` do Terraform). A
  porta só é publicada fora de `127.0.0.1` quando há security group autorizado em `indexer_client_security_groups`,
  e a regra de entrada aceita só esses grupos.
- **TLS:** o certificado do indexer é emitido para esse nome, e o certificado público da CA é publicado no parâmetro
  `indexer_ca_parameter` a cada deploy. A API valida a cadeia e o nome; não existe opção de pular a validação.

## Contas AWS dos clientes (CloudTrail, GuardDuty e WAF)

No nó de cliente, o manager sobe sem contas no PR-W1; a entrega das chaves de acesso pelo cofre do nó, com o gerador
abaixo escrevendo `credentials` e `config` em `/run/verax/wazuh-aws`, vem no PR-V4. O que segue é o fluxo do EC2, com
o papel e o `ExternalId`; as correlações por conta valem nos dois.

A lista das contas conectadas fica no segredo `<nome>/wazuh-aws-sources` (saída `aws_sources_secret_arn` do
Terraform), mantida pela API a partir do cadastro. Cada item traz a conta, o `ExternalId`, a região, a data de
início (`onlyLogsAfter`, no formato `2026-NOV-01`) e os buckets que saem do stack do conector
(`infra/cloudformation`). Um exemplo, com contas fictícias, está em `tests/fixtures/aws-sources.example.json`.

A cada deploy, o `scripts/render-manager-config.py` valida a lista inteira (qualquer valor fora do formato derruba o
deploy) e gera:

- o `ossec.conf` do manager, com o módulo `aws-s3` e um bucket por fonte de cada conta;
- o `/root/.aws/config` do manager, com um profile por conta que assume
  `arn:aws:iam::<conta>:role/VeraxControlReadOnly` com o `ExternalId` dela, usando a credencial da instância. O ARN
  do papel é derivado do ID da conta, para a lista não conseguir apontar para outro papel.

A lista chega ao gerador pela entrada padrão, a partir de um arquivo em tmpfs que o bootstrap apaga no fim: ela não
passa por variável de ambiente, argumento nem configuração de contêiner. Depois de atualizar a lista, rode o
documento de reaplicação.

**Correlações por conta.** Um Wazuh atende todos os clientes, e as regras de frequência da AWS no Wazuh contam
eventos de qualquer conta: três logins com falha num cliente e três noutro disparavam "Possible break in attempt"
(80255) no segundo. O `config/manager/rules/verax_aws_rules.xml` sobrescreve essas regras (80252, 80255 e 80443)
para contarem só eventos da mesma conta (no WAF, da mesma Web ACL). O gerador instala o arquivo junto com o
`ossec.conf`. O `scripts/test-rules.sh` confere o efeito no `wazuh-logtest` e falha se uma versão nova do Wazuh
trouxer outra correlação da AWS que ainda não foi avaliada.

**Credencial da instância.** O manager precisa do IMDS (por isso o hop limit 2). O serviço `verax-imds-guard`
libera o IMDS só para o IP fixo do manager (`172.30.250.10`); o indexer fica bloqueado. O bootstrap
confere as duas coisas no fim de todo deploy e falha se o filtro não estiver valendo.

## Retenção e backup

- **Retenção (decisão D-6 da fase 2):** a política ISM `verax-retencao` apaga os índices diários do Wazuh
  (`wazuh-alerts-*`, `wazuh-monitoring-*` e `wazuh-statistics-*`) com 30 dias (`ALERT_RETENTION_DAYS`; o Terraform do
  EC2 passa o dele). Ela vale para os índices novos, pelo `ism_template`, e é ligada aos que já existiam. Os achados
  ficam no Postgres pelo prazo do plano; só o evento bruto do detalhe do achado expira com o índice.
- **1 shard por dia:** o template legado `verax-alertas` (order 1) vale por cima do template do Wazuh (3 shards) nos
  índices `wazuh-alerts-4.x-*`: 1 shard e nenhuma réplica. Com 30 índices, ficam 30 shards.
- **Snapshot diário:** a política de Snapshot Management `verax-diario` faz o snapshot dos índices `wazuh-*` às
  02:00 de Brasília no repositório em disco `verax-snapshots` e mantém 7 dias (mínimo de 3 snapshots). No nó, ele
  fica só no disco (contra erro lógico; o disco inteiro tem o snapshot diário da GCP), sem cópia para o bucket.
- **Cópia no S3 (EC2):** às 03:00 de Brasília o timer `verax-snapshot-sync` espelha o repositório no bucket de backup
  (saída `backup_bucket`), privado, cifrado com KMS e versionado. A imagem oficial do indexer não traz o plugin
  `repository-s3`, por isso a cópia é feita pelo host.

Tudo isso é aplicado a cada subida por `scripts/configure-indexer.sh`, de forma idempotente, usando o certificado
admin do indexer (sem senha).

### Restaurar o backup

Roteiro testado em todo `ci-test.sh` (snapshot, índice apagado, restauração com e sem renomear, mesma contagem).
Como root, em `/opt/verax/wazuh` no nó (com as variáveis `COMPOSE_*` da seção "Ler os alertas sem o dashboard") ou
em `/opt/verax-wazuh` no EC2:

1. **Escolha o que restaurar.** Para conferir o que existe:
   `source scripts/lib-indexer.sh && indexer_admin GET '/_cat/snapshots/verax-snapshots?v' </dev/null && echo "$response_body"`.
2. **Disco perdido:** no nó, restaure o snapshot do disco da GCP (traz o repositório junto). No EC2, suba o Wazuh pelo
   documento de reaplicação e traga o repositório do S3 junto com a restauração, usando `--from-s3`.
3. **Restaure:**
   - para conferir dados antigos sem mexer nos atuais (recomendado), use `--rename`. Os índices voltam como
     `restaurado-<nome>`, fora da política de retenção (índices com mais de 30 dias seriam apagados pela política se
     voltassem com o nome original):

     ```sh
     bash scripts/restore-snapshot.sh --rename latest 'wazuh-alerts-4.x-2026.11.*'
     ```

   - para recompor os índices originais (perda de dados), os de mesmo nome não podem estar abertos. O script não
     apaga nem fecha nada, para não perder dado por engano:

     ```sh
     bash scripts/restore-snapshot.sh --from-s3 latest 'wazuh-alerts-*'
     ```

4. **Confira** a contagem: `indexer_admin GET '/<índice>/_count' </dev/null`. Quando terminar a análise, apague os
   índices `restaurado-*`.

## Diagnóstico

No nó, `systemctl status verax-wazuh` e `journalctl -u verax-wazuh` (a sequência da partida e o smoke test) e, com as
variáveis `COMPOSE_*` da seção "Ler os alertas sem o dashboard", `docker compose ps`,
`docker compose logs --tail 100 wazuh.manager` e `docker stats`. No EC2, a compose exige as senhas até para `ps` e
`logs`; use o Docker direto (`sudo docker ps` e `sudo docker logs --tail 100 verax-wazuh-wazuh.manager-1`). Lá, os
mesmos logs estão no CloudWatch, no grupo `/verax-control/<nome>/wazuh`.

## Renovar os certificados

Os certificados valem 5 anos, e a CA, 10 (a data aparece no log da primeira subida). Como a chave da CA não é
guardada, renovar significa emitir uma CA nova: pare o Wazuh, apague os volumes dos certificados e suba de novo.

- **Nó:** `sudo systemctl stop verax-node` (para o `verax-wazuh` junto), depois
  `sudo docker volume rm verax_certs-indexer verax_certs-manager verax_certs-public` e
  `sudo systemctl start verax-node verax-wazuh`. A API e o worker passam a confiar na CA nova sozinhos: ela fica no
  mesmo volume.
- **EC2:** pare e remova `verax-wazuh-wazuh.manager-1` e `verax-wazuh-wazuh.indexer-1`, apague os volumes
  `verax-wazuh_certs-indexer`, `verax-wazuh_certs-manager` e `verax-wazuh_certs-public` e rode o documento de
  reaplicação. A API precisa receber a CA nova (parâmetro do SSM).

## Testar localmente

Com Docker, uns 5 GB livres e `/run/verax` gravável (em Linux: `sudo install -d -o "$USER" /run/verax`):

```sh
cd infra/wazuh && bash scripts/ci-test.sh
```

O teste sobe o Wazuh como o nó (o `compose.yaml` e o `compose.wazuh.yaml` de `infra/node`) num projeto próprio,
`verax-wazuh-ci`, apagado com os volumes no começo e no fim, e recusa rodar num nó. Ele termina com a atualização do
manager da versão anterior (`UPGRADE_FROM`, no começo do script) para a da compose, com os mesmos volumes: o código
que a imagem nova traz para os volumes persistentes (wodles, integrations, active-response/bin e agentless) não pode
ficar escondido por eles, e o marcador do módulo da AWS tem de continuar lá. Quando o Dependabot subir a versão,
`UPGRADE_FROM` passa a ser a que estava em produção.

As correlações por conta têm um teste próprio, mais leve (só um manager avulso): `bash scripts/test-rules.sh`. No Git
Bash do Windows, rode antes `export MSYS_NO_PATHCONV=1`; o `ci-test.sh` precisa de um shell Linux (o caminho
`/run/verax` é o do host do Docker).

## Riscos conhecidos

- Manager e indexer estão no mesmo host. O manager não tem mais a senha do admin do indexer (usuário `wazuh_filebeat`,
  só escrita), mas divide o kernel e o Docker com o resto do nó.
- Os contêineres do manager e do indexer não rodam com sistema de arquivos só leitura: as imagens oficiais escrevem
  em vários caminhos internos na inicialização. Os jobs de inicialização rodam só leitura.
- No nó, 2 vCPU contra as 4 que a documentação do Docker do Wazuh pede: o ensaio da homologação mede (24 h de
  `docker stats`), com a e2-standard-4 como plano B.
- O volume dos wodles guarda o marcador do módulo da AWS e o código dos módulos. O init da imagem copia o código a cada
  partida (lista de exclusão dela); o `ci-test.sh` confere isso a cada versão nova.
