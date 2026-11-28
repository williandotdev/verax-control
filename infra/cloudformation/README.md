# Acesso de leitura do Verax Control à sua conta AWS

O template `verax-control-reader.yaml` cria na sua conta o papel IAM **somente leitura** `verax-control-reader`
(caminho `/verax/`) e duas políticas gerenciadas. **Não existe chave de acesso:** ninguém cria, copia, guarda ou troca
uma chave. O nó do Verax Control roda na Google Cloud e prova quem é com um token que o Google assina para a conta de
serviço dele e que vale no máximo 1 hora. A AWS troca esse token por uma sessão do papel, também de no máximo 1 hora,
e **só aceita o pedido vindo do IP de saída do nó**. O motivo de usar um papel sem chave está em `docs/ARQUITETURA.md`
("Por que papel sem chave").

O papel **enxerga** o que a conta já registra (só configuração) e **lê só o que você autorizar** ao criar a pilha:
os logs que a AWS grava no S3 para a sua conta, os achados de segurança e os grupos do CloudWatch Logs que você
etiquetar. Cada autorização é um parâmetro `true`/`false`, e a seção "O que cada permissão libera" diz, uma a uma, o
que o papel passa a ler e o que ele continua sem poder fazer.

Nada que já existe na conta é alterado: trilhas, destinos de log, buckets, assinaturas e políticas continuam como
estão, e o **WAF nunca é tocado**. O Verax Control não liga nenhum serviço na sua conta. A trilha do CloudTrail e o
export do GuardDuty só são criados se você pedir na pilha (o padrão é não).

O conector anterior, com papel e ExternalId (`verax-control-connector.yaml`), está **obsoleto**: não use em contas
novas (seção no fim).

## O que a pilha cria

| Recurso                                  | Para quê                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Papel `/verax/verax-control-reader`      | O nó entra nele com o token do Google (`sts:AssumeRoleWithWebIdentity`), em sessões de até 1 hora. Tem as duas políticas abaixo e, como limite de permissões (_permissions boundary_), a `VeraxControlReader`. |
| Política `/verax/VeraxControlReader`     | A leitura mínima, abaixo. Como também é o limite de permissões do papel, uma política que alguém anexe a ele depois não passa dela.                                                                            |
| Política `/verax/VeraxControlGuardrails` | As negações explícitas, abaixo.                                                                                                                                                                                |

O ARN do papel é sempre `arn:aws:iam::<sua conta>:role/verax/verax-control-reader`: o painel o deriva do ID da conta
que você cadastrou. Nenhuma saída da pilha é segredo.

## Quem entra no papel

Só o nó do Verax Control que atende a sua empresa. A política de confiança do papel, com valores fictícios:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SoONoDaVerax",
      "Effect": "Allow",
      "Principal": { "Federated": "accounts.google.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "accounts.google.com:aud": "123456789012345678901",
          "accounts.google.com:sub": "123456789012345678901",
          "accounts.google.com:oaud": "https://control.veraxsistemas.com.br/aws-reader"
        },
        "IpAddress": {
          "aws:SourceIp": ["203.0.113.10/32"]
        }
      }
    }
  ]
}
```

- **`Federated: accounts.google.com`:** o Google é um provedor de identidade já embutido na AWS, e não se cria
  provedor OIDC no IAM. Só a troca do token (`sts:AssumeRoleWithWebIdentity`) é permitida; nenhum usuário, papel ou
  conta da AWS entra.
- **`accounts.google.com:aud` e `accounts.google.com:sub`:** o ID único da conta de serviço do nó, com 21 dígitos. No
  token de uma conta de serviço, a AWS lê o `aud` do campo `azp`, que é esse ID. O `sub` é o identificador estável: uma
  conta de serviço apagada e recriada com o mesmo nome ganha outro ID e não entra mais. O ID não é segredo, mas não se
  forja, porque o token é assinado pelo Google.
- **`accounts.google.com:oaud`:** o _audience_ que o nó pede ao Google, `https://control.veraxsistemas.com.br/aws-reader`,
  o mesmo para todo cliente. Um token que o nó emitiu para outro destino não serve aqui.
- **`aws:SourceIp`:** o IP de saída do nó. Um token vazado não entra de outro lugar.

Todas as condições comparam o valor exato (`StringEquals` e `IpAddress`), sem curinga. Cada cliente tem o próprio nó e
a própria conta de serviço: se outro cliente da Verax cadastrar a sua conta AWS no painel dele, o nó dele chega com
outro `sub` e de outro IP, e o seu papel recusa. É isso que substitui o ExternalId do conector antigo.

> **Não crie o papel pelo assistente "Web identity → Google" do console da AWS.** Ele grava o audience em
> `accounts.google.com:aud`, onde a AWS espera o ID da conta de serviço, e o papel nunca aceitaria o nó. Use o
> template ou a política escrita à mão (seção "Sem CloudFormation").

Se a sua organização usa uma RCP (_resource control policy_) de perímetro de dados que nega a federação de provedores
fora de uma lista, inclua `accounts.google.com` nela ou marque o papel como exceção. A decisão é sua.

## O que cada permissão libera

O papel tem uma parte que vale sempre, a **descoberta**, que só enxerga configuração, e três **autorizações** que você
liga ou desliga ao criar a pilha (`true` ou `false`; o padrão é `true`). Com uma autorização desligada, a permissão
dela nem é criada na política. Nenhuma delas escreve, cria, apaga ou altera nada na conta.

| O quê                         | Parâmetro              | O que o papel passa a ler                                                       |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| Descoberta e postura          | (vale sempre)          | Só configuração: o que a conta registra e como está protegida. Nenhum conteúdo  |
| Logs que a AWS grava no S3    | `ReadAwsServiceLogs`   | Os objetos da pasta `AWSLogs/<conta>/`, em qualquer bucket, e só eles           |
| Achados de segurança          | `ReadSecurityFindings` | Os achados do GuardDuty, do Security Hub, do Inspector e do IAM Access Analyzer |
| Grupos do CloudWatch Logs     | `ReadTaggedLogGroups`  | Os eventos só dos grupos de log que você etiquetar com `verax-control=leitura`  |
| Buckets fora do padrão da AWS | `LogBucketArns`        | Os buckets que você informar, inteiros (ou só os prefixos de `LogObjectPrefix`) |

O papel carrega duas etiquetas que não dão permissão nenhuma, só informam: `verax-control:template` (a versão deste
modelo, `2`) e `verax-control:capabilities` (o que foi autorizado, separado por espaço, como
`discovery service-logs findings log-groups`). O nó as lê do próprio papel, e o painel mostra o que está ligado.

### Descoberta e postura (vale sempre)

Serve para o painel mostrar as fontes de log que existem na conta, sem ninguém digitar bucket, ARN, região ou nome de
grupo, e para as telas de Ativos e Postura. O papel vê **configuração e nomes**. Ele não lê evento de log, achado,
objeto de bucket nem dado de banco, e não liga, desliga nem altera nada.

| O que ele enxerga                                                 | Ações                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O próprio papel: as etiquetas dele e se tem permissão demais      | `iam:GetRole` e `iam:SimulatePrincipalPolicy`, **só no próprio papel**                                                                                                                                                                                                                                                                                                                                                          |
| Trilhas do CloudTrail e o que cada uma registra                   | `cloudtrail:DescribeTrails`, `cloudtrail:GetTrailStatus`, `cloudtrail:GetEventSelectors`                                                                                                                                                                                                                                                                                                                                        |
| Detectores do GuardDuty e para onde exportam                      | `guardduty:ListDetectors`, `guardduty:GetDetector`, `guardduty:ListPublishingDestinations`, `guardduty:DescribePublishingDestination`                                                                                                                                                                                                                                                                                           |
| Se o Security Hub, o Inspector e o Access Analyzer estão ativos   | `securityhub:DescribeHub`, `inspector2:BatchGetAccountStatus`, `access-analyzer:ListAnalyzers`                                                                                                                                                                                                                                                                                                                                  |
| VPCs e flow logs                                                  | `ec2:DescribeVpcs`, `ec2:DescribeFlowLogs`                                                                                                                                                                                                                                                                                                                                                                                      |
| Web ACLs do WAF e para onde vai o log de cada uma (não as regras) | `wafv2:ListWebACLs`, `wafv2:ListLoggingConfigurations`, `wafv2:GetLoggingConfiguration`                                                                                                                                                                                                                                                                                                                                         |
| Balanceadores e o log de acesso deles                             | `elasticloadbalancing:DescribeLoadBalancers`, `elasticloadbalancing:DescribeLoadBalancerAttributes`                                                                                                                                                                                                                                                                                                                             |
| O AWS Config (gravador e entrega)                                 | `config:DescribeConfigurationRecorders`, `config:DescribeConfigurationRecorderStatus`, `config:DescribeDeliveryChannels`                                                                                                                                                                                                                                                                                                        |
| Grupos do CloudWatch Logs: nome, tamanho, retenção e etiquetas    | `logs:DescribeLogGroups`, `logs:ListTagsForResource`                                                                                                                                                                                                                                                                                                                                                                            |
| A região e a cifragem de cada bucket                              | `s3:GetBucketLocation`, `s3:GetEncryptionConfiguration`                                                                                                                                                                                                                                                                                                                                                                         |
| Bancos do RDS: se são públicos e cifrados                         | `rds:DescribeDBInstances`, `rds:DescribeDBClusters`                                                                                                                                                                                                                                                                                                                                                                             |
| Ativos e Postura: IAM, EC2 e exposição dos buckets                | `iam:GetAccountSummary`, `iam:GetAccountPasswordPolicy`, `iam:ListUsers`, `iam:ListAccessKeys`, `iam:GetAccessKeyLastUsed`, `iam:ListMFADevices`, `iam:GetLoginProfile`, `ec2:DescribeRegions`, `ec2:DescribeInstances`, `ec2:DescribeSecurityGroups`, `ec2:GetEbsEncryptionByDefault`, `s3:ListAllMyBuckets`, `s3:GetBucketAcl`, `s3:GetBucketPolicyStatus`, `s3:GetBucketPublicAccessBlock`, `s3:GetAccountPublicAccessBlock` |

Das chaves de acesso dos usuários, o papel vê só a idade e o último uso, nunca o segredo. Ele não usa a política
`SecurityAudit` nem `iam:GenerateCredentialReport` (que cria o relatório na conta).

### Logs que a AWS grava no S3 (`ReadAwsServiceLogs`)

A AWS grava os logs dos serviços dela numa pasta que leva o ID da conta: `AWSLogs/<conta>/` (CloudTrail, VPC Flow
Logs, WAF, export do GuardDuty, balanceadores e Config) ou, na trilha de organização, `AWSLogs/o-<organização>/<conta>/`.
Com esta autorização, o papel lê **só o que está nessas pastas**, em qualquer bucket, e você não informa bucket nenhum.

- **`s3:GetObject`:** só os objetos em `AWSLogs/<conta>/` e `AWSLogs/o-<organização>/<conta>/`. Nenhum outro objeto
  de nenhum bucket: nem os logs de outra conta que divida o bucket com a sua, nem os seus arquivos.
- **`s3:ListBucket`:** os nomes dos objetos dessas mesmas pastas.
- **O que o papel vê além disso, e é bom você saber:** para achar a pasta `AWSLogs`, o coletor lista o primeiro nível
  do bucket. Com isso o papel consegue ver os **nomes** das pastas e dos arquivos que ficam na raiz de qualquer bucket
  da conta, e os IDs de conta e de organização dentro de `AWSLogs/`. São só nomes (com o tamanho e a data dos arquivos
  da raiz): ele não abre nenhuma outra pasta e **só lê conteúdo em `AWSLogs/<conta>/`**.
- **`kms:Decrypt`:** só quando quem pede é o S3, ao entregar um objeto cifrado com SSE-KMS que o papel pode ler. O
  papel não usa a chave direto no KMS, nem por outro serviço. Se a política da chave não delega as permissões ao IAM
  da conta, inclua o papel nela.

Três limites, para não haver surpresa:

- Num bucket de **outra conta** (o bucket central da organização, por exemplo), a política do bucket e a da chave
  também precisam liberar o papel. A permissão do papel, sozinha, não alcança o bucket de outra conta.
- A regra do IAM compara texto: um objeto que tenha `AWSLogs/<conta>/` mais adiante no nome, depois de outra pasta,
  também passa. Os logs gravados pela AWS nunca têm o caminho de outra conta assim.
- Logs **fora desse padrão** não entram: um prefixo seu antes de `AWSLogs`, VPC Flow Logs em formato Hive, entregas do
  Firehose e o log de acesso do S3. Para eles, use os buckets adicionais, abaixo.

### Achados de segurança (`ReadSecurityFindings`)

O papel lê os achados pela API de cada serviço: `guardduty:ListFindings` e `guardduty:GetFindings`;
`securityhub:GetFindings` e `securityhub:GetEnabledStandards`; `inspector2:ListFindings` e `inspector2:ListCoverage`;
`access-analyzer:ListFindings` e `access-analyzer:GetFinding`.

Ele **não ativa** nenhum desses serviços (ativar tem custo na AWS, e a decisão é sua), não arquiva, não altera nem
apaga achado, e não envia nada ao Security Hub. Um serviço desligado só aparece no painel como "não habilitado".

### Grupos do CloudWatch Logs que você etiquetar (`ReadTaggedLogGroups`)

Log de aplicação pode ter dado pessoal. Por isso, mesmo com esta autorização ligada, o papel **não lê nenhum grupo de
log** até você pôr nele a etiqueta `verax-control` com o valor `leitura`. É você quem escolhe, grupo a grupo:

```sh
aws logs tag-resource --resource-arn <arn do log group> --tags verax-control=leitura
```

O ARN é o do grupo, sem o `:*` do fim: `arn:aws:logs:<região>:<conta>:log-group:<nome>` (o campo `logGroupArn` de
`aws logs describe-log-groups`). Para tirar a leitura de um grupo, tire a etiqueta:

```sh
aws logs untag-resource --resource-arn <arn do log group> --tag-keys verax-control
```

- Nos grupos etiquetados, o papel lista os streams e lê os eventos (`logs:DescribeLogStreams`, `logs:GetLogEvents` e
  `logs:FilterLogEvents`). Nos outros, ele só vê o nome e as etiquetas, pela descoberta.
- O papel **não consegue etiquetar** um grupo para ganhar a leitura: `logs:TagResource` é negado a ele.
- A consulta do Logs Insights, a exportação e as assinaturas dos grupos ficam fora: o papel não tem essas permissões.

### Buckets adicionais, fora do padrão AWSLogs (`LogBucketArns`)

Só para as exceções acima. Informe em `LogBucketArns` o ARN de cada bucket (exemplo:
`arn:aws:s3:::empresa-logs-centrais`): o papel **lista e lê esses buckets inteiros** (`s3:ListBucket`,
`s3:GetBucketLocation` e `s3:GetObject`) e nenhum outro. Com `LogObjectPrefix`, só os objetos com os prefixos
informados (seção "Bucket com logs de várias contas"). Com a leitura dos logs da AWS desligada, informe também em
`LogKmsKeyArns` as chaves KMS desses buckets: o papel decifra só com elas, e só pelo S3. Vazio, o papel não lê nenhum
bucket além do padrão.

### Como revogar

- **Uma autorização:** atualize a pilha com o parâmetro dela em `false` (no console, _Update stack_ → _Use existing
  template_ e troque o valor; ou o comando da CLI, abaixo). A permissão sai da política, e a etiqueta do papel passa a
  dizer o que ficou. No painel, o bloco "Atualize a pilha" entrega o arquivo já com a escolha nova; ao trocar o
  arquivo pelo console, confira o parâmetro na tela dos parâmetros, porque o console mantém o valor que a pilha tinha.
- **Um grupo de log:** tire a etiqueta `verax-control` dele (comando acima). Não é preciso mexer na pilha.
- **Um bucket adicional:** tire o ARN dele de `LogBucketArns` e atualize a pilha.
- **Tudo:** apague a pilha (seção "Como desconectar"). Sem o papel, o nó não entra mais na conta.

A mudança vale em instantes, também para a sessão que o nó já tem aberta: a AWS confere a política a cada chamada. Para
cortar de uma vez todas as sessões já emitidas, use o _Revoke active sessions_ do IAM (seção "Como desconectar").

### O que o papel nunca faz

O papel não tem nenhuma permissão de escrita, a não ser a do log de acesso dos ALB, só se você pedir
(`EnableAlbAccessLogs`, abaixo). O teste do template compara cada ação liberada com uma lista exata, e falha se
aparecer qualquer outra. Além disso, a política `VeraxControlGuardrails` nega explicitamente, o que vale
mesmo se alguém anexar outra política ao papel:

- **qualquer chamada de fora do IP do nó** (`NodeEgressIps`), mesmo com uma sessão já emitida: as credenciais de uma
  sessão vazada não servem de outro lugar. Duas exceções, as duas inevitáveis: o `sts:GetCallerIdentity`, que a AWS não
  deixa negar por política e que só revela a conta e o ARN da sessão; e a chamada que um serviço da AWS faz em nome do
  papel (o S3 pedindo ao KMS para decifrar um objeto que o nó leu), que chega de um endereço da própria AWS. Essa
  segunda só acontece depois de uma leitura feita do IP do nó: de outro lugar, a chamada ao S3 já é negada;
- apagar, alterar, assinar, exportar ou etiquetar no CloudWatch Logs; apagar, gravar ou replicar no S3; parar, apagar
  ou alterar trilhas; alterar o WAF ou o log dele; arquivar findings ou ligar, desligar e alterar o GuardDuty, o
  Security Hub, o Inspector e o Access Analyzer; criar ou apagar flow logs; alterar o Config e os balanceadores;
  desativar ou apagar chaves KMS;
- ampliar o próprio acesso: nenhuma escrita no IAM (nem na confiança, no limite ou nas etiquetas do próprio papel),
  `PassRole`, assumir outros papéis ou `GetFederationToken`;
- com `LogObjectPrefix`, ler objetos dos buckets adicionais fora dos prefixos.

## Antes de começar

- Use um usuário ou papel com permissão de administrador na conta. A pilha cria nomes fixos no IAM e põe etiquetas no
  papel, então o CloudFormation pede a confirmação `CAPABILITY_NAMED_IAM`.
- Os **três valores do nó** estão no painel, em Contas cloud → AWS, e o botão **Conectar com AWS** já os entrega
  preenchidos. Nenhum deles é segredo:
  - o **ID da conta de serviço do nó** (`NodeServiceAccountId`), com 21 dígitos;
  - o **IP de saída do nó** (`NodeEgressIps`), com `/32` (até 4, separados por vírgula);
  - o **audience** (`Audience`), `https://control.veraxsistemas.com.br/aws-reader`.

  Sem o ID e o IP, a pilha não é criada.

- Decida o que autorizar (seção "O que cada permissão libera"). Você pode começar com menos e ligar o resto depois,
  atualizando a pilha.
- Só se tiver logs fora do padrão `AWSLogs/<conta>/`: cadastre os buckets no painel, em Contas cloud → a conta AWS →
  **Buckets de log**. O painel confere as regras de nome do S3 e mostra o `LogBucketArns` pronto, com o ARN de cada um
  (exemplo: `arn:aws:s3:::empresa-logs-centrais`).

## Como criar a pilha

Crie uma pilha só por conta, porque os nomes no IAM são únicos na conta. Qualquer região serve; com o export do
GuardDuty, use a região do detector.

**Pelo painel (o caminho mais curto):**

1. No painel, em Contas cloud → AWS, escolha o que autorizar e clique em **Conectar com AWS**. O painel baixa o
   arquivo `verax-control-reader-<conta>.yaml` e abre o console do CloudFormation na criação de pilha. O arquivo é
   este mesmo template, com os valores do seu nó e as suas escolhas já gravados como o padrão dos parâmetros. Ele não
   tem segredo, e você pode compará-lo com o deste repositório: só mudam as linhas `Default:` desses parâmetros.
2. No console da AWS: _Create stack_ → _With new resources (standard)_ → _Upload a template file_, escolha o arquivo
   baixado e avance. O console guarda o arquivo num bucket `cf-templates-…` que ele cria na sua conta: é o
   comportamento padrão do CloudFormation.
3. Dê o nome `verax-control-reader` à pilha e **revise os parâmetros**, que já vêm preenchidos: quem entra no papel e
   o que ele pode ler. Mude o que quiser: vale o que fica na pilha. Se uma autorização ficar diferente do que você
   marcou no painel, a tela "Pilha na AWS" avisa e mostra a diferença.
4. Avance até a revisão, marque _I acknowledge that AWS CloudFormation might create IAM resources with custom names_
   e clique em _Submit_. A pilha fica pronta em 1 ou 2 minutos.
5. Volte ao painel do Verax Control. Ele confere a conexão sozinho; se preferir, clique em **Verificar conexão**, na
   conta. Enquanto a pilha não termina, o papel ainda não existe e o painel mostra a conta aguardando; logo depois da
   criação, o papel pode levar alguns minutos para valer. Não há nada para copiar ou colar. Depois, o Verax Control
   confere a cada 15 minutos e, uma vez por dia, se o papel ganhou permissão além da leitura
   (`SimulatePrincipalPolicy` no próprio papel). Todas as chamadas são de leitura e aparecem no CloudTrail da conta, na
   sessão `verax-control-reader/verax-control-worker`.

**Manual, pelo console:** baixe o `verax-control-reader.yaml` (pelo painel ou deste repositório), siga os passos 2 a
5 e, no passo 3, preencha os três valores do nó que o painel mostra.

**Pela CLI** (ou no AWS CloudShell, com o arquivo enviado pelo menu _Actions_ → _Upload file_). O template tem cerca
de 47 KB, abaixo do limite de 51.200 bytes do CloudFormation, e vai direto, sem bucket. Os valores abaixo são
fictícios: troque pelos seus e pelos do painel, que também mostra o comando pronto.

```sh
aws cloudformation deploy --stack-name verax-control-reader \
  --template-file verax-control-reader.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    NodeServiceAccountId=123456789012345678901 \
    NodeEgressIps=203.0.113.10/32 \
    ReadAwsServiceLogs=true \
    ReadSecurityFindings=true \
    ReadTaggedLogGroups=true
```

O mesmo comando atualiza uma pilha que já existe: para ligar ou desligar uma autorização, troque o valor dela e rode
de novo. Só as políticas e a etiqueta do papel mudam, e o nó continua entrando.

**Quem já tem a pilha do modelo anterior** (a que pedia os buckets): atualize a pilha com este arquivo (_Update
stack_ → _Replace existing template_, ou o comando acima). Os parâmetros que você já tinha continuam valendo, os
buckets informados continuam legíveis, e as três autorizações entram ligadas; desligue as que não quiser.

Para incluir ou tirar um **bucket adicional** depois, mude a lista no painel (**Buckets de log**, na conta) e
atualize a pilha com o `LogBucketArns` novo que o painel mostra (_Update stack_ → _Use existing template_ no console,
ou o comando do painel, que cria ou atualiza a pilha e leva sempre o `LogBucketArns`, vazio quando não há bucket). Ao
salvar outra lista, a conexão volta a "Aguardando" e o painel não confere nada sozinho: depois de atualizar a pilha,
clique em **Verificar conexão**.

## Como desconectar

1. No painel, remova a conta: a coleta para.
2. Se quiser cortar na hora as sessões já emitidas (cada uma vale no máximo 1 hora): no console do IAM, _Roles_ →
   `verax-control-reader` → aba _Revoke sessions_ → _Revoke active sessions_. O IAM grava no papel a política
   `AWSRevokeOlderSessions`, que nega tudo às sessões emitidas antes do clique.
3. Apague a pilha `verax-control-reader` (CloudFormation → _Delete_). Sem o papel, o nó não consegue mais entrar. Os
   buckets e a chave KMS criados pela pilha (se houver) ficam, com os logs; apague-os quando não precisar mais deles
   (uma pilha nova cria outros). Nenhum log ou recurso seu é afetado.

Não existe chave para lembrar de apagar.

## Num incidente

- **Para tirar o acesso da Verax na hora:** os passos 2 e 3 de "Como desconectar".
- **Para ver o que o nó fez:** no seu CloudTrail, cada entrada no papel aparece como `AssumeRoleWithWebIdentity`, com
  o ID da conta de serviço do nó e o IP de origem, e cada leitura, como a sessão
  `assumed-role/verax-control-reader/...`.

## Opcional: trilha e export do GuardDuty

O padrão é não. Com eles, a pilha cria recursos novos, e nada que já existe muda:

- **`CreateTrail=true`:** uma trilha multi-região `verax-control`, com validação de integridade, num bucket novo
  (saída `TrailBucketArn`) cifrado com uma chave KMS nova (`alias/verax-control-logs`). Use só se a conta não tiver
  trilha: uma segunda trilha dos mesmos eventos de gerenciamento é cobrada pela AWS.
- **`EnableGuardDutyExport=true`**, com o `GuardDutyDetectorId` do detector já ativo na região
  (`aws guardduty list-detectors`): exporta os findings para um bucket novo (saída `GuardDutyBucketArn`), cifrado com
  a chave da pilha. A pilha não ativa o GuardDuty; sem o ID do detector, ela é recusada.

Os buckets criados são privados, versionados, com retenção de `LogRetentionDays` dias (365 por padrão) e log de
acesso num terceiro bucket (saída `AccessLogsBucketArn`). O nome dos três é gerado pelo CloudFormation (começa com o
nome da pilha). O papel já lê os dois de log, com ou sem a autorização dos logs da AWS: cadastre no painel (**Buckets
de log**) as saídas `TrailBucketArn` e `GuardDutyBucketArn`; o campo aceita o ARN como a saída mostra.

Se uma opção for desligada ou a pilha apagada, a trilha e o export param, mas os buckets e a chave ficam na conta, com
os logs. Ligar a opção de novo, ou recriar a pilha, cria buckets e chave novos (por isso o nome não é fixo: a criação
nunca esbarra num bucket que ficou); cadastre as saídas novas no painel e apague os buckets antigos quando não
precisar mais dos logs deles.

O WAF aceita um só destino de log por Web ACL, e a pilha nunca o troca. O log que o WAF já grava direto no S3 (num
bucket `aws-waf-logs-*`, exigência da AWS) fica em `AWSLogs/<conta>/WAFLogs/` e é lido pela autorização dos logs da
AWS, sem cadastrar o bucket.

## Opcional: o painel liga o log de acesso dos ALB (`EnableAlbAccessLogs`)

O padrão é não. Com `EnableAlbAccessLogs=true`, a pilha:

- cria um bucket novo, só para o log de acesso dos balanceadores de aplicação (ALB) **desta região** (o ALB só grava
  num bucket da região dele): privado, versionado, com SSE-S3 (o ALB não grava com chave do KMS) e retenção de
  `LogRetentionDays` dias. A política do bucket só deixa a entrega de logs do ELB
  (`logdelivery.elasticloadbalancing.amazonaws.com`, a política atual da AWS para toda região) gravar em
  `AWSLogs/<sua conta>/`, e só para balanceadores desta região e conta. O papel lê esse bucket. Saída
  `AlbLogsBucketName`;
- deixa o papel chamar `elasticloadbalancing:ModifyLoadBalancerAttributes` nos ALB desta região
  (`loadbalancer/app/*`). Toda outra ação de alteração do balanceador continua negada (`Modify*` nos ouvintes, regras,
  grupos de destino e nos NLB, e a capacidade e os IPs do ALB). O IAM não filtra qual atributo muda: quem garante que
  só o log muda é o código do nó, que só manda `access_logs.s3.enabled`, `access_logs.s3.bucket` (o bucket desta
  pilha) e `access_logs.s3.prefix` (vazio), e só quando alguém do seu time clica em **Ligar logs** no painel;
- põe no papel a etiqueta `verax-control:alb-logs-bucket` (`<região>/<bucket>`), que diz ao nó para onde ligar o log.

O nó nunca troca o destino de um log que já está ligado, e o **Desligar logs** do painel só desliga o que o próprio
painel ligou, se o destino ainda for este bucket. O log tem custo na AWS (o S3 grava e guarda os arquivos).

Desligar a opção (ou apagar a pilha) tira a permissão, mas o bucket e a política dele ficam na conta, com os logs: um
ALB que ainda grava nele não perde o log. Para parar de vez, desligue o log de cada ALB (no painel ou no console do
EC2) antes de apagar o bucket: senão, a AWS pode gravar o log num bucket de mesmo nome que outra pessoa criar.

## Bucket com logs de várias contas

Com a leitura dos logs da AWS (`ReadAwsServiceLogs`), não há o que configurar: num bucket que recebe os logs de
várias contas (a trilha da organização, por exemplo), o papel só lê a pasta desta conta, `AWSLogs/<conta>/` ou
`AWSLogs/o-<organização>/<conta>/`. Se o bucket é de outra conta, a política dele (e a da chave KMS) precisa liberar o
papel.

O `LogObjectPrefix` é só para um **bucket adicional** com logs de várias contas num layout próprio: informe os
prefixos desta conta, separados por vírgula e terminados em `/`, como `logs-centrais/AWSLogs/111111111111/`. Os
prefixos valem para todos os buckets adicionais informados.

- Só a leitura dos objetos fica limitada. A listagem continua no bucket adicional inteiro (o nome dos objetos, que
  traz a conta e a data, mas não o conteúdo), porque o coletor do Wazuh lista o bucket a partir da raiz.
- Por limitação da política do IAM, um objeto que tenha o prefixo mais adiante no nome, depois de uma `/`, também
  passa. Os logs que a AWS grava nunca têm o caminho de outra conta assim.
- Os prefixos não tiram o que a leitura dos logs da AWS liberou: a pasta `AWSLogs/<conta>/` continua legível em
  qualquer bucket.
- O nó de cada cliente é dedicado: só os logs desta conta chegam ao painel.

## Sem CloudFormation

O `verax-control-reader.policy.json` traz a confiança (`AssumeRolePolicyDocument`) e as duas políticas com os mesmos
valores fictícios (a conta `111111111111`, a conta de serviço `123456789012345678901`, três buckets adicionais e o
IP `203.0.113.10/32`) e as três autorizações ligadas. Troque pelos seus e pelos do painel, e apague o que não se
aplicar: as declarações dos buckets adicionais (`ListarBucketsDeLog` e `LerObjetosDeLog`) e as de uma autorização que
você não queira dar (as de `Sid` `LerLogsDaAwsDestaConta`, `ListarLogsDaAwsDestaConta`, `VerPrimeiroNivelDosBuckets`
e `DecifrarLogsDaAwsSoPeloS3`; `LerAchadosDeSeguranca`; `LerGruposDeLogEtiquetados`). Ponha no papel as duas
etiquetas, com a lista do que ficou (sempre com `discovery`; o IAM não aceita vírgula no valor, por isso o espaço). O
audience não muda. A trilha e o export do GuardDuty ficam só na pilha.

### Com a CLI

Com o `jq` (já instalado no AWS CloudShell):

```sh
conta=$(aws sts get-caller-identity --query Account --output text)
aws iam create-policy --path /verax/ --policy-name VeraxControlReader --policy-document "$(jq -c .VeraxControlReader verax-control-reader.policy.json)"
aws iam create-policy --path /verax/ --policy-name VeraxControlGuardrails --policy-document "$(jq -c .VeraxControlGuardrails verax-control-reader.policy.json)"
aws iam create-role --path /verax/ --role-name verax-control-reader --max-session-duration 3600 --permissions-boundary "arn:aws:iam::$conta:policy/verax/VeraxControlReader" --assume-role-policy-document "$(jq -c .AssumeRolePolicyDocument verax-control-reader.policy.json)" --tags Key=verax-control:template,Value=3 'Key=verax-control:capabilities,Value=discovery service-logs findings log-groups'
aws iam attach-role-policy --role-name verax-control-reader --policy-arn "arn:aws:iam::$conta:policy/verax/VeraxControlReader"
aws iam attach-role-policy --role-name verax-control-reader --policy-arn "arn:aws:iam::$conta:policy/verax/VeraxControlGuardrails"
```

Para mudar uma política depois, use `aws iam create-policy-version --set-as-default` com o arquivo editado; para mudar
a confiança, `aws iam update-assume-role-policy`; e, se a lista do que foi autorizado mudar, `aws iam tag-role` com a
etiqueta `verax-control:capabilities` nova.

### Com Terraform

O mesmo papel num projeto Terraform seu, com o provedor `hashicorp/aws`. As duas políticas vêm do mesmo arquivo, e a
confiança fica escrita no código, com os valores do painel no lugar dos fictícios:

```hcl
locals {
  verax = jsondecode(file("${path.module}/verax-control-reader.policy.json"))
}

resource "aws_iam_policy" "verax_control_reader" {
  name   = "VeraxControlReader"
  path   = "/verax/"
  policy = jsonencode(local.verax.VeraxControlReader)
}

resource "aws_iam_policy" "verax_control_guardrails" {
  name   = "VeraxControlGuardrails"
  path   = "/verax/"
  policy = jsonencode(local.verax.VeraxControlGuardrails)
}

resource "aws_iam_role" "verax_control_reader" {
  name                 = "verax-control-reader"
  path                 = "/verax/"
  max_session_duration = 3600
  permissions_boundary = aws_iam_policy.verax_control_reader.arn
  tags = {
    "verax-control:template"     = "2"
    "verax-control:capabilities" = "discovery service-logs findings log-groups"
  }
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SoONoDaVerax"
      Effect    = "Allow"
      Principal = { Federated = "accounts.google.com" }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "accounts.google.com:aud"  = "123456789012345678901"
          "accounts.google.com:sub"  = "123456789012345678901"
          "accounts.google.com:oaud" = "https://control.veraxsistemas.com.br/aws-reader"
        }
        IpAddress = { "aws:SourceIp" = ["203.0.113.10/32"] }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "verax_control_reader" {
  for_each = {
    reader     = aws_iam_policy.verax_control_reader.arn
    guardrails = aws_iam_policy.verax_control_guardrails.arn
  }

  role       = aws_iam_role.verax_control_reader.name
  policy_arn = each.value
}
```

## Custos na sua conta

O papel e as políticas não têm custo, e a troca do token no STS também não. A leitura gera requisições do S3 (e do
KMS, nos buckets com SSE-KMS) e a transferência dos logs para fora da AWS, cobradas pela AWS conforme o volume. Os valores estão nos
[preços do S3](https://aws.amazon.com/s3/pricing/) e na [calculadora da AWS](https://calculator.aws/); com o CloudTrail
compactado, o volume é pequeno. O log completo do WAF e os VPC Flow Logs podem pesar mais, e a leitura dos grupos do
CloudWatch Logs paga a transferência dos eventos lidos: etiquete só os grupos de que precisa. As chamadas de
descoberta e de leitura dos achados não são cobradas pela AWS. Ligar o GuardDuty, o Security Hub, o Inspector, uma
trilha nova ou flow logs tem custo na AWS, e o Verax Control nunca liga nenhum deles: a decisão é sua. Cada
entrada do nó no papel é um evento de gerenciamento a mais no seu CloudTrail (alguns por hora, por bucket), que a
primeira trilha da conta registra sem custo. A trilha e o export opcionais somam o armazenamento nos buckets novos e,
no caso da trilha, a cópia extra dos eventos se a conta já tiver outra.

## Conector com papel e ExternalId (obsoleto)

> **Obsoleto desde a revisão de 04/11/2026.** Não use em contas novas: o nó do Verax Control roda fora da AWS e lê
> pelo papel de leitura sem chave acima. O arquivo `verax-control-connector.yaml` fica guardado para um futuro modo
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
`tests/test_reader.py` monta a pilha com valores fictícios, decide cada chamada com as duas políticas juntas e cada
entrada no papel com a confiança, e confere que o `verax-control-reader.policy.json` é a pilha com os valores do
exemplo e que a confiança deste README e o exemplo de Terraform são os mesmos. Do modelo 2, ele confere que cada
autorização soma só as declarações dela (nas oito combinações), que toda ação liberada está numa lista exata
(`ALLOWED_ACTIONS`: uma ação nova só passa se entrar nela e neste README), os padrões do S3 e a etiqueta dos grupos de
log, as etiquetas do papel e o tamanho das políticas (o limite do IAM é 6.144 caracteres; a maior fica a mais de 500
dele). Localmente:

```sh
python3 -m venv .venv && .venv/bin/pip install --require-hashes --no-deps -r infra/cloudformation/requirements-lint.txt
.venv/bin/cfn-lint infra/cloudformation/*.yaml
.venv/bin/python -m unittest discover -s infra/cloudformation/tests -v
cfn-guard validate --rules infra/cloudformation/guard/verax-control-reader.guard \
  --data infra/cloudformation/verax-control-reader.yaml
cfn-guard test --rules-file infra/cloudformation/guard/verax-control-reader.guard \
  --test-data infra/cloudformation/guard/verax-control-reader.tests.yaml
```

O arquivo que o botão **Conectar com AWS** baixa é montado no navegador por `prefillReaderTemplate`
(`packages/shared/src/aws-reader.ts`): o texto deste template com a linha `Default:` de sete parâmetros trocada pelos
valores do nó e da conta, cada um conferido antes de entrar. O teste dela compara linha a linha com este arquivo.
Por isso os parâmetros ficam como estão escritos aqui: um por bloco, com `Type:` e `Default:` cada um na sua linha.

O que muda ao mexer nas permissões:

- a versão do modelo (`verax-control:template`, hoje `2`) sobe quando o nó precisa distinguir o papel novo do antigo;
  o painel a compara com `AWS_READER_TEMPLATE_VERSION`;
- as ações de cada autorização têm espelho em `packages/shared/src/read-keys.ts` (o usuário IAM da VM própria do
  cliente usa as mesmas), e um teste compara os dois com o `verax-control-reader.policy.json`;
- o valor da etiqueta `verax-control:capabilities` é separado por espaço porque o IAM recusa vírgula no valor de uma
  etiqueta (`[\p{L}\p{Z}\p{N}_.:/=+\-@]*`).

Os dois valores de quem entra no papel que não mudam de cliente para cliente:

- **O audience `https://control.veraxsistemas.com.br/aws-reader` é uma constante do produto:** o padrão do parâmetro
  `Audience`, o valor que o nó pede ao Google ao emitir o token (no PR-V4', `AWS_WEB_IDENTITY_AUDIENCE` no
  `node.conf`) e o que o painel mostra. Mudá-lo exige atualizar a pilha de todos os clientes.
- **O ID único da conta de serviço do nó** sai da saída `service_account_unique_id` do módulo
  `infra/gcp/modules/node` (na homologação, `terraform output node_service_account_unique_id`). Recriada, a conta
  ganha outro ID, e o papel de todo cliente daquele nó deixa de aceitá-la. Ela não tem `prevent_destroy` (a
  homologação é destruída entre as janelas de teste, e a exclusão do cliente destrói tudo): o que a recriaria sai só
  do `name_prefix` e do `project_id`, um teste do módulo confere que as mudanças de rotina não a recriam, e o executor
  do Terraform do plano de controle (CP-07) vai recusar um plano que a recrie ou apague fora da exclusão do cliente.
  Uma conta apagada por engano volta com o mesmo ID em até 30 dias (`gcloud iam service-accounts undelete`); depois
  disso, cada cliente atualiza a pilha com o ID novo.

O checkov não avalia as duas políticas gerenciadas do papel de leitura, porque elas têm declarações condicionais
(`Fn::If`): quem as confere são os testes e o cfn-guard (uma regra por declaração de cada autorização, com o recurso
e a condição comparados inteiros). Os recursos opcionais (trilha e export) só entram na
varredura com os parâmetros ligados; o checkov roda com os padrões, que os desligam.
