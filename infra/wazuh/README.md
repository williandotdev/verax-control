# Wazuh do Verax Control

Bundle do Wazuh single-node (manager, indexer e dashboard 4.14.9) que roda no EC2 de produção
(`infra/terraform/modules/wazuh`). O Terraform envia este diretório para um bucket privado; a instância baixa,
confere os checksums e roda `scripts/bootstrap-host.sh`.

| Arquivo                     | Papel                                                                          |
| --------------------------- | ------------------------------------------------------------------------------ |
| `docker-compose.yml`        | Os três serviços, mais dois jobs de inicialização. Imagens fixadas por digest. |
| `config/`                   | Configuração do manager (`ossec.conf`), do indexer e do dashboard.             |
| `scripts/bootstrap-host.sh` | Só no EC2: disco de dados, Docker, senhas do Secrets Manager e deploy.         |
| `scripts/deploy.sh`         | Sobe ou reaplica a stack. Portátil (EC2 ou Docker local).                      |
| `scripts/init-certs.sh`     | Emite os certificados TLS com uma CA própria, uma vez.                         |
| `scripts/init-security.sh`  | Gera os usuários internos do indexer com o hash das senhas.                    |
| `scripts/smoke-test.sh`     | Verificações de segurança, no fim de todo deploy.                              |
| `scripts/ci-test.sh`        | Teste de ponta a ponta: instalação, rotação de senha e verificações.           |

## O que muda em relação ao single-node oficial

- **Nenhuma senha padrão.** As senhas de `admin` e `kibanaserver` (indexer) e de `wazuh-wui` (API) são geradas
  pelo Terraform e lidas do Secrets Manager. A compose não sobe sem elas. Os usuários de demonstração do indexer
  (`kibanaro`, `logstash`, `readall`, `snapshotrestore`) não existem, e o outro usuário padrão da API (`wazuh`)
  recebe uma senha aleatória descartada.
- **Certificados próprios.** O gerador oficial baixa e executa um script da internet sem conferir checksum; aqui
  quem emite é o `init-certs.sh`, com openssl, sem rede. A chave da CA é apagada depois da emissão e cada contêiner
  monta só o próprio par de chaves.
- **TLS sempre ligado:** HTTPS no indexer (só TLS 1.2 com cifras ECDHE-GCM), no dashboard e entre os componentes,
  com verificação completa do certificado (filebeat e dashboard).
- **Nada exposto.** O manager não publica nenhuma porta (não há agentes). O dashboard publica só em `127.0.0.1` do
  host, e o indexer também, até um security group da API ser autorizado (seção "Acesso da API").
- **Mapeamento de papéis mínimo.** Os mapeamentos de demonstração do indexer ficam de fora, inclusive o
  `own_index` para todos os usuários, que daria a qualquer usuário escrita num índice com o nome dele. A
  configuração de segurança é gerada inteira a cada deploy (padrões da imagem + o bundle) e aplicada inteira.
- **Contêineres sem ganho de privilégio** (`no-new-privileges`) e logs no CloudWatch, cifrados.

## Acessar o dashboard

Pelo port forwarding do Session Manager (a instância não tem porta aberta):

```sh
aws ssm start-session --target <wazuh_instance_id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8443"],"localPortNumber":["8443"]}'
```

Abra `https://localhost:8443` e entre como `admin`. A senha está no segredo `<nome>/wazuh`, campo
`indexer_admin`; copie pelo console do Secrets Manager, sem colar em terminal compartilhado. O navegador vai
avisar que não conhece a CA: o certificado dela está em `/data/docker/volumes/verax-wazuh_certs-public/_data/root-ca.pem`
na instância, se quiser importá-lo.

## Reaplicar a configuração

Depois de mudar algo neste diretório e rodar `terraform apply` (que atualiza o bundle no S3):

```sh
aws ssm send-command --document-name <wazuh_apply_document> \
  --targets Key=InstanceIds,Values=<wazuh_instance_id>
```

O documento baixa o bundle, confere os checksums e roda o deploy, que termina com o smoke test. O resultado
fica no histórico do Run Command.

## Trocar as senhas

1. Aumente `password_version` no módulo `wazuh` e rode `terraform apply`. A AWS gera quatro senhas novas (as três
   do Wazuh e a do `verax_api_read`), gravadas direto no Secrets Manager, sem passar pelo state. Depois da
   reaplicação, a API precisa reler o segredo `<nome>/wazuh-api-read`.
2. Rode o documento de reaplicação (seção anterior). O deploy aplica as senhas novas no indexer, recria o manager
   e o dashboard e confere que as antigas deixaram de funcionar. O Wazuh fica indisponível por 2 a 3 minutos.

## Acesso da API (usuário só leitura)

A API do Verax Control lê os alertas com o usuário `verax_api_read` (T4.8):

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
libera o IMDS só para o IP fixo do manager (`172.30.250.10`); indexer e dashboard ficam bloqueados. O bootstrap
confere as duas coisas no fim de todo deploy e falha se o filtro não estiver valendo.

## Retenção e backup

- **Retenção (pendência 6):** a política ISM `verax-retencao` apaga os índices diários do Wazuh (`wazuh-alerts-*`,
  `wazuh-monitoring-*` e `wazuh-statistics-*`) com 90 dias (`alert_retention_days` no Terraform). Ela vale para os
  índices novos, pelo `ism_template`, e é ligada aos que já existiam no deploy.
- **Snapshot diário:** a política de Snapshot Management `verax-diario` faz o snapshot dos índices `wazuh-*` às
  02:00 de Brasília no repositório em disco `verax-snapshots` e mantém 14 dias (mínimo de 3 snapshots).
- **Cópia no S3:** às 03:00 de Brasília o timer `verax-snapshot-sync` espelha o repositório no bucket de backup
  (saída `backup_bucket`), privado, cifrado com KMS e versionado: o que sai do repositório ainda fica 30 dias no
  bucket. A imagem oficial do indexer não traz o plugin `repository-s3`, por isso a cópia é feita pelo host.

Tudo isso é aplicado a cada deploy por `scripts/configure-indexer.sh`, de forma idempotente, usando o certificado
admin do indexer (sem senha).

### Restaurar o backup

Roteiro testado em todo `ci-test.sh` (snapshot, índice apagado, restauração com e sem renomear, mesma contagem).
Na instância, como root, em `/opt/verax-wazuh`:

1. **Escolha o que restaurar.** Para conferir o que existe:
   `source scripts/lib-indexer.sh && indexer_admin GET '/_cat/snapshots/verax-snapshots?v' </dev/null && echo "$response_body"`.
2. **Instância nova ou disco perdido:** suba o Wazuh pelo documento de reaplicação e traga o repositório do S3 junto
   com a restauração, usando `--from-s3`.
3. **Restaure:**
   - para conferir dados antigos sem mexer nos atuais (recomendado), use `--rename`. Os índices voltam como
     `restaurado-<nome>`, fora da política de retenção (índices com mais de 90 dias seriam apagados pela política se
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

## Diagnóstico na instância

A compose exige as senhas até para `ps` e `logs` (é a trava que impede subir sem elas). Para olhar o estado,
use o Docker direto:

```sh
sudo docker ps
sudo docker logs --tail 100 verax-wazuh-wazuh.manager-1
```

Os mesmos logs estão no CloudWatch, no grupo `/verax-control/<nome>/wazuh`.

## Renovar os certificados

Os certificados valem 5 anos, e a CA, 10 (a data aparece no log do primeiro deploy). Como a chave da CA não é
guardada, renovar significa emitir uma CA nova:

```sh
sudo docker stop verax-wazuh-wazuh.dashboard-1 verax-wazuh-wazuh.manager-1 verax-wazuh-wazuh.indexer-1
sudo docker rm verax-wazuh-wazuh.dashboard-1 verax-wazuh-wazuh.manager-1 verax-wazuh-wazuh.indexer-1
sudo docker volume rm verax-wazuh_certs-indexer verax-wazuh_certs-manager verax-wazuh_certs-dashboard \
  verax-wazuh_certs-public
```

Depois rode o documento de reaplicação. Quem confia na CA antiga (a API, a partir da T4.8) precisa receber a
nova.

## Testar localmente

Com Docker e uns 6 GB livres:

```sh
cd infra/wazuh && bash scripts/ci-test.sh
```

O teste apaga a instalação local `verax-wazuh` no começo e no fim. As correlações por conta têm um teste próprio,
mais leve (só um manager avulso): `bash scripts/test-rules.sh`. No Git Bash do Windows, rode antes
`export MSYS_NO_PATHCONV=1`.

## Riscos conhecidos

- O plugin do Wazuh no dashboard não valida o certificado da API do manager. O tráfego fica na rede interna do
  Docker, no mesmo host.
- O manager usa o usuário `admin` do indexer, como no oficial, porque a detecção de vulnerabilidades escreve em
  índices próprios. Manager e indexer estão no mesmo host e na mesma fronteira de confiança.
- Os contêineres não rodam com sistema de arquivos só leitura: as imagens oficiais escrevem em vários caminhos
  internos na inicialização.
