# Arquitetura de implantação (decisões de 02/11/2026 e 04/11/2026)

Substitui a plataforma central na AWS do E8 (ECS, RDS, CloudFront, ALB, NAT e endpoints privados), cara para o
estágio atual. O código da aplicação (API, painel, autenticação, isolamento entre clientes) não muda.

A revisão de 04/11/2026 (fase 2) põe todo nó de cliente na GCP da Verax, com o Wazuh, e troca o papel com ExternalId
por um papel de leitura **sem chave**, em que o nó entra com a própria identidade no Google (federação de identidade
web). A pilha do nó na AWS e o conector com papel saem do caminho atual. O usuário IAM com chave, decidido na mesma
revisão e feito no PR-V2, deu lugar a esse papel no mesmo dia (seção "Por que papel sem chave").

O que vem dessa revisão é o **desenho-alvo da fase 2, ainda a construir**: o nó de cliente com o Wazuh, os perfis de
nó, o template do papel de leitura, o cofre, o token do Cloudflare colado no painel e o coletor nativo do Cloudflare.
As seções dessas partes levam a marca _(fase 2, a construir)_, e o que já existe está marcado como feito em "Ordem de
execução". Até lá, o painel segue com o fluxo anterior, do papel com ExternalId.

## Princípios

1. **Simples e replicável.** Cada implantação é um **nó**: uma VM com tudo dentro, criada pelo Terraform de
   `infra/gcp/` num projeto da Verax na GCP, no perfil `lean` ou `standard` (seção "Perfis de nó"). Um nó atende um
   só cliente. Subir um cliente novo é aplicar o Terraform e criar dois registros de DNS; na fase 3, isso fica
   automático.
2. **Leitura de fora, só leitura.** O nó lê os dados do cliente **pela API, como uma ferramenta externa**, e a Verax
   não ganha nenhum acesso de escrita:
   - AWS: um **papel IAM de leitura sem chave** (`verax-control-reader`), criado por um template na conta
     monitorada. Só o nó entra nele, com um token de até 1 hora que o Google assina para a conta de serviço do nó, e
     só a partir do IP reservado do Cloud NAT do nó;
   - GCP: um sink do próprio cliente publica no Pub/Sub do nó, sem nenhum papel para a Verax no projeto do cliente;
   - Cloudflare: um token só de leitura.
3. **Nada no ambiente do cliente é alterado.** O template da AWS só cria o papel de leitura e duas políticas. A
   trilha do CloudTrail e o export do GuardDuty só são criados se o cliente pedir na pilha (o padrão é não). Nenhuma
   trilha, destino de log, assinatura, bucket ou política existente é modificado.
4. **Nenhum log é apagado ou sobrescrito.** Em três camadas:
   - o papel de leitura não tem nenhuma ação de escrita ou exclusão, e o teste do template falha se alguma
     aparecer. Além disso, uma política de negação barra as ações que apagariam, desligariam ou desviariam logs e as
     que ampliariam o próprio acesso, o que vale mesmo que alguém anexe outra política ao papel;
   - o Wazuh lê os buckets com `remove_from_bucket` desligado, escrito de forma explícita em cada bucket do
     `ossec.conf`. O gerador da configuração passa a escrever a opção na fase 2; até lá vale o padrão do Wazuh, que
     também é desligado;
   - o WAF aceita um só destino de log por Web ACL: o Verax lê de onde o log já está e nunca troca o destino.

## Componentes de um nó

```
Navegador
 ├─ <cliente>.control.veraxsistemas.com.br ──► GCP (Firebase Hosting, projeto da Verax): só o painel estático
 └─ api-<cliente>.veraxsistemas.com.br ──► Cloudflare ──► túnel (conexão de saída do nó; nenhuma porta aberta)
                                                                     │
GCP da Verax, projeto dos nós de clientes, southamerica-east1 — um nó por cliente (perfil standard)
  rede própria, VM sem IP público; saída pelo Cloud NAT com IP reservado
   └─ VM e2-standard-2 (2 vCPU, 8 GB) com Docker
       ├─ Wazuh (manager e indexer, sem dashboard): coleta dos logs da AWS e correlação
       ├─ API, worker e PostgreSQL
       └─ cloudflared (túnel)
  Secret Manager: senhas do nó e chave do cofre de credenciais
  bucket: backup do banco
        │ leitura pela API, a partir do IP do NAT
        ├─► AWS do cliente: papel verax-control-reader, sem chave (token do Google de 1 h, só do IP do NAT)
        │     buckets S3 (CloudTrail, export do GuardDuty, WAF) e configuração (Ativos e Postura)
        └─► Cloudflare do cliente: auditoria e eventos de segurança (token no cofre)
GCP do cliente: sink de log ──► tópico do Pub/Sub no projeto do nó (sem papel para a Verax no projeto do cliente)
```

- **Fontes de log da AWS**, lidas pelo módulo `aws-s3` do Wazuh, só de buckets S3 que o cliente já tem:
  - CloudTrail;
  - findings do GuardDuty exportados (o export exige SSE-KMS);
  - log do WAF, opcional por conta. Só BLOCK e COUNT são indexados (ALLOW é descartado), por causa do volume.

  O CloudWatch Logs, o Security Hub e o Inspector ficam fora da v1. O módulo guarda o marcador do último objeto lido
  e retoma dele depois de uma parada. As leituras registradas no CloudTrail não são descartadas, porque alimentam as
  detecções de reconhecimento; as da própria Verax, vindas do IP do nó, recebem uma regra de nível 0.

- **Configuração da AWS (Ativos e Postura):** o worker lê pelo mesmo papel, só pelas ações de leitura da política,
  com cerca de 18 checagens de postura nativas. Sem Prowler.
- **GCP do cliente:** o sink do projeto do cliente publica num tópico do projeto do nó. O cliente cria o sink com o
  comando pronto de Contas cloud e cola no painel a identidade dele; o Terraform do nó (`customer_projects`) deixa só
  essa identidade publicar no tópico do projeto, sem nada no nível do projeto do nó (que isso basta é o que o teste
  na homologação confirma: `infra/gcp/GUIA.md`, "Projeto de cliente: o sink é do cliente"). O worker lê a assinatura
  com a identidade da VM e aplica regras próprias, como no nó da Verax (roteiro em
  `docs/runbooks/onboarding-cliente.md`, seção 5).
- **Cloudflare:** coletor nativo no worker (seção "Logs do Cloudflare").
- **Retenção:** o índice do Wazuh guarda 30 dias (alertas a partir do nível 5, 1 shard). Os achados ficam no Postgres
  pelo prazo do plano (90 ou 365 dias), com os campos do evento; só o evento bruto do detalhe expira em 30 dias.
- **Região:** os nós de clientes ficam em São Paulo (southamerica-east1). A leitura dos buckets sai da AWS pela
  internet, com custo na conta do cliente (seção "Custo estimado por nó").
- **Acesso:**
  - o painel e a API saem pelo túnel do Cloudflare, com login, MFA e as proteções do E2. Equipe remota sem IP fixo
    acessa sem VPN;
  - a operação da VM é pelo túnel do IAP com OS Login, auditado, sem IP público e sem porta aberta;
  - não há dashboard do Wazuh: a operação lê os alertas pelo próprio produto ou pela API do indexer, de dentro da VM;
  - só o worker alcança o servidor de metadados da VM, que dá acesso aos segredos. O manager e o indexer, que
    processam log não confiável, não alcançam.
- **Disponibilidade:** uma VM só, sem alta disponibilidade. Se ela parar, os logs continuam onde estão e o Wazuh
  retoma de onde parou. Tem backup diário do banco e snapshot do disco.

## Perfis de nó (`lean` e `standard`)

_(fase 2: o módulo, os perfis e o ambiente de homologação estão no código, em `infra/gcp/modules/node` e
`infra/gcp/envs/`, e o Wazuh do `standard` está no pacote do nó, em `infra/node/compose.wazuh.yaml` (PR-W1); falta o
apply da homologação e o aceite nela.)_

O perfil é uma variável do Terraform (`node_profile`) e do pacote do nó (`NODE_PROFILE`). Ele define a VM, o disco,
o snapshot, o IP do NAT (reservado no `standard`) e os limites de memória dos contêineres.

|          | `lean`                                           | `standard`                                                          |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| Uso      | Nó da própria Verax (fontes da GCP e Cloudflare) | Nó de cliente, um por cliente                                       |
| VM       | e2-micro do nível gratuito, em us-east1          | e2-standard-2 (2 vCPU, 8 GB), em southamerica-east1                 |
| Disco    | 30 GB pd-standard                                | 60 GB pd-balanced, que cresce sem parar a VM                        |
| Snapshot | Semanal, guardado por 28 dias                    | Diário, guardado por 7 dias                                         |
| Wazuh    | Não                                              | Manager e indexer, sem dashboard                                    |
| Sistema  | Swap cifrado de 2 GB                             | Swap cifrado de 2 GB, `vm.swappiness=1` e `vm.max_map_count=262144` |

- **Swap cifrado, nos dois perfis:** o swap usa uma chave aleatória nova a cada boot (dm-crypt no modo plain, com a
  chave tirada de `/dev/urandom`), que só existe na memória. O que o kernel tira da memória para o swap (o tmpfs com
  a chave privada do cofre e o token de 1 hora para a AWS, a memória do worker e a do manager) chega ao disco, e ao snapshot dele,
  só cifrado. Ao trocar o swap atual por este, o cifrado é ligado antes, num arquivo novo; só depois o antigo é
  desligado, sobrescrito com zeros e tirado do `fstab` e do disco, para a VM não ficar sem swap nem sobrar texto
  claro nos blocos. Todo nó criado pelo módulo já nasce assim. O nó da Verax, aplicado antes do módulo, segue com o script de boot antigo
  (swap em claro) até uma manutenção planejada: trocar o script recria a VM (o disco fica), como descreve
  `infra/gcp/GUIA.md`.
- **Imagem uniforme:** todo nó de cliente é `standard`, com ou sem conta AWS, nos planos Essencial e Profissional. O
  plano muda limites e retenção, não a máquina.
- **Memória no `standard`** (soma dos limites de cerca de 6 GiB): indexer com 3 GiB, heap de 1,5 GiB e memória
  travada; manager com 1,5 GiB; Postgres com 512 MB; API com 384 MB; worker com 512 MB. O swap protege os outros
  processos de um OOM; o heap travado não vai para ele.
- **Redes no `standard`:**
  - `verax`: Postgres, API, worker e cloudflared;
  - `wazuh`, interna: indexer e manager. O indexer não tem porta publicada nem rota para fora;
  - `wazuh-read`, interna: indexer, API e worker, que só leem. A API nunca divide rede com o manager, que processa
    log de fora como root: numa rede só, ele chegaria à API por dentro, fora do Cloudflare, e forjaria o
    `X-Forwarded-For` em que ela confia;
  - `wazuh-egress`: só o manager, para a saída ao S3 e ao STS. O manager não alcança o Postgres.
- **Usuários do indexer no `standard`:** o filebeat do manager grava com `wazuh_filebeat` (só escrita em
  `wazuh-alerts-*`); a API e o worker leem com `verax_api_read`; a senha do `admin` não fica em nenhum contêiner que
  fica no ar (os scripts usam o certificado admin).
- **Serviços do systemd:** nos dois perfis, `verax-metadata-guard` (a guarda do servidor de metadados, antes do Docker
  e exigida por ele: sem ela o Docker não sobe, e ela não aceita `stop` nem `restart` manual) e `verax-node` (a
  aplicação, que exige a guarda); no `standard`, também `verax-wazuh` (o Wazuh, depois da aplicação, que o
  `restart` do `verax-node` sobe de novo mesmo quando ele tinha falhado): uma falha do Wazuh não derruba a aplicação
  nem o backup diário.
- **Portão:** o ensaio geral da fase 2 mede 24 h de `docker stats` e CPU. A documentação do Wazuh pede 4 núcleos para
  o single-node em Docker; se 2 vCPU não bastarem, o plano B é a e2-standard-4.
- Os nós de clientes ficam num projeto da GCP separado do nó da Verax.

## Painel e destinos

O painel é estático, no Firebase Hosting do projeto `verax-control-prod` (GCP), um site por destino. Roteiro em
`docs/runbooks/painel.md`.

- `control.veraxsistemas.com.br`: **demonstração comercial**, com dados fictícios simulados no navegador, sem API e
  com aviso em toda tela.
- `verax.control.veraxsistemas.com.br`: **SOC da própria Verax**. Monitora a infraestrutura da Verax na GCP e no
  Cloudflare.
- `<cliente>.control.veraxsistemas.com.br`: um por cliente.

A API de cada destino fica em `api-<cliente>.veraxsistemas.com.br` (a da Verax, em `api-verax`), e não em
`api.<cliente>.control...`. Ela passa pelo túnel do Cloudflare, que exige o proxy ligado e, portanto, o certificado do
Cloudflare. O certificado gratuito dele cobre só um nível de subdomínio (`*.veraxsistemas.com.br`), e o de mais níveis
custaria cerca de US$ 10 por mês (decisão de 02/11/2026). Os painéis não têm esse limite: ficam com o proxy desligado
e o certificado é do Firebase.

### Proteções do login

O login é do Better Auth (regra 10: nada de hash, sessão ou MFA próprios), com o que o E2 definiu: MFA obrigatório
(TOTP, código válido uma vez), senha temporária de 72 h no primeiro acesso, bloqueio por conta (5 tentativas em 15
min, reservadas antes de a senha ser conferida), limite por IP nas rotas de autenticação, checagem de origem em todo
POST (CSRF de login), senha nova conferida no Have I Been Pwned e trilha de auditoria de cada evento.

Na frente de tudo isso, nos dois formulários que qualquer pessoa chama sem sessão, o **Cloudflare Turnstile** (widget
"Managed", em português, no tema do painel): o login e o "esqueci minha senha". O painel manda o token do widget no
header `X-Turnstile-Token`; a API o confere no `siteverify` da Cloudflare (com o IP de quem pediu, 5 s de limite)
**antes** de reservar a tentativa de login e de olhar a senha. Sem token ou com token recusado, 400
(`TURNSTILE_REQUIRED` / `TURNSTILE_FAILED`, mensagem genérica, sem gastar tentativa); com o `siteverify` fora do ar,
503 genérico: a porta fecha, nunca abre. A chave secreta fica no cofre `<prefixo>-turnstile-secret-key` do Secret
Manager e a chave do site (pública) no `node.conf`; sem as duas, o desafio fica desligado e a API avisa na partida
(`Turnstile desligado`). O `siteverify` também diz a `action` do widget que gerou o token e o `hostname` da página: a
API exige a `action` da rota (`login` ou `password-reset`; um token do login não vale no pedido de redefinição) e,
com uma chave de site real, o `hostname` do `WEB_ORIGIN`; a chamada não segue redirecionamento (a chave secreta vai
no corpo). O painel descobre a chave do site em `GET /v1/auth/client-config` (público e sem limite por IP: devolve um
valor constante lido da configuração em memória, com `Cache-Control: public, max-age=300`, que o navegador e o
Cloudflare na frente da API reaproveitam) e, sem ela, os formulários são os de sempre. A CSP do painel abre só
`script-src` e `frame-src` para `https://challenges.cloudflare.com`. O token não vai para o log nem para a
auditoria; a recusa, sim.

## Contas monitoradas por provedor

_(papel da AWS e token do Cloudflare no cofre: fase 2, a construir)_

O cadastro de contas (Contas cloud) aceita três provedores. **A GCP e a AWS não guardam credencial:** na GCP, o sink
do cliente publica no tópico do nó; na AWS, o nó entra no papel de leitura do cliente com a própria identidade no
Google (seção "Por que papel sem chave"). **Cloudflare: token de leitura cifrado no cofre do nó** (seção "Cofre de
credenciais"). Um admin cola o token no painel; ele nunca volta pela API e nunca fica no cadastro da conta.

| Provedor   | Identificador                            | Origem dos logs                                                                                                                   | Como o nó lê                                                                                                      |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| AWS        | ID da conta (12 dígitos)                 | Buckets S3 (CloudTrail, GuardDuty e WAF)                                                                                          | Papel `verax-control-reader`, sem chave: o nó entra com o token da conta de serviço dele, só a partir do IP do nó |
| GCP        | ID do projeto                            | Assinatura do Pub/Sub, no projeto do nó, ligada ao sink que o cliente cria (a identidade do sink fica no cadastro; não é segredo) | Identidade da VM do nó, sem chave                                                                                 |
| Cloudflare | ID da conta (32 caracteres hexadecimais) | Zonas (domínios) monitoradas                                                                                                      | Token só de leitura, no cofre                                                                                     |

Cada origem de log (bucket, assinatura, identidade do sink ou zona) pertence a um só cliente, como já valia para os
buckets: é o que permite atribuir cada alerta ao cliente certo. A identidade do sink, além disso, é de um projeto só,
mesmo dentro do cliente: em outro projeto, daria a ele a publicação no tópico do primeiro.

## Cofre de credenciais

_(fase 2: a tabela, a cifra, a chave do nó e a recifragem estão no código, em `apps/api/src/credentials` e
`infra/node`; a tela que grava o token do Cloudflare vem no PR-11')_

- **O que guarda:** o token do Cloudflare, uma linha por conta cloud (`CloudCredential`), com o mesmo isolamento por
  cliente de todo dado de cliente. A AWS não passa pelo cofre: o papel de leitura não tem chave. O tipo
  `aws_access_key`, feito no PR-V1 para a chave do usuário IAM, e o código que só ele usa viraram código morto e saem
  no PR-V3', enquanto não há linha dele em produção.
- **Cifra assimétrica:** RSA-3072 com OAEP-SHA256. A API, exposta pelo túnel, tem só a chave pública: cifra o que o
  admin cola e não consegue decifrar o que já está guardado. Só o worker tem a chave privada.
- **Vínculo:** o rótulo do OAEP amarra o texto cifrado ao cliente, à conta e ao tipo. Uma linha copiada para outra
  conta ou outro cliente não abre.
- **Chave do nó:** com `CREDENTIALS_VAULT=true` no `node.conf` (o nó da Verax não liga), nasce na VM, na instalação,
  se o segredo `<prefixo>-credentials-key` do Secret Manager estiver vazio, e vai direto para ele, sem passar pelo
  disco. A permissão de acrescentar versões vale só nesse segredo. A chave privada nunca sai da GCP e não é gravada no
  disco do nó: a cada partida, o `start.sh` escreve as versões ativas num arquivo do tmpfs
  (`/run/verax/vault/worker-keys`, 0400, só o usuário do worker lê), numa pasta montada só leitura no worker
  (`compose.vault.yaml`; a pasta, e não o arquivo, porque a origem de um bind mount que falta vira uma pasta criada
  pelo Docker ao subir o contêiner), e a API recebe só a pública. A parada do nó apaga a pasta. As privadas não vão
  por variável de ambiente, porque o Docker grava o ambiente de cada contêiner na configuração dele, em
  `/var/lib/docker`, que está no disco e nos snapshots; de um volume montado, só o caminho vai para lá. O swap é
  cifrado com uma chave que some a cada boot (seção "Perfis de nó"). Por isso, os backups do banco e os snapshots do
  disco não levam a chave privada nem credencial em claro.
- **Versões:** a versão do segredo é a versão da chave. Uma tarefa diária do worker recifra as linhas antigas. Na
  saída de um cliente, destruir a versão depois do prazo dos backups inutiliza o texto cifrado que sobrou neles.
- **Validação antes de gravar:** só os admins (`admin_cliente` e `admin_verax`) colam, com permissão própria e limite
  de tentativas por conta e por cliente. Cloudflare: `tokens/verify`. A Global API Key é recusada.
- **O segredo não sai:** não volta pela API e não vai para a auditoria (só os 4 últimos caracteres, `keyIdSuffix`)
  nem para o log (o logger mascara os segredos decifrados no processo).
- **Desativar a conta** apaga a credencial na mesma transação.

## Por que papel sem chave

_(fase 2: o template está feito, no PR-V2'; o resto vem nos PRs V3' a V5', depois do teste prático na conta AWS de
teste)_

**Decisão de 04/11/2026**, tomada pelo responsável pelo produto depois da proposta de conectar a AWS sem chave. Ela
substitui a decisão do mesmo dia de ler com um usuário IAM com chave (PR-V2).

- A premissa do usuário com chave era que assumir um papel exige uma credencial da AWS do lado da Verax. Isso vale
  para o `AssumeRole`, mas não para o `AssumeRoleWithWebIdentity`, que não exige credencial da AWS: o nó apresenta um
  token que o Google assina para a conta de serviço dele, e a AWS o troca por uma sessão do papel.
- O Google é um provedor de identidade embutido na AWS: o cliente não cria provedor OIDC no IAM, e a Verax não
  precisa de conta AWS.
- O módulo `aws-s3` do Wazuh 4.14.9 cria a sessão com `boto3.Session(profile_name=...)`, e o botocore fixado por ele
  aceita `role_arn` com `web_identity_token_file` no profile: o coletor não muda.
- Nada secreto é copiado: o cliente cria a pilha no próprio console. Não há chave para criar, colar, guardar, trocar
  a cada 90 dias nem apagar, e o cofre fica só para o token do Cloudflare.
- O modo papel com ExternalId fica guardado para um futuro modo Enterprise.

**O template** (`infra/cloudformation/verax-control-reader.yaml`, feito; o passo a passo do cliente está no README da
pasta) cria o papel `/verax/verax-control-reader` e duas políticas gerenciadas. Nome e caminho são fixos
(`CAPABILITY_NAMED_IAM`): a saída `RoleArn` é sempre `arn:aws:iam::<conta>:role/verax/verax-control-reader`, que o
painel deriva do ID da conta. Nenhuma saída é segredo. O template tem cerca de 32 KB, abaixo dos 51.200 bytes que o
CloudFormation aceita sem bucket.

- **Confiança:** só `Federated: accounts.google.com` e só `sts:AssumeRoleWithWebIdentity`, com quatro condições
  exatas (`StringEquals` e `IpAddress`, sem curinga):
  - `accounts.google.com:aud` e `accounts.google.com:sub` iguais ao ID único da conta de serviço do nó
    (`NodeServiceAccountId`, 21 dígitos). No token de uma conta de serviço, a AWS lê o `aud` do campo `azp`, que é
    esse ID; o `sub` é o identificador estável (uma conta recriada ganha outro);
  - `accounts.google.com:oaud` igual ao audience fixo do Verax Control (`Audience`);
  - `aws:SourceIp` igual ao IP do NAT do nó (`NodeEgressIps`, de 1 a 4 `/32`).

  A política é escrita à mão: o assistente "Web identity → Google" do console grava o audience em
  `accounts.google.com:aud` e faz um papel que nunca aceita o nó. A sessão dura até 1 hora.

- `VeraxControlReader` (Allow, que também é o permissions boundary do papel): lê só os buckets e as chaves KMS
  informados (`kms:Decrypt` só pelo S3), confere as fontes, simula as permissões do próprio papel e lê a configuração
  para Ativos e Postura.
- `VeraxControlGuardrails` (Deny): tudo o que vier de fora do IP do NAT do nó (também com uma sessão já emitida),
  qualquer alteração de logs e qualquer ampliação do próprio acesso, inclusive mexer na confiança do papel.
- **Confused deputy, sem ExternalId:** cada cliente tem o próprio nó e a própria conta de serviço, e a confiança do
  cliente B fixa o `sub` do nó de B. Se o cliente A cadastrar a conta AWS de B, o nó de A chega com outro `sub` e de
  outro IP e é recusado. O `sub` não é segredo, mas não se forja: o token é assinado pelo Google. Para isso continuar
  verdadeiro, cada nó tem a sua conta de serviço, nunca reaproveitada (`prevent_destroy` em `infra/gcp/modules/node`,
  que também expõe o ID na saída `service_account_unique_id`), e nunca há nó compartilhado entre clientes.

**O audience** é uma constante do produto, `https://control.veraxsistemas.com.br/aws-reader`: o padrão do parâmetro
`Audience` do template e o valor que o nó pede ao servidor de metadados da GCP (no PR-V4', `AWS_WEB_IDENTITY_AUDIENCE`
no `node.conf`). Mudá-la exige atualizar a pilha de todos os clientes.

**Ciclo da conexão:**

1. **Conectar (PR-V3'):** o admin cadastra a conta (ID e buckets), baixa o template e o cria no console da AWS com os
   três valores que o painel mostra: o ID da conta de serviço do nó, o IP do nó e o audience (que já vem preenchido).
   "Verificar" grava `connection=waiting`; a API não alcança o metadata e não assume o papel.
2. **Coletar (PR-V4'):** um timer do host renova a cada 10 min o token do Google (`format=standard`, sem o projeto
   nem a VM) num tmpfs (`/run/verax/wazuh-aws`, 0600), montado só leitura no manager. O gerador da configuração, o
   único que escreve, grava o `ossec.conf` e o `config` com um profile por conta: o ARN do papel, derivado do ID da
   conta, e `web_identity_token_file`. Não há arquivo `credentials` nem `<access_key>`, e o cano até o gerador não
   leva segredo. Mudar contas ou buckets reinicia só o manager, com volta automática à configuração anterior se ele
   não subir; indexer, API e painel seguem no ar.
3. **Conferir (PR-V5'):** o worker, o único contêiner com metadata, pede o próprio token, assume o papel e confere a
   cada 15 min a conta (`GetCallerIdentity`) e a leitura de cada bucket. Uma vez por dia, simula a permissão demais
   (só avisa) e confere se a trilha e o export do GuardDuty apontam para os buckets cadastrados. Erros próprios: papel
   recusado, Google fora do ar, token inválido, STS regional desligado e token do host sem renovar.
4. **Desconectar:** o painel para a coleta e mostra os passos no console: "Revoke active sessions" no papel (corta as
   sessões já emitidas, de até 1 hora) e apagar a pilha. Não há chave para apagar.

**Riscos residuais e mitigação:**

| Risco                                                                                                                                    | Mitigação                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token do Google vazado: vale até 1 hora e não pode ser revogado                                                                          | Só entra do IP do NAT do nó (`aws:SourceIp` na confiança) e só no papel deste cliente; a sessão emitida também fica presa ao IP (Deny); regra de nível 12 para entrada de outro IP                               |
| Root no nó lê o token e as sessões em claro (tmpfs e memória do worker e do manager)                                                     | Valem 1 hora; nó dedicado a um cliente; sem porta aberta; acesso só pelo IAP com OS Login auditado; metadata só para o worker; o alcance é leitura de logs e configuração                                        |
| Página da memória com segredo em claro (chave privada do cofre, token, sessões) vai para o swap, no disco do snapshot                    | Swap cifrado com chave aleatória a cada boot, nos dois perfis; no `standard`, `vm.swappiness=1` e o heap do indexer travado na memória                                                                           |
| O ambiente de um contêiner fica gravado em `/var/lib/docker`, no disco e no snapshot                                                     | Chaves privadas do cofre só por arquivo do tmpfs montado só leitura no worker, nunca por variável (teste e CI conferem); o token da AWS fica num tmpfs do host                                                   |
| Execução remota de código na API, exposta pelo túnel                                                                                     | A API não alcança o metadata e não emite token; cofre assimétrico para o Cloudflare                                                                                                                              |
| O manager processa log não confiável e lê o token                                                                                        | Sem acesso ao Postgres nem ao metadata; `cap_drop`; rede de saída só dele; imagem fixada pelo digest; nó dedicado; o token vale 1 hora e só do IP do nó                                                          |
| Quem emite ID token da conta de serviço do nó entra no papel (operador com `serviceAccountUser`; no plano de controle, o `cp-terraform`) | Precisa também sair pelo IP do NAT do nó; alertas em `SetIamPolicy` na conta de serviço, em `GenerateIdToken` e em VM criada com a conta de um nó (CP-12); nunca `serviceAccountOpenIdTokenCreator` no Terraform |
| A conta de serviço do nó é apagada ou recriada, e o ID único muda                                                                        | `prevent_destroy` no módulo; restauração em até 30 dias com o mesmo ID; depois disso, cada cliente atualiza a pilha                                                                                              |
| Google ou o metadata fora do ar (`IDPCommunicationError`, renovação do token falha)                                                      | O token tem 50 min de folga; o wodle retoma do marcador e não perde log; aviso de token sem renovar                                                                                                              |
| A web identity pelo profile não funcionar no contêiner do manager                                                                        | Teste prático antes do PR-V4'; plano B: o host troca o token por uma sessão e grava um `credentials` temporário de 1 hora                                                                                        |
| O `GetCallerIdentity` não pode ser negado e revela a conta e o ARN da sessão                                                             | Impacto baixo; documentado                                                                                                                                                                                       |
| O IP do NAT muda e a coleta para                                                                                                         | IP reservado com `prevent_destroy`; erro `source_ip_denied` com instrução no painel                                                                                                                              |
| O cliente amplia o papel (anexa política, tira o boundary)                                                                               | `SimulatePrincipalPolicy` todo dia, com uma amostra de escrita, IAM, KMS e leitura fora da política, e aviso na Torre. Permissão a mais fora da amostra não é detectada                                          |
| O cliente cria o papel pelo assistente do console e põe o audience no `aud`                                                              | Template e Terraform prontos; o README avisa; a mensagem de papel recusado explica                                                                                                                               |
| RCP de perímetro de dados do cliente nega a federação do Google                                                                          | O cliente inclui `accounts.google.com` na RCP ou marca o papel como exceção (decisão dele); texto pronto no onboarding                                                                                           |
| STS de sa-east-1 desligado pelo cliente                                                                                                  | O worker cai para us-east-1; no Wazuh, o erro instrui a religar                                                                                                                                                  |
| Objeção de conformidade: o Access Analyzer mostra o papel com acesso externo federado                                                    | Esperado e explicado no onboarding: papel com credencial temporária é o que a AWS recomenda; o CloudTrail registra cada entrada com o `sub` do nó                                                                |
| Ruído no CloudTrail e no medidor (cerca de 1.700 entradas por dia por conta, estimativa)                                                 | Medir no teste prático; se pesar, intervalo de 10 min ou descontar do medidor                                                                                                                                    |
| Bucket de organização legível inteiro                                                                                                    | Prefixo opcional na pilha (`LogObjectPrefix`); nó dedicado ao mesmo cliente                                                                                                                                      |
| Na saída do cliente, o papel segue na conta dele                                                                                         | Roteiro: "Revoke active sessions" e apagar a pilha; sem o papel, o nó não entra                                                                                                                                  |

## SOC da própria Verax (fontes da GCP)

A base do nó da Verax na GCP está em `infra/gcp/envs/verax`, pelo módulo `infra/gcp/modules/node`, com o passo a
passo em `infra/gcp/GUIA.md`, e foi aplicada em 03/11/2026. É um nó **`lean`**: como ele monitora só a GCP e o
Cloudflare, não usa o Wazuh. O worker lê os logs direto do Pub/Sub e aplica regras próprias. Tudo roda numa
e2-micro do nível gratuito em us-east1. Os nós de clientes usam o perfil `standard`, todos com o Wazuh (seção
"Perfis de nó").

O pacote do nó está em `infra/node/`, com o roteiro em `docs/runbooks/no-verax.md`. Ele roda numa VM só, sem porta
aberta: Postgres com TLS, papéis e migrations, API, worker e o túnel do Cloudflare. As imagens vêm do registro do
projeto, fixadas pelo digest. O nó não depende de e-mail: toda conta nasce com uma senha temporária, que a pessoa
troca no primeiro login antes de cadastrar o MFA (decisão de 03/11/2026). Se o e-mail for ligado (SMTP com TLS), ele
serve só para a redefinição de senha pelo link.

A infraestrutura da Verax roda na GCP. O nó da Verax coleta:

- **Cloud Logging:** auditoria (Admin Activity e acesso a dados, onde estiver ligado), requisições das APIs (Cloud
  Run e balanceador) e, se existir, o WAF (Cloud Armor). A entrega é feita por um _sink_ de log para um tópico do
  Pub/Sub, só com o filtro de segurança. O nó lê a assinatura com uma identidade sem chave: a conta da VM, se o nó
  rodar na GCP, ou federação de identidade, se rodar fora. Nenhuma chave JSON de conta de serviço é criada.
- **Cloudflare:** como na seção abaixo.

## Logs do Cloudflare

_(fase 2, a construir)_

O Cloudflare é lido pela API dele, por um coletor nativo no worker, sem o Wazuh. Vale para o nó da Verax e para os
nós de clientes:

- **Auditoria da conta** (audit logs v2), com cursor por conta;
- **Eventos de segurança do WAF**, pela API GraphQL de analytics, em janelas de 15 min. O Cloudflare amostra esses
  eventos, então as contagens são aproximadas. Ele guarda os eventos por uma janela que vale por zona e depende do
  plano (`notOlderThan`, de até 31 dias). Uma parada do nó mais curta que essa janela não perde dados; numa parada
  mais longa, o que passou da janela se perde.

As regras são próprias (faixa 9903xx), com título em português e MITRE. O token é de conta, **só de leitura**, com
três permissões: `Account Settings Read`, `Analytics Read` e `Zone Read`. O admin cola o token no painel, e ele fica
no cofre do nó. A recomendação ao cliente é restringir o token ao IP de saída do nó.

O Logpush fica fora da v1: exige permissão de escrita (`Logs Edit`) e um destino que o Cloudflare possa gravar. Pode
voltar depois como modo completo, sem amostragem.

## Custo estimado por nó

Estimativa por mês, a conferir na calculadora do Google. Premissas: câmbio de R$ 5,4935; e2-standard-2 a US$ 77,65
por mês em southamerica-east1 (preço de agregador); pd-balanced a US$ 0,15/GB; snapshot a US$ 0,08/GiB. "Outros"
soma o Cloud NAT e o IP reservado dele (US$ 0,005/h, cerca de R$ 20), Pub/Sub, segredos, backup e flow logs.

| Perfil `standard` (R$)           | VM     | Disco | Snapshots | Outros | Total  | Com folga de 15% |
| -------------------------------- | ------ | ----- | --------- | ------ | ------ | ---------------- |
| Essencial (plano de R$ 2.490)    | 426,57 | 49,44 | 21,97     | 34,84  | 532,83 | **612,75**       |
| Profissional (plano de R$ 4.990) | 426,57 | 49,44 | 26,37     | 37,56  | 539,94 | **620,93**       |

- **Com CUD de 1 ano**, quando houver clientes anuais: a VM cai para R$ 268,74, e o total com folga fica em cerca de
  R$ 431 (Essencial) e R$ 439 (Profissional).
- **Plano B (e2-standard-4):** cerca de R$ 1.103 (Essencial) e R$ 1.111 (Profissional) com folga.
- **Homologação parada** fora das janelas de teste: cerca de R$ 70 por mês (disco e IP).
- **`lean`:** de R$ 5 a 15 por mês, pelo `infra/gcp/GUIA.md`. Essa estimativa não conta o IP do Cloud NAT (cerca de
  R$ 20), a conferir na fatura.
- **Túnel do Cloudflare e Firebase Hosting:** sem custo nesta escala.
- **Na conta AWS do cliente** (fora da tabela): saída do S3 para a internet (cerca de US$ 0,15/GB em sa-east-1, a
  conferir), GETs e KMS. Com o CloudTrail compactado abaixo de 5 GB por mês, fica abaixo de US$ 1. O log completo do
  WAF pode pesar, e por isso ele é opcional.
- **Referência anterior:** na pilha do nó na AWS, fora do caminho atual, só a VM `t3a.xlarge` (16 GB) era estimada em
  US$ 150 a 170 por mês.

## Plano de controle _(fase 3, a construir)_

O plano de controle é o que transforma uma compra no site num nó de cliente no ar sem operador: checkout, webhook
da Stripe, máquina de estados do cliente, provisionamento passo a passo e exclusão. Vive em `apps/control-plane`
(NestJS 12 + zod 4, as mesmas regras do monorepo) e roda no projeto da Verax na GCP, dentro do nível gratuito
(R$ 0 com 0 clientes; R$ 2 a 8 por mês com 20). Os nós continuam como na fase 2; o plano de controle só os cria,
para, liga e destrói. O detalhamento (fluxos, limites, custos e PRs) está no plano da fase 3, documento interno.

### Peças

| Peça                                           | Onde                                                                                | Faz                                                                                                                                          | Não faz                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Site estático** (repo privado)               | `veraxsistemas.com.br`, Firebase Hosting                                            | Formulário de compra, página de status com a revelação única da senha, link do Portal do cliente                                             | Nunca toca chave da Stripe nem dado de cliente além do que o usuário digita                                       |
| **`cp-public`** (Cloud Run, 0 a 2 instâncias)  | Projeto da Verax, atrás de `conta.veraxsistemas.com.br` (Hosting com rewrite `/**`) | Checkout, consulta de subdomínio, página de status (claim, status, reveal), webhook da Stripe, `/health`                                     | Nenhuma rota interna: aceita invocação anônima (exigência do rewrite do Hosting)                                  |
| **`cp-worker`** (mesma imagem, `ROLE=worker`)  | Projeto da Verax, só IAM                                                            | Um passo do provisionamento por task, `tick` horário, `reconcile` diário, operações do responsável (`resume`, `delete-now`, `export`)        | Não é alcançável sem token de identidade do Google; o app ainda confere `aud` e `email` do token                  |
| **`cp-terraform`** (Cloud Run Job)             | Projeto da Verax; identidade com papéis no projeto dos nós                          | `init`, `plan` e `apply`/`destroy` de `infra/gcp/envs/tenant` com Terraform fixado, estado por tenant no bucket                              | Não lê Stripe, Cloudflare nem Firestore; só recebe variáveis já validadas por regex                               |
| **Firestore** (banco `(default)`, modo nativo) | Projeto da Verax                                                                    | Estado: `tenants` (com `transitions` e `invoices`), `slugs`, `stripeEvents`, `statusTokens`, `provisioningRuns`, `auditLog`, `rateLimits`    | Nunca guarda segredo, senha, cartão, token do túnel nem corpo bruto do webhook                                    |
| **Cloud Tasks** e **Cloud Scheduler**          | Projeto da Verax                                                                    | Filas `provisioning` e `lifecycle` com nova tentativa e recuo, OIDC para o `cp-worker`; `tick` a cada hora e `reconcile` às 03:00            | Nada de longa duração: o `apply` roda no Job, a task só dispara e espera                                          |
| **Secret Manager** e **bucket de releases**    | Projeto da Verax                                                                    | Chaves da Stripe (teste e produção separadas), token do Cloudflare, senha SMTP, chave do cookie; manifesto da versão e bundle do painel      | —                                                                                                                 |
| **Projeto dos nós** e **Firebase dos painéis** | Pago, criado na 1.ª venda; 1 a N projetos do Firebase (36 sites por projeto)        | Recursos `vx-<slug>` do módulo `node` (perfil `standard`); um site por cliente em `<slug>.control.veraxsistemas.com.br`, API em `api-<slug>` | Sem o projeto dos nós, o provisionamento falha com `provisioning_disabled` (sem laço) e retoma quando configurado |

### Identidades

- **`cp-public`:** lê e escreve no Firestore, enfileira tasks e lê as chaves da Stripe e do cookie. Nada mais.
- **`cp-worker`:** Firestore, tasks, execução do Job, Firebase Hosting nos projetos do pool, leitura do bucket de
  releases e, no projeto dos nós, um papel personalizado que só para, liga e lê atributos de VMs cujo nome começa com
  `vx-`. Por tenant, o Terraform concede: adicionar a versão do token do túnel; ler uma vez e destruir a versão do
  `admin-bootstrap`; destruir versões de `credentials-key`. Nunca ler o cofre de credenciais.
- **`cp-terraform`:** os papéis de criar e destruir os recursos do módulo `node` no projeto dos nós (o mais sensível é
  `projectIamAdmin`, para a SA de cada nó escrever logs e métricas; mitigado pelo projeto isolado, pela imagem fixada e
  por alerta em `SetIamPolicy` fora da lista). Não lê Stripe, Cloudflare nem Firestore.
- **`cp-deployer`:** Workload Identity Federation para o environment `control-plane` da `main`; publica a imagem e
  troca a imagem dos serviços (`run.developer` em cada serviço e no Job, nunca no projeto; `iam.serviceAccountUser`
  nas SAs de execução; escrita no registro). Não cria serviço nem toca o Firestore: índices e TTL são do Terraform.
  Nenhum segredo.
- **Responsável:** invoca o `cp-worker` com token de identidade, administra os segredos; tudo auditado.

O que o plano de controle **não** pode fazer: ler o banco do nó, abrir o cofre de credenciais, entrar na VM (sem OS
Login), ver dados de cartão (Checkout hospedado) ou usar a chave completa da Stripe (chave restrita).

### Estados do cliente

Toda mudança de estado é uma transação no documento `tenants/{id}` que relê o estado, confere a tabela de transições,
grava a transição em `tenants/{id}/transitions` e a auditoria em `auditLog`. O evento da Stripe só dispara: o objeto
que decide é relido na API; `event.id` é único (`stripeEvents`). Os passos do provisionamento usam uma trava por
tenant (`lock{owner, expiresAt}`, 20 min renovados; vencida, é tomada), que os campos de cobrança nunca disputam.

| Estado                        | Entra quando                                                                                                      | Ação                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pending`                     | `checkout.session.completed`: a reserva do subdomínio vira tenant                                                 | Cartão pago segue direto; boleto espera a compensação                                                  |
| `provisioning`                | `invoice.paid` do 1.º ciclo ou `checkout.session.async_payment_succeeded`                                         | Enfileira o `preflight`; 10 passos idempotentes, um por task                                           |
| `provisioning_failed`         | Um passo esgotou as tentativas ou falhou sem repetição (`provisioning_disabled`, `ready_timeout`, `node_error`)   | Alerta à Verax; o site diz "estamos finalizando"; `resume` pelo responsável retoma do passo registrado |
| `waiting_customer_connection` | Passo `access.ready`                                                                                              | E-mail "ambiente pronto" com o link da página de status; a senha é revelada ali, uma vez               |
| `active`                      | O `tick` lê no nó `verax/accounts-connected >= 1`                                                                 | Monitoramento normal                                                                                   |
| `past_due`                    | `invoice.payment_failed` numa renovação                                                                           | Carência de 7 dias (relógio próprio: o Smart Retries não cobre boleto); e-mail com o Portal; nó no ar  |
| `suspended`                   | Assinatura `unpaid`, carência vencida, disputa ou alerta de fraude (decisão humana)                               | VM parada (`instances.stop`); disco e snapshots ficam; `invoice.paid` reativa                          |
| `canceled`                    | `customer.subscription.deleted`, reembolso integral na garantia, boleto do 1.º ciclo vencido ou 30 dias sem pagar | VM parada; exportação sob pedido por 30 dias; relógios de D+30 e D+97                                  |
| `deleted`                     | `tick` com `deleteAfter` vencido, ou `delete-now` pelo responsável                                                | Exclusão em dois tempos (abaixo)                                                                       |

### Exclusão em dois tempos

| Momento              | O que acontece                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D+30 do cancelamento | **Exclusão 1:** `terraform destroy` do ambiente do tenant, disco e snapshots, tópicos e assinaturas, túnel e seus registros de DNS, site e domínio do Firebase, segredos `admin-bootstrap`, `cloudflare-tunnel-token` e `smtp-password`. Ficam o bucket de backups (ciclo de 90 dias) e a chave `credentials-key`. `state=deleted`; e-mail de registro |
| D+97 do cancelamento | **Exclusão 2 (cripto-destruição):** todas as versões de `credentials-key` destruídas, segredo e bucket apagados, estado do Terraform removido. O tenant vira registro mínimo: ficam `slug`, `company`, `stripe.customerId`, `lifecycle` e as faturas por 5 anos (obrigação fiscal); `adminEmail`, `resources` e `access` são apagados                  |

Retenção do resto: `auditLog` 24 meses, `stripeEvents` 90 dias, `provisioningRuns` 180 dias, tokens e reservas pelo
próprio prazo, tudo por TTL do Firestore. Nunca gravado: dado de cartão, senha temporária (lida do Secret Manager e
devolvida uma vez), token do túnel, chaves da Stripe e do Cloudflare, corpo bruto do webhook, IP completo do cliente.

## Ordem de execução

**Decisão de 02/11/2026** (os números dos passos são citados em outros arquivos):

1. Diagnóstico somente leitura da conta monitorada (`infra/diagnostico/`), publicado por release e com roteiro de
   onboarding (`docs/runbooks/onboarding-cliente.md`). **Feito.**
2. Conector só com o papel de leitura (`infra/cloudformation/verax-control-connector.yaml`). **Feito; substituído**
   pelo papel de leitura sem chave na revisão de 04/11/2026.
3. Pilha do nó na AWS (`infra/cloudformation/verax-control-node.yaml`). **Feito; fora do caminho atual**, porque os
   nós rodam na GCP.
4. Docker Compose do nó: instalação, atualização por versão fixada e backup (`infra/node/`). **Feito** para o nó
   da Verax na GCP.
5. Painel no Firebase Hosting, com os cabeçalhos de segurança, e publicação pelo GitHub Actions. **Feito.**
6. Remoção do que deixou de ser usado (E8 e a rede do E4).
7. Integração do E5 e telas do E7. **Feito.**

**Fase 2 (decisões de 04/11/2026)**, por blocos:

1. **Fundação:** esta revisão; plano do nó e medidor de uso; módulo Terraform do nó com os perfis e o IP reservado do
   NAT, mais o nó de homologação em São Paulo; conexão de projeto GCP de cliente. O agendador do worker, o cursor dos
   coletores, o estado da conexão e a conexão de projeto GCP de cliente já estão feitos.
2. **Wazuh no nó** (perfil `standard`) e leitura do indexer pela API, com chave estável do achado. **Feito no
   código** (PR-W1 e PR-W2); o aceite depende da homologação no ar.
3. **Cofre e AWS:** cofre de credenciais (feito no PR-V1; fica para o token do Cloudflare); template do papel de
   leitura sem chave (feito no PR-V2', que substituiu o usuário IAM do PR-V2); "Conectar AWS" no painel; entrega ao
   Wazuh pelo token do Google, com recarga sem parar o painel; checagem da conexão e das fontes; medidor da ingestão;
   regras críticas da AWS com títulos em português. O template espera o teste prático na conta AWS de teste.
4. **Cloudflare:** token no cofre, auditoria e eventos de segurança.
5. **Ativos e Postura da AWS** pelo papel de leitura do cliente.
6. **Compromissos do plano:** avisos por e-mail, limites do plano, expurgo do histórico e 365 dias nas telas.
7. **Versão do nó reproduzível e ensaio geral.** É o portão da fase 3: um nó nasce do zero só com `terraform apply` e
   a versão publicada, sem SSH e sem operador.

**Fase 3:** provisionamento automático do cliente (checkout, estados do cliente, Terraform por cliente, túnel e DNS
por API e primeiro acesso), pelo plano de controle da seção "Plano de controle". **A primeira venda só acontece depois
dela**; não há venda assistida. Blocos: base (CP-00 a CP-02: arquitetura, esqueleto com configuração e `/health`,
Firestore com modelo de dados e auditoria), venda (checkout, webhook e página de status), nó (ambiente `tenant`,
painel de build único, bundle do painel na versão, bootstrap do admin do cliente), provisionamento e ciclo (executor
Terraform e passos, suspensão e exclusão, reconciliação e alertas) e o portão da venda (ensaio ponta a ponta no modo
de teste da Stripe).
Hoje o primeiro acesso é manual: a Verax cadastra o cliente em Clientes → Novo cliente, já com o primeiro
administrador, e repassa a senha temporária dele por um canal seguro (`docs/runbooks/onboarding-cliente.md`). Na fase
3, o bootstrap do nó cria esse administrador no provisionamento, com o e-mail do checkout.
