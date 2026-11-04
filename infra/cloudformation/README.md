# Acesso de leitura do Verax Control à sua conta AWS

O template `verax-control-reader.yaml` cria na sua conta o usuário IAM **somente leitura** `verax-control-reader`
(caminho `/verax/`), **sem chave e sem senha**, o grupo `VeraxControlReaders` e duas políticas gerenciadas. O nó do
Verax Control roda fora da AWS e lê os seus logs com uma chave desse usuário, que você mesmo cria no console e que
**só funciona a partir do IP do nó**. O motivo de usar um usuário IAM, e não um papel, está em `docs/ARQUITETURA.md`
("Por que usuário IAM com chave").

Nada que já existe na conta é alterado: trilhas, destinos de log, buckets, assinaturas e políticas continuam como
estão, e o **WAF nunca é tocado**. A trilha do CloudTrail e o export do GuardDuty só são criados se você pedir na
pilha (o padrão é não).

O conector anterior, com papel e ExternalId (`verax-control-connector.yaml`), está **obsoleto**: não use em contas
novas (seção no fim).

## O que a pilha cria

| Recurso                                  | Para quê                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usuário `/verax/verax-control-reader`    | O nó lê com a chave dele. Nasce sem chave e sem senha, é membro só do grupo e tem como limite de permissões (_permissions boundary_) a política `VeraxControlReader`. |
| Grupo `/verax/VeraxControlReaders`       | Recebe as duas políticas.                                                                                                                                             |
| Política `/verax/VeraxControlReader`     | A leitura mínima, abaixo. Como também é o limite de permissões do usuário, uma política que alguém anexe a ele depois não passa dela.                                 |
| Política `/verax/VeraxControlGuardrails` | As negações explícitas, abaixo.                                                                                                                                       |

## O que o usuário pode fazer

| Permissão                                                                                                                                                                                                     | Alcance                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Listar e ler objetos de log (`s3:ListBucket`, `s3:GetBucketLocation` e `s3:GetObject`)                                                                                                                        | **Só** os buckets de `LogBucketArns` (e os criados pela pilha). Com `LogObjectPrefix`, só os objetos com o prefixo |
| Decifrar esses objetos (`kms:Decrypt`), e só pelo S3                                                                                                                                                          | **Só** as chaves de `LogKmsKeyArns` (e a criada pela pilha)                                                        |
| Simular as próprias permissões (`iam:SimulatePrincipalPolicy`): o painel confere que a chave não tem permissão demais                                                                                         | **Só** o próprio usuário                                                                                           |
| Conferir as fontes: trilhas (`cloudtrail:DescribeTrails`, `GetTrailStatus`) e o export do GuardDuty (`guardduty:ListDetectors`, `GetDetector`, `ListPublishingDestinations`, `DescribePublishingDestination`) | Toda a conta, sem acesso a dados                                                                                   |
| Ativos e Postura: usuários, chaves (só os dados, nunca o segredo), MFA e política de senha do IAM; regiões, instâncias, grupos de segurança e cifragem padrão do EBS; exposição dos buckets                   | Toda a conta, sem acesso a dados                                                                                   |

Nada além disso: sem a política `SecurityAudit` e sem `iam:GenerateCredentialReport` (que cria o relatório na
conta). Com `LogBucketArns` vazio e sem a trilha ou o export da pilha, o usuário não lê o conteúdo de nenhum log.

### O que o usuário nunca faz

O usuário não tem nenhuma permissão de escrita, e o teste do template falha se alguma aparecer. Além disso, a
política `VeraxControlGuardrails` nega explicitamente, o que vale mesmo se alguém anexar outra política ao usuário:

- **qualquer chamada de fora do IP do nó** (`NodeEgressIps`). A única exceção é o `sts:GetCallerIdentity`, que a AWS
  não deixa negar e que só revela a conta e o ARN do próprio usuário. A leitura de objetos cifrados continua
  funcionando do nó: o S3 decifra no KMS em nome do usuário e preserva o IP de origem;
- apagar, alterar, assinar ou exportar no CloudWatch Logs; apagar, gravar ou replicar no S3; parar, apagar ou alterar
  trilhas; alterar o log do WAF; arquivar findings ou desligar o GuardDuty, o Security Hub, o Inspector e o Access
  Analyzer; desativar ou apagar chaves KMS;
- ampliar o próprio acesso: nenhuma escrita no IAM, `PassRole`, assumir papéis ou `GetFederationToken`. O usuário não
  consegue nem criar, desativar ou apagar a própria chave: a troca e a revogação são sempre feitas por você;
- com `LogObjectPrefix`, ler objetos fora dos prefixos;
- num incidente, com `RevokeSessionsIssuedBefore`, usar uma sessão temporária emitida antes da data.

## Antes de começar

- Use um usuário ou papel com permissão de administrador na conta. A pilha cria nomes fixos no IAM, então o
  CloudFormation pede a confirmação `CAPABILITY_NAMED_IAM`.
- Tenha em mãos, da Verax, o **IP de saída do nó**, com `/32` (`NodeEgressIps`). Sem ele, a pilha não é criada.
- Escolha os logs que o Verax Control vai ler. O relatório do diagnóstico somente leitura (`infra/diagnostico/`)
  lista as fontes que existem na conta. Para cada uma, informe o ARN do bucket em `LogBucketArns` (exemplo:
  `arn:aws:s3:::empresa-cloudtrail-logs`) e, se o bucket usar SSE-KMS, a chave em `LogKmsKeyArns`
  (`aws s3api get-bucket-encryption --bucket <nome>`). O export do GuardDuty sempre usa uma chave KMS. Para o WAF,
  informe o bucket `aws-waf-logs-*` que já recebe o log. Vários valores vão separados por vírgula.

## Como criar a pilha

Baixe o `verax-control-reader.yaml` (pelo painel ou deste repositório). Crie uma pilha só por conta, porque os
nomes no IAM são únicos na conta. Qualquer região serve; com o export do GuardDuty, use a região do detector.

**Pelo console:** CloudFormation → _Create stack_ → _With new resources_ → _Upload a template file_, escolha o
arquivo, preencha os parâmetros e marque a confirmação de recursos IAM.

**Pela CLI** (ou no AWS CloudShell, com o arquivo enviado pelo menu _Actions_ → _Upload file_). Os valores abaixo são
fictícios: troque pelos seus e pelo IP informado pela Verax. Nenhum parâmetro é segredo.

```sh
aws cloudformation deploy --stack-name verax-control-reader \
  --template-file verax-control-reader.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    NodeEgressIps=203.0.113.10/32 \
    LogBucketArns=arn:aws:s3:::trilha-111111111111,arn:aws:s3:::guardduty-111111111111 \
    LogKmsKeyArns=arn:aws:kms:sa-east-1:111111111111:key/00000000-0000-0000-0000-000000000000
```

Para incluir ou tirar um bucket depois, rode o mesmo comando com os valores novos: só as políticas mudam, e a chave
continua valendo.

## Criar a chave e informar no painel

1. Abra o link da saída `SecurityCredentialsUrl` da pilha (ou IAM → _Users_ → `verax-control-reader` → _Security
   credentials_).
2. _Create access key_ → caso de uso _Application running outside AWS_ → _Create access key_.
3. Copie o _Access key ID_ e o _Secret access key_ e cole no painel do Verax Control, no cadastro da conta. O segredo
   só aparece nessa tela: não guarde cópia e não mande por e-mail ou chat.

O painel confere a conta e o ARN exatos do usuário, que a chave não tem permissão demais e a data de criação dela, e
guarda a chave cifrada no cofre do nó. O segredo nunca volta pela API.

## Trocar a chave

O painel avisa aos 90 dias (e mostra uma faixa a partir dos 75). Crie a segunda chave no mesmo lugar (o IAM aceita
duas por usuário), cole no painel e, só depois, exclua a antiga no console. A coleta nunca para por idade da chave.

## Num incidente

1. Desative ou exclua a chave no console (_Security credentials_ → _Actions_).
2. Sessões temporárias já emitidas com a chave (`GetSessionToken`) continuam valendo por até 36 horas depois da
   exclusão. Elas também só funcionam do IP do nó, mas, para negá-las de vez, atualize a pilha com a data e a hora de
   agora, em UTC:

```sh
aws cloudformation deploy --stack-name verax-control-reader \
  --template-file verax-control-reader.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides RevokeSessionsIssuedBefore="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Os outros parâmetros ficam como estavam. A chave em si não tem data de sessão e não é afetada: só a exclusão a revoga.

## Opcional: trilha e export do GuardDuty

O padrão é não. Com eles, a pilha cria recursos novos, e nada que já existe muda:

- **`CreateTrail=true`:** uma trilha multi-região `verax-control`, com validação de integridade, num bucket novo
  (`verax-control-cloudtrail-<conta>-<região>`) cifrado com uma chave KMS nova (`alias/verax-control-logs`). Use só
  se a conta não tiver trilha: uma segunda trilha dos mesmos eventos de gerenciamento é cobrada pela AWS.
- **`EnableGuardDutyExport=true`**, com o `GuardDutyDetectorId` do detector já ativo na região
  (`aws guardduty list-detectors`): exporta os findings para um bucket novo
  (`verax-control-guardduty-<conta>-<região>`), cifrado com a chave da pilha. A pilha não ativa o GuardDuty; sem o
  ID do detector, ela é recusada.

Os buckets criados são privados, versionados, com retenção de `LogRetentionDays` dias (365 por padrão) e log de
acesso em `verax-control-access-logs-<conta>-<região>`. O usuário já lê esses buckets: cadastre no painel as saídas
`TrailBucketArn` e `GuardDutyBucketArn`. Se a pilha for apagada, a trilha e o export param, mas os buckets e a chave
ficam, com os logs.

O WAF aceita um só destino de log por Web ACL, e a pilha nunca o troca: informe em `LogBucketArns` o bucket que já
recebe o log.

## Bucket com logs de várias contas

Num bucket que recebe os logs de várias contas (por exemplo, a trilha da organização), informe em `LogObjectPrefix`
os prefixos desta conta, separados por vírgula, como `AWSLogs/o-exemplo123/111111111111/,AWSLogs/111111111111/`
(o primeiro para a trilha da organização e o segundo para o export do GuardDuty e o WAF da própria conta). Os
prefixos valem para todos os buckets informados.

- Só a leitura dos objetos fica limitada. A listagem continua no bucket inteiro (o nome dos objetos, que traz a conta
  e a data, mas não o conteúdo), porque o coletor do Wazuh lista o bucket a partir da raiz.
- Por limitação da política do IAM, um objeto que tenha o prefixo mais adiante no nome, depois de uma `/`, também
  passa. Os logs que a AWS grava nunca têm o caminho de outra conta assim.
- O nó de cada cliente é dedicado: só os logs desta conta chegam ao painel.

## Sem CloudFormation

O `verax-control-reader.policy.json` traz as duas políticas com os mesmos valores fictícios (a conta
`111111111111`, os buckets, a chave e o IP `203.0.113.10/32`). Troque pelos seus, apague os buckets e a declaração
`DecifrarSoPeloS3` se não se aplicarem, e rode, com o `jq` (já instalado no AWS CloudShell):

```sh
conta=$(aws sts get-caller-identity --query Account --output text)
aws iam create-policy --path /verax/ --policy-name VeraxControlReader --policy-document "$(jq -c .VeraxControlReader verax-control-reader.policy.json)"
aws iam create-policy --path /verax/ --policy-name VeraxControlGuardrails --policy-document "$(jq -c .VeraxControlGuardrails verax-control-reader.policy.json)"
aws iam create-group --path /verax/ --group-name VeraxControlReaders
aws iam attach-group-policy --group-name VeraxControlReaders --policy-arn "arn:aws:iam::$conta:policy/verax/VeraxControlReader"
aws iam attach-group-policy --group-name VeraxControlReaders --policy-arn "arn:aws:iam::$conta:policy/verax/VeraxControlGuardrails"
aws iam create-user --path /verax/ --user-name verax-control-reader --permissions-boundary "arn:aws:iam::$conta:policy/verax/VeraxControlReader"
aws iam add-user-to-group --group-name VeraxControlReaders --user-name verax-control-reader
```

Depois, crie a chave como acima. Para mudar uma política, use `aws iam create-policy-version --set-as-default` com o
arquivo editado. A trilha, o export do GuardDuty e a revogação de sessões ficam só na pilha.

## Custos na sua conta

O usuário, o grupo e as políticas não têm custo. A leitura gera requisições do S3 (e do KMS, nos buckets com SSE-KMS)
e a transferência dos logs para fora da AWS, cobradas pela AWS conforme o volume. Com o CloudTrail compactado abaixo
de 5 GB por mês, fica abaixo de US$ 1. O log completo do WAF pode pesar mais. A trilha e o export opcionais somam o
armazenamento nos buckets novos e, no caso da trilha, a cópia extra dos eventos se a conta já tiver outra.

## Como remover

1. Exclua a chave no console (_Security credentials_ → _Actions_ → _Delete_). A Verax perde o acesso na hora.
2. Apague a pilha `verax-control-reader`. Os buckets e a chave KMS criados pela pilha (se houver) ficam, com os
   logs. Nenhum log ou recurso seu é afetado.

## Conector com papel e ExternalId (obsoleto)

> **Obsoleto desde a revisão de 04/11/2026.** Não use em contas novas: o nó do Verax Control roda fora da AWS e lê
> pelo usuário de leitura acima. O arquivo `verax-control-connector.yaml` fica guardado para um futuro modo
> Enterprise, com papel e ExternalId.

O template `verax-control-connector.yaml` cria **um único recurso** na sua conta: o papel **somente leitura**
`VeraxControlReadOnly`. Só o nó do Verax Control consegue assumi-lo. O template não cria nem altera trilhas,
destinos de log, buckets, assinaturas ou políticas existentes. O Verax Control lê os logs de onde eles já estão,
pela API da AWS, como qualquer ferramenta externa.

### O que o papel pode fazer

| Permissão                                                                                        | Alcance                                         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Ler configuração (políticas AWS `SecurityAudit` e `ViewOnlyAccess`, mais as leituras do Prowler) | Toda a conta, sem acesso a dados                |
| Ler findings (GuardDuty, Security Hub, Inspector e IAM Access Analyzer)                          | Toda a conta                                    |
| Ler o conteúdo de logs do CloudWatch Logs                                                        | **Só** os grupos informados em `LogGroupArns`   |
| Ler objetos em buckets S3 de log                                                                 | **Só** os buckets informados em `LogBucketArns` |
| Decifrar esses objetos (SSE-KMS), e só pelo S3                                                   | **Só** as chaves informadas em `LogKmsKeyArns`  |

Com os três últimos parâmetros vazios, o papel não lê o conteúdo de nenhum log.

#### O que o papel nunca faz

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

#### O que a Verax não lê

O papel inclui as permissões extras de leitura que o Prowler (o verificador de configuração usado pelo painel)
recomenda, **menos** estas:

| Permissão                                         | Por que ficou de fora                                              | Efeito no painel                                               |
| ------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `securityhub:BatchImportFindings`                 | É escrita (envia findings ao seu Security Hub).                    | Nenhum: o painel não usa o Security Hub da sua conta.          |
| `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` | Baixam suas imagens de contêiner inteiras.                         | As checagens que inspecionam o conteúdo das imagens não rodam. |
| `logs:FilterLogEvents`                            | Lê o conteúdo dos logs das suas aplicações (dados pessoais, LGPD). | A busca por segredos dentro de logs do CloudWatch não roda.    |

### Quem assume o papel

- Só o **papel do nó** do Verax Control (`NodeRoleName`, padrão `verax-control-node`), na conta onde o nó roda
  (`NodeAccountId`), **e** só informando o `ExternalId` exclusivo da sua conta.
- O nó pode rodar na sua própria conta ou numa conta da Verax. Nos dois casos ele só chega aos dados por este papel:
  a conta que hospeda o nó não ganha nenhum outro acesso.
- O `ExternalId` é gerado pelo painel, impede que outro cliente da Verax use o mesmo caminho para chegar à sua conta e
  não aparece de novo depois de criado o stack.
- As sessões duram no máximo 1 hora. Toda chamada fica registrada no seu CloudTrail, com o nome da sessão.

### Antes de começar

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

### Como rodar

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

### Limites de leitura

O CloudWatch Logs limita as chamadas de leitura por segundo de cada conta e região, e esse limite é dividido com
qualquer outra ferramenta que já leia os mesmos logs. O Verax Control lê em intervalos conservadores. Se outra
ferramenta da sua equipe começar a receber erros de limite (`ThrottlingException`), avise a Verax para espaçar a
coleta.

### Custos na sua conta

O papel não tem custo. A leitura dos logs pela API gera requisições do CloudWatch Logs e do S3, cobradas pela AWS
conforme o volume. Não há transferência entre regiões quando o nó fica na mesma região dos logs.

### Como remover

Apague o stack `verax-control-connector`. A Verax perde o acesso na hora. Nenhum log ou recurso seu é afetado.

## Para quem mantém estes templates (Verax)

Validação no CI (`.github/workflows/iac.yml`): cfn-lint (instalado com hashes, `requirements-lint.txt`), checkov,
cfn-guard (binário com o SHA-256 fixado, regras em `guard/`) e os testes de `tests/`, que conferem as garantias acima.
`tests/test_reader.py` monta a pilha com valores fictícios e decide cada chamada com as duas políticas juntas, e o
`verax-control-reader.policy.json` precisa ser a pilha com os valores do exemplo (o teste compara). Localmente:

```sh
python3 -m venv .venv && .venv/bin/pip install --require-hashes --no-deps -r infra/cloudformation/requirements-lint.txt
.venv/bin/cfn-lint infra/cloudformation/*.yaml
.venv/bin/python -m unittest discover -s infra/cloudformation/tests -v
cfn-guard validate --rules infra/cloudformation/guard/verax-control-reader.guard \
  --data infra/cloudformation/verax-control-reader.yaml
cfn-guard test --rules-file infra/cloudformation/guard/verax-control-reader.guard \
  --test-data infra/cloudformation/guard/verax-control-reader.tests.yaml
```

O checkov não avalia as duas políticas gerenciadas do usuário de leitura, porque elas têm declarações condicionais
(`Fn::If`): quem as confere são os testes e o cfn-guard. Os recursos opcionais (trilha e export) só entram na
varredura com os parâmetros ligados; o checkov roda com os padrões, que os desligam.
