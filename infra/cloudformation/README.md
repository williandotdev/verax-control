# Acesso de leitura do Verax Control à sua conta AWS

O template `verax-control-reader.yaml` cria na sua conta o papel IAM **somente leitura** `verax-control-reader`
(caminho `/verax/`) e duas políticas gerenciadas. **Não existe chave de acesso:** ninguém cria, copia, guarda ou troca
uma chave. O nó do Verax Control roda na Google Cloud e prova quem é com um token que o Google assina para a conta de
serviço dele e que vale no máximo 1 hora. A AWS troca esse token por uma sessão do papel, também de no máximo 1 hora,
e **só aceita o pedido vindo do IP de saída do nó**. O motivo de usar um papel sem chave está em `docs/ARQUITETURA.md`
("Por que papel sem chave").

Nada que já existe na conta é alterado: trilhas, destinos de log, buckets, assinaturas e políticas continuam como
estão, e o **WAF nunca é tocado**. A trilha do CloudTrail e o export do GuardDuty só são criados se você pedir na
pilha (o padrão é não).

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

## O que o papel pode fazer

| Permissão                                                                                                                                                                                                     | Alcance                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Listar e ler objetos de log (`s3:ListBucket`, `s3:GetBucketLocation` e `s3:GetObject`)                                                                                                                        | **Só** os buckets de `LogBucketArns` (e os criados pela pilha). Com `LogObjectPrefix`, só os objetos com o prefixo |
| Decifrar esses objetos (`kms:Decrypt`), e só pelo S3                                                                                                                                                          | **Só** as chaves de `LogKmsKeyArns` (e a criada pela pilha)                                                        |
| Simular as próprias permissões (`iam:SimulatePrincipalPolicy`): o Verax Control confere que o papel não tem permissão demais                                                                                  | **Só** o próprio papel                                                                                             |
| Conferir as fontes: trilhas (`cloudtrail:DescribeTrails`, `GetTrailStatus`) e o export do GuardDuty (`guardduty:ListDetectors`, `GetDetector`, `ListPublishingDestinations`, `DescribePublishingDestination`) | Toda a conta, sem acesso a dados                                                                                   |
| Ativos e Postura: usuários, chaves (só os dados, nunca o segredo), MFA e política de senha do IAM; regiões, instâncias, grupos de segurança e cifragem padrão do EBS; exposição dos buckets                   | Toda a conta, sem acesso a dados                                                                                   |

Nada além disso: sem a política `SecurityAudit` e sem `iam:GenerateCredentialReport` (que cria o relatório na
conta). Com `LogBucketArns` vazio e sem a trilha ou o export da pilha, o papel não lê o conteúdo de nenhum log.

### O que o papel nunca faz

O papel não tem nenhuma permissão de escrita, e o teste do template falha se alguma aparecer. Além disso, a política
`VeraxControlGuardrails` nega explicitamente, o que vale mesmo se alguém anexar outra política ao papel:

- **qualquer chamada de fora do IP do nó** (`NodeEgressIps`), mesmo com uma sessão já emitida: as credenciais de uma
  sessão vazada não servem de outro lugar. A única exceção é o `sts:GetCallerIdentity`, que a AWS não deixa negar por
  política e que só revela a conta e o ARN da sessão. A leitura de objetos cifrados continua funcionando do nó: o S3
  decifra no KMS em nome do papel e preserva o IP de origem;
- apagar, alterar, assinar ou exportar no CloudWatch Logs; apagar, gravar ou replicar no S3; parar, apagar ou alterar
  trilhas; alterar o log do WAF; arquivar findings ou desligar o GuardDuty, o Security Hub, o Inspector e o Access
  Analyzer; desativar ou apagar chaves KMS;
- ampliar o próprio acesso: nenhuma escrita no IAM (nem na confiança ou no limite do próprio papel), `PassRole`,
  assumir outros papéis ou `GetFederationToken`;
- com `LogObjectPrefix`, ler objetos fora dos prefixos.

## Antes de começar

- Use um usuário ou papel com permissão de administrador na conta. A pilha cria nomes fixos no IAM, então o
  CloudFormation pede a confirmação `CAPABILITY_NAMED_IAM`.
- Tenha em mãos os **três valores que o painel mostra** em Contas cloud → AWS. Nenhum deles é segredo:
  - o **ID da conta de serviço do nó** (`NodeServiceAccountId`), com 21 dígitos;
  - o **IP de saída do nó** (`NodeEgressIps`), com `/32` (até 4, separados por vírgula);
  - o **audience** (`Audience`), que já vem preenchido no template com
    `https://control.veraxsistemas.com.br/aws-reader`: só confira.

  Sem o ID e o IP, a pilha não é criada.

- Escolha os logs que o Verax Control vai ler. O relatório do diagnóstico somente leitura (`infra/diagnostico/`)
  lista as fontes que existem na conta. Cadastre os buckets no painel, em Contas cloud → a conta AWS → **Buckets de
  log**: um por fonte (o bucket da trilha do CloudTrail, o do export do GuardDuty e o `aws-waf-logs-*` que já recebe o
  log do WAF), pelo nome ou pelo ARN. O painel confere as regras de nome do S3 e mostra o `LogBucketArns` pronto, com
  o ARN de cada um (exemplo: `arn:aws:s3:::empresa-cloudtrail-logs`). Se um bucket usar SSE-KMS, informe a chave em
  `LogKmsKeyArns` (`aws s3api get-bucket-encryption --bucket <nome>`; chave comum ou multirregião, `key/mrk-...`). O
  export do GuardDuty sempre usa uma chave KMS. Vários valores vão separados por vírgula.

## Como criar a pilha

Crie uma pilha só por conta, porque os nomes no IAM são únicos na conta. Qualquer região serve; com o export do
GuardDuty, use a região do detector.

**Pelo console:**

1. Baixe o `verax-control-reader.yaml` (pelo painel ou deste repositório).
2. No console da AWS, abra o CloudFormation → _Create stack_ → _With new resources (standard)_ → _Upload a template
   file_, escolha o arquivo e avance. O console guarda o arquivo num bucket `cf-templates-…` que ele cria na sua
   conta: é o comportamento padrão do CloudFormation.
3. Dê o nome `verax-control-reader` à pilha e preencha os três valores do painel, o `LogBucketArns` que o painel
   mostra, as chaves dos logs e, se quiser, os opcionais.
4. Avance até a revisão, marque _I acknowledge that AWS CloudFormation might create IAM resources with custom names_
   e clique em _Submit_. A pilha fica pronta em 1 ou 2 minutos.
5. Volte ao painel do Verax Control e clique em **Verificar conexão**, na conta (Contas cloud → AWS). O Verax entra no
   papel e lê um objeto de cada bucket cadastrado; logo depois da criação da pilha, o papel pode levar alguns minutos
   para valer, e ele tenta de novo por até 10 minutos. Não há nada para copiar ou colar.

**Pela CLI** (ou no AWS CloudShell, com o arquivo enviado pelo menu _Actions_ → _Upload file_). O template tem cerca
de 32 KB, abaixo do limite de 51.200 bytes do CloudFormation, e vai direto, sem bucket. Os valores abaixo são
fictícios: troque pelos seus e pelos do painel.

```sh
aws cloudformation deploy --stack-name verax-control-reader \
  --template-file verax-control-reader.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    NodeServiceAccountId=123456789012345678901 \
    NodeEgressIps=203.0.113.10/32 \
    LogBucketArns=arn:aws:s3:::trilha-111111111111,arn:aws:s3:::guardduty-111111111111 \
    LogKmsKeyArns=arn:aws:kms:sa-east-1:111111111111:key/00000000-0000-0000-0000-000000000000
```

Para incluir ou tirar um bucket depois, mude a lista no painel (**Buckets de log**, na conta) e atualize a pilha com o
`LogBucketArns` novo que o painel mostra (_Update stack_ → _Use existing template_ no console, ou o comando do painel,
que cria ou atualiza a pilha e leva sempre o `LogBucketArns`, vazio quando não há bucket): só as políticas mudam, e o
nó continua entrando. Ao salvar outra lista, a conexão volta a "Aguardando" e o painel não confere nada sozinho:
depois de atualizar a pilha, clique em **Verificar conexão**. Um bucket novo com SSE-KMS também pede a chave dele em
`LogKmsKeyArns`.

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
nome da pilha). O papel já lê os dois de log: cadastre no painel (**Buckets de log**) as saídas `TrailBucketArn` e
`GuardDutyBucketArn`; o campo aceita o ARN como a saída mostra.

Se uma opção for desligada ou a pilha apagada, a trilha e o export param, mas os buckets e a chave ficam na conta, com
os logs. Ligar a opção de novo, ou recriar a pilha, cria buckets e chave novos (por isso o nome não é fixo: a criação
nunca esbarra num bucket que ficou); cadastre as saídas novas no painel e apague os buckets antigos quando não
precisar mais dos logs deles.

O WAF aceita um só destino de log por Web ACL, e a pilha nunca o troca: cadastre no painel o bucket que já recebe o
log (`aws-waf-logs-*`, exigência da AWS para o log direto no S3); ele vai no `LogBucketArns` com os outros.

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

O `verax-control-reader.policy.json` traz a confiança (`AssumeRolePolicyDocument`) e as duas políticas com os mesmos
valores fictícios (a conta `111111111111`, a conta de serviço `123456789012345678901`, os buckets, a chave e o IP
`203.0.113.10/32`). Troque pelos seus e pelos do painel, e apague os buckets e a declaração `DecifrarSoPeloS3` se não
se aplicarem. O audience não muda. A trilha e o export do GuardDuty ficam só na pilha.

### Com a CLI

Com o `jq` (já instalado no AWS CloudShell):

```sh
conta=$(aws sts get-caller-identity --query Account --output text)
aws iam create-policy --path /verax/ --policy-name VeraxControlReader --policy-document "$(jq -c .VeraxControlReader verax-control-reader.policy.json)"
aws iam create-policy --path /verax/ --policy-name VeraxControlGuardrails --policy-document "$(jq -c .VeraxControlGuardrails verax-control-reader.policy.json)"
aws iam create-role --path /verax/ --role-name verax-control-reader --max-session-duration 3600 --permissions-boundary "arn:aws:iam::$conta:policy/verax/VeraxControlReader" --assume-role-policy-document "$(jq -c .AssumeRolePolicyDocument verax-control-reader.policy.json)"
aws iam attach-role-policy --role-name verax-control-reader --policy-arn "arn:aws:iam::$conta:policy/verax/VeraxControlReader"
aws iam attach-role-policy --role-name verax-control-reader --policy-arn "arn:aws:iam::$conta:policy/verax/VeraxControlGuardrails"
```

Para mudar uma política depois, use `aws iam create-policy-version --set-as-default` com o arquivo editado; para mudar
a confiança, `aws iam update-assume-role-policy`.

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
compactado, o volume é pequeno. O log completo do WAF pode pesar mais. Cada
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
exemplo e que a confiança deste README e o exemplo de Terraform são os mesmos. Localmente:

```sh
python3 -m venv .venv && .venv/bin/pip install --require-hashes --no-deps -r infra/cloudformation/requirements-lint.txt
.venv/bin/cfn-lint infra/cloudformation/*.yaml
.venv/bin/python -m unittest discover -s infra/cloudformation/tests -v
cfn-guard validate --rules infra/cloudformation/guard/verax-control-reader.guard \
  --data infra/cloudformation/verax-control-reader.yaml
cfn-guard test --rules-file infra/cloudformation/guard/verax-control-reader.guard \
  --test-data infra/cloudformation/guard/verax-control-reader.tests.yaml
```

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
(`Fn::If`): quem as confere são os testes e o cfn-guard. Os recursos opcionais (trilha e export) só entram na
varredura com os parâmetros ligados; o checkov roda com os padrões, que os desligam.
