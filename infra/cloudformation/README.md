# Conector do Verax Control para a sua conta AWS

O template `verax-control-connector.yaml` cria **um único recurso** na sua conta: o papel **somente leitura**
`VeraxControlReadOnly`. Só o nó do Verax Control consegue assumi-lo. O template não cria nem altera trilhas,
destinos de log, buckets, assinaturas ou políticas existentes. O Verax Control lê os logs de onde eles já estão,
pela API da AWS, como qualquer ferramenta externa.

## O que o papel pode fazer

| Permissão                                                                                        | Alcance                                         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Ler configuração (políticas AWS `SecurityAudit` e `ViewOnlyAccess`, mais as leituras do Prowler) | Toda a conta, sem acesso a dados                |
| Ler findings (GuardDuty, Security Hub, Inspector e IAM Access Analyzer)                          | Toda a conta                                    |
| Ler o conteúdo de logs do CloudWatch Logs                                                        | **Só** os grupos informados em `LogGroupArns`   |
| Ler objetos em buckets S3 de log                                                                 | **Só** os buckets informados em `LogBucketArns` |
| Decifrar esses objetos (SSE-KMS), e só pelo S3                                                   | **Só** as chaves informadas em `LogKmsKeyArns`  |

Com os três últimos parâmetros vazios, o papel não lê o conteúdo de nenhum log.

### O que o papel nunca faz

Além de não receber nenhuma permissão de escrita, o papel tem uma **negação explícita**. Ela prevalece sobre qualquer
permissão, inclusive se a AWS ampliar as políticas gerenciadas no futuro, e cobre as ações que poderiam apagar,
desligar ou desviar logs e findings:

- apagar ou alterar grupos, streams, retenção, assinaturas e exportações do CloudWatch Logs;
- apagar, gravar ou replicar objetos e alterar políticas e ciclo de vida de buckets;
- parar, apagar ou alterar trilhas do CloudTrail;
- alterar o destino de log do AWS WAF;
- arquivar ou apagar findings, e desligar o GuardDuty, o Security Hub, o Inspector ou o Access Analyzer;
- desativar ou apagar chaves KMS.

Também ficam negadas as ações que ampliariam o próprio acesso: criar ou alterar papéis e políticas do IAM, `PassRole`
e assumir outros papéis.

### O que a Verax não lê

O papel inclui as permissões extras de leitura que o Prowler (o verificador de configuração usado pelo painel)
recomenda, **menos** estas:

| Permissão                                         | Por que ficou de fora                                              | Efeito no painel                                               |
| ------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `securityhub:BatchImportFindings`                 | É escrita (envia findings ao seu Security Hub).                    | Nenhum: o painel não usa o Security Hub da sua conta.          |
| `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` | Baixam suas imagens de contêiner inteiras.                         | As checagens que inspecionam o conteúdo das imagens não rodam. |
| `logs:FilterLogEvents`                            | Lê o conteúdo dos logs das suas aplicações (dados pessoais, LGPD). | A busca por segredos dentro de logs do CloudWatch não roda.    |

## Quem assume o papel

- Só o **papel do nó** do Verax Control (`NodeRoleName`, padrão `verax-control-node`), na conta onde o nó roda
  (`NodeAccountId`), **e** só informando o `ExternalId` exclusivo da sua conta.
- O nó pode rodar na sua própria conta ou numa conta da Verax. Nos dois casos ele só chega aos dados por este papel:
  a conta que hospeda o nó não ganha nenhum outro acesso.
- O `ExternalId` é gerado pelo painel, impede que outro cliente da Verax use o mesmo caminho para chegar à sua conta e
  não aparece de novo depois de criado o stack.
- As sessões duram no máximo 1 hora. Toda chamada fica registrada no seu CloudTrail, com o nome da sessão.

## Antes de começar

- Use um usuário ou papel com permissão de administrador na conta. O stack cria um papel com nome fixo, então o
  CloudFormation pede a confirmação `CAPABILITY_NAMED_IAM`.
- Tenha em mãos, da Verax: a **conta do nó**, o **nome do papel do nó** (se não for o padrão) e o **ExternalId**.
- Escolha os logs que o Verax Control vai ler. O relatório do diagnóstico somente leitura (`infra/diagnostico/`)
  lista as fontes que existem na conta. Para cada fonte:
  - **CloudWatch Logs:** o ARN do grupo, sem `:*` no fim (campo `logGroupArn` de
    `aws logs describe-log-groups`). Exemplo: `arn:aws:logs:us-east-1:111122223333:log-group:aws-cloudtrail-logs`;
  - **bucket S3:** o ARN do bucket. Exemplo: `arn:aws:s3:::empresa-cloudtrail-logs`. Se o bucket usar SSE-KMS,
    informe também a chave em `LogKmsKeyArns` (`aws s3api get-bucket-encryption --bucket <nome>`).

  Vários valores vão separados por vírgula.

## Como rodar

**Pelo console (recomendado):** CloudFormation → _Create stack_ → _With new resources_ → _Upload a template file_,
escolha `verax-control-connector.yaml`, preencha os parâmetros e marque a confirmação de recursos IAM.

**Pela CLI:** para o `ExternalId` não ficar no histórico do terminal, use um arquivo de parâmetros e apague-o em
seguida:

```sh
cat > parametros.json <<'EOF'
[
  { "ParameterKey": "NodeAccountId", "ParameterValue": "<conta do nó>" },
  { "ParameterKey": "ExternalId", "ParameterValue": "<ExternalId da Verax>" },
  { "ParameterKey": "LogGroupArns", "ParameterValue": "<ARN do grupo 1>,<ARN do grupo 2>" },
  { "ParameterKey": "LogBucketArns", "ParameterValue": "<ARN do bucket>" }
]
EOF
aws cloudformation create-stack --stack-name verax-control-connector \
  --template-body file://verax-control-connector.yaml \
  --parameters file://parametros.json --capabilities CAPABILITY_NAMED_IAM
aws cloudformation wait stack-create-complete --stack-name verax-control-connector
rm parametros.json
```

Depois, informe à Verax a **saída** `RoleArn` do stack.

**Para incluir ou tirar um log depois:** atualize o stack com os novos valores de `LogGroupArns`, `LogBucketArns` e
`LogKmsKeyArns` (_Update stack_ → _Use current template_). Só o papel muda.

## Limites de leitura

O CloudWatch Logs limita as chamadas de leitura por segundo de cada conta e região, e esse limite é dividido com
qualquer outra ferramenta que já leia os mesmos logs. O Verax Control lê em intervalos conservadores. Se outra
ferramenta da sua equipe começar a receber erros de limite (`ThrottlingException`), avise a Verax para espaçar a
coleta.

## Custos na sua conta

O papel não tem custo. A leitura dos logs pela API gera requisições do CloudWatch Logs e do S3, cobradas pela AWS
conforme o volume. Não há transferência entre regiões quando o nó fica na mesma região dos logs.

## Como remover

Apague o stack `verax-control-connector`. A Verax perde o acesso na hora. Nenhum log ou recurso seu é afetado.

## Para quem mantém este template (Verax)

Validação no CI (`.github/workflows/iac.yml`): cfn-lint (instalado com hashes, `requirements-lint.txt`), checkov e
os testes de `tests/test_connector.py`, que conferem as garantias acima. Localmente:

```sh
python3 -m venv .venv && .venv/bin/pip install --require-hashes --no-deps -r infra/cloudformation/requirements-lint.txt
.venv/bin/cfn-lint infra/cloudformation/verax-control-connector.yaml
.venv/bin/python -m unittest discover -s infra/cloudformation/tests -v
```
