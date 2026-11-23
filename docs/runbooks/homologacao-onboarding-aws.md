# Homologação do onboarding AWS self-service

Roteiro para conferir, numa **conta AWS de teste** e no **nó de homologação**, o que os testes do repositório não
provam: eles usam clientes falsos do SDK e a imagem do Wazuh sem rede, e nenhum chama a AWS (`docs/ARQUITETURA.md`,
"Onboarding AWS self-service", tabela "O que foi conferido onde"). Cada conferência abaixo tem um número (H-01 a
H-25), os comandos ou os passos no console, e o resultado esperado. Anote o resultado de cada uma na tabela do fim.

> **Nunca rode nada deste roteiro numa conta de cliente.** Ele cria recursos, gera achados de exemplo, nega
> permissões de propósito e apaga a pilha. A conta é uma conta AWS de teste da Verax, sem dado de cliente, e o nó é o
> de homologação, sem nenhum cliente de verdade.

Os passos marcados **[custo]** criam recurso cobrado na conta de teste. A seção 5 lista tudo o que foi criado e como
apagar. Os valores dos exemplos são fictícios (a conta `111111111111`): troque pelos da conta de teste e não os
escreva em nenhum arquivo do repositório.

## 1. Antes de começar

### 1.1 O que é preciso

1. **Uma conta AWS de teste**, com acesso de administrador pelo console e pelo AWS CloudShell (os comandos `aws`
   abaixo rodam lá). Se houver uma organização de teste (AWS Organizations), as conferências H-07 (SCP) e H-12
   (trilha de organização) também podem ser feitas; sem ela, ficam como "não aplicável".
2. **O nó de homologação** (`infra/gcp/envs/homolog-sp`, perfil `standard`, em São Paulo), criado e ligado como no
   `infra/gcp/GUIA.md` (seção "O nó de homologação: o que muda"). Ele fica parado fora das janelas de teste:

   ```bash
   gcloud compute instances start verax-homolog --zone southamerica-east1-b --project PROJETO_DOS_NOS
   cd infra/gcp/envs/homolog-sp
   terraform output nat_ip                           # o IP de saída do nó
   terraform output node_service_account_unique_id   # o ID da conta de serviço do nó (21 dígitos)
   terraform output ssh_command                      # como entrar na VM, pelo IAP
   ```

   Depois de um `destroy` seguido de `apply`, a conta de serviço e o IP são novos: os dois valores mudam, e uma pilha
   antiga na conta de teste deixa de aceitar o nó.

3. **A versão com o onboarding no nó de homologação.** O `infra/node/bin/deploy.sh` só instala imagens publicadas
   pelo workflow `Imagens do nó`, que roda na `main`: a homologação acontece **depois** do merge da branch de
   integração na `main` (decisão do responsável) e **antes** de promover uma versão para a frota. O merge não muda
   nenhum nó de cliente: cada nó só anda com uma versão promovida (seção 6).

   ```bash
   infra/node/bin/deploy.sh COMMIT caminho/para/node.conf   # docs/runbooks/no-verax.md, "Instalar ou atualizar"
   ```

   No `node.conf` do nó de homologação (`docs/runbooks/onboarding-cliente.md`, seção 4, item 2): `NODE_PROFILE=standard`,
   `SYNC_SOURCES` com `wazuh`, `NODE_EGRESS_IPS=<nat_ip>/32` e `NODE_SA_UNIQUE_ID=<o ID de 21 dígitos>`.

4. **O painel do nó de homologação**, do mesmo commit, e um cliente de teste ("Cliente Demo A") com um administrador
   (`docs/runbooks/onboarding-cliente.md`, seção 4, itens 3 e 4). Um segundo cliente de teste ("Cliente Demo B") só é
   preciso na H-15, para a fila sem dono.

### 1.2 Atalhos usados nos comandos

No CloudShell da conta de teste:

```bash
export CONTA=111111111111     # o ID da conta AWS de TESTE
export REGIAO=sa-east-1       # a região principal cadastrada no painel
export REGIAO2=us-east-1      # uma segunda região, para a H-09
```

Na VM do nó de homologação, como root (`sudo -i`):

```bash
cd /opt/verax/wazuh && export COMPOSE_FILE=/opt/verax/compose.yaml:/opt/verax/compose.wazuh.yaml \
  COMPOSE_ENV_FILES=/etc/verax/images.env,/run/verax/memory.env
sql() { docker compose exec -T postgres psql -U verax -d verax -c "$1"; }
worker_log() { docker compose logs --tail "${1:-200}" worker; }
export CONTA=111111111111     # a mesma conta de teste
export REGIAO=sa-east-1       # a mesma região principal
```

- **O estado da conta e das fontes, sem o painel:**

  ```bash
  sql "SELECT connection, \"connectionError\", \"collectionError\", \"awsTemplateVersion\", \"awsCapabilities\", \"awsChosenCapabilities\", \"awsDiscoveredRegions\" FROM \"CloudAccount\" WHERE \"accountId\" = '$CONTA'"
  sql "SELECT trigger, status, \"requestedAt\", \"finishedAt\", regions, errors FROM \"AwsDiscoveryRun\" r JOIN \"CloudAccount\" a ON a.id = r.\"cloudAccountId\" WHERE a.\"accountId\" = '$CONTA' ORDER BY r.\"requestedAt\" DESC LIMIT 5"
  sql "SELECT kind, region, name, availability, permission, \"permissionDetail\", state, \"stateCode\", \"lastSyncAt\", \"lastEventAt\", \"lagSeconds\" FROM \"AwsSource\" s JOIN \"CloudAccount\" a ON a.id = s.\"cloudAccountId\" WHERE a.\"accountId\" = '$CONTA' ORDER BY kind, region, name"
  ```

- **Os sinais do host** (sem segredo): `cat /run/verax/wazuh-signal/applied`, `cat /run/verax/wazuh-signal/progress`
  e `cat /run/verax/wazuh-signal/aws-token`.
- **O log do módulo da AWS no manager:**
  `docker compose exec -T wazuh.manager grep -E 'wm_aws|aws-s3' /var/ossec/logs/ossec.log | tail -40`.
- **Os alertas no indexer** (`infra/wazuh/README.md`, "Ler os alertas sem o dashboard"):

  ```bash
  source scripts/lib-indexer.sh
  indexer_admin GET '/wazuh-alerts-*/_search?size=5&sort=timestamp:desc' </dev/null && echo "$response_body"
  ```

- **Uma chamada com o papel, do IP do nó.** O papel só aceita o nó, vindo do IP dele. Para conferir uma permissão
  exata (H-03 a H-05), a chamada sai do contêiner do manager, com o profile que o gerador escreve para a conta (a
  sessão aparece no CloudTrail como `verax-control-reader/verax-control-wazuh`). O profile só existe depois de a conta
  ter ao menos uma fonte de bucket ou um grupo de logs autorizado:

  ```bash
  papel() { docker compose exec -T wazuh.manager /var/ossec/framework/python/bin/python3 - "$@"; }
  ```

  Cada conferência manda um pequeno script pela entrada padrão. Nada é gravado, e só chamadas de leitura são feitas.

## 2. Conectar: a pilha a partir do YAML preenchido

Com a conta de teste **ainda sem** CloudTrail, GuardDuty, Security Hub e Inspector ligados por este roteiro (a H-08
usa esse estado):

1. No painel, com o administrador do Cliente Demo A: Contas cloud → Cadastrar conta → AWS, com o ID da conta de teste
   e a região principal (`sa-east-1`). Nenhum bucket.
2. Em "O que você autoriza", **desmarque "Grupos do CloudWatch Logs marcados"** (a H-24 confere a escolha gravada; a
   autorização é ligada depois, na H-15).
3. Clique em **Conectar com AWS**. O navegador baixa `verax-control-reader-<conta>.yaml` e abre o CloudFormation.
4. Confira o arquivo baixado contra o template do repositório, antes de enviar:

   ```bash
   diff --strip-trailing-cr infra/cloudformation/verax-control-reader.yaml ~/Downloads/verax-control-reader-$CONTA.yaml
   ```

   **Esperado:** só linhas `Default:`. Duas a mais: a do `NodeServiceAccountId` (o ID de 21 dígitos) e a do
   `NodeEgressIps` (`<nat_ip>/32`), que o template do repositório não traz. Duas trocadas: a do `Audience` (o valor
   deste nó, agora entre aspas) e a do `ReadTaggedLogGroups` (`'false'`). Nenhuma outra linha, nenhum recurso e
   nenhuma declaração de política.

5. No CloudFormation da conta de teste: _Create stack_ → _Upload a template file_ → o arquivo; nome
   `verax-control-reader`; avance **sem mudar os valores**; marque a confirmação de IAM e crie.
6. Volte ao painel e **não clique em nada**.

## 3. Linha do tempo esperada

| Quando                                | Na tela ("Situação da conexão")                | `state`                  | O que conferir                                                                                                                     |
| ------------------------------------- | ---------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| No clique                             | Aguardando autorização na AWS                  | `awaiting_authorization` | O aviso "O Verax não enxerga a pilha enquanto ela é criada" e o tempo restante (60 min)                                            |
| Pilha `CREATE_COMPLETE` (1 a 2 min)   | idem                                           | idem                     | O nó tenta a 20 s, 40 s e depois a cada 60 s: a entrada acontece em até 1 min depois de o papel existir                            |
| Até 1 min depois                      | Descoberta em andamento                        | `discovering`            | A conferência "Entrada no papel de leitura" passa a Certo; "Modelo da pilha e autorizações", Certo                                 |
| Segundos a poucos minutos             | Aguardando autorização de fontes               | `awaiting_sources`       | "O que encontramos" com o retrato da conta; "Fontes de log" com as listas                                                          |
| Depois de autorizar uma fonte         | Configurando coletores                         | `configuring`            | A fonte em "Aguardando o coletor iniciar"                                                                                          |
| Até 1 min + o reinício do manager     | idem                                           | idem                     | Fonte de bucket ou grupo de logs: "Configurada, ainda sem eventos" quando o `applied` diz `ok` para a lista nova                   |
| Até 5 min (achados)                   | Coletando eventos, ou Parcialmente operacional | `collecting`/`partial`   | Fonte de achados: "Coletando" (ou "Sincronizada, sem achados novos") na leitura seguinte da tarefa `aws-findings`                  |
| 10 a 20 min (bucket e grupos de logs) | Coletando eventos                              | `collecting`             | O módulo lê a cada 5 min, e o host exporta os marcadores a cada 5 min; a AWS entrega os objetos da trilha com 5 a 15 min de atraso |

Anote os horários reais. Uma etapa que demore muito mais que isso é um achado da homologação.

## 4. Conferências

### H-01. Entrada no papel e identidade

1. No painel, "Conferências da conexão": **Entrada no papel de leitura** e **Conta e papel conferidos** em Certo.
2. No CloudTrail da conta de teste (em até 15 min; a entrada no papel é registrada na região do STS usado):

   ```bash
   aws cloudtrail lookup-events --region $REGIAO --max-results 5 \
     --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
     --query 'Events[].CloudTrailEvent' --output text | head -c 3000
   ```

   **Esperado:** `userIdentity.identityProvider` = `accounts.google.com`, o `userName` (o `sub`) igual ao
   `node_service_account_unique_id`, `sourceIPAddress` igual ao `nat_ip`, `roleSessionName` = `verax-control-worker`
   (e, com fontes no Wazuh, `verax-control-wazuh`), e o papel `…:role/verax/verax-control-reader`.

3. **A recusa por IP:** atualize a pilha com `NodeEgressIps=198.51.100.1/32` (um IP de documentação) e clique em
   "Verificar conexão". **Esperado:** "Desconectada", com `trust_denied` na conferência da entrada. Volte o valor
   certo, "Verificar conexão": conectada de novo, sem perder fonte nem autorização.
4. **A conta errada:** cadastre no painel uma segunda conta AWS com um ID que não é o da conta de teste (por
   exemplo `222222222222`) e clique em "Conectar com AWS" sem criar pilha. **Esperado:** fica em "Aguardando
   autorização na AWS" até a janela fechar (60 min) e termina em "Tempo esgotado". Desative essa conta depois.

### H-02. Tags do papel: versão do template e autorizações

```bash
aws iam list-role-tags --role-name verax-control-reader --query 'Tags[?starts_with(Key, `verax-control`)]'
```

**Esperado:** `verax-control:template` = `2` e `verax-control:capabilities` = `discovery service-logs findings` (sem
`log-groups`, que foi desmarcado no passo 2). No painel, "Pilha na AWS": "versão 2 (atual)", "Logs de serviços da AWS
no S3: ligada", "Achados de segurança: ligada", "Grupos do CloudWatch Logs marcados: desligada". No banco,
`awsTemplateVersion = 2`, `awsCapabilities = {discovery,service-logs,findings}` e
`awsChosenCapabilities = 'service-logs findings'`.

### H-03. IAM: `logs:GetLogEvents` honra a tag do grupo _(não provado sem a AWS)_

A referência do IAM lista a condição `aws:ResourceTag` para `GetLogEvents`, mas o recurso da chamada é o stream, que
não tem tag própria. É preciso ver as duas pontas: com a tag, a leitura passa; sem a tag, é negada.

1. Crie dois grupos de teste, um stream e um evento em cada um, e ponha a tag só no primeiro:

   ```bash
   for g in /verax/homolog/com-tag /verax/homolog/sem-tag; do
     aws logs create-log-group --region $REGIAO --log-group-name $g
     aws logs put-retention-policy --region $REGIAO --log-group-name $g --retention-in-days 1
     aws logs create-log-stream --region $REGIAO --log-group-name $g --log-stream-name s1
     aws logs put-log-events --region $REGIAO --log-group-name $g --log-stream-name s1 \
       --log-events timestamp=$(date +%s000),message='homologacao verax'
   done
   aws logs tag-resource --tags verax-control=leitura \
     --resource-arn arn:aws:logs:$REGIAO:$CONTA:log-group:/verax/homolog/com-tag
   ```

2. Ligue a autorização dos grupos de logs: em "Pilha na AWS" → "Atualize a pilha", marque "Grupos do CloudWatch Logs
   marcados", baixe o arquivo, atualize a pilha (**confira o parâmetro `ReadTaggedLogGroups` em `true` na tela dos
   parâmetros**) e clique em "Verificar de novo". Autorize no painel o grupo `/verax/homolog/com-tag` (para o profile
   da conta existir no manager).
3. No nó, com o papel:

   ```bash
   papel <<PY
   import boto3, botocore
   logs = boto3.Session(profile_name='verax-$CONTA').client('logs', region_name='$REGIAO')
   for group in ('/verax/homolog/com-tag', '/verax/homolog/sem-tag'):
       for call in ('describe_log_streams', 'get_log_events', 'filter_log_events'):
           args = {'logGroupName': group, 'limit': 1}
           if call == 'get_log_events':
               args['logStreamName'] = 's1'
           try:
               getattr(logs, call)(**args)
               print(group, call, 'PERMITIDO')
           except botocore.exceptions.ClientError as error:
               print(group, call, error.response['Error']['Code'])
   PY
   ```

   **Esperado:** as três chamadas `PERMITIDO` no grupo com a tag, e `AccessDeniedException` nas três no grupo sem a
   tag. Se `get_log_events` for negado **com** a tag, a coleta dos grupos de logs não funciona como está: é um
   bloqueio para a produção (o template precisa de outra forma de limitar a leitura).

### H-04. IAM: a condição `s3:prefix` vazia, pelo CloudFormation _(não provado sem a AWS)_

O módulo do Wazuh lista o primeiro nível do bucket com o prefixo vazio. A política o permite com `s3:prefix` igual a
`""`, e é preciso ver que o valor vazio sobreviveu ao CloudFormation e que o S3 o avalia como esperado.

1. A política como ficou na conta:

   ```bash
   arn=arn:aws:iam::$CONTA:policy/verax/VeraxControlReader
   aws iam get-policy-version --policy-arn $arn \
     --version-id $(aws iam get-policy --policy-arn $arn --query Policy.DefaultVersionId --output text) \
     --query 'PolicyVersion.Document.Statement[?Sid==`VerPrimeiroNivelDosBuckets`]'
   ```

   **Esperado:** `"s3:prefix": ["", "AWSLogs", "AWSLogs/"]` e `"s3:delimiter": "/"`.

2. Num bucket de teste com um arquivo na raiz, uma pasta qualquer e a pasta `AWSLogs/` (o bucket da trilha da H-11
   serve, com um objeto de teste a mais: `aws s3 cp - s3://<bucket>/outra-pasta/teste.txt <<< teste`), no nó:

   ```bash
   papel <<PY
   import boto3, botocore
   s3 = boto3.Session(profile_name='verax-$CONTA').client('s3', region_name='$REGIAO')
   bucket = 'NOME_DO_BUCKET_DE_TESTE'
   cases = {
       'primeiro nível (prefixo vazio, com /)': {'Prefix': '', 'Delimiter': '/'},
       'AWSLogs/ (com /)': {'Prefix': 'AWSLogs/', 'Delimiter': '/'},
       'a pasta desta conta': {'Prefix': 'AWSLogs/$CONTA/', 'MaxKeys': 1},
       'outra pasta': {'Prefix': 'outra-pasta/', 'Delimiter': '/'},
       'o bucket inteiro (sem /)': {},
       'a pasta de outra conta': {'Prefix': 'AWSLogs/222222222222/', 'MaxKeys': 1},
   }
   for name, args in cases.items():
       try:
           s3.list_objects_v2(Bucket=bucket, **args)
           print(name, 'PERMITIDO')
       except botocore.exceptions.ClientError as error:
           print(name, error.response['Error']['Code'])
   try:
       s3.get_object(Bucket=bucket, Key='outra-pasta/teste.txt')
       print('ler fora de AWSLogs', 'PERMITIDO')
   except botocore.exceptions.ClientError as error:
       print('ler fora de AWSLogs', error.response['Error']['Code'])
   PY
   ```

   **Esperado:** os três primeiros `PERMITIDO`; os três seguintes e a leitura fora de `AWSLogs/` com `AccessDenied`.
   Qualquer `PERMITIDO` a mais é um vazamento de permissão, e bloqueia a produção.

### H-05. IAM: objeto com SSE-KMS sob a negação por IP _(não provado sem a AWS)_

A negação `SoDoNoDaVerax` tem a exceção `aws:ViaAWSService`, para o S3 poder pedir ao KMS a chave de um objeto que o
papel lê. Usa o bucket com KMS da H-10.

```bash
papel <<PY
import boto3, botocore
session = boto3.Session(profile_name='verax-$CONTA')
s3 = session.client('s3', region_name='$REGIAO')
bucket = 'NOME_DO_BUCKET_COM_KMS'
key = s3.list_objects_v2(Bucket=bucket, Prefix='AWSLogs/$CONTA/', MaxKeys=1)['Contents'][0]['Key']
head = s3.head_object(Bucket=bucket, Key=key)
print('cifra do objeto:', head.get('ServerSideEncryption'), head.get('SSEKMSKeyId'))
s3.get_object(Bucket=bucket, Key=key, Range='bytes=0-0')
print('ler 1 byte pelo S3: PERMITIDO')
try:
    session.client('kms', region_name='$REGIAO').decrypt(KeyId=head['SSEKMSKeyId'], CiphertextBlob=b'homologacao')
    print('decifrar direto no KMS: PERMITIDO')
except botocore.exceptions.ClientError as error:
    print('decifrar direto no KMS:', error.response['Error']['Code'])
PY
```

**Esperado:** `cifra do objeto: aws:kms <arn da chave>`, a leitura de 1 byte `PERMITIDO` e a chamada direta ao KMS
com `AccessDeniedException` (o texto cifrado da chamada é inventado: qualquer outra resposta, como
`InvalidCiphertextException`, quer dizer que o KMS aceitou o papel fora do S3, e é para investigar antes da
produção). No painel, a fonte desse bucket com a permissão conferida (sem `kms_denied`). Se a leitura pelo S3 for
negada, a exceção `aws:ViaAWSService` não cobre o caso: bloqueio para a produção.

A contraprova da negação por IP: do CloudShell (outro IP), ninguém entra no papel, e a H-01 (passo 3) já mostrou a
recusa com o IP trocado.

### H-06. Descoberta completa

Depois da H-11 à H-19 (com os serviços ligados), clique em "Descobrir de novo".

**Esperado:** "Última descoberta: completa"; em "O que encontramos", o retrato com os números da conta (compare
`instâncias`, `buckets`, `VPCs`, `Web ACLs`, `trilhas` e `grupos de logs` com o console); em "Fontes de log", uma
linha para cada trilha, flow log, Web ACL com log no S3, detector, o Security Hub, o Inspector, cada analisador e cada
grupo de logs. No banco, a execução `succeeded`, com `errors = []`. No CloudTrail da conta de teste, só chamadas
`Describe*`, `Get*`, `List*` e `BatchGet*` da sessão `verax-control-worker`:

```bash
aws cloudtrail lookup-events --region $REGIAO --max-results 50 \
  --lookup-attributes AttributeKey=Username,AttributeValue=verax-control-worker \
  --query 'Events[].EventName' --output text | tr '\t' '\n' | sort | uniq -c
```

### H-07. Descoberta parcial

Negue um serviço de propósito, **só na conta de teste**, com uma política em linha no papel (fora da pilha):

```bash
aws iam put-role-policy --role-name verax-control-reader --policy-name homologacao-negar-rds \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"rds:Describe*","Resource":"*"}]}'
```

"Descobrir de novo" (uma a cada 5 min). **Esperado:** "Última descoberta: parcial"; "Descoberta parcial: N leituras
ficaram de fora", com "Bancos do RDS", a região e "sem permissão para ler"; o retrato mostra os bancos do RDS como
"não lido" (nunca zero); as fontes já descobertas e as autorizadas continuam como estavam; a conferência "Descoberta das fontes" fica
Certo com a ressalva. Tire a negação e descubra de novo:

```bash
aws iam delete-role-policy --role-name verax-control-reader --policy-name homologacao-negar-rds
```

Opcional, com uma organização de teste: a mesma negação por uma SCP numa unidade organizacional só com a conta de
teste. O resultado esperado é o mesmo.

A outra forma de ver o que falta, sem negar nada: uma autorização desligada na pilha (H-22, passo 2) deixa as fontes
do tipo em "Precisam de permissão adicional", com `capability_off`.

### H-08. Conta sem CloudTrail, GuardDuty e Security Hub

Logo depois da seção 2 (a conta recém-conectada), antes de ligar qualquer serviço. **Esperado:** a descoberta termina
completa; a conta fica em "Aguardando autorização de fontes"; em "Não habilitadas na AWS", uma linha para cada
serviço que a conta de teste não tem em nenhuma região (o CloudTrail, os VPC Flow Logs, o GuardDuty, o Security Hub,
o Inspector e o Access Analyzer), com o aviso de que ligar tem custo na AWS e de que o Verax nunca liga nada.
Nenhuma fonte "disponível" desses serviços, nada autorizado, nenhum erro.

### H-09. Várias regiões

Crie um grupo de logs na segunda região (`aws logs create-log-group --region $REGIAO2 --log-group-name
/verax/homolog/regiao2`) e, se a H-13 for feita, um flow log numa VPC de `$REGIAO2`. "Descobrir de novo".
**Esperado:** as fontes da segunda região aparecem com a região certa; `awsDiscoveredRegions` e as regiões
monitoradas da conta ganham `$REGIAO2`; o `run.regions` traz todas as regiões habilitadas da conta. Uma região
desligada (fora do opt-in) aparece no máximo como uma leitura que ficou de fora, sem derrubar a descoberta.

### H-10. Bucket com KMS **[custo]**

Uma trilha gravando num bucket cifrado com uma chave KMS própria (a chave custa cerca de US$ 1 por mês, proporcional
aos dias). O caminho mais curto é a própria pilha: atualize-a com `CreateTrail=true` (a pilha cria o bucket, a chave
e a trilha, em todas as regiões). **Esperado:** a trilha aparece como fonte disponível, com o bucket e a pasta dela,
e a permissão conferida (a sondagem leu 1 byte de um objeto cifrado com a chave). Use esse bucket na H-05.

Depois, tire o papel da política da chave de **outro** bucket cifrado (ou crie um segundo bucket de teste com uma
chave que não delega ao IAM da conta, e ponha nele uma cópia de um objeto de `AWSLogs/<conta>/`): "Verificar de novo"
na fonte. **Esperado:** "Falta permissão: a chave KMS do bucket não decifra os logs para o Verax", com a declaração
pronta para a política da chave.

### H-11. CloudTrail, trilha da conta, de ponta a ponta **[custo: o armazenamento do bucket]**

1. Com a trilha da H-10 (ou outra, de gerenciamento, em todas as regiões), "Descobrir de novo" e autorize a fonte
   "CloudTrail (trilha)".
2. Gere um evento que uma regra pega, na conta de teste, por exemplo um grupo de segurança aberto e fechado em
   seguida:

   ```bash
   # Numa conta sem a VPC padrão, acrescente --vpc-id <uma VPC de teste>.
   sg=$(aws ec2 create-security-group --region $REGIAO --group-name verax-homolog --description homologacao \
     --query GroupId --output text)
   aws ec2 authorize-security-group-ingress --region $REGIAO --group-id $sg --protocol tcp --port 22 --cidr 0.0.0.0/0
   aws ec2 delete-security-group --region $REGIAO --group-id $sg
   ```

3. **Esperado, em 15 a 30 min:** a fonte passa por "Aguardando o coletor iniciar", "Configurada, ainda sem eventos"
   e "Coletando", com o último evento e a última leitura; o `applied` com `ok` e o `seq` uma unidade acima; no
   `progress`, a tabela `cloudtrail` com o último objeto lido da conta e da região; em Achados, "Grupo de segurança
   aberto para a internet em porta de administração remota" (regra 100317, crítica), com a conta de teste. As
   leituras do próprio nó (`ListObjectsV2`, `GetObject`) não viram achado (regras de nível 0).
4. **Sem histórico:** confirme que nenhum evento anterior ao dia da autorização virou achado (`only_logs_after` no
   `ossec.conf`: `docker compose exec -T wazuh.manager grep -A8 '<bucket type="cloudtrail">' /var/ossec/etc/ossec.conf`).

### H-12. Trilha de organização _(só com uma organização de teste)_

Com uma trilha de organização gravando num bucket da conta de gerenciamento (a conta de teste como membro, ou ela
mesma). **Esperado:** a fonte aparece como trilha de organização, com o ID `o-…` lido dos nomes de `AWSLogs/` no
bucket; num bucket de outra conta, "Precisa de permissão" (`bucket_denied`) até a política do bucket citar o papel;
autorizada, o `ossec.conf` leva `aws_organization_id` e a pasta `AWSLogs/o-…/<conta>/`. Não autorize, na mesma conta,
a trilha da conta e a de organização no mesmo bucket (limite conhecido do módulo).

### H-13. VPC Flow Logs e as duas regras **[custo: os flow logs e uma instância de teste]**

1. Numa VPC de teste, um flow log para o S3, no **formato padrão** (14 campos, texto, sem partições do Hive), com o
   tráfego `REJECT` ou `ALL`:

   ```bash
   aws ec2 create-flow-logs --region $REGIAO --resource-type VPC --resource-ids vpc-EXEMPLO \
     --traffic-type REJECT --log-destination-type s3 --log-destination arn:aws:s3:::NOME_DO_BUCKET_DE_TESTE
   ```

2. "Descobrir de novo" e autorize a fonte. **Esperado na confirmação:** o aviso de volume e o de que autorizar um
   Flow Log lê todos os Flow Logs daquela conta e região que gravam no mesmo bucket.
3. **Gere tráfego recusado, só entre máquinas suas, dentro da conta de teste.** De uma instância de teste (ou do
   CloudShell numa VPC), abra conexões TCP curtas para um destino seu cujo grupo de segurança as recuse:
   - para a varredura: mais de 40 conexões, em portas diferentes (fora a 22 e a 3389), em menos de um minuto, do
     mesmo endereço de origem;
   - para a insistência: mais de 15 conexões para a porta 22 (ou a 3389) do **mesmo** destino, do mesmo endereço.

   Um laço de conexões com tempo de espera de 1 segundo basta (cada conexão sai de uma porta de origem diferente, e
   é um registro do flow log). Não aponte para nenhum endereço que não seja seu.

4. **Esperado, em 15 a 30 min** (a AWS entrega os flow logs em janelas de 1 a 10 min, e o módulo lê a cada 5 min): em
   Achados, "Possível varredura de rede vinda do mesmo endereço" (média, regra 100400) e "Insistência em porta de
   administração remota vinda do mesmo endereço" (alta, regra 100401), com a conta de teste, o endereço de origem e a
   interface; um achado por regra e por endereço, mesmo com a rajada repetida. O tráfego aceito não aparece em lugar
   nenhum (confira no indexer que não há alerta da regra 80401).
5. Um segundo flow log com **formato próprio** ou **partições do Hive**: **esperado** a fonte em "Em destino ou
   formato que o Verax não lê", com o motivo, sem opção de autorizar.

### H-14. WAF para o S3 **[custo: a Web ACL e o recurso associado]**

Uma Web ACL regional de teste, associada a um recurso de teste (um API Gateway ou um ALB), com o log para um bucket
`aws-waf-logs-<nome>`. Gere, do mesmo endereço, mais de 8 requisições em menos de dois minutos que uma regra de teste
bloqueie (um cabeçalho que a regra bloqueia), e algumas liberadas. **Esperado:** uma fonte "WAF" por Web ACL;
autorizada, o `ossec.conf` leva o caminho `AWSLogs/<conta>/WAFLogs/<região>/<nome da Web ACL>/`; em Achados, "Rajada
de bloqueios do WAF vinda do mesmo IP" (regra 80443, alta), com a conta de teste; um bloqueio sozinho e as
requisições liberadas não viram achado (as liberadas nem chegam ao analysisd). **Este caminho foi derivado do código do módulo, e não de objetos de
verdade: se a fonte ficar em "Configurada, ainda sem eventos" com objetos no bucket, compare o caminho dos objetos
(`aws s3 ls s3://aws-waf-logs-<nome>/AWSLogs/$CONTA/WAFLogs/ --recursive | head`) com o do `ossec.conf`.** Uma Web
ACL com o log no Firehose aparece como "destino não lido"; sem log, "sem destino", com o aviso de custo.

### H-15. Grupo do CloudWatch Logs: com e sem a tag, o atraso de 10 min e a fila sem dono

Com os grupos da H-03 e a autorização ligada:

1. **Sem a tag:** o grupo `/verax/homolog/sem-tag` aparece na lista dos grupos, sem caixa de marcar, com "Como
   liberar a leitura deste grupo" e o comando `aws logs tag-resource …` pronto. Rode o comando da tela e clique em
   "Verificar de novo": **esperado**, em segundos, o grupo passa a poder ser marcado.
2. **Autorizar:** marque o grupo, confirme (a confirmação de dado sensível é obrigatória). **Esperado:** em até 1 min,
   o `ossec.conf` ganha um `<service type="cloudwatchlogs">` com o grupo, `remove_log_streams` em `no` e a data de
   hoje; o `applied` com `ok` e o `seq` uma unidade acima.
3. **Um evento que uma regra pega.** Os eventos do grupo chegam crus, e só as regras genéricas do Wazuh valem. Grave
   uma linha que uma regra de fábrica reconheça, por exemplo uma falha de login do `sshd`:

   ```bash
   for i in $(seq 10); do
     aws logs put-log-events --region $REGIAO --log-group-name /verax/homolog/com-tag --log-stream-name s1 \
       --log-events timestamp=$(date +%s000),message="$(LC_ALL=C date '+%b %e %H:%M:%S') homolog sshd[4242]: Failed password for invalid user teste from 203.0.113.50 port 51234 ssh2"
   done
   ```

   São dez linhas em menos de um minuto: uma falha sozinha tem nível 5, e a regra de várias falhas seguidas (5712)
   tem nível 10. O sync dos grupos de logs lê do nível 7 para cima.

4. **Esperado:** o alerta aparece no indexer em até 10 min (`location` = `Wazuh-AWS`); **o achado só aparece no
   painel pelo menos 10 min depois do alerta** (a espera da prova do dono), como achado do Cliente Demo A, na conta de
   teste, com a origem "CloudWatch Logs". No log do worker, a tarefa `wazuh-config` com `cloudWatch: owner`.
5. **A margem de 15 min** só vale depois de uma queda da prova (o passo 6, a H-23). Num nó em que a lista já tinha
   sido aplicada antes do primeiro grupo de logs, os alertas da primeira leitura já são do cliente. Anote quando o
   primeiro achado apareceu, e se algum alerta desse grupo foi para a fila sem dono.
6. **A fila sem dono, com dois clientes:** com o Cliente Demo B, cadastre uma **segunda conta AWS de teste** (ou pule
   este passo se não houver), conecte e autorize um grupo de logs dela. **Esperado:** na conferência seguinte da
   tarefa, `cloudWatch: unproven`; os alertas novos dos grupos vão para a fila sem dono da equipe da Verax ("Origem em
   mais de um cliente"), e nenhum vira achado de A nem de B. Revogue o grupo de B: depois de a lista ser aplicada e de
   15 min de margem, os alertas voltam a virar achado de A; os que foram para a fila ficam lá.
7. **Nada apagado na origem:** `aws logs describe-log-streams --region $REGIAO --log-group-name /verax/homolog/com-tag`
   mostra o stream e os eventos intactos.

### H-16. GuardDuty: achados de exemplo **[custo: o GuardDuty, depois do período de teste]**

Só na conta de teste:

```bash
det=$(aws guardduty create-detector --region $REGIAO --enable --query DetectorId --output text)   # se ainda não houver
aws guardduty create-sample-findings --region $REGIAO --detector-id $det \
  --finding-types Recon:EC2/PortProbeUnprotectedPort UnauthorizedAccess:IAMUser/ConsoleLoginSuccess.B Backdoor:EC2/C\&CActivity.B
```

"Descobrir de novo", autorize "GuardDuty (API)" (a recomendada). **Esperado, em até 5 min:** os três achados em
Achados, com o título da AWS, a severidade pela escala do painel (9 ou mais crítica, 7 ou mais alta, 4 ou mais média)
e a conta de teste; a fonte em "Coletando", com o volume das últimas 24 h; um achado por achado de exemplo (a
sondagem de porta vira um achado por IP e porta). Rode o `create-sample-findings` de novo: **esperado** nenhum achado
novo (só o `lastSeenAt` anda); com um achado já triado no painel, a versão nova vira uma recorrência ligada ao
original.

### H-17. Security Hub **[custo: o Security Hub e os padrões, depois do período de teste]**

Ligue o Security Hub na conta de teste (`aws securityhub enable-security-hub --region $REGIAO`) e espere os primeiros
controles (algumas horas para os padrões avaliarem). Autorize "Security Hub". **Esperado:** os controles reprovados
viram achados (regra 990501), com "Controle de segurança reprovado" e o título da origem, só os ativos e ainda em
aberto no Security Hub; os achados que o Security Hub recebe do GuardDuty e do Inspector **não** aparecem duas vezes
enquanto a fonte própria do serviço estiver coletando na mesma conta e região (na dúvida, a regra é um achado
repetido, nunca um perdido: anote os repetidos que aparecerem); os bytes entram em "Plano e uso". Sem achado nenhum, a fonte fica "Sincronizada,
sem achados novos", e a conta não fica "parada".

### H-18. Inspector **[custo: o Inspector, depois do período de teste]**

Ligue o Inspector para um tipo de recurso (`aws inspector2 enable --region $REGIAO --resource-types LAMBDA`) e tenha
um recurso de teste com uma vulnerabilidade conhecida (uma função Lambda de teste com uma dependência antiga, por
exemplo). **Esperado:** os achados ativos em Achados, com a severidade da origem (`CRITICAL` crítica, `HIGH` alta);
um achado `CRITICAL` aparece (pelas regras de fábrica do Wazuh ele não apareceria: por isso a leitura é pela API).

### H-19. Access Analyzer

Um analisador de acesso externo da conta (sem custo; o de acesso sem uso é cobrado, e não é preciso):

```bash
aws accessanalyzer create-analyzer --region $REGIAO --analyzer-name verax-homolog --type ACCOUNT
```

Crie um recurso de teste com acesso externo, por exemplo um papel de teste que confie na **segunda conta de teste da
Verax** (nunca numa conta que não seja sua). **Esperado:** uma fonte "Access Analyzer" por analisador; autorizada, o
achado de acesso externo em Achados (média; público, alta). Apague o papel de teste: o achado some da origem e
continua no painel, com o status de quem triou (nada é fechado sozinho).

### H-20. Sem duplicar: o GuardDuty pela API e pelo export **[custo: o bucket e a chave do export]**

Ligue o export do GuardDuty para o S3 (pela pilha, `EnableGuardDutyExport=true` com o `GuardDutyDetectorId`, ou pelo
console). "Descobrir de novo": **esperado** o export marcado "coberto pela API". Autorize os dois e gere achados de
exemplo (H-16). **Esperado:** um achado só por achado do GuardDuty, venha por onde vier primeiro:

```bash
sql "SELECT split_part(split_part(\"sourceEventId\", 'guardduty:', 2), ':', 1) AS achado, count(*) FROM \"Finding\" WHERE \"sourceEventId\" LIKE '%guardduty:%' GROUP BY 1 HAVING count(*) > 1"
```

sem linha nenhuma (a chave do achado leva o ID do GuardDuty e a regra: duas linhas com o mesmo ID seriam o mesmo
achado gravado por dois caminhos). A única exceção esperada é a sondagem de porta com mais de um IP ou porta, que é
um achado por IP e porta nos dois caminhos. Anote se o export entrega os achados de exemplo (a AWS só exporta os
achados novos ou atualizados depois de o export ser ligado).

### H-21. Marcadores da leitura e a fonte parada

1. **Marcadores:** `cat /run/verax/wazuh-signal/progress`. **Esperado:** uma linha de JSON, com menos de 20 min, com
   o último objeto lido de cada bucket, conta e região e o último evento de cada grupo de logs autorizado; só nomes,
   nenhum conteúdo. No painel, o "Último evento" e a "Última leitura" de cada fonte batem com ele.
2. **Parada (`stalled`):** na política do bucket da trilha de teste, negue ao papel só o `s3:GetObject` (ele continua
   listando), e espere mais de 2 horas, com a trilha gravando:

   ```json
   {
     "Sid": "HomologacaoNegarLeitura",
     "Effect": "Deny",
     "Principal": { "AWS": "arn:aws:iam::111111111111:role/verax/verax-control-reader" },
     "Action": "s3:GetObject",
     "Resource": "arn:aws:s3:::NOME_DO_BUCKET_DE_TESTE/AWSLogs/*"
   }
   ```

   **Esperado:** a fonte passa a "Parada" (`no_progress`), a conta a "Parcialmente operacional" (ou "Falha de
   ingestão", se for a única), e as conferências "Chegada de eventos" e "Atraso da coleta" apontam a linha dela.
   "Tentar de novo" mostra a permissão negada. Tire a negação: na leitura seguinte, volta a "Coletando", e o Wazuh
   retoma do último objeto lido (nenhum evento perdido nem repetido: confira um evento do intervalo).

3. Uma conta quieta não é uma fonte parada: uma trilha sem objeto novo não muda de estado.

### H-22. Revogação

1. **Uma fonte:** "Revogar" numa fonte de bucket autorizada. **Esperado:** em até 1 min, ela sai do `ossec.conf`
   (o `applied` com `ok` e o `seq` uma unidade acima), volta para "Disponíveis para coletar" com "Autorização retirada
   em …", e **nada muda na origem**: o bucket, os objetos e a trilha continuam lá (confira com `aws s3 ls` e com
   `aws cloudtrail get-trail-status`). O que já foi coletado continua em Achados. Numa fonte de achados, ela deixa de
   ser lida na execução seguinte (confira no CloudTrail que as chamadas `ListFindings` pararam).
2. **Uma autorização:** em "Pilha na AWS" → "Atualize a pilha", desmarque "Achados de segurança", baixe o arquivo,
   atualize a pilha (confira o parâmetro `ReadSecurityFindings` em `false` na tela dos parâmetros) e clique em
   "Verificar de novo". **Esperado:** as tags do papel perdem `findings`; as fontes de achados autorizadas passam a
   "Erro de permissão" (`capability_off`), sem nenhuma chamada negada no CloudTrail (o nó nem tenta); as outras
   seguem coletando; a conta fica "Erro de permissão"; nenhum aviso de diferença (a escolha gravada é a da pilha).
   Ligue de novo pelo mesmo bloco e verifique: voltam a "Coletando", sem autorizar de novo.
3. **Um grupo de logs:** tire a tag (`aws logs untag-resource --resource-arn … --tag-keys verax-control`) e clique em
   "Tentar de novo". **Esperado:** "Erro de permissão" (`tag_missing`), e o grupo sai da lista do manager.
4. **Tudo:** apague a pilha. **Esperado:** em até 25 min (a conferência de 15 em 15 min, mais as tentativas), ou na
   hora com "Verificar conexão", a conta fica "Desconectada" (`trust_denied`); as fontes e as autorizações continuam
   guardadas; nada mais é lido (o CloudTrail só mostra entradas recusadas no papel). Crie a pilha de novo pelo
   "A pilha foi apagada da conta? Criar de novo": **esperado** as caixas com a escolha gravada, e a conta de volta,
   com as mesmas fontes.

### H-23. Retomada depois de uma falha

1. **O worker morto no meio da descoberta:** peça "Descobrir de novo" e, com a execução `running`, mate o worker:

   ```bash
   sql "SELECT status FROM \"AwsDiscoveryRun\" ORDER BY \"requestedAt\" DESC LIMIT 1"   # running
   docker compose kill worker && docker compose up -d worker
   ```

   **Esperado:** em até 15 min (a concessão da tarefa precisa vencer), a execução vira `failed`, com o motivo "a
   descoberta foi interrompida no meio"; nenhuma fonte fica pela metade (a execução grava tudo numa transação só); as
   fontes autorizadas seguem coletando; "Descobrir de novo" termina completa.

2. **O worker morto no meio dos achados:** mate o worker durante uma leitura grande do Security Hub (H-17).
   **Esperado:** a execução seguinte relê a página em que parou; nenhum achado duplicado e nenhum perdido (compare a
   contagem com a do console do Security Hub).
3. **O token do nó velho:** pare a renovação do token do Google do host por mais de 40 min:

   ```bash
   systemctl stop verax-aws-token.timer
   ```

   **Esperado:** passados 40 min, as contas AWS do nó mostram o aviso `aws_token_stale` (a conferência "Configuração
   dos coletores" com problema, do nó e não da conta), e as fontes do Wazuh, "Falha de ingestão"; passada 1 hora, o
   módulo deixa de ler (o token venceu). Religue (`systemctl start verax-aws-token.timer verax-aws-token.service`):
   o aviso sai, e a leitura retoma do marcador, sem perder nem repetir evento.

4. **O nó reiniciado:** `systemctl restart verax-node` (ou o reboot da VM). A parada apaga os sinais de
   `/run/verax`, e a partida aplica a configuração antes de subir o manager. **Esperado:** o contador continua de
   onde estava (`cat /var/lib/verax/wazuh-apply/seq` antes e depois: uma unidade a mais, nunca um número menor); as
   fontes voltam a "Coletando" sem autorizar de novo, e o Wazuh retoma dos marcadores; a prova do dono dos alertas
   do CloudWatch Logs recomeça (o sinal sumiu): os alertas dos grupos de logs dos 15 min seguintes vão para a fila
   sem dono, e os de depois voltam a virar achado.

### H-24. A escolha gravada e o aviso de diferença

1. Depois do passo 3 da seção 2, **recarregue a página** enquanto ela espera a pilha. **Esperado:** em "O que o
   arquivo autoriza", "Grupos do CloudWatch Logs marcados" continua desmarcado; "Baixar o arquivo de novo" baixa o
   mesmo arquivo (o `diff` do passo 4 dá o mesmo resultado). Ainda na espera, marque e desmarque uma caixa algumas
   vezes seguidas: **esperado** "Salvando a escolha…" com o botão de baixar desligado por um instante, e, recarregada
   a página, as caixas como você as deixou por último (o arquivo baixado então sai com elas).
2. **A pilha concede mais do que a escolha** (a atualização pelo console que mantém o valor antigo): em "Atualize a
   pilha", desmarque "Achados de segurança", baixe o arquivo e atualize a pilha pelo console **sem** mudar o
   parâmetro `ReadSecurityFindings` na tela dos parâmetros (o console mantém o `true` que a pilha já tinha). Clique em
   "Verificar de novo". **Esperado:** em "Pilha na AWS", o aviso "A pilha na AWS não está como você escolheu aqui",
   com "Concede mais do que a sua escolha" e o nome da autorização, e o bloco de atualização aberto com a caixa
   desmarcada. Marque a caixa de novo e clique em "Verificar de novo": o aviso some.
3. **A pilha concede menos do que a escolha:** atualize a pilha fora do painel (pela CLI ou pelo console, mudando só
   o parâmetro) com `ReadSecurityFindings=false` e clique em "Verificar conexão". **Esperado:** o mesmo aviso, agora
   dizendo que a autorização marcada aqui está desligada na pilha, e as fontes de achados em "Precisam de permissão
   adicional" ou em "Erro de permissão" (`capability_off`). Volte o parâmetro a `true` e verifique: o aviso some.
4. **Na VM própria do cliente** (se a homologação incluir uma, `docs/runbooks/instalacao-no-cliente.md`): a escolha é
   gravada no "Verificar conexão" do passo das políticas, e o aviso fala de "O usuário de leitura".

### H-25. O número de sequência do sinal `applied`

```bash
cat /run/verax/wazuh-signal/applied; cat /var/lib/verax/wazuh-apply/seq
```

**Esperado:** o `seq` do sinal igual ao do arquivo; uma unidade a mais a cada autorização ou revogação que muda a
configuração do manager (H-11, H-15, H-22); o mesmo número nas execuções do timer de 15 min sem mudança
(`journalctl -u verax-wazuh-apply`). No log do worker, a tarefa `wazuh-config` com `cloudWatch: owner` (ou `empty`,
sem grupo autorizado) depois de cada troca única; `unproven` só nos casos da H-15 (dois clientes), logo depois de o
nó reiniciar (H-23) e depois de uma aplicação que derrubou o manager.

## 5. Custos e limpeza

Tudo o que este roteiro cria fica na **conta AWS de teste**. No fim da janela, apague:

| O que foi criado                                             | Conferência | Custo                                                          | Como apagar                                                                                                            |
| ------------------------------------------------------------ | ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A pilha `verax-control-reader` (o papel e as duas políticas) | Seção 2     | Sem custo                                                      | CloudFormation → apagar a pilha. Com `CreateTrail` ou o export, os buckets da pilha ficam (retenção): esvazie e apague |
| A trilha, o bucket e a chave KMS (`CreateTrail=true`)        | H-10, H-11  | A chave (cerca de US$ 1 por mês) e o armazenamento             | Apagar a pilha; esvaziar e apagar os buckets; agendar a exclusão da chave (`aws kms schedule-key-deletion`)            |
| Os grupos de logs `/verax/homolog/*`                         | H-03, H-09  | Centavos (retenção de 1 dia)                                   | `aws logs delete-log-group --log-group-name …` em cada região                                                          |
| A política em linha `homologacao-negar-rds`                  | H-07        | Sem custo                                                      | `aws iam delete-role-policy` (some com a pilha)                                                                        |
| O flow log, a VPC e a instância de teste                     | H-13        | A instância, enquanto ligada, e os flow logs por GB            | `aws ec2 delete-flow-logs`, encerrar a instância, apagar a VPC de teste                                                |
| A Web ACL, o recurso associado e o bucket `aws-waf-logs-*`   | H-14        | A Web ACL (cerca de US$ 5 por mês), as regras e as requisições | Desassociar e apagar a Web ACL; apagar o recurso de teste; esvaziar e apagar o bucket                                  |
| O detector do GuardDuty e os achados de exemplo              | H-16, H-20  | Depois do período de teste, pelo volume analisado              | `aws guardduty delete-detector` (os achados de exemplo somem com ele); o bucket e a chave do export, como os da trilha |
| O Security Hub                                               | H-17        | Depois do período de teste, por controle avaliado              | `aws securityhub disable-security-hub`                                                                                 |
| O Inspector e o recurso vulnerável de teste                  | H-18        | Depois do período de teste, por recurso avaliado               | `aws inspector2 disable --resource-types …`; apagar a função de teste                                                  |
| O analisador `verax-homolog` e o papel de teste              | H-19        | Sem custo (acesso externo)                                     | `aws accessanalyzer delete-analyzer`; `aws iam delete-role`                                                            |
| A negação na política do bucket                              | H-21        | Sem custo                                                      | Tirar a declaração `HomologacaoNegarLeitura`                                                                           |
| A segunda conta de teste e o cliente Demo B                  | H-15, H-19  | Conforme o que foi criado nela                                 | O mesmo, nela; desativar as contas e os clientes de teste no painel                                                    |

No nó de homologação: desative as contas AWS de teste no painel e **pare a VM** (`gcloud compute instances stop
verax-homolog …`). Parada, sobram o disco, os snapshots e o IP reservado.

A própria limpeza gera achados no cliente de teste, enquanto a trilha ainda é lida ("CloudTrail parado ou apagado",
"GuardDuty desligado ou silenciado"): é o esperado, e serve de última conferência das regras críticas.

Confira no Cost Explorer da conta de teste, uma semana depois, que nada ficou cobrando.

## 6. Checklist de produção

Só depois de as conferências H-01 a H-05 passarem (as três do IAM são bloqueio) e de as demais terem o resultado
anotado.

### 6.1 Ordem

1. **O merge da branch de integração na `main`** (decisão do responsável). Com ele, sozinhos: o workflow `Plano de
controle` implanta o plano de controle e o console (só texto mudou no console; o modelo que ele serve é o
   template v2); o `Painel` publica a demonstração; o `Imagens do nó` publica as imagens da API. **Nenhum nó muda.**
2. **A homologação** (este roteiro), com o commit da `main` no nó de homologação.
3. **A versão do nó:** Actions → `Versão do nó`, com o commit homologado (`docs/runbooks/versao-no.md`, "Promover uma
   versão"). O pacote leva o `wazuh-apply.sh` novo, o gerador e as regras de flow logs; o manifesto, as imagens e o
   bundle do painel.
4. **A frota:** "Promover para a frota", no console (`docs/runbooks/console-do-responsavel.md`). A onda 0 é a célula
   da Verax: lá o onboarding fica desligado (a descoberta responde "não disponível neste ambiente"), e o que se
   confere é que nada mudou para os clientes dela. Depois, os nós dedicados, onda a onda, parando na primeira falha.
5. **Os clientes que já têm a pilha (modelo 1):** nada muda para eles. Continuam lendo os buckets do cadastro, e a
   tela mostra "Atualize a pilha". Cada um atualiza **quando quiser** a descoberta e as autorizações novas
   (`docs/runbooks/onboarding-cliente.md`, seção 4.1). Não há prazo, e ninguém atualiza a pilha por eles.
6. **A VM própria do cliente:** a mesma versão; o cliente atualiza a política e as tags do usuário de leitura quando
   quiser as autorizações novas.

### 6.2 Migrations

Seis, todas de acréscimo, aplicadas na partida do nó (`migrate`), nesta ordem: `20261124120000_aws_onboarding`,
`…130000_aws_source_retry_limit`, `…140000_aws_source_note_flow_logs`, `…150000_cloudwatch_alert_ownership`,
`…160000_aws_chosen_capabilities` e `…170000_cloudwatch_ownership_applied_seq`. A primeira cria uma fonte
"Cadastrada manualmente" para cada bucket já cadastrado: confira, num nó com contas AWS, que o número de linhas
`origin = 'legacy'` é o de buckets cadastrados e que a configuração do manager não mudou (o hash do `running` é o
mesmo, e o manager não reinicia). O banco não volta com a versão: a regra do repositório (`docs/runbooks/no-verax.md`).

### 6.3 O que acompanhar nas primeiras semanas

- **Torre da equipe da Verax:** "Medidor da AWS parado neste nó" e a **fila sem dono** (os motivos `ambiguous_source`
  dos grupos de logs depois de cada atualização do nó; `source_mismatch` e `unknown_account` dos achados de contas
  administradas).
- **Em cada nó:** `journalctl -u verax-wazuh-apply` (uma aplicação por mudança de fonte, sem laço de reinícios; o
  serviço para depois de 5 partidas em 5 min), o `applied` com `ok`, o `progress` com menos de 20 min, e o log do
  worker com as tarefas `aws-check`, `aws-discovery`, `aws-findings` e `wazuh-config` terminando sem `failed`
  repetido.
- **Volume:** "Plano e uso" de cada cliente depois de autorizar flow logs e grupos de logs; o disco do nó
  (`verax/disk-free`) e o do indexer.
- **No CloudTrail do primeiro cliente:** o número de leituras por dia da sessão `verax-control-worker` (a
  estimativa de antes da descoberta era de cerca de 1.700 entradas por dia por conta) e nenhuma chamada que não seja
  `Describe*`, `Get*`, `List*` ou `BatchGet*`.
- **Suporte:** os pedidos mais prováveis são a pilha atualizada pelo console com o parâmetro antigo (o aviso de
  diferença), o grupo de logs sem a tag e o bucket central de outra conta (`bucket_denied`).

### 6.4 Volta

- **A frota volta de versão** com a intenção `rollback` (`docs/runbooks/versao-no.md`): o host restaura o pacote, as
  imagens e as unidades de antes. O banco fica com as colunas e as tabelas novas, que a versão anterior não lê.
- **O que a volta custa:** a versão anterior só lê os buckets do cadastro. As fontes que os clientes autorizaram pelo
  onboarding self-service **deixam de ser coletadas** até a versão nova voltar (os logs continuam na origem; ao
  voltar, o Wazuh retoma dos marcadores e os coletores de achados, dos cursores, com a janela de 24 h). Um cliente
  que conectou só pelo onboarding (sem bucket no cadastro) fica sem coleta da AWS nesse intervalo. Avise antes.
- **Um cliente** sempre pode tirar o próprio acesso sem a Verax: desligar uma autorização ou apagar a pilha
  (`infra/cloudformation/README.md`, "Como revogar").
- **O template** não volta: a pilha do modelo 2 continua valendo com a versão anterior do nó para os buckets
  adicionais (`LogBucketArns`), que são o que ela lê.

## Registro do resultado

Copie a tabela para o registro da janela (fora do repositório, se tiver nome de conta ou de recurso) e preencha:

| Conferência                                            | Resultado (passou, falhou, não aplicável) | Observação (horários, diferenças do esperado) |
| ------------------------------------------------------ | ----------------------------------------- | --------------------------------------------- |
| Seção 2: o arquivo preenchido só difere nos `Default:` |                                           |                                               |
| Seção 3: a linha do tempo                              |                                           |                                               |
| H-01 Entrada no papel e identidade                     |                                           |                                               |
| H-02 Tags do papel                                     |                                           |                                               |
| H-03 `GetLogEvents` e a tag do grupo                   |                                           |                                               |
| H-04 `s3:prefix` vazio                                 |                                           |                                               |
| H-05 SSE-KMS sob a negação por IP                      |                                           |                                               |
| H-06 Descoberta completa                               |                                           |                                               |
| H-07 Descoberta parcial                                |                                           |                                               |
| H-08 Conta sem CloudTrail, GuardDuty e Security Hub    |                                           |                                               |
| H-09 Várias regiões                                    |                                           |                                               |
| H-10 Bucket com KMS                                    |                                           |                                               |
| H-11 CloudTrail, trilha da conta                       |                                           |                                               |
| H-12 Trilha de organização                             |                                           |                                               |
| H-13 VPC Flow Logs e as duas regras                    |                                           |                                               |
| H-14 WAF para o S3                                     |                                           |                                               |
| H-15 Grupo do CloudWatch Logs                          |                                           |                                               |
| H-16 GuardDuty (achados de exemplo)                    |                                           |                                               |
| H-17 Security Hub                                      |                                           |                                               |
| H-18 Inspector                                         |                                           |                                               |
| H-19 Access Analyzer                                   |                                           |                                               |
| H-20 GuardDuty pela API e pelo export                  |                                           |                                               |
| H-21 Marcadores e a fonte parada                       |                                           |                                               |
| H-22 Revogação                                         |                                           |                                               |
| H-23 Retomada depois de uma falha                      |                                           |                                               |
| H-24 A escolha gravada e o aviso de diferença          |                                           |                                               |
| H-25 O número de sequência do sinal `applied`          |                                           |                                               |
| Seção 5: tudo apagado na conta de teste                |                                           |                                               |
