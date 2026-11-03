# Nó do Verax Control (`verax-control-node.yaml`)

O nó é a VM que roda o Verax Control de um cliente: Wazuh (coleta e correlação), API, banco e o túnel do Cloudflare
por onde o painel chega à API. O template cria a VM e tudo de que ela precisa numa **rede própria e isolada**. Ele
pode rodar na conta do cliente (que paga a infraestrutura) ou numa conta da Verax: nos dois casos, o nó só lê os
dados monitorados pelo papel `VeraxControlReadOnly` do conector (`README.md`), como uma ferramenta externa.

## O que é criado

| Recurso                                                     | Para quê                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| VPC `10.250.0.0/24` com uma sub-rede e saída para internet  | Rede só do nó, sem ligação com as redes existentes da conta.                                                  |
| Grupo de segurança **sem nenhuma regra de entrada**         | Saída só para HTTPS (443) e para o túnel do Cloudflare (7844, TCP e UDP).                                     |
| VM Amazon Linux 2023 (`t3a.xlarge`, 4 vCPU e 16 GB)         | Docker com o Verax Control. Sem chave SSH: acesso só pelo Session Manager. IMDSv2 obrigatório.                |
| Disco de dados cifrado (200 GiB, gp3)                       | Alertas, banco e snapshots. Sobrevive à troca da VM e vira snapshot se o stack for apagado.                   |
| Snapshots diários do disco de dados (7 dias)                | Recuperação do disco inteiro.                                                                                 |
| Bucket privado do nó                                        | Backup do banco, snapshots do indexer, relatórios do Prowler e flow logs da VPC. Fica se o stack for apagado. |
| Papel `verax-control-node` (ou `verax-control-node-<nome>`) | Papel da VM. Veja abaixo o que ele pode e o que ele nunca faz.                                                |
| Documento e associação do State Manager                     | Instalam e atualizam a versão do Verax Control, conferida pelo SHA-256.                                       |
| Alarmes, tópico de e-mail e orçamento                       | Falha do hardware (recuperação automática), VM travada (reinício), disco acima de 80% e custo.                |

O template só cria recursos novos, com a etiqueta `verax-control-node`. Ele não altera nenhuma rede, papel, bucket,
trilha ou log que já exista na conta.

## O papel da VM

**Pode:**

- assumir o papel `VeraxControlReadOnly` de um conector (a confiança do conector ainda exige este papel exato e o
  `ExternalId` daquela conta);
- ler e gravar no bucket do próprio nó, só nas pastas `db/`, `indexer-snapshots/` e `prowler/`;
- ler os parâmetros do próprio nó (`/verax-control-node/...`), como o token do túnel;
- publicar métricas no namespace `VeraxControl/Node`;
- o básico do Session Manager e do State Manager (política AWS `AmazonSSMManagedInstanceCore`).

**Nunca faz** (negação explícita, que vale mesmo se alguém anexar outra política ao papel):

- nada no IAM, no Organizations, no CloudFormation ou no Lambda;
- criar, alterar, parar ou apagar VMs, redes, discos, snapshots e grupos de segurança;
- apagar, alterar ou desviar logs e findings (CloudWatch Logs, CloudTrail, log do WAF, GuardDuty, Security Hub,
  Inspector e Access Analyzer) ou desativar chaves KMS;
- rodar comandos em outras máquinas (`SendCommand`, `StartSession`) ou gravar parâmetros do SSM;
- assumir qualquer papel que não seja o `VeraxControlReadOnly`;
- gravar ou apagar em qualquer bucket que não seja o do nó;
- ler parâmetros do SSM que não sejam do nó (a política do Session Manager, sozinha, liberaria todos).

## Antes de começar

- Use um usuário ou papel com permissão de administrador na conta que vai hospedar o nó. O stack cria papéis com nome
  fixo, então o CloudFormation pede a confirmação `CAPABILITY_NAMED_IAM`.
- Escolha a **região dos logs monitorados**: a leitura pela API não paga transferência entre regiões.
- Tenha em mãos, da Verax: a **versão** do Verax Control e o **SHA-256** do pacote (arquivo `SHA256SUMS` da release
  `node-v<versão>` no GitHub). Sem versão, o stack cria só a infraestrutura, e a versão pode ser informada depois.
- Para o alerta de custo contar só o nó, ative a etiqueta `verax-control-node` como **etiqueta de alocação de custo**
  (Billing → _Cost allocation tags_, na conta pagadora). Até isso, o orçamento fica zerado.

## Como rodar

**Pelo console:** CloudFormation → _Create stack_ → _With new resources_ → _Upload a template file_, escolha
`verax-control-node.yaml`, preencha os parâmetros e marque a confirmação de recursos IAM.

**Pela CLI:**

```sh
aws cloudformation create-stack --stack-name verax-control-node \
  --template-body file://verax-control-node.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameters ParameterKey=AlertEmail,ParameterValue=<e-mail> \
    ParameterKey=BundleVersion,ParameterValue=<versão> ParameterKey=BundleSha256,ParameterValue=<sha-256>
aws cloudformation wait stack-create-complete --stack-name verax-control-node
aws cloudformation describe-stacks --stack-name verax-control-node --query 'Stacks[0].Outputs'
```

Depois de criado:

1. **Confirme a inscrição** no e-mail de alertas (mensagem da AWS).
2. **Grave o token do túnel** do Cloudflare, que a Verax entrega, no parâmetro da saída `TunnelTokenParameter`. Use
   um arquivo, para o token não ficar no histórico do terminal, e apague-o em seguida:

   ```sh
   aws ssm put-parameter --type SecureString --name /verax-control-node/cloudflare-tunnel-token \
     --value file://token.txt
   rm token.txt
   ```

3. **Conector:** em cada conta monitorada, use as saídas `NodeAccountId` e `NodeRoleName` nos parâmetros de mesmo
   nome do conector (`README.md`).

## Atualizar a versão

Atualize o stack (_Update stack_ → _Use current template_) com os novos `BundleVersion` e `BundleSha256`. A
associação do State Manager roda de novo e instala a versão nova. O andamento aparece em Systems Manager → _State
Manager_.

Uma atualização do stack com uma imagem nova do Amazon Linux (o parâmetro `LatestAmiId` é relido a cada atualização)
troca a VM. O disco de dados é mantido e a instalação roda de novo na VM nova.

## Acesso à VM

Só pelo Session Manager: Systems Manager → _Session Manager_ → _Start session_, ou
`aws ssm start-session --target <InstanceId>`. Não há SSH nem porta aberta.

## Como remover

1. Desligue a proteção contra encerramento da VM: EC2 → a instância → _Actions_ → _Instance settings_ → _Change
   termination protection_.
2. Apague o stack `verax-control-node`.

O disco de dados vira um snapshot e o bucket do nó continua na conta, com os backups. Apague os dois manualmente
quando não forem mais necessários.

## Custo

Veja a estimativa em `docs/ARQUITETURA.md`: a VM é a maior parte. Os flow logs e o bucket custam poucos dólares por
mês.

## Para quem mantém este template (Verax)

Validação no CI (`.github/workflows/iac.yml`): cfn-lint, checkov e os testes de `tests/test_node.py`, que conferem as
garantias acima (inclusive que a negação não corta nenhuma ação de que o Session Manager precisa, e que nada do pacote
é extraído ou executado antes de o SHA-256 conferir).
