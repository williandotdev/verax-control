# Conector do Verax Control para a sua conta AWS

O template `verax-control-connector.yaml` prepara a sua conta para o monitoramento do Verax Control. Ele cria um
papel **somente leitura** que só a Verax consegue assumir e os destinos de log de segurança que o painel lê. Nada
no template dá à Verax permissão para alterar recursos da sua conta.

## O que é criado

| Recurso                                          | Para quê                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Papel `VeraxControlReadOnly`                     | Leitura de configuração (políticas AWS `SecurityAudit` e `ViewOnlyAccess`) e dos logs abaixo. |
| Trilha `verax-control` do CloudTrail (opcional)  | Registro de atividade de todas as regiões, com validação de integridade dos arquivos.         |
| Exportação de findings do GuardDuty (opcional)   | Findings desta região gravados em S3. Ativa o GuardDuty se ele ainda não estiver ativo.       |
| Bucket `aws-waf-logs-verax-control-*` (opcional) | Destino dos logs do AWS WAF.                                                                  |
| Bucket de log de acesso                          | Registra quem acessou os buckets acima (recomendação do CIS Benchmark).                       |
| Chave KMS `alias/verax-control-logs`             | Cifra os logs. Rotação anual automática.                                                      |

Todos os buckets são privados (bloqueio de acesso público e sem ACL), cifrados, versionados, aceitam só HTTPS e
apagam os logs depois de `LogRetentionDays` (padrão 365 dias). Buckets e chave **ficam na sua conta** mesmo que o
stack seja removido, porque guardam registros de auditoria.

## Como a Verax acessa

- O papel só pode ser assumido por papéis da conta da Verax cujo nome começa com `verax-control-production-`
  (parâmetro `VeraxRolePrefix`) **e** que informem o `ExternalId` exclusivo da sua conta. O `ExternalId` é gerado
  pelo painel, impede que outro cliente da Verax use o mesmo caminho para chegar à sua conta e não aparece de novo
  depois de criado o stack.
- As sessões duram no máximo 1 hora.
- Toda chamada da Verax fica registrada no seu CloudTrail, com o nome da sessão.

### O que a Verax não lê

O papel inclui as permissões extras de leitura que o Prowler (o verificador de configuração usado pelo painel)
recomenda, **menos** estas:

| Permissão                                         | Por que ficou de fora                                              | Efeito no painel                                               |
| ------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `securityhub:BatchImportFindings`                 | É escrita (envia findings ao seu Security Hub).                    | Nenhum: o painel não usa o Security Hub da sua conta.          |
| `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` | Baixam suas imagens de contêiner inteiras.                         | As checagens que inspecionam o conteúdo das imagens não rodam. |
| `logs:FilterLogEvents`                            | Lê o conteúdo dos logs das suas aplicações (dados pessoais, LGPD). | A busca por segredos dentro de logs do CloudWatch não roda.    |

## Antes de começar

- Use um usuário ou papel com permissão de administrador na conta. O stack cria um papel com nome fixo, então o
  CloudFormation pede a confirmação `CAPABILITY_NAMED_IAM`.
- Tenha em mãos, do painel da Verax: o **ID da conta da Verax** e o **ExternalId** desta conta.
- Rode na região principal da conta (por exemplo, `sa-east-1`).
- Se a conta já tiver:
  - **uma trilha multi-região** gravando em um bucket desta conta: use `CreateCloudTrail=false` e informe o bucket
    em `ExistingCloudTrailBucket` (e a chave KMS em `ExistingCloudTrailKmsKeyArn`, se a trilha for cifrada). Trilhas
    de organização que gravam em outra conta precisam de liberação na conta de logs: fale com a Verax;
  - **GuardDuty ativo** nesta região: informe o ID do detector em `GuardDutyDetectorId`
    (`aws guardduty list-detectors`). Com o campo vazio, o template ativa o GuardDuty, que é cobrado pela AWS.

## Como rodar

**Pelo console (recomendado):** CloudFormation → _Create stack_ → _With new resources_ → _Upload a template file_,
escolha `verax-control-connector.yaml`, preencha os parâmetros e marque a confirmação de recursos IAM.

**Pela CLI:** para o `ExternalId` não ficar no histórico do terminal, use um arquivo de parâmetros e apague-o em
seguida:

```sh
cat > parametros.json <<'EOF'
[
  { "ParameterKey": "VeraxAccountId", "ParameterValue": "<ID da conta da Verax>" },
  { "ParameterKey": "ExternalId", "ParameterValue": "<ExternalId do painel>" }
]
EOF
aws cloudformation create-stack --stack-name verax-control-connector \
  --template-body file://verax-control-connector.yaml \
  --parameters file://parametros.json --capabilities CAPABILITY_NAMED_IAM
aws cloudformation wait stack-create-complete --stack-name verax-control-connector
rm parametros.json
```

Depois, informe no painel as **saídas** do stack: `RoleArn` e os nomes dos buckets.

## Logs do AWS WAF

- **Web ACL regional desta região:** informe o ARN em `RegionalWebAclArn` e o template liga o log, já omitindo os
  cabeçalhos de credencial (`authorization`, `cookie` e `proxy-authorization`), para que tokens e cookies dos
  usuários da sua aplicação não saiam da conta.
- **Web ACL do CloudFront ou de outra região:** ligue o log apontando para o bucket criado (o bucket aceita
  entregas de qualquer região desta conta), com a mesma omissão:

  ```sh
  cat > waf-logging.json <<'EOF'
  {
    "ResourceArn": "<ARN da web ACL>",
    "LogDestinationConfigs": ["arn:aws:s3:::<saída WafLogsBucket>"],
    "RedactedFields": [
      { "SingleHeader": { "Name": "authorization" } },
      { "SingleHeader": { "Name": "cookie" } },
      { "SingleHeader": { "Name": "proxy-authorization" } }
    ]
  }
  EOF
  aws wafv2 put-logging-configuration --region us-east-1 --logging-configuration file://waf-logging.json
  ```

## GuardDuty em outras regiões

A exportação de findings é por região. Para cada outra região em que o GuardDuty estiver ativo, configure a
exportação para o mesmo bucket e a mesma chave (GuardDuty → _Settings_ → _Findings export options_). As políticas do
bucket e da chave já aceitam os detectores de qualquer região desta conta.

## Custos na sua conta

- CloudTrail: a primeira trilha de eventos de gerenciamento não é cobrada; paga-se o armazenamento em S3.
- GuardDuty: cobrado pela AWS conforme o volume analisado, se for ativado pelo template.
- KMS: cerca de US$ 1 por mês pela chave, mais as requisições.
- S3: armazenamento dos logs pelo período de retenção.

## Como remover

Apague o stack `verax-control-connector`. A Verax perde o acesso na hora. Os buckets de log e a chave KMS
continuam na conta, com os registros, e podem ser apagados manualmente quando não forem mais necessários.

## Para quem mantém este template (Verax)

Validação no CI (`.github/workflows/iac.yml`): cfn-lint (instalado com hashes, `requirements-lint.txt`), checkov e
os testes de `tests/test_connector.py`, que conferem as garantias acima. Localmente:

```sh
python3 -m venv .venv && .venv/bin/pip install --require-hashes --no-deps -r infra/cloudformation/requirements-lint.txt
.venv/bin/cfn-lint infra/cloudformation/verax-control-connector.yaml
.venv/bin/python -m unittest discover -s infra/cloudformation/tests -v
```
