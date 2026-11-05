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
execução". O painel já conecta a AWS pelo papel sem chave (PR-V3'): o ExternalId saiu do cadastro.

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
  internet, com custo na conta do cliente (seção "Custo por nó").
- **Acesso:**
  - o painel e a API saem pelo túnel do Cloudflare, com login, MFA e as proteções do E2. Equipe remota sem IP fixo
    acessa sem VPN;
  - a operação da VM é pelo túnel do IAP com OS Login, auditado, sem IP público e sem porta aberta;
  - não há dashboard do Wazuh: a operação lê os alertas pelo próprio produto ou pela API do indexer, de dentro da VM;
  - só o worker alcança o servidor de metadados da VM, que dá acesso aos segredos. O manager e o indexer, que
    processam log não confiável, não alcançam;
  - a única porta que um nó pode abrir é a dos agentes do Wazuh nas instâncias do cliente (TCP 1514 e 1515), desligada
    por padrão e só para as faixas de IP do cliente (seção "Agentes nas instâncias do cliente").
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
- **Imagem uniforme:** todo nó de cliente é `standard`, com ou sem conta AWS. A configuração contratada (preço
  configurável) muda limites e retenção e decide o porte (P, M ou G); hoje o módulo só tem o porte P, e o M e o G chegam
  no PC-09 (seção "Custo por nó").
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
exigiria o Advanced Certificate Manager, pago à parte (decisão de 02/11/2026). Os painéis não têm esse limite: ficam
com o proxy desligado e o certificado é do Firebase.

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

_(fase 2: o token do Cloudflare entra pelo painel (PR-11'); o template do papel da AWS está feito (PR-V2'), e o
"Conectar AWS" do painel também (PR-V3'); a leitura pelo nó e a conferência real vêm nos PRs V4' e V5')_

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
`infra/node`, e a rota que recebe o token do Cloudflare colado no painel também, no PR-11'. A rota é genérica, por tipo;
a AWS não passa por ela)_

- **O que guarda:** o token do Cloudflare, uma linha por conta cloud (`CloudCredential`), com o mesmo isolamento por
  cliente de todo dado de cliente. A AWS não passa pelo cofre: o papel de leitura não tem chave. O tipo
  `aws_access_key`, feito no PR-V1 para a chave do usuário IAM, e o código que só ele usava saíram no PR-V3', antes
  de existir alguma linha dele (a migration para, sem mudar nada, se encontrar uma).
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
- **Validação antes de gravar:** só os admins (`admin_cliente` e `admin_verax`) colam, com permissão própria
  (`cloud_credentials:write`), pela rota `PUT /v1/cloud-accounts/:id/credential` (corpo discriminado por `kind`; trocar
  é colar de novo) e `DELETE` no mesmo caminho. A conferência roda na memória da API, antes de cifrar, sob o lock da
  conta. O limite é de 5 recusas por conta e 20 por cliente a cada hora, contadas na própria trilha de auditoria (só as
  recusas da origem; indisponibilidade não conta). Cada cliente confere uma credencial por vez, e a recusa entra na
  trilha no mesmo commit, antes de o lock ser solto: a contagem é exata com pedidos simultâneos. Conta de outro cliente
  dá 404 sem chamar a origem.
  - Cloudflare: a Global API Key é recusada antes de tudo (`cfk_` ou 37 a 45 hexadecimais). Depois, em até 5 s, o
    `GET /accounts/<conta>/tokens/verify` (token de conta, o recomendado) ou `GET /user/tokens/verify` (de usuário),
    que precisa responder `active`, dentro da validade; e uma leitura de prova da auditoria da conta cadastrada (uma
    entrada da última hora), que exige `Account Settings: Read` nela. O `verify` sozinho não diz a quais contas o token
    dá acesso, e o filtro de IP do token não vale para ele (vale para a leitura de prova). O sufixo guardado é o fim do
    ID do token, e a validade vai para `expiresAt`: a tela avisa 14 dias antes. O host é fixo (`api.cloudflare.com`),
    sem variável que o troque; só os testes apontam para um servidor falso em `127.0.0.1`.
- **O segredo não sai:** não volta pela API e não vai para a auditoria (só os 4 últimos caracteres do ID do token,
  `keyIdSuffix`) nem para o log (o logger mascara os segredos decifrados no processo). A conta mostra só os metadados
  (`keyStatus`: tipo, sufixo, validade, última conferência). Erros da origem vão para o log só pelo código. Na API, o
  logger esquece o valor colado no fim da requisição, para a memória do processo exposto não acumular credenciais.
- **Desativar a conta** apaga a credencial na mesma transação.

## Por que papel sem chave

_(fase 2: o template está feito, no PR-V2', e o "Conectar AWS" do painel, no PR-V3'; o resto vem nos PRs V4' e V5',
depois do teste prático na conta AWS de teste)_

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
  verdadeiro, cada nó tem a sua conta de serviço, nunca reaproveitada entre clientes (o módulo
  `infra/gcp/modules/node` expõe o ID na saída `service_account_unique_id`), e nunca há nó compartilhado entre
  clientes.
- **Conta de serviço estável:** uma conta recriada, mesmo com o mesmo nome, ganha outro ID único, e o papel de todo
  cliente daquele nó deixa de aceitá-la até cada um atualizar a pilha. A conta não tem `prevent_destroy`, porque a
  homologação é destruída entre as janelas de teste e a exclusão do cliente destrói o ambiente inteiro (o `lifecycle`
  não muda por variável). A proteção é outra: o que a recriaria (`account_id` e `project`) sai só do `name_prefix` e
  do `project_id`, e um teste do módulo (`tests/conta_de_servico.tftest.hcl`) confere que as mudanças de rotina não a
  recriam; e o executor do Terraform do plano de controle recusa o plano que a recrie ou apague fora da exclusão
  (seção "Exclusão em dois tempos").

**O audience** é uma constante do produto, `https://control.veraxsistemas.com.br/aws-reader`: o padrão do parâmetro
`Audience` do template e o valor que o nó pede ao servidor de metadados da GCP. A linha opcional
`AWS_WEB_IDENTITY_AUDIENCE` do `node.conf` a troca num nó (o painel mostra o valor do nó; o timer do token do PR-V4' o
usa). Mudá-la exige atualizar a pilha de todos os clientes do nó.

**Ciclo da conexão:**

1. **Conectar (PR-V3', feito):** o admin cadastra a conta (ID e buckets). O detalhe da conta em Contas cloud mostra
   o ARN do papel (derivado do ID, nunca digitado), o link "Baixar o template" e os três valores da pilha, com cópia:
   o ID único da conta de serviço do nó (`NODE_SA_UNIQUE_ID`), o IP de saída (`NODE_EGRESS_IPS`) e o audience. Os
   dois primeiros vêm do `node.conf`, que o `start.sh` passa à API só quando têm a linha; sem eles, a tela os pede à
   Verax. Mostra também os ARNs dos buckets cadastrados (`LogBucketArns`), o link do console do CloudFormation e o
   comando da CLI. Nenhum valor é segredo, e quem só lê vê o mesmo, sem o botão.
   - **O template é servido pelo painel:** o arquivo do repositório entra no build como recurso (`?url` do Vite),
     copiado byte a byte para `assets/` com o hash do conteúdo no nome, e é baixado da mesma origem, com o nome
     `verax-control-reader.yaml`. É o template revisado no commit do painel, sem nada preenchido; o e2e confere byte a
     byte. Um link para o GitHub dependeria de saber o commit no navegador (o painel só aceita `VITE_API_URL`), não
     baixaria o arquivo (o atributo `download` não vale para outra origem) e dependeria do GitHub no ar.
   - **"Verificar"** (`POST /v1/cloud-accounts/:id/aws/verify`, `cloud_accounts:write`, 202): grava o pedido
     (`checkRequestedAt`) e volta a conexão para `waiting`, sem erro; um pedido pendente não é renovado. A API não
     alcança o metadata e não assume o papel. A tarefa `aws-check` do worker (a cada 30 s) confere cada pedido pela
     interface `AwsConnectionChecker`, com as conferências diárias (passo 3), e grava `connected` (com um aviso, se
     houver) ou `error` com o código, com auditoria (`cloud_account.aws_check`) na trilha do cliente. Um erro que pode
     passar deixa o pedido pendente por até 10 min (o papel recém-criado pode levar segundos para valer), com as
     tentativas espaçadas: 30 s, 1 min, 2 min e depois a cada 4 min, no máximo 6 conferências por clique (cada uma é
     uma linha no CloudTrail do cliente). O resultado só vale para o pedido conferido: a conta desativada no meio o
     descarta. O painel relê a conta a cada 5 s enquanto o pedido está pendente e mostra o que conferir em cada erro e
     em cada aviso.
   - **Início da coleta (`ingestFrom`):** na primeira verificação bem-sucedida, o dia anterior, gravado uma vez só. É
     o `only_logs_after` que o gerador da configuração do Wazuh usa (PR-V4'), para o nó não ler o histórico inteiro do
     bucket.
   - **Buckets de log no painel:** no máximo um por fonte (CloudTrail, GuardDuty e WAF), no cadastro e no detalhe da
     conta (`cloud_accounts:write`; quem só lê vê a lista). Outra lista de nomes volta a conexão para `waiting` e
     descarta um "Verificar" pendente, sem chamar a AWS: o cliente atualiza o `LogBucketArns` da pilha e pede a
     verificação. Trocar só a fonte de um bucket não muda nada disso, e o `ingestFrom` fica (um bucket incluído
     depois herda o dia da conta).
   - **Nó sem a própria identidade:** sem `NODE_SA_UNIQUE_ID` no `worker.env` (o nó da Verax, o ambiente local), a
     conferência é a `UnavailableAwsConnectionChecker`, que responde `check_unavailable` sem chamar a AWS nem o
     metadata, e o SDK da AWS nem é carregado no worker.
2. **Coletar (PR-V4'):** um timer do host renova a cada 10 min o token do Google (`format=standard`, sem o projeto
   nem a VM) num tmpfs (`/run/verax/wazuh-aws`, 0600), montado só leitura no manager. O gerador da configuração, o
   único que escreve, grava o `ossec.conf` e o `config` com um profile por conta: o ARN do papel, derivado do ID da
   conta, e `web_identity_token_file`. Não há arquivo `credentials` nem `<access_key>`, e o cano até o gerador não
   leva segredo. Mudar contas ou buckets reinicia só o manager, com volta automática à configuração anterior se ele
   não subir; indexer, API e painel seguem no ar.
3. **Conferir (PR-V5', feito):** o worker, o único contêiner com metadata, pede o próprio token, assume o papel e
   confere a conta e a leitura de cada bucket: é a `WebIdentityAwsConnectionChecker`
   (`apps/api/src/aws/web-identity-checker.ts`), no lugar da `UnavailableAwsConnectionChecker` do PR-V3'. Toda chamada
   é de leitura e cai no CloudTrail do cliente.
   - **Entrada no papel** (`aws/web-identity.ts`, `WebIdentityCredentials`): o token do Google pelo metadata
     (`audience` do nó, `format=standard`, 3 s de prazo), trocado no STS da primeira região da conta
     (`AssumeRoleWithWebIdentity`, sem assinatura, `RoleSessionName` `verax-control-worker`, 1 hora). As quatro partes
     da sessão são conferidas com zod e ficam num objeto que não vira JSON nem log, guardado por conta até faltarem
     5 min para vencer: uma entrada no papel por hora, dividida por todos os clientes do SDK (o inventário do PR-14'
     usa o mesmo provedor, `credentialsFor`). O token nunca vai para log nem erro, e o logger oculta qualquer JWT e o
     segredo e o token da sessão enquanto ela vale. Se o cliente desligou o STS da região (`RegionDisabled`), a troca é
     repetida em us-east-1 (que não pode ser desligado), e a conta fica conectada com o aviso `region_disabled`: o
     Wazuh usa o STS da região.
   - **A cada conferência** (o "Verificar" e, sem pedido, a cada 15 min para as contas já verificadas, conectadas ou
     com erro): `GetCallerIdentity` (a sessão tem de ser `assumed-role/verax-control-reader/verax-control-worker` da
     conta cadastrada, ou `account_mismatch`) e, em cada bucket cadastrado (sem repetir), `ListObjectsV2` com
     `MaxKeys=1` e `GetObject` de 1 byte (`Range: bytes=0-0`) do primeiro objeto, que prova o KMS quando o objeto é
     cifrado com ele. Os erros de bucket levam a fonte: `bucket_missing:<fonte>`, `bucket_denied:<fonte>` e
     `kms_denied:<fonte>` (`cloudtrail`, `guardduty` ou `waf`). Um objeto arquivado ou vazio não é erro. A negação
     explícita na política do papel só passa como o `LogObjectPrefix` quando o objeto listado é dos logs de outra conta
     (`AWSLogs/[<org>/]<outra conta>/`): o worker lê então o primeiro objeto desta conta no mesmo formato, e a negação
     dele (ou do objeto desta conta logo de início) é `bucket_denied:<fonte>`.
   - **Uma vez por dia** (e em todo "Verificar"), avisos que não param a coleta: `trail_not_logging` (nenhuma trilha
     ligada grava no bucket do CloudTrail: `DescribeTrails` com as de outras regiões e de organização, e
     `GetTrailStatus` só das que gravam nele), `guardduty_export_missing` (nenhum detector publica no bucket do
     GuardDuty: `ListDetectors`, `ListPublishingDestinations` e `DescribePublishingDestination`) e
     `excess_permissions` (`SimulatePrincipalPolicy` no próprio papel, com o IP de saída do nó em `aws:SourceIp`, numa
     amostra de escrita, IAM, STS, KMS fora do S3 e leitura fora da política; sem o `NODE_EGRESS_IPS` no worker, a
     simulação fica de fora). A trilha e o export são procurados nas regiões monitoradas até o primeiro encontrado.
   - **O que vai para a conta:** um erro vira `error` com o código; sem erro, a conta fica `connected` com o aviso de
     maior prioridade em `connectionError` (`region_disabled`, `trail_not_logging`, `guardduty_export_missing`,
     `excess_permissions`), que a API só devolve na AWS. Sem pedido, só uma mudança é gravada (com auditoria); um erro
     que pode passar numa conta conectada é tentado de novo, espaçado, por até 10 min antes de virar o erro dela, e a
     conta corrigida pelo cliente volta a conectada sozinha. A conta que voltou a aguardar (outra lista de buckets,
     reativação) fica fora até o "Verificar". O agendamento (15 min, diárias, tentativas) fica na memória do worker:
     numa partida nova, tudo é conferido de novo.
   - **Na partida do worker:** o `sub` do token do Google (decodificado sem rede) tem de ser o `NODE_SA_UNIQUE_ID`;
     senão, um erro no log com os dois IDs (nenhum é segredo, nunca o token): as pilhas criadas com o valor do painel
     recusam o nó.
   - Erros próprios: `trust_denied`, `token_invalid`, `idp_unavailable`, `metadata_unavailable` (o metadata do nó),
     `region_disabled` e `aws_unavailable`; o token do host sem renovar (`aws_token_stale`) é do PR-V4'.
4. **Desconectar:** o painel para a coleta e mostra os passos no console: "Revoke active sessions" no papel (corta as
   sessões já emitidas, de até 1 hora) e apagar a pilha. Não há chave para apagar.

**Riscos residuais e mitigação:**

| Risco                                                                                                                                    | Mitigação                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token do Google vazado: vale até 1 hora e não pode ser revogado                                                                          | Só entra do IP do NAT do nó (`aws:SourceIp` na confiança) e só no papel deste cliente; a sessão emitida também fica presa ao IP (Deny); regra de nível 12 para entrada de outro IP                                                                                                                  |
| Root no nó lê o token e as sessões em claro (tmpfs e memória do worker e do manager)                                                     | Valem 1 hora; nó dedicado a um cliente; sem porta aberta; acesso só pelo IAP com OS Login auditado; metadata só para o worker; o alcance é leitura de logs e configuração                                                                                                                           |
| Página da memória com segredo em claro (chave privada do cofre, token, sessões) vai para o swap, no disco do snapshot                    | Swap cifrado com chave aleatória a cada boot, nos dois perfis; no `standard`, `vm.swappiness=1` e o heap do indexer travado na memória                                                                                                                                                              |
| O ambiente de um contêiner fica gravado em `/var/lib/docker`, no disco e no snapshot                                                     | Chaves privadas do cofre só por arquivo do tmpfs montado só leitura no worker, nunca por variável (teste e CI conferem); o token da AWS fica num tmpfs do host                                                                                                                                      |
| Execução remota de código na API, exposta pelo túnel                                                                                     | A API não alcança o metadata e não emite token; cofre assimétrico para o Cloudflare                                                                                                                                                                                                                 |
| O manager processa log não confiável e lê o token                                                                                        | Sem acesso ao Postgres nem ao metadata; `cap_drop`; rede de saída só dele; imagem fixada pelo digest; nó dedicado; o token vale 1 hora e só do IP do nó                                                                                                                                             |
| Quem emite ID token da conta de serviço do nó entra no papel (operador com `serviceAccountUser`; no plano de controle, o `cp-terraform`) | Precisa também sair pelo IP do NAT do nó; alertas em `SetIamPolicy` na conta de serviço, em `GenerateIdToken` e em VM criada com a conta de um nó (CP-12); nunca `serviceAccountOpenIdTokenCreator` no Terraform                                                                                    |
| A conta de serviço do nó é apagada ou recriada, e o ID único muda                                                                        | `account_id` e `project` só do `name_prefix` e do `project_id`, com teste de que as mudanças de rotina não a recriam; o executor do plano de controle (CP-07) recusa recriá-la ou apagá-la fora da exclusão; restauração em até 30 dias com o mesmo ID; depois disso, cada cliente atualiza a pilha |
| Google ou o metadata fora do ar (`IDPCommunicationError`, renovação do token falha)                                                      | O token tem 50 min de folga; o wodle retoma do marcador e não perde log; aviso de token sem renovar                                                                                                                                                                                                 |
| A web identity pelo profile não funcionar no contêiner do manager                                                                        | Teste prático antes do PR-V4'; plano B: o host troca o token por uma sessão e grava um `credentials` temporário de 1 hora                                                                                                                                                                           |
| O `GetCallerIdentity` não pode ser negado e revela a conta e o ARN da sessão                                                             | Impacto baixo; documentado                                                                                                                                                                                                                                                                          |
| O IP do NAT muda e a coleta para                                                                                                         | IP reservado com `prevent_destroy`; erro `source_ip_denied` com instrução no painel                                                                                                                                                                                                                 |
| O cliente amplia o papel (anexa política, tira o boundary)                                                                               | `SimulatePrincipalPolicy` todo dia, com o IP do nó e uma amostra de escrita, IAM, KMS e leitura fora da política: aviso na conta, sem parar a coleta. Permissão a mais fora da amostra não é detectada                                                                                              |
| O cliente cria o papel pelo assistente do console e põe o audience no `aud`                                                              | Template e Terraform prontos; o README avisa; a mensagem de papel recusado explica                                                                                                                                                                                                                  |
| RCP de perímetro de dados do cliente nega a federação do Google                                                                          | O cliente inclui `accounts.google.com` na RCP ou marca o papel como exceção (decisão dele); texto pronto no onboarding                                                                                                                                                                              |
| STS de sa-east-1 desligado pelo cliente                                                                                                  | O worker cai para us-east-1; no Wazuh, o erro instrui a religar                                                                                                                                                                                                                                     |
| Objeção de conformidade: o Access Analyzer mostra o papel com acesso externo federado                                                    | Esperado e explicado no onboarding: papel com credencial temporária é o que a AWS recomenda; o CloudTrail registra cada entrada com o `sub` do nó                                                                                                                                                   |
| Ruído no CloudTrail e no medidor (cerca de 1.700 entradas por dia por conta, estimativa)                                                 | Medir no teste prático; se pesar, intervalo de 10 min ou descontar do medidor                                                                                                                                                                                                                       |
| Bucket de organização legível inteiro                                                                                                    | Prefixo opcional na pilha (`LogObjectPrefix`); nó dedicado ao mesmo cliente                                                                                                                                                                                                                         |
| Na saída do cliente, o papel segue na conta dele                                                                                         | Roteiro: "Revoke active sessions" e apagar a pilha; sem o papel, o nó não entra                                                                                                                                                                                                                     |

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

_(fase 2: a auditoria está no código, no PR-12; os eventos de segurança vêm no PR-13)_

O Cloudflare é lido pela API dele, por um coletor nativo no worker, sem o Wazuh. Vale para o nó da Verax e para os
nós de clientes:

- **Auditoria da conta** (audit logs v2), com cursor por conta (detalhes abaixo);
- **Eventos de segurança do WAF**, pela API GraphQL de analytics, em janelas de 15 min. O Cloudflare amostra esses
  eventos, então as contagens são aproximadas. Ele guarda os eventos por uma janela que vale por zona e depende do
  plano (`notOlderThan`, de até 31 dias). Uma parada do nó mais curta que essa janela não perde dados; numa parada
  mais longa, o que passou da janela se perde.

As regras são próprias (faixa 9903xx), com título em português e MITRE. O token é de conta, **só de leitura**, com
três permissões: `Account Settings: Read` (a auditoria da conta), `Zone: Read` (a lista de zonas) e `Analytics: Read`
(os eventos de segurança). Contas cloud abre a criação dele no Cloudflare com as três já marcadas (o link de token de
conta pré-preenchido que o Cloudflare documenta), mostra o IP de saída do nó (`NODE_EGRESS_IPS`) para o filtro de IP do
token e recebe o token colado, que vai para o cofre do nó (seção "Cofre de credenciais").

O Logpush fica fora da v1: exige permissão de escrita (`Logs Edit`) e um destino que o Cloudflare possa gravar. Pode
voltar depois como modo completo, sem amostragem.

### Coletor da auditoria (`apps/api/src/cloudflare/`)

- **Onde roda:** no worker, como a fonte `cloudflare` de `SYNC_SOURCES`, que exige o cofre de credenciais (o worker
  não sobe com a fonte e sem as chaves privadas). O token de cada conta é aberto na memória do worker a cada execução,
  entra na máscara do logger (segredo vivo) e só sai no header `Authorization`, só para `api.cloudflare.com` (host
  fixo; só os testes apontam para `127.0.0.1`). A API nunca decifra.
- **O que lê:** `GET /accounts/<conta>/logs/audit` com `since` e `before` (obrigatórios, RFC 3339), `direction=asc`,
  `limit=500` e o `cursor` opaco de `result_info.cursor`, no máximo 20 páginas por execução. A conta só é lida com o
  token dela, e cada uma tem dois cursores (`CollectorCursor`): `cloudflare_audit` e `cloudflare_check`.
- **Janela:** a cada `CLOUDFLARE_AUDIT_INTERVAL_SECONDS` (5 min por padrão; o laço da tarefa segue o
  `SYNC_INTERVAL_SECONDS`), de `cursor - 10 min` até `agora - 1 min`. A primeira leitura pega 7 dias, e nenhuma volta
  mais de 30 dias. Cada página processada é gravada antes do pedido da seguinte: a continuação (o cursor do Cloudflare
  e a janela) e o uso medido. Uma execução cortada no meio (orçamento de tempo, parada do worker, falha numa página
  adiante) ou no teto de páginas não perde o que já leu, e a próxima, logo em seguida, segue dela. Lida a janela
  inteira, o cursor vai para o fim dela. Uma continuação recusada (400) recomeça a janela pelo cursor.
- **Cada entrada:** validada com zod, uma a uma (texto longo é cortado, `request` e `response` são lidos pelas regras e
  descartados; nada do evento bruto é gravado). A inválida vai para a fila sem dono (`invalid_alert`) sem parar o lote;
  a que diz ser de outra conta, também (`source_mismatch`, ou `no_account` sem conta). A da conta conta como atividade
  (`lastEventAt`), e a de uma zona fora da lista cadastrada é ignorada (lista vazia é todas). Regra que casa vira
  achado do cliente da conta (`source='cloudflare'`, `logSource='cloudflare_audit'`, chave única `cf/<conta>/<id>`),
  com a exceção e o incidente na mesma transação: reler a sobreposição não duplica. O ator é o e-mail ou o nome do
  token, e o ID do token (que não é segredo) vai em `accessKeyId`, para juntar as ações do mesmo token num incidente.
- **Regras (990301 a 990324):** tabela em `cloudflare-rules.ts`, pelo caminho da API (`raw.uri`, sem regex), pelo
  método e, quando precisa, pelo corpo da requisição. Os caminhos são os da API pública; se as ações feitas pelo painel
  aparecem com o mesmo caminho só os eventos reais confirmam.
- **Conferência de hora em hora:** o `tokens/verify` e a leitura de prova (os mesmos do painel), que atualizam a
  validade e a última conferência do token guardado, e, com zonas cadastradas, `GET /zones?account.id=<conta>`: uma
  zona cadastrada que não existe deixa a conexão em erro (`zone_not_found`), e o token sem `Zone: Read`, também
  (`zones_forbidden`), sem parar a auditoria.
- **Falhas e conexão:** 5xx, rede e tempo esgotado (20 s por tentativa) são tentados de novo duas vezes na mesma
  execução; depois, o cursor recua (1 min, dobrando, até 1 h). O 429 nunca é repetido: o limite é do token inteiro,
  então os dois fluxos da conta (auditoria e conferência) esperam o `retry-after` (5 min sem ele), venha o 429 de
  qualquer um deles. O cartão da conta mostra o código (`rate_limited`, `timeout`, `http_503`...).
  **Token recusado (401), sem acesso à auditoria (403), vencido ou desativado** param a coleta: o worker não chama mais
  o Cloudflare com aquele token até um admin colar outro (o que recomeça a conexão), e o cartão explica o motivo. Toda
  escrita da conexão confere, sob o lock da credencial, que o token guardado ainda é o usado na leitura.
- **Medidor:** os bytes de cada página lida entram no uso do cliente (`IngestUsage`, fonte `cloudflare`), depois de o
  cursor avançar.

## Agentes nas instâncias do cliente

_(no código, desligado por padrão em cada nó; o aceite depende da homologação no ar. Roteiro para ligar:
`docs/runbooks/onboarding-cliente.md`, seção 6)_

O cliente instala o agente do Wazuh 4.14.9 nas VMs e EC2 dele, e os agentes falam com o manager do nó dedicado:
integridade de arquivos, inventário, vulnerabilidades pelo inventário e avaliação de configuração (SCA). Liga nó a nó,
em dois interruptores que andam juntos: `wazuh_agents` no Terraform do nó e `WAZUH_AGENTS=true` no `node.conf`, só no
perfil `standard`. Desligado, nada muda: o Terraform não cria nada, o `install.sh` não instala nada, os arquivos de
ambiente e o projeto do Compose saem byte a byte como antes e o nó não publica porta nenhuma (os testes e o CI conferem).

```
instância do cliente (agente) ──TCP 1514 e 1515──► IP fixo de entrada (regra de encaminhamento da GCP, só das faixas
                                                    do cliente) ──► VM do nó, sem IP externo ──► Docker ──► manager
host do nó (timer, a cada minuto) ──docker exec──► API do manager (localhost:55000) ──► /run/verax/wazuh-agents/agents.json
worker (lê o arquivo, só leitura) ──► Postgres (WazuhAgent, no cliente do nó) ──► API ──► painel (Agentes)
```

- **Entrada sem tirar a saída do Cloud NAT.** Um IP externo na VM faria o NAT um para um por ele e tiraria a VM do
  Cloud NAT (docs.cloud.google.com/nat/docs/public-nat): a saída do nó mudaria de IP, e o acesso à AWS do cliente, que
  só vale a partir do IP reservado do NAT, pararia. Por isso o IP fixo é de uma regra de encaminhamento (protocol forwarding)
  para a VM, nas portas 1514-1515: o IP de origem do agente chega preservado, a resposta sai com o IP da regra, e o que
  o nó inicia continua saindo pelo NAT (`infra/gcp/modules/node/agents.tf`).
- **Firewall:** uma regra de entrada só com as faixas que o cliente informa (`wazuh_agents_sources`, IPv4 de /16 a
  /32, no endereço da rede; nada de `0.0.0.0/0`), só TCP 1514 e 1515, só para a VM do nó, com registro. Sem faixa, a
  regra não existe, a `deny-ingress` recusa tudo e o painel diz que a liberação está pendente.
- **No nó:** o `compose.wazuh-agents.yaml`, que o `start.sh` soma só com o interruptor, publica no manager só a
  1514/tcp e a 1515/tcp. O manager continua nas mesmas redes (`wazuh` e `wazuh-egress`): não divide rede com a API nem
  com o banco.
- **Registro (authd, 1515) só com senha** (`use_password`), gerada por nó pelo `install.sh` como as outras senhas
  internas (`/var/lib/verax/secrets/wazuh-agents-enrollment`, 32 letras e dígitos) e entregue ao manager pelo gerador
  da configuração (`etc/authd.pass`). A API a recebe pelo ambiente e a mostra só a quem administra o cliente
  (`agents:enroll`), só na resposta das instruções, com vaga no limite do nó; a trilha de auditoria registra cada
  consulta às instruções e se a senha foi mostrada, nunca a senha, e o logger a oculta por valor.
- **O agente confere o manager antes de mandar a senha:** o `install.sh` emite uma CA só dos agentes e o certificado do
  authd com o IP fixo no CN e no SAN (refeitos se o IP mudar; a chave da CA é descartada). A CA vai no script de
  instalação (`WAZUH_REGISTRATION_CA`). Conferido num manager 4.14.9 avulso: o TLS fecha com o IP certo e é recusado
  com outro (`infra/wazuh/scripts/test-agents.sh`).
- **Manager endurecido** (`infra/wazuh/config/manager/agents/ossec-agents.conf`, opções da referência 4.14): resposta
  ativa desligada no manager e em todos os agentes (`<active-response><disabled>yes</disabled>`), nenhum comando de
  resposta definido; agente mais novo que o manager recusado; o agent.conf do grupo `default` só com FIM, inventário,
  rootcheck, SCA e limite de eventos por agente (`client_buffer`, 200 por segundo), sem coleta por comando nem módulo
  de comando (os `remote_commands` do agente ficam no padrão, 0); detecção de vulnerabilidades ligada, sem indexar o
  estado (as detecções viram alertas). Os pacotes do script são os oficiais da versão do manager, conferidos pelo
  SHA-512 publicado pela Wazuh numa pasta temporária própria (`mktemp -d` no Linux; no Windows, nome aleatório e ACL
  só de Administradores e SYSTEM), apagada no fim, sem acrescentar repositório.
- **Como o painel sabe dos agentes sem falar com o manager:** nem a API nem o worker dividem rede com ele. O host, que
  já fala com o contêiner do manager pelo Docker, pede a lista à API dele (`localhost:55000`, usuário `wazuh-wui`, a
  senha pela entrada padrão do curl) a cada minuto, só com os campos do painel, e grava o arquivo em `/run/verax`
  (memória), com teto de tamanho. O worker o lê montado só leitura, confere cada campo com zod (a resposta é entrada
  não confiável), grava em `WazuhAgent` no cliente do nó (`WAZUH_AGENTS_TENANT`) e tira o que saiu do manager; a API lê
  pelo escopo da sessão. O indexer não serve: sem o dashboard, ninguém grava o estado dos agentes em
  `wazuh-monitoring-*`, e o `wazuh-states-*` só traria o inventário, não o estado nem o último sinal.
- **Limite por nó:** `WAZUH_AGENTS_MAX` (padrão 50, até 500). O Wazuh 4.14 não tem opção de limite de agentes (as
  referências de `auth` e `remote` não trazem nenhuma): o limite é do produto, e no limite a senha deixa de sair no
  painel. Quem já tem a senha ainda registraria; a troca da senha (roteiro) fecha isso.
- **Memória:** o manager segue com 1,5 GiB (a soma dos limites do nó continua em cerca de 6 GiB). Para 50 agentes, o
  remoted e o analysisd pesam pouco; o que pode pesar é a detecção de vulnerabilidades (o banco do feed da CTI e as
  varreduras). O ensaio da homologação mede: se passar, o caminho é subir o manager e baixar o heap do indexer, ou o
  plano B da VM.
- **Alertas dos agentes:** chegam ao indexer como os outros e viram achados do cliente do nó pelas regras da seção
  abaixo.
- **Fora desta entrega:** o agente com o cloudflared de cada instância (túnel TCP, sem IP de entrada, mas um processo
  a mais em cada máquina do cliente e um token por instância) e a VPN para o Enterprise (rede privada até o nó, sem
  porta na internet).

### Atribuição dos alertas dos agentes (`apps/api/src/alerts/agent-*.ts`)

Na dúvida, o alerta não é de ninguém: vai para a fila sem dono, que só `admin_verax` vê, com o motivo.

- **Dois caminhos que nunca se cruzam.** Quem gerou o alerta é o `agent.id`, que o manager grava pela conexão de cada
  agente (a chave dele), e não pelo conteúdo do log. `000` é o próprio manager, onde o módulo aws-s3 lê as contas AWS:
  esses alertas seguem só pelo sync da AWS (`wazuh`), pela regra de sempre (o bucket de origem e a conta, que precisam
  concordar). Qualquer outro id é um agente, e o alerta segue só pelo sync dos agentes (`wazuh-agent-alerts`). A
  partição vale na consulta (`agent.id` igual a `000` na página da AWS e diferente na dos agentes) e de novo em cada
  alerta lido (`isAgentAlert`): um alerta nunca é atribuído pelos dois caminhos. Um agente que mande um log igual ao do
  aws-s3 (o log da instância é de quem a usa) não vira achado de conta AWS: vira, no máximo, achado da própria
  instância.
- **O alerta do agente é do cliente do nó só quando, ao mesmo tempo:**
  1. os agentes estão ligados no worker (`WAZUH_AGENTS_FILE` e `WAZUH_AGENTS_TENANT`, sempre juntos). Sem eles, o
     alerta vai para a fila (`agents_disabled`);
  2. o id do agente está na lista do cliente do nó (`WazuhAgent`, que o worker grava a partir da API do manager), com o
     mesmo nome. Fora da lista, `unknown_agent`; na lista com outro nome, `agent_name_mismatch`. O nome sozinho nunca
     decide: quem registra o agente escolhe o nome;
  3. nenhuma conta AWS citada no log (`data.aws`, pelos mesmos campos e conferências do sync da AWS) está cadastrada em
     outro cliente, ativa ou não (`agent_account_conflict`). A conta do próprio cliente, ou de cliente nenhum, não muda
     nada. Campo de conta fora do formato invalida o alerta (`invalid_alert`), como no sync da AWS.
- **A lista chega com atraso:** o host a exporta a cada minuto, e o worker a grava a cada minuto. O alerta de um agente
  que a lista não conhece (ou conhece com outro nome) espera a próxima execução, sem ir para a fila, quando é recente
  (menos de 3 min) e a lista é mais antiga que ele: a sobreposição da leitura (10 min) o relê. Passada a espera, ou com
  a lista mais nova que o alerta, vai para a fila.
- **O achado:** `source='wazuh'`, `logSource='wazuh_agent'` (o painel mostra "Agente (instância)"), origem
  `agent:<id>` no lugar da conta (os dois-pontos não aparecem em nenhum identificador de conta, e o contrato aceita os
  dois formatos), recurso `host:<nome do agente na lista>`, severidade pelo nível da regra (12 ou mais crítica, 10
  alta, 7 média, abaixo baixa), MITRE da regra e, do log, só o IP (`data.srcip`) e o usuário (`srcuser`, `dstuser` ou
  o `targetUserName` do Windows), conferidos no formato e usados só para mostrar e agrupar. A chave única é
  `wazuh/agent:<id>/alert:<id do alerta>:<regra>`: o log da instância não tem um id próprio em todas as fontes, e o id
  do alerta é o mesmo a cada releitura do documento (reler a janela não duplica). O detalhe busca o evento bruto no
  indexer pelo id do alerta, saneado como os outros.
- **O mesmo tratamento dos outros achados:** exceção do cliente (por regra e usuário, IP ou recurso, como
  `host:web-01`) e agrupamento em incidente (os achados da mesma instância se juntam pelo recurso), na mesma transação,
  pelo `FindingStore` de sempre. A cobertura das contas (último evento, conta silenciosa) não muda: agente não é conta.
- **Leitura separada:** a tarefa `wazuh-agent-alerts` tem estado e concessão próprios no `SyncState`, com as mesmas
  regras de leitura do sync da AWS (nível 5 ou mais, sobreposição de 10 min, cursor, até 100 páginas). Uma instância
  barulhenta não atrasa os achados das contas, e o caminho da AWS não muda.

## Custo por nó

Valores ficam fora deste documento: o preço da nuvem muda, e preço, custo por cliente e margem são informação
comercial, mantida fora do repositório público. Preços e custos vivem no Firestore do plano de controle: a tabela de
preços (`pricingTables`) e o modelo de custos (`costModels`), editados pelo responsável no console (`cp-admin`) e
conferidos pela checagem de publicação (seção "Preço configurável"); o custo de cada porte, a estimativa da nuvem do
cliente e a DRE de qualquer configuração saem do simulador do console. Para estimar a infraestrutura, use a
[calculadora da Google Cloud](https://cloud.google.com/products/calculator) com os recursos de cada perfil (seção
"Perfis de nó"):

- **`standard`** (nó de cliente, southamerica-east1): a VM e2-standard-2 é a maior parte; depois vêm o disco de 60
  GB pd-balanced, os snapshots diários guardados por 7 dias e o resto: o Cloud NAT com o IP reservado, o Pub/Sub, os
  segredos, o backup e os flow logs. O plano B (e2-standard-4) dobra a VM.
- **Portes:** o nó de cliente tem um porte, P, M ou G, calculado pela regra da tabela de preços a partir das contas
  de nuvem, do volume de logs e dos agentes contratados (o maior que qualquer um exigir). O porte P é o nó `standard`
  de hoje; M e G (máquina, disco, memória e heap do indexer maiores) chegam ao módulo `node` no PC-09. A regra (os
  limites de cada porte) é dado da tabela, não código: o portão do ensaio geral decide os números do P.
- **Homologação parada** fora das janelas de teste: só o disco, os snapshots e o IP reservado.
- **`lean`** (nó da Verax): estimativa em `infra/gcp/GUIA.md`.
- **Túnel do Cloudflare e Firebase Hosting:** sem custo nesta escala.
- **Agentes nas instâncias do cliente** (só nos nós que ligam): uma regra de encaminhamento da GCP por nó, cobrada
  por hora (o IP preso a ela não é cobrado), e o tráfego de entrada processado, pelos
  [preços do Cloud Load Balancing](https://cloud.google.com/load-balancing/pricing) e da
  [rede](https://cloud.google.com/vpc/network-pricing). Um IP externo na VM sairia mais barato, mas tiraria a saída
  do Cloud NAT.
- **Na conta AWS do cliente** (fora da conta da Verax): saída do S3 para a internet, GETs e KMS, pelos
  [preços do S3](https://aws.amazon.com/s3/pricing/). Com o CloudTrail compactado, o volume é pequeno; o log completo
  do WAF pode pesar, e por isso ele é opcional.
- **Referência anterior:** a pilha do nó na AWS, fora do caminho atual, usa uma VM `t3a.xlarge` (16 GB); estimativa
  na [calculadora da AWS](https://calculator.aws/).
- **Plano de controle:** cabe no nível gratuito do projeto da Verax.

## Plano de controle _(fase 3, a construir)_

O plano de controle é o que transforma uma compra no site num nó de cliente no ar sem operador: calculadora de preço,
checkout, webhook da Stripe, máquina de estados do cliente, provisionamento passo a passo e exclusão, mais o console do
responsável (tabelas de preços e de custos e DRE). Vive em `apps/control-plane` (NestJS 12 + zod 4, as mesmas regras
do monorepo) e roda no projeto da Verax na GCP, dentro do nível gratuito. Os nós continuam como na fase 2; o plano de
controle só os cria, para, liga e destrói. O detalhamento (fluxos, limites e PRs) está no plano da fase 3 e no estudo
do preço configurável, documentos internos.

### Peças

| Peça                                           | Onde                                                                                | Faz                                                                                                                                                                                                           | Não faz                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Site estático** (repo privado)               | `veraxsistemas.com.br`, Firebase Hosting                                            | Calculadora de preço (lê a tabela pública e pede a cotação), formulário de compra, página de status com a revelação única da senha, link do Portal do cliente                                                 | Nunca toca chave da Stripe nem dado de cliente além do que o usuário digita; nunca manda preço (só a cotação)     |
| **`cp-public`** (Cloud Run, 0 a 2 instâncias)  | Projeto da Verax, atrás de `conta.veraxsistemas.com.br` (Hosting com rewrite `/**`) | Tabela pública de preços e cotação, checkout pela cotação, consulta de subdomínio, página de status (claim, status, reveal), webhook da Stripe, `/health`                                                     | Nenhuma rota interna nem do console: aceita invocação anônima (exigência do rewrite do Hosting)                   |
| **`cp-worker`** (mesma imagem, `ROLE=worker`)  | Projeto da Verax, só IAM                                                            | Um passo do provisionamento por task, `tick` horário, `reconcile` diário, operações do responsável (`resume`, `delete-now`, `export`)                                                                         | Não é alcançável sem token de identidade do Google; o app ainda confere `aud` e `email` do token                  |
| **`cp-admin`** (mesma imagem, `ROLE=admin`)    | Projeto da Verax, atrás do IAP ligado direto no Cloud Run (sem balanceador)         | Console do responsável: as telas (`apps/console`) e a API das tabelas de preços e dos modelos de custo (rascunho, checagem, publicação), simulador de DRE                                                     | Só o responsável entra (IAP); o app confere de novo o JWT assinado do IAP; nenhum segredo, nem a chave da Stripe  |
| **`cp-terraform`** (Cloud Run Job)             | Projeto da Verax; identidade com papéis no projeto dos nós                          | `init`, `plan` e `apply`/`destroy` de `infra/gcp/envs/tenant` com Terraform fixado, estado por tenant no bucket                                                                                               | Não lê Stripe, Cloudflare nem Firestore; só recebe variáveis já validadas por regex                               |
| **Firestore** (banco `(default)`, modo nativo) | Projeto da Verax                                                                    | Estado: `tenants` (com `transitions` e `invoices`), `slugs`, `stripeEvents`, `statusTokens`, `provisioningRuns`, `auditLog`, `rateLimits`; preço configurável: `pricingTables`, `costModels`, `quotes` (24 h) | Nunca guarda segredo, senha, cartão, token do túnel nem corpo bruto do webhook                                    |
| **Cloud Tasks** e **Cloud Scheduler**          | Projeto da Verax                                                                    | Filas `provisioning` e `lifecycle` com nova tentativa e recuo, OIDC para o `cp-worker`; `tick` a cada hora e `reconcile` às 03:00                                                                             | Nada de longa duração: o `apply` roda no Job, a task só dispara e espera                                          |
| **Secret Manager** e **bucket de releases**    | Projeto da Verax                                                                    | Chaves da Stripe (teste e produção separadas), token do Cloudflare, senha SMTP, chave do cookie; manifesto da versão e bundle do painel                                                                       | —                                                                                                                 |
| **Projeto dos nós** e **Firebase dos painéis** | Pago, criado na 1.ª venda; 1 a N projetos do Firebase (36 sites por projeto)        | Recursos `vx-<slug>` do módulo `node` (perfil `standard`); um site por cliente em `<slug>.control.veraxsistemas.com.br`, API em `api-<slug>`                                                                  | Sem o projeto dos nós, o provisionamento falha com `provisioning_disabled` (sem laço) e retoma quando configurado |

### Identidades

- **`cp-public`:** lê e escreve no Firestore, enfileira tasks e lê as chaves da Stripe e do cookie. Nada mais.
- **`cp-worker`:** Firestore, tasks, execução do Job, Firebase Hosting nos projetos do pool, leitura do bucket de
  releases e, no projeto dos nós (`envs/nodes-platform`), um papel personalizado que só para, liga e lê atributos de
  VMs cujo nome começa com `vx-` (`cpNodeLifecycle`) e a leitura de `runs/` no bucket do estado. Por tenant, o
  `envs/tenant` concede, cada permissão num cofre só: adicionar a versão do token do túnel (`secretVersionAdder`); ler
  uma vez e destruir a versão do `admin-bootstrap` (`secretAccessor` e `secretVersionManager`); listar e destruir as
  versões de `credentials-key` (`cpSecretVersionDestroyer`, sem ler nem gravar). Nunca ler o cofre de credenciais, e
  nada no `support-bootstrap`.
- **`cp-terraform`:** os papéis de criar e destruir os recursos do módulo `node` no projeto dos nós
  (`envs/nodes-platform`; o mais sensível é `projectIamAdmin`, para a SA de cada nó escrever logs e métricas; mitigado
  pelo projeto isolado, pela imagem fixada e por alerta em `SetIamPolicy` fora da lista). Cofres e buckets por papéis
  personalizados que não alcançam o conteúdo. Não lê Stripe, Cloudflare nem Firestore.
- **`cp-deployer`:** Workload Identity Federation para o environment `control-plane` da `main`; publica a imagem e
  troca a imagem dos serviços (`run.developer` em cada serviço e no Job, nunca no projeto; `iam.serviceAccountUser`
  nas SAs de execução; escrita no registro). Não cria serviço nem toca o Firestore: índices e TTL são do Terraform.
  Nenhum segredo.
- **`cp-admin`:** lê e escreve no Firestore (tabelas de preços, modelos de custo e auditoria). Nenhum segredo: a
  configuração recusa qualquer um, inclusive a chave da Stripe. O ingresso é só pelo IAP (o agente de serviço do IAP
  tem `run.invoker`; o responsável, `iap.httpsResourceAccessor`), e o app confere em toda requisição o JWT do cabeçalho
  `x-goog-iap-jwt-assertion` (ES256, emissor `https://cloud.google.com/iap`, `aud` = `IAP_AUDIENCE`, e-mail em
  `OWNER_PRINCIPALS`).
- **Responsável:** invoca o `cp-worker` com token de identidade, entra no `cp-admin` pelo IAP, administra os segredos;
  tudo auditado (`owner:<e-mail>`).

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

### Página de status e revelação única da senha (CP-05)

A página `/checkout/sucesso` do site acompanha a compra e mostra a senha temporária do primeiro admin uma vez. O site
fala só com o `cp-public`; quem lê o segredo é o `cp-worker`.

- **`POST /v1/public/status/claim`** (`{sessionId: "cs_..."}`, 10 por hora por IP): relê a sessão do Checkout na Stripe
  (completa, do mesmo modo, com `metadata.tenantId` igual ao `client_reference_id`), confere que o cliente, se já
  existe, é dessa sessão, não foi excluído e não teve a senha revelada, e devolve o cookie `__session` (httpOnly,
  Secure, SameSite=Lax, `Path=/v1/public/status`, 7 dias): `v1.<valor>.<HMAC-SHA256 com a COOKIE_KEY>`. O valor tem
  256 bits aleatórios; no Firestore fica só o SHA-256 dele (`statusTokens/{sha256}`, tipo `cookie`). Qualquer
  divergência é o mesmo 404. Uma compra paga cujo cliente o webhook ainda não criou também recebe o cookie, e a página
  mostra `pending` até ele nascer.
- **`GET /v1/public/status`** (12 por minuto por cookie): `{state, step, etaMinutes, panelUrl, apiUrl,
revealAvailable, boletoUrl?}`. O passo e a estimativa só em `provisioning`; os endereços do ambiente pronto em
  diante; o link do boleto só em `pending` com boleto em aberto, lido na hora da Stripe e nunca guardado. Nunca o
  código de um erro. Cookie ausente, forjado, vencido ou de cliente excluído: 404.
- **`POST /v1/public/status/reveal`** (5 por hora por IP, só JSON): com o cookie, ou com o valor do link do e-mail no
  corpo. O `cp-public` confere a credencial e chama `POST <WORKER_URL>/internal/access/reveal` com o token de
  identidade da própria conta. No `cp-worker`: (1) uma transação marca `access.passwordRevealedAt` (e o uso do link)
  antes de qualquer leitura, com a auditoria `access.revealed`; a segunda revelação é 409; (2) lê a versão `latest` de
  `vx-<slug>-admin-bootstrap` no projeto dos nós e põe a senha na máscara do logger antes do próximo `await`; (3)
  enfileira `secrets.destroy_bootstrap` antes de responder, então a versão é destruída mesmo que a resposta se perca;
  (4) devolve painel, login e senha, com `Cache-Control: private, no-store`. Se a leitura falhar, a senha já tiver
  vencido ou a fila recusar, nada foi mostrado: a marcação é desfeita (`access.reveal_reverted`) e o cliente tenta de
  novo. Depois da revelação o `cs_` não vale mais.
- **Quem chama o quê no `cp-worker`:** o ingresso exige token de identidade do Google com `run.invoker` (cp-invoker,
  cp-public e o responsável). O app tira a identidade do cabeçalho que o Cloud Run conferiu (o
  `X-Serverless-Authorization` quando houver, senão o `Authorization`; os dois juntos são recusados, porque com os dois
  o Cloud Run só confere o primeiro), confere de novo a assinatura com as chaves públicas do Google (sem assinatura, só
  no `X-Serverless-Authorization`, onde o Cloud Run a remove depois de conferir), o emissor, `aud = WORKER_URL`, o prazo
  e o e-mail por rota. O token do `cp-public` (`PUBLIC_SA_EMAIL`) só vale na revelação; o da cp-invoker e o do
  responsável, só nos passos (`POST /internal/steps/<passo>`). A chamada do `cp-public` sai pela internet, então a revelação depende da decisão
  sobre a entrada do `cp-worker` no GUIA ("Revelação da senha e a entrada do cp-worker"); até lá, ela responde 503.
- **Plano B por e-mail:** 48 h depois de o cliente entrar em `waiting_customer_connection` sem ver a senha (e antes das
  72 h em que ela vence), o `tick` do CP-11 chama `RevealEmailService.dispatchDue`, que enfileira o passo
  `access.reveal_email`; o passo cria um link de uso único (`statusTokens` do tipo `email_reveal`, 24 h), manda o
  e-mail "ambiente pronto" pelo SMTP do `cp-worker` com o link no fragmento (`#acesso=<valor>`, que o navegador não
  envia a servidor nenhum) e marca `access.revealEmailSentAt`. O e-mail nunca leva a senha.
- **Contrato com o bootstrap do nó (CP-10):** cada versão de `admin-bootstrap` é um JSON com exatamente `email`,
  `password` (16 a 256 caracteres) e `expiresAt` (ISO 8601 com fuso). O segredo guarda só o admin do cliente: a senha
  de outra conta (a de suporte) vai para outro segredo, `vx-<slug>-support-bootstrap` (seção seguinte), senão a
  `latest` a mostraria ao cliente.

### O nó de cada cliente: `envs/tenant` e `envs/nodes-platform` (CP-06)

O projeto dos nós tem dois tipos de ambiente do Terraform em `infra/gcp/envs/`:

- **`nodes-platform`**, um só, aplicado pelo responsável: as APIs, o orçamento, o bucket do estado
  `<projeto-dos-nos>-tfstate` (criado à mão antes do primeiro `init` e adotado pelo primeiro `apply`, com acesso
  uniforme, versionamento, versões antigas por 30 dias e `runs/` por 180 dias) e as permissões do plano de controle
  nesse projeto: os papéis do `cp-terraform` (os 10 predefinidos, `cpSecretsProvisioner` e `cpBucketsProvisioner`), o
  `objectAdmin` dele no bucket do estado, o `cpNodeLifecycle` do `cp-worker` com a condição `vx-*`, a leitura dele em
  `runs/` e o papel `cpSecretVersionDestroyer` (só `versions.destroy`, `versions.get` e `versions.list`), que o tenant
  concede por cofre. Até o CP-06 essas permissões ficavam no `envs/control-plane`; o bucket e as concessões nele agora
  estão no mesmo estado.
- **`tenant`**, um por cliente, aplicado pelo `cp-terraform` com estado em `tenants/<slug>/`: o módulo `node` no perfil
  `standard` com o prefixo `vx-<slug>` em todo recurso (a VM, a conta de serviço, a rede, o NAT e o IP dele, o disco,
  os cofres; o bucket de backups é `<projeto>-vx-<slug>-backups`), a leitura do registro das imagens para a conta da VM
  e as permissões do `cp-worker` nos cofres daquele nó (seção "Identidades"). As variáveis são as do Job (projeto,
  região e zona) e as de cada execução: `slug`, `plan` (essencial, profissional ou enterprise; `interno` é recusado),
  os quatro limites opcionais (`plan_max_cloud_accounts`, `plan_max_users`, `plan_monthly_gib`, `plan_history_days`,
  obrigatórios no enterprise), `node_version` (`node-vX.Y.Z`), `node_package_sha256`, `web_origin`, `api_origin`,
  `mail_from`, `subnet_cidr` (uma /24 em 10.0.0.0/8), `bootstrap_admin_email`, `bootstrap_tenant_name`,
  `bootstrap_support_email` (a conta de suporte da Verax, CP-10),
  `control_plane_sa` (só a conta `cp-worker@...`), `images_project_id` e `deletion_protection`. As saídas, que vão para
  o `outputs.json`, não têm dado pessoal: `name_prefix`, `instance_name`, `zone`, `nat_ip`, `service_account_email`,
  `service_account_unique_id`, `secrets` (o nome de cada cofre) e `backups_bucket`.

Os três contratos do nó com a instalação sem operador (PR-N7) e com o bootstrap do admin (CP-10) são interruptores
do módulo, desligados por padrão (o nó da Verax e a homologação não mudam) e ligados pelo `tenant`:

1. **Cofres que a VM grava** (`support_bootstrap_secret`):

   | Cofre                               | Quem grava                                                        | Quem lê (pelo Terraform)                                       |
   | ----------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
   | `vx-<slug>-credentials-key`         | a VM, na instalação                                               | a VM; o `cp-worker` só lista e destrói as versões (Exclusão 2) |
   | `vx-<slug>-admin-bootstrap`         | a VM (JSON do contrato acima)                                     | o `cp-worker`, uma vez, na revelação, e destrói a versão       |
   | `vx-<slug>-support-bootstrap`       | a VM (a senha da conta de suporte)                                | ninguém: só o responsável, com as permissões dele no projeto   |
   | `vx-<slug>-cloudflare-tunnel-token` | o `cp-worker` (passo `secrets.tunnel_token`)                      | a VM                                                           |
   | `vx-<slug>-smtp-password`           | ninguém pelo plano de controle, por enquanto (pendência do CP-07) | a VM                                                           |

   No `support-bootstrap`, a única permissão do Terraform é `secretVersionAdder` para a conta da VM.

2. **Atributos de convidado** (`guest_attributes`): metadado `enable-guest-attributes = "TRUE"`. O worker do nó grava
   no espaço `verax/` (`verax/version`, `verax/accounts-connected`, `verax/last-event-at`, `verax/disk-free` pelo
   CP-10; `verax/ready` e `verax/error` pela instalação), e o `cp-worker` lê com `getGuestAttributes`
   (`cpNodeLifecycle`). Só o worker fala com o servidor de metadados dentro da VM.

3. **Configuração nos metadados da VM** (`install_config` e `install_metadata`): a instalação lê cada chave em
   `instance/attributes/<chave>` do servidor de metadados e monta o `node.conf` e as contas do cliente. As 20 chaves
   existem sempre; valor vazio é "não definido" (a instalação não escreve a linha). Nada é segredo; os e-mails e o
   nome do cliente são dados de cadastro, que ficam nos metadados enquanto o nó existir, e a instalação os trata como
   dado (nunca os interpreta num shell). O projeto vem de `project/project-id`. O IP de saída (`NODE_EGRESS_IPS`)
   fica de fora: o checkov 3.4.0 não avalia os metadados da VM com uma referência ao IP reservado do NAT, e deixaria
   de conferir as chaves de segurança dela; a instalação o descobre pela própria saída ou o recebe do plano de controle
   (saída `nat_ip`), decisão do PR-N7. O ID único da conta da VM também está no `sub` do token de identidade que ela
   pede ao servidor de metadados.

   | Chave                           | No nó                                         | De onde vem               |
   | ------------------------------- | --------------------------------------------- | ------------------------- |
   | `verax-config-version`          | (versão deste contrato, `1`)                  | o módulo                  |
   | `verax-node-profile`            | `NODE_PROFILE`                                | o módulo (`standard`)     |
   | `verax-secret-prefix`           | `VERAX_SECRET_PREFIX`                         | o módulo (`vx-<slug>`)    |
   | `verax-credentials-vault`       | `CREDENTIALS_VAULT`                           | o módulo (`true`)         |
   | `verax-backup-bucket`           | `BACKUP_BUCKET`                               | o módulo                  |
   | `verax-node-sa-unique-id`       | `NODE_SA_UNIQUE_ID`                           | o módulo                  |
   | `verax-images-repository`       | `IMAGES_REPOSITORY`                           | o `tenant` (`images_*`)   |
   | `verax-node-version`            | a versão a instalar (`node-vX.Y.Z`)           | `node_version`            |
   | `verax-node-package-sha256`     | o SHA-256 do pacote, conferido antes          | `node_package_sha256`     |
   | `verax-plan`                    | `PLAN`                                        | `plan`                    |
   | `verax-plan-max-cloud-accounts` | `PLAN_MAX_CLOUD_ACCOUNTS` (vazio: o do plano) | `plan_max_cloud_accounts` |
   | `verax-plan-max-users`          | `PLAN_MAX_USERS` (vazio: o do plano)          | `plan_max_users`          |
   | `verax-plan-monthly-gib`        | `PLAN_MONTHLY_GIB` (vazio: o do plano)        | `plan_monthly_gib`        |
   | `verax-plan-history-days`       | `PLAN_HISTORY_DAYS` (vazio: o do plano)       | `plan_history_days`       |
   | `verax-web-origin`              | `WEB_ORIGIN`                                  | `web_origin`              |
   | `verax-api-origin`              | `API_ORIGIN`                                  | `api_origin`              |
   | `verax-mail-from`               | `MAIL_FROM`                                   | `mail_from`               |
   | `verax-tenant-name`             | o nome do cliente no nó (CP-10)               | `bootstrap_tenant_name`   |
   | `verax-admin-email`             | o primeiro admin do cliente (CP-10)           | `bootstrap_admin_email`   |
   | `verax-support-email`           | a conta de suporte da Verax (CP-10)           | `bootstrap_support_email` |

   O Terraform é dono dos metadados da VM inteiros: uma chave gravada fora dele (o `verax-renew-admin-password` do
   plano, por exemplo) some no `apply` seguinte do tenant, a menos que entre como variável.

**Cota de redes:** o módulo cria uma rede VPC, um roteador, um NAT e um IP externo reservado por nó. As cotas do
projeto dos nós (redes VPC por projeto, endereços IP externos estáticos e CPUs em `southamerica-east1`) são baixas num
projeto novo e limitam o número de clientes antes do resto: conferir no console (IAM e administrador, Cotas) na
primeira venda e pedir aumento antes de chegar perto, contando a homologação. Uma rede compartilhada entre os nós é
mudança do módulo numa fase seguinte, quando passar de cerca de 10 clientes.

### Exclusão em dois tempos

| Momento              | O que acontece                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D+30 do cancelamento | **Exclusão 1:** `terraform destroy` do ambiente do tenant, disco e snapshots, tópicos e assinaturas, túnel e seus registros de DNS, site e domínio do Firebase, segredos `admin-bootstrap`, `support-bootstrap`, `cloudflare-tunnel-token` e `smtp-password`. Ficam o bucket de backups (ciclo de 90 dias) e a chave `credentials-key`. `state=deleted`; e-mail de registro |
| D+97 do cancelamento | **Exclusão 2 (cripto-destruição):** todas as versões de `credentials-key` destruídas, segredo e bucket apagados, estado do Terraform removido. O tenant vira registro mínimo: ficam `slug`, `company`, `stripe.customerId`, `lifecycle` e as faturas por 5 anos (obrigação fiscal); `adminEmail`, `resources` e `access` são apagados                                       |

**A fazer no CP-07 (executor do Terraform):** recusar, antes do `apply`, todo plano que recrie ou apague
`module.node.google_service_account.node` (no plano em JSON, uma ação `delete` nesse endereço, sozinha ou num
`delete` + `create`), a menos que a execução seja da exclusão do cliente (CP-11: `delete` na Exclusão 1 ou
`crypto_destroy` na Exclusão 2). A conta recriada ganha outro ID único, e o papel de leitura na AWS do cliente
deixaria de aceitar o nó (seção "Por que papel sem chave"); a recusa para a execução sem `apply` e avisa a Verax. É a
proteção que substitui o `prevent_destroy`, que não muda por variável e impediria a própria exclusão.

**A fazer no CP-11 (Exclusão 1 com o `envs/tenant`):** antes do `destroy`, um `apply` com `deletion_protection =
false` e, então, `terraform state rm` destes endereços, que ficam fora do `destroy`:

- `module.node.google_compute_disk.node` e `module.node.google_compute_address.nat[0]` (os dois com `prevent_destroy`,
  que faria o `destroy` falhar): o disco é apagado pela API depois que a VM sai (e os snapshots, que o
  `KEEP_AUTO_SNAPSHOTS` mantém), e o IP do NAT é liberado pela API;
- `module.node.google_storage_bucket.backups` (com `force_destroy = false`), que fica até a Exclusão 2;
- `module.node.google_secret_manager_secret.node_written["credentials-key"]` e
  `google_secret_manager_secret_iam_member.worker_credentials_key`: o cofre e a permissão do `cp-worker` de destruir
  as versões ficam até a Exclusão 2. Sem tirar a permissão do estado, o `destroy` a apagaria, e o `cp-worker` não
  conseguiria cripto-destruir a chave em D+97.

Na Exclusão 2, depois de destruir as versões, o cofre e o bucket são apagados, e `tenants/<slug>/` sai do bucket do
estado; as versões antigas do estado (com o e-mail do admin nos metadados da VM) saem 30 dias depois, pela retenção do
bucket do estado. O bucket de backups é versionado: um backup sai 90 dias depois de gravado e a versão anterior mais 30
dias depois, então ele só fica vazio cerca de 120 dias depois do último backup. Em D+97 ainda há objetos, e nem o
`cp-terraform` nem o `cp-worker` apagam objeto lá; o CP-11 decide entre esperar a retenção ou dar a permissão para
esvaziá-lo.

Retenção do resto: `auditLog` 24 meses, `stripeEvents` 90 dias, `provisioningRuns` 180 dias, tokens e reservas pelo
próprio prazo, tudo por TTL do Firestore. Nunca gravado: dado de cartão, senha temporária (lida do Secret Manager e
devolvida uma vez), token do túnel, chaves da Stripe e do Cloudflare, corpo bruto do webhook, IP completo do cliente.

### Preço configurável

O preço é montado pelo cliente: seis respostas (onde roda, contas de nuvem, volume de logs, agentes nas instâncias,
histórico e suporte), o porte do nó calculado por uma regra determinística (nunca escolhido) e o total como a soma dos
componentes. Nenhum valor comercial está no código nem neste repositório; o código (`apps/control-plane/src/pricing`)
só define a forma dos documentos e as regras.

- **Tabela de preços** (`pricingTables/{versão}`): por componente, o valor em centavos e o `lookup_key` do preço na
  Stripe (ambiente ou licença por porte e modo, conta adicional, faixas de volume, pacote de agentes, histórico
  estendido, suporte prioritário, implantação por modo), os incluídos e máximos, a regra de porte e os pacotes de
  partida. Estados: `draft` (editável), `published` (imutável, vigente a partir de `effectiveFrom`, que pode ser
  agendado) e `retired` (substituída; `retiredAt` diz quando deixa de valer). A vigente é a de maior `effectiveFrom`
  até agora. Uma versão nova nunca muda assinatura existente (os preços da Stripe são imutáveis).
- **Modelo de custos** (`costModels/{versão}`, confidencial, só no console): custo de nuvem por porte e por item,
  câmbio e folga, tarifas por meio de pagamento, alíquotas, reserva, horas e custo do suporte, custos fixos e as metas
  de margem (mínima e de alerta). Publicado, vale na hora (custo não muda o preço de ninguém).
- **Cotação** (`POST /v1/public/quote`, sem nenhum campo de preço): a configuração é levada à opção vendida (sempre
  para cima); acima do que a tabela vende ou do maior porte, a resposta é "fale conosco". Na v1, a nuvem do cliente
  também é "fale conosco" (o provisionamento desse modo não existe). A cotação é gravada em `quotes/{id}` por 24 h, com
  limite por IP e teto diário, e é o que o checkout aceita. `GET /v1/public/pricing` devolve só a parte pública da
  tabela vigente (preços e regras, o "a partir de"), sem custo, margem nem `lookup_key`, com 5 min de cache no CDN.
- **Checkout** (`POST /v1/public/checkout` com `quoteId`): relê a cotação, recalcula pela tabela da versão dela
  (honrada até vencer, mesmo com outra tabela publicada), confere cada preço na Stripe (ativo, em BRL, mensal ou
  avulso, com o valor da tabela, e a soma igual ao total) e abre a sessão com um item por componente; a implantação, se
  o modo tiver, entra como item avulso, só na primeira fatura. A reserva guarda a configuração, os limites do nó e o
  preço cotado (versão, cotação, mensal e implantação), que o webhook copia para o cliente.
- **Checagem de publicação** (no console): antes de publicar uma tabela, o motor percorre a grade inteira de
  configurações vendáveis com o modelo de custos vigente (cartão e a alíquota padrão) e recusa a publicação se alguma
  ficar com margem de contribuição abaixo da mínima, se acrescentar uma unidade baixar o preço ou se o "a partir de"
  não for o menor preço da grade. O relatório (as piores, as abaixo do alerta, o pior caso com as outras alíquotas e
  no boleto) volta ao console; a recusa e a publicação ficam na auditoria.
- **DRE** (`POST /v1/admin/dre/simulate`): por cliente e por mês, receita bruta, imposto, reserva, receita líquida,
  infraestrutura (só no gerenciado), meio de pagamento, suporte, margem de contribuição, custos fixos rateados e
  resultado; a implantação à parte e os 12 meses; na nuvem do cliente, a estimativa da nuvem dele, só informativa.
- **Console do responsável** (`apps/console`, servido pelo `cp-admin`): um app React compilado pelo Vite, com os
  tokens e os padrões do painel (pt-BR, claro e escuro, WCAG 2.2 AA conferido pelo axe), que a imagem do plano de
  controle leva em `/app/console`. O próprio `cp-admin` serve as telas e a API na mesma origem, atrás do mesmo IAP: sem
  CORS, sem outro serviço e sem outro login. Cada arquivo das telas também exige o JWT do IAP de um responsável (como a
  API), com a CSP própria das telas (só scripts, estilos e chamadas da própria origem, nada inline, nada em frame);
  `/assets/` (nomes com hash) fica em cache privado, o resto sem cache. As telas não têm nenhum número: o modelo de
  custos (com o custo do nó por porte recalculado na hora), a tabela de preços (com a checagem e a publicação, e o
  relatório da recusa) e o simulador de DRE leem e gravam só pela API, e os problemas de validação voltam por campo.
  Os tipos que as telas leem são conferidos contra os da API no `pnpm typecheck` (teste de contrato do plano de
  controle).
- **Limites no nó** (gancho do PR-18): a configuração vira os ajustes `PLAN_*` que o nó já lê (`PLAN=enterprise` e os
  quatro limites) e, com agentes contratados, `WAZUH_AGENTS=true` e `WAZUH_AGENTS_MAX` (seção "Agentes nas instâncias
  do cliente"); fica gravada no cliente (`tenants/{id}.limits`) para o provisionamento.

## Versões do nó: imagens públicas e manifesto assinado _(fase 3, SH-02)_

Preparação do modo próprio (o nó na nuvem do cliente, que vem depois do portão da venda gerenciada). Um nó fora da
GCP da Verax precisa baixar as imagens sem login e saber, sem o `gh` e sem falar com a Verax, que a versão foi
publicada por ela. O roteiro e os passos únicos do responsável estão em `docs/runbooks/versao-no.md`.

| Imagem                                      | Nó gerenciado (GCP da Verax)                            | Nó na nuvem do cliente                                   |
| ------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| API e migrations (do Verax)                 | Artifact Registry privado, pelo `deploy.sh`             | GHCR público (`ghcr.io/williandotdev/verax-control/...`) |
| Wazuh, PostgreSQL e cloudflared (terceiros) | Registro de origem, pelo digest dos compose (como hoje) | Registro de origem, pelo digest dos compose              |

- **O mesmo digest nos dois registros.** O workflow `Imagens do nó` publica no Artifact Registry e, num job separado
  (o único com `packages: write`), copia o manifesto byte a byte para o GHCR com
  `docker buildx imagetools create --prefer-index=false` e confere o digest lá. A atestação de origem vale para o
  digest, em qualquer registro; a cópia ganha mais uma, com o nome do GHCR, guardada também no registro.
- **Terceiros não são copiados.** A Verax não redistribui a imagem do Wazuh (GPLv2) nem as outras: o nó as baixa da
  origem, pelo digest fixado nos compose, e o manifesto lista exatamente essas referências.
- **Manifesto por versão.** O workflow `Versão do nó` (disparo manual, environment `release` com aprovação, só a
  `main`) confere o pull anônimo e as atestações das imagens, monta o pacote do nó (reproduzível a partir do commit),
  escreve o `manifest.json` (commit, digests, imagens de terceiros e SHA-256 do pacote), assina com a chave de release
  no Cloud KMS e publica tudo num release `node-vX.Y.Z`.
- **Chave de release:** ECDSA P-256 com SHA-256, em software, em `infra/gcp/envs/release` (no projeto do nó da Verax).
  Só a conta do workflow assina (`cloudkms.signer` na chave, nada no projeto), e a federação só aceita o token desse
  arquivo, na `main`, por disparo manual, num executor do GitHub. É separada da chave das licenças (SH-03, Ed25519, no
  plano de controle): comprometer o plano de controle não permite empurrar código para a nuvem de um cliente. O P-256
  foi escolhido porque o nó confere com `openssl dgst -sha256 -verify`, que existe em qualquer Linux, e porque existe
  também em HSM, se um cliente exigir (o Ed25519 só existe em software).
- **Confiança no nó:** `infra/node/bin/verify-release.sh` confere a assinatura com as chaves públicas do pacote já
  instalado (`keys/release-*.pem`), nunca com as do pacote novo. O pacote leva a chave antiga e a nova por uma versão
  na troca; revogar é publicar um pacote sem ela.
- **Diferença em relação ao PR-N7 do plano da fase 2:** o N7 previa espelhar as imagens de terceiros no Artifact
  Registry para o nó gerenciado não depender do Docker Hub. Para o nó na nuvem do cliente, a proposta do modo próprio
  troca isso por "terceiros pela origem, pelo digest", para a Verax não redistribuir imagem GPL a terceiros. Este
  passo segue a proposta e não espelha nada; o manifesto já descreve as imagens de terceiros pelo digest, então um
  espelho privado só para os nós gerenciados, se o N7 o mantiver, não muda o manifesto.

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
   leitura sem chave (feito no PR-V2', que substituiu o usuário IAM do PR-V2); "Conectar AWS" no painel (feito no
   PR-V3', com a conferência real ainda por fazer no PR-V5'); entrega ao
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
