# Prowler agendado

Imagem da tarefa que analisa a configuração das contas AWS conectadas todo dia (T4.7). É a imagem oficial do
Prowler 5.47.0, fixada por digest, mais o `entrypoint.py` da Verax. A infraestrutura (ECR, ECS Fargate, EventBridge
Scheduler, bucket e papéis) está em `infra/terraform/modules/prowler`.

## Como funciona

1. O EventBridge Scheduler dispara a tarefa todo dia às 03:00 (horário de Brasília), numa subnet privada, sem IP
   público.
2. O entrypoint lê a lista de contas no segredo `<nome>/prowler-targets`, mantido pela API. Cada item tem
   `tenantId`, `accountId`, `externalId` e, opcionalmente, `regions`. A lista inteira é validada: um valor fora
   do formato interrompe a execução antes de qualquer análise.
3. Para cada conta, assume `arn:aws:iam::<conta>:role/VeraxControlReadOnly` com o `ExternalId` dela (sessão de 1
   hora) e roda o Prowler com essa credencial **só no ambiente do processo do Prowler**. O processo não herda nada
   da credencial da tarefa.
4. Envia o JSON-OCSF para `s3://<bucket>/<tenantId>/<conta>/<AAAA-MM-DD>/prowler-<horário>.ocsf.json` com a
   credencial da tarefa: a credencial do cliente nunca escreve na conta da Verax. O bucket é privado, cifrado com
   KMS e apaga os relatórios brutos depois de 90 dias (a nota e o histórico ficam no banco da API).
5. Uma conta com erro não impede as outras. A tarefa termina com código 1 se alguma falhou (alarme da T8.6) e com
   código 2 se a configuração ou a lista forem inválidas.

`ExternalId` e credenciais nunca vão para o log nem para argumentos de processo. A tarefa roda como usuário sem
privilégio (uid 1000), com a raiz do sistema de arquivos só leitura e `/tmp` como único diretório gravável.

## Publicar uma versão

O pipeline de deploy (E8) constrói esta imagem, envia ao ECR (tags imutáveis, varredura na publicação) e informa o
digest ao Terraform em `prowler_image_digest`. Sem digest, só a base existe (repositório, bucket, segredo e papéis),
sem tarefa nem agendamento.

## Testar localmente

```sh
python3 -m unittest discover -s infra/prowler/tests -v
docker build -t verax-prowler:teste infra/prowler
docker run --rm --read-only --tmpfs /tmp verax-prowler:teste   # sem configuração: código 2
```

Os testes simulam STS, S3, Secrets Manager e o processo do Prowler; nenhum deles acessa a AWS.
