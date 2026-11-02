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
- **Nada exposto.** O manager não publica nenhuma porta (não há agentes). Indexer e dashboard publicam só em
  `127.0.0.1` do host. A instância não tem regra de entrada no security group.
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

1. Aumente `password_version` no módulo `wazuh` e rode `terraform apply`. A AWS gera três senhas novas, gravadas
   direto no Secrets Manager, sem passar pelo state.
2. Rode o documento de reaplicação (seção anterior). O deploy aplica as senhas novas no indexer, recria o manager
   e o dashboard e confere que as antigas deixaram de funcionar. O Wazuh fica indisponível por 2 a 3 minutos.

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

**Credencial da instância.** O manager precisa do IMDS (por isso o hop limit 2). O serviço `verax-imds-guard`
libera o IMDS só para o IP fixo do manager (`172.30.250.10`); indexer e dashboard ficam bloqueados. O bootstrap
confere as duas coisas no fim de todo deploy e falha se o filtro não estiver valendo.

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

O teste apaga a instalação local `verax-wazuh` no começo e no fim. No Git Bash do Windows, rode antes
`export MSYS_NO_PATHCONV=1`.

## Riscos conhecidos

- O plugin do Wazuh no dashboard não valida o certificado da API do manager. O tráfego fica na rede interna do
  Docker, no mesmo host.
- O manager usa o usuário `admin` do indexer, como no oficial, porque a detecção de vulnerabilidades escreve em
  índices próprios. Manager e indexer estão no mesmo host e na mesma fronteira de confiança.
- Os contêineres não rodam com sistema de arquivos só leitura: as imagens oficiais escrevem em vários caminhos
  internos na inicialização.
