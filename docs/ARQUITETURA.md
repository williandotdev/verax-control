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

A revisão de 22/11/2026 faz do cliente quem conecta a AWS: o "Conectar com AWS" do painel, a descoberta das fontes de
log da conta e a autorização de cada uma, com o CloudWatch Logs, os VPC Flow Logs e os achados do Security Hub, do
Inspector e do Access Analyzer entre as fontes (seção "Onboarding AWS self-service").

A revisão de 10/11/2026 põe o plano **Plataforma** numa **célula compartilhada**: um nó `standard` em São Paulo que
atende vários clientes, cobrados só pelo volume de logs em GB/dia. Dedicado e vCISO continuam com um nó por cliente, e
o SOC da própria Verax vira o primeiro cliente da célula. O desenho e o que já existe estão na seção "Célula
compartilhada (Plataforma)".

## Princípios

1. **Simples e replicável.** Cada implantação é um **nó**: uma VM com tudo dentro, criada pelo Terraform de
   `infra/gcp/` num projeto da Verax na GCP, no perfil `lean` ou `standard` (seção "Perfis de nó"). Há dois tipos:
   - o **nó dedicado** atende um só cliente (Dedicado e vCISO). Subir um cliente novo é aplicar o Terraform e criar
     dois registros de DNS; na fase 3, isso fica automático;
   - a **célula** atende vários clientes da Plataforma (decisão de 10/11/2026). O cliente novo entra numa célula que
     já está no ar, e o isolamento entre eles é o da seção "Célula compartilhada (Plataforma)": identidade de nuvem,
     plano, endereço, sessão e dados por cliente. O que sobra de risco é o raio de impacto, que na célula é a célula
     inteira, e essa é a diferença documentada entre a Plataforma e o Dedicado.
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
        │     as fontes de log que o cliente autorizou (buckets S3, grupos do CloudWatch Logs e as APIs de
        │     achados) e a configuração da conta (descoberta, Ativos e Postura)
        └─► Cloudflare do cliente: auditoria e eventos de segurança (token no cofre)
GCP do cliente: sink de log ──► tópico do Pub/Sub no projeto do nó (sem papel para a Verax no projeto do cliente)
```

- **Fontes de log da AWS**, só de onde os logs já estão, descobertas pelo nó e autorizadas pelo cliente uma a uma
  (seção "Onboarding AWS self-service"):
  - pelo módulo `aws-s3` do Wazuh, dos buckets S3: CloudTrail, VPC Flow Logs (só o tráfego rejeitado), log do WAF
    (só BLOCK e COUNT; ALLOW é descartado, por causa do volume) e os findings do GuardDuty exportados (o export exige
    SSE-KMS);
  - pelo mesmo módulo, os grupos do CloudWatch Logs que o cliente marcar com a tag `verax-control = leitura`;
  - pelo worker, sem o Wazuh, os achados do GuardDuty, do Security Hub, do Inspector e do Access Analyzer, pela API
    de cada serviço.

  O módulo guarda o marcador do último objeto lido e retoma dele depois de uma parada. As leituras registradas no
  CloudTrail não são descartadas, porque alimentam as detecções de reconhecimento; as da própria Verax, vindas do IP
  do nó, recebem uma regra de nível 0. Os buckets digitados no cadastro da conta (CloudTrail, GuardDuty e WAF)
  continuam valendo, para o que fica fora do padrão `AWSLogs/`.

- **Configuração da AWS (Ativos e Postura):** o worker lê pelo mesmo papel, só pelas ações de leitura da política:
  o inventário de Ativos e as 18 checagens de postura nativas, numa coleta só, uma vez por dia por conta (PR-14' e
  PR-15', seção "Ativos e Postura da AWS"). Sem Prowler.
- **GCP do cliente:** o sink do projeto do cliente publica num tópico do projeto do nó. O cliente cria o sink com o
  comando pronto de Contas cloud e cola no painel a identidade dele; o Terraform do nó (`customer_projects`) deixa só
  essa identidade publicar no tópico do projeto, sem nada no nível do projeto do nó (que isso basta é o que o teste
  na homologação confirma: `infra/gcp/GUIA.md`, "Projeto de cliente: o sink é do cliente"). O worker lê a assinatura
  com a identidade da VM e aplica regras próprias, como no nó da Verax (roteiro em
  `docs/runbooks/onboarding-cliente.md`, seção 5).
- **Cloudflare:** coletor nativo no worker (seção "Logs do Cloudflare").
- **Retenção:** o índice do Wazuh guarda 30 dias (alertas a partir do nível 5, 1 shard). Os achados ficam no Postgres
  pelo prazo do plano (90 ou 365 dias), com os campos do evento; só o evento bruto do detalhe expira em 30 dias. O
  expurgo diário do Postgres está na seção "Expurgo do histórico".
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
| Uso      | Nó da própria Verax (fontes da GCP e Cloudflare) | Nó dedicado de cliente, um por cliente, e a célula da Plataforma    |
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
  - `wazuh`, interna: indexer, manager e worker. O indexer não tem porta publicada nem rota para fora; o worker (que
    não abre porta) entra só para ler os contadores da API do manager (PR-V6, usuário `verax_stats`);
  - `wazuh-read`, interna: indexer, API e worker, que só leem. A API nunca divide rede com o manager, que processa
    log de fora como root: numa rede só, ele chegaria à API por dentro, fora do Cloudflare, e forjaria o
    `X-Forwarded-For` em que ela confia (o CI exige que a API e o manager não dividam rede nenhuma);
  - `wazuh-egress`: só o manager, para a saída ao S3 e ao STS. O manager não alcança o Postgres.
- **Usuários do indexer no `standard`:** o filebeat do manager grava com `wazuh_filebeat` (só escrita em
  `wazuh-alerts-*`); a API e o worker leem com `verax_api_read`; a senha do `admin` não fica em nenhum contêiner que
  fica no ar (os scripts usam o certificado admin).
- **API do manager no `standard` (PR-V6):** o certificado é o par do manager da CA própria do Wazuh (nome
  `wazuh.manager`), que o `manager-api-tls.sh` põe nela a cada partida do contêiner, antes dos daemons; quem a chama
  confere com a CA (o worker, pelo volume público; o host, pelo loopback com o nome). Usuários: `wazuh-wui`
  (administrador, só o host e os scripts) e `verax_stats` (só `manager:read`, o worker), criado e acertado pelo
  `init-api-users.sh` no `start.sh wazuh-up`, pela API, de forma idempotente. A senha do `verax_stats` é a quinta do
  Wazuh, gerada pelo `install.sh`, e não chega ao manager.
- **Serviços do systemd:** nos dois perfis, `verax-metadata-guard` (a guarda do servidor de metadados, antes do Docker
  e exigida por ele: sem ela o Docker não sobe, e ela não aceita `stop` nem `restart` manual) e `verax-node` (a
  aplicação, que exige a guarda); no `standard`, também `verax-wazuh` (o Wazuh, depois da aplicação, que o
  `restart` do `verax-node` sobe de novo mesmo quando ele tinha falhado): uma falha do Wazuh não derruba a aplicação
  nem o backup diário.
- **Portão:** o ensaio geral da fase 2 mede 24 h de `docker stats` e CPU. A documentação do Wazuh pede 4 núcleos para
  o single-node em Docker; se 2 vCPU não bastarem, o plano B é a e2-standard-4.
- Os nós de clientes ficam num projeto da GCP separado do nó da Verax. A primeira célula da Plataforma
  (`envs/celula`, `verax-celula`) fica, por enquanto, no projeto do nó da Verax (decisão de 10/11/2026; seção "Célula
  compartilhada (Plataforma)").

## Painel e destinos

O painel é estático, no Firebase Hosting, um site por destino. Roteiro em `docs/runbooks/painel.md`. Desde a
atualização da frota (16/11/2026), só a demonstração sai a cada merge (workflow `Painel`); o painel de produção de cada
destino é o bundle da versão do nó dele, publicado pelo plano de controle junto com o nó ("Atualização da frota").

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

### API presa ao endereço do cliente na célula (CE-01)

Na célula compartilhada do Plataforma (`NODE_MODE=cell`; o padrão `dedicated` é o nó de um cliente, como sempre),
todos os `api-<cliente>` apontam para o mesmo túnel, que repassa o `Host` como o navegador mandou. A API amarra cada
requisição ao cliente desse endereço:

- **De onde sai o cliente:** o `Host` precisa ser exatamente `api-<slug>.<CELL_DOMAIN>` (sem porta, sem maiúsculas,
  sem rótulo a mais), e o `<slug>` precisa estar na tabela `TenantHost`. Ela é gravada só pelo sistema
  (`tenants/tenant-host.ts`, o provisionamento da célula): nenhuma rota aceita o subdomínio, o escopo do cliente só a
  lê, e o banco recusa `UPDATE` (trocar de endereço é apagar a linha e gravar outra). Uma tabela à parte, e não uma
  coluna no `Tenant`, porque o cadastro de clientes tem rota de escrita e porque o nó dedicado não a usa: fica vazia.
- **Endereço desconhecido:** 404 genérico em toda rota, antes de qualquer regra de sessão, login, permissão ou CSRF
  (`HostTenantGuard`, o primeiro guard global), e sem os headers de CORS. A exceção é o health check (`@AnyHost`), que
  o Docker chama pelo IP. Um meta-teste varre todas as rotas do Express num endereço sem cliente.
- **Sessão:** guarda o cliente do endereço onde nasceu (`Session.hostTenantId`) e só vale nele, para alguém desse
  cliente. O cookie não tem `Domain`, então o navegador nunca o leva a outro endereço; levado à mão, a sessão é
  recusada (401) e apagada.
- **Equipe da Verax:** o `admin_verax` só entra e só tem sessão no endereço da equipe (`CELL_STAFF_SLUG`, o `api-verax`
  do SOC da Verax), onde fica a troca de cliente auditada (`POST /v1/session/tenant`).
- **Origem:** o CORS, a checagem de origem dos POST da autenticação, o CSRF das escritas e os links do contato de
  escalonamento aceitam só o painel do cliente do endereço, `https://<slug>.control.<CELL_DOMAIN>`. O `WEB_ORIGIN` e o
  `API_ORIGIN` da célula são os da equipe, e a configuração confere que batem com o domínio.
- **Unicidade:** o e-mail de usuário e o ID de conta continuam únicos no nó inteiro; a recusa é a mesma para o valor de
  outro cliente e para o do próprio, e nenhuma frase diz "em outro cliente". Que o valor já está em uso no nó continua
  visível (é o preço da unicidade global), sem dizer de quem.
- **E-mails:** o link de redefinição de senha leva ao painel do cliente do endereço, e só sai para quem é desse cliente.
  O resgate também confere: o link de um cliente usado no endereço de outro recebe a mesma recusa do link inválido
  (400 `INVALID_TOKEN`), antes de a senha mudar e sem gastar o link.
  Os avisos do worker ainda montam os links com um `WEB_ORIGIN` só; até serem por cliente, o worker da célula exige
  `MAIL_TRANSPORT=none`.

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

Na célula (seção acima), o login procura o usuário só no cliente do endereço, antes de conferir a senha: quem é de
outro cliente (ou o `admin_verax` fora do endereço da equipe) recebe a mesma recusa da senha errada (401
`INVALID_EMAIL_OR_PASSWORD`), no mesmo tempo (o hash da senha recebida) e com o mesmo registro na trilha, depois de
gastar a tentativa da conta e a do IP. O código do MFA levado a outro endereço também é recusado, sem sessão. O
`hostname` exigido do Turnstile é o do painel do cliente do endereço, e não o do `WEB_ORIGIN`.

### Entrada única: o console como provedor de identidade do SIEM (Admin master)

**Decisão de 15/11/2026**, do responsável: **um login só** para o SIEM da própria Verax (o painel da equipe na célula,
`verax.control.veraxsistemas.com.br`, API `api-verax`) e para o console do responsável (o "Admin master", `cp-admin`,
`admin.veraxsistemas.com.br`), com o Admin master aparecendo como um módulo dentro do SIEM. O desenho escolhido: **o
plano de controle é o provedor de identidade**. O responsável entra uma vez no console (e-mail, senha e TOTP, o login de
sempre, com a mesma força), e o SIEM aceita esse login para a equipe da Verax. A célula **nunca** consegue emitir um login
de Admin master: ela só confere a assinatura do console.

```
painel da equipe ──► api-verax /v1/auth/sso/start ──302──► admin /sso/authorize ──(sem sessão)──► admin /entrar
  (navegador)          state, nonce, PKCE no banco            cliente e retorno da lista;          e-mail, senha, TOTP
                       cookie __Host-verax-sso (10 min)       sessão do console                         │
                                                                     │ ◄────────────── volta ao pedido ─┘
                                                                     ▼ 303 com code, state e iss
api-verax /v1/auth/sso/callback ──POST /sso/token (servidor a servidor, PKCE)──► cp-admin: token EdDSA de 5 min
   confere state, iss, a assinatura com a chave FIXADA, iss/aud/prazo/nonce/amr, jti único
   └─► sessão normal do Better Auth para o admin_verax que já existe ──302──► painel; menu "Admin master" ──► console
```

**O protocolo** é o fluxo de código de autorização do OAuth 2.0 com PKCE S256, no formato do OpenID Connect, reduzido ao
mínimo; o contrato fica em `packages/shared/src/sso.ts`:

- **No console (`apps/control-plane/src/admin/sso/`)**: `GET /sso/authorize`, `POST /sso/token` (JSON, de servidor
  para servidor) e `GET /sso/jwks`, fora do prefixo `/v1`. Um cliente só (`verax-siem`) e a lista **exata** de
  endereços de retorno (`SSO_REDIRECT_URIS`, do Terraform `sso_redirect_uris`), conferidos antes de qualquer outra
  coisa: fora da lista, uma tela de recusa e nenhum redirecionamento (nada de redirecionamento aberto). `state`,
  `nonce` e o desafio do PKCE (S256) são obrigatórios, e um pedido vindo de outro site (`Sec-Fetch-Site: cross-site`) é
  recusado. Sem a sessão do console, o login dele (`/entrar?voltar=/sso/authorize?...`, remontado dos campos
  conferidos), que volta ao pedido por navegação. O código: 32 bytes aleatórios, só o SHA-256 no Firestore
  (`adminSsoCodes`, TTL), preso ao cliente, ao retorno, ao desafio, ao `nonce`, ao e-mail e à sessão do console, 60
  segundos e uso único. A troca o apaga na mesma transação que o confere (usado ou recusado, não vale de novo), confere
  o verificador do PKCE e que a sessão do console ainda vale (sair do console revoga os códigos pendentes), e assina o
  token. Limites só de falhas, por IP e no total; auditoria `admin.sso_code_issued`, `admin.sso_token_issued` e
  `admin.sso_refused`.
- **O token**: um JWS compacto montado à mão com `node:crypto` (nenhuma dependência nova), **EdDSA com Ed25519**
  (assinatura determinística, chave de 32 bytes que cabe numa linha do `node.conf`, sem o formato de assinatura do
  ECDSA para errar). Cabeçalho exatamente `{alg: "EdDSA", typ: "JWT", kid}`, com o `kid` = impressão digital RFC 7638.
  Declarações: `iss` (a origem do console), `aud` (`verax-siem`, texto), `sub` (o id da conta no console), `email`,
  `nonce`, `iat`, `exp` (5 minutos), `auth_time` (o login no console), `jti` e `amr: ["pwd", "otp"]`. A chave privada
  fica no cofre `cp-admin-sso-signing-key`, lido só pela conta `cp-admin`; a pública sai em `/sso/jwks`.
- **Na API do nó (`apps/api/src/auth/sso/`)**: um plugin do Better Auth, só com `SSO_ISSUER`, `SSO_CLIENT_ID` e
  `SSO_PUBLIC_KEY` no `node.conf`, e só onde a equipe da Verax entra (`sso-site.ts`): na célula (`NODE_MODE=cell`), no
  endereço da equipe (`api-<CELL_STAFF_SLUG>`); no nó dedicado, só no da própria Verax (`PLAN=interno`, abaixo). Em
  qualquer outro lugar, 404. A chave pública é **fixada** na configuração (o `x` da chave), nunca baixada. O retorno
  gasta o pedido antes de conferir, confere o `state` (contra o login forçado), o `iss` da resposta (RFC 9207), troca o
  código (https, 5 s, sem seguir redirecionamento, resposta pelo schema) e confere o token com rigor: três partes em
  base64url canônico, cabeçalho estrito (nada de `none`, HS256, `jku`, `jwk`, `x5u` ou `crit`), `kid` da chave fixada,
  assinatura Ed25519, declarações estritas, `iss`, `aud`, prazo (30 s de folga, no máximo 5 min de vida), `nonce` do
  pedido, `amr` com senha e código, e o `jti` gasto numa tabela (`SsoTokenUse`). Então abre a sessão **normal** (o mesmo
  cookie, o hook de criação com as regras da célula, 30 minutos sem uso e 12 horas, o CSRF das escritas) do
  `admin_verax` que já existe com aquele e-mail, sem tenant, ativo, com a senha definitiva e o MFA do painel. Nada é
  criado: e-mail desconhecido, de outro papel ou de um cliente recebe a mesma recusa (`?sso=recusado` no login), com o
  motivo só no log e na trilha (`auth.sso_login`). O login com senha do painel continua;
  `STAFF_PASSWORD_LOGIN_DISABLED=true` (padrão `false`, só com a entrada única) o tira da equipe no endereço dela.

**No nó dedicado da Verax (decisão de 16/11/2026).** O servidor do SIEM da própria Verax ainda roda como nó **dedicado**
(`PLAN=interno`, na VM da célula): a troca para `NODE_MODE=cell` pararia a coleta da AWS, que espera a identidade de
cada cliente (CE-11). Para a equipe não esperar a troca, a entrada única vale também ali, e **só** ali: o `start.sh`
aceita as linhas no nó dedicado só com `PLAN=interno` e sem o `CUSTOMER_MODE`, e a configuração da API só com
`PLAN=interno` escrito no ambiente (o padrão `interno` de fora de produção não conta). Num nó dedicado de cliente
(qualquer outro plano), as duas recusam as linhas e o serviço não sobe, como antes. Sem endereço por cliente, o nó
inteiro é o da equipe: o pedido nasce sem cliente do endereço (`SsoLoginAttempt.hostTenantId` vazio), a volta vai ao
`WEB_ORIGIN`, e a sessão é a do nó dedicado de sempre. As conferências são as mesmas da célula (`state`, `nonce` e
PKCE de uso único, `jti` gasto, `iss`, `aud` e prazo, os limites por IP, e só o `admin_verax` sem cliente, ativo e
com o MFA do painel), e o interruptor `STAFF_PASSWORD_LOGIN_DISABLED` vale no nó inteiro. Os endereços do nó da Verax
são os mesmos da equipe na célula (`api-verax` e `verax.control`): o retorno na lista do console não muda na troca.

**A equipe vê o painel como o cliente, no nó dedicado da Verax (decisão de 17/11/2026).** Com `STAFF_CUSTOMER_VIEW=true`
(padrão `false`; só no nó dedicado com `PLAN=interno` escrito no ambiente, nunca na célula, e só com a entrada única
configurada; o `start.sh` e a configuração da API recusam o resto), o `resolveSession` troca a sessão do `admin_verax`
sem cliente pela do `admin_cliente` do **único** cliente ativo do nó (a própria Verax): `role`, `tenantId` e
`scopeTenantId` passam a ser os desse cliente, e o guard de permissões, o `/v1/me`, a Torre e a trilha seguem o papel do
cliente por construção. A consulta é barata (`take: 2`): com nenhum ou mais de um cliente ativo, nada muda. O `userId`
continua o da pessoa (no banco, ainda `admin_verax`), então a trilha mostra a equipe como Verax, agora na trilha do
cliente do nó; a marca `staffAsCustomer` fica só no servidor (o `/v1/me` não a devolve) e tira a preferência de aviso
por e-mail, que não teria efeito. Ficam de fora, nesse nó, a fila "Alertas sem dono", a lista e a troca de cliente e o
item "Admin master" do menu; o botão "Entrar com o Admin master" do login continua (depende só do `client-config`).

**O módulo Admin master no SIEM: o item do menu abre o console, sem embutir.** O `admin_verax` no endereço da equipe vê
"Admin master" no menu (a API diz onde fica o console em `GET /v1/auth/client-config`, `adminMasterUrl`), que abre o
console na mesma aba, já com a sessão dele (a entrada única deixou o console logado). A alternativa, o painel chamar a
API do console por CORS com o cookie do console, foi recusada nesta fase: ela poria a origem do SIEM (o bundle dele, o
site do Hosting dele e qualquer XSS a partir do que a célula serve) dentro da base de confiança do Admin master, que é
exatamente o que a decisão quer evitar, e obrigaria a abrir o CORS com credenciais e o CSRF do console a outro site.
Como está, o console continua com a CSP, o `frame-ancestors 'none'`, o cookie `SameSite=Strict` só do host e a recusa
de escrita que não seja da própria origem (`Sec-Fetch-Site: same-origin`, que já barra os subdomínios irmãos). O plano
para a integração completa, quando valer o esforço: um build das telas do console com o mesmo visual do painel (os
mesmos tokens de design), servido pelo próprio `cp-admin` na origem dele, e não telas do console dentro do bundle do
SIEM; o CORS do console nunca se abre para o painel.

**Modelo de confiança.** A célula atende clientes e é o maior raio de impacto do produto (seção "Risco residual: o raio
de impacto é a célula"); por isso ela é só a parte que confia. O nó dedicado da Verax (`PLAN=interno`) é a mesma parte
que confia, no lugar da célula, com o mesmo modelo: o que vale abaixo para "a célula" vale para ele. Um nó dedicado de
**cliente** nunca é parte que confia: o `start.sh` e a configuração da API recusam as linhas com outro plano, e o
console só manda código para os endereços da lista exata. O que uma célula comprometida consegue: abrir sessões do
SIEM para quem quiser (já conseguia, sem a entrada única), ver o código e o token de identidade do responsável (que só
valem para o SIEM, por 5 minutos, e que o console nunca aceita de volta: nenhuma rota dele lê `Authorization`, e a
sessão do console é só o cookie `__session` do próprio host). O que ela **não** consegue: a sessão do console (cookie
`HttpOnly` do host `admin...`, que a célula nunca vê), um token assinado pelo console (a chave privada não está no nó:
meta-teste `cell-cannot-sign.test.ts`), nem fazer o console mandar um código para outro lugar (a lista exata).

**Riscos residuais:**

- **Phishing em tempo real.** Uma célula comprometida pode, no `/v1/auth/sso/start`, mandar o navegador a uma página
  falsa no lugar do console e colher e-mail, senha e o código TOTP (que não resiste a phishing). Mitigação: o
  responsável só digita a senha no endereço `admin.veraxsistemas.com.br` (o gerenciador de senhas só preenche nele);
  o passo seguinte é uma chave de acesso (WebAuthn) no console, fora deste PR.
- **Sessão do console aberta.** Com a sessão do console viva (30 minutos sem uso, 12 horas no máximo), o SIEM entra
  sem perguntar nada; quem tem o navegador do responsável tem os dois, como já tinha o console.
- **Troca da chave.** O `cp-admin` guarda a chave em memória: trocar a versão no cofre pede uma revisão nova do
  serviço e a chave pública nova no `node.conf` da célula, juntas (o runbook do console, seção 9). Entre as duas, a
  entrada única recusa; o login com senha do painel continua, a não ser que o interruptor esteja ligado.
- **Negação de serviço.** Os limites do console contam as falhas no balde da saída do Hosting, dividido por todos:
  uma enxurrada de pedidos ruins pode deixar a entrada única em 429 por até 15 minutos (o login com senha continua).
- **O nó da Verax pelo plano.** No nó dedicado, quem separa o nó da Verax do de um cliente é a linha `PLAN=interno` do
  `node.conf` (e o `CUSTOMER_MODE`, no `start.sh`). Um nó de cliente com `PLAN=interno` por engano e as três linhas
  aceitaria a entrada única, mas continuaria sem receber código: o retorno dele não está na lista do console. O
  `aud` é o mesmo (`verax-siem`) para a célula e o nó da Verax; o que prende cada token a um nó é o retorno da lista,
  o `nonce` e o PKCE do pedido daquele nó, e a troca feita pelo próprio nó.
- **Subdomínios irmãos.** O console e o SIEM são o mesmo "site" (`veraxsistemas.com.br`) para o navegador: os cookies
  `SameSite=Strict` vão de um ao outro numa navegação, e é isso que deixa o fluxo funcionar. O que protege o console de
  um subdomínio irmão é o que já protegia: o cookie só do host, a limpeza dos `__session` plantados com `Domain` e a
  recusa de escrita que não seja da própria origem.

## Contas monitoradas por provedor

_(fase 2, feito no código: o token do Cloudflare entra pelo painel (PR-11'); o papel de leitura da AWS, a coleta pelo
nó e a conferência da conexão (PR-V2' a PR-V5'); e o onboarding self-service da AWS, da revisão de 22/11/2026)_

O cadastro de contas (Contas cloud) aceita três provedores. **A GCP e a AWS não guardam credencial:** na GCP, o sink
do cliente publica no tópico do nó; na AWS, o nó entra no papel de leitura do cliente com a própria identidade no
Google (seção "Por que papel sem chave"). **Cloudflare: token de leitura cifrado no cofre do nó** (seção "Cofre de
credenciais"). Um admin cola o token no painel; ele nunca volta pela API e nunca fica no cadastro da conta. **Na VM
própria do cliente** (`NODE_PLATFORM=vm`), sem identidade do Google, a AWS e a GCP também são lidas com uma chave de
leitura colada no painel e cifrada no mesmo cofre (seção "Cofre de credenciais", "Chaves de leitura da VM própria").

| Provedor   | Identificador                            | Origem dos logs                                                                                                                   | Como o nó lê                                                                                                      |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| AWS        | ID da conta (12 dígitos)                 | As fontes que o nó descobre e o cliente autoriza: buckets S3, grupos do CloudWatch Logs e as APIs de achados                      | Papel `verax-control-reader`, sem chave: o nó entra com o token da conta de serviço dele, só a partir do IP do nó |
| GCP        | ID do projeto                            | Assinatura do Pub/Sub, no projeto do nó, ligada ao sink que o cliente cria (a identidade do sink fica no cadastro; não é segredo) | Identidade da VM do nó, sem chave                                                                                 |
| Cloudflare | ID da conta (32 caracteres hexadecimais) | Zonas (domínios) monitoradas                                                                                                      | Token só de leitura, no cofre                                                                                     |

Cada origem de log (bucket do cadastro, assinatura, identidade do sink ou zona) pertence a um só cliente, como já
valia para os buckets: é o que permite atribuir cada alerta ao cliente certo. Nas fontes da AWS que o nó descobre, o
dono sai da conta (seção "Onboarding AWS self-service", "Isolamento entre clientes"). A identidade do sink, além disso, é de um projeto só,
mesmo dentro do cliente: em outro projeto, daria a ele a publicação no tópico do primeiro.

### Desativar e excluir uma conta (decisão de 23/11/2026)

O painel tem duas operações distintas na conta cloud, as duas para quem tem `cloud_accounts:write`:

- **Desativar** (`DELETE /v1/cloud-accounts/:id`, ou o `PATCH` com `status`): exclusão lógica, como sempre foi. A conta
  para de ser lida, a credencial do cofre sai e a vaga do plano volta, mas o cadastro fica, e o ID da conta continua do
  cliente (`@@unique([provider, accountId])`). Reativar retoma de onde parou. Na conta que a Verax cadastrou pelo
  console, o painel recusa (409 `CONSOLE_MANAGED`): o monitoramento dela é do console.
- **Excluir** (`POST /v1/cloud-accounts/:id/delete`, corpo estrito `{confirmAccountId}`, 204): o cadastro sai do nó, e
  o mesmo ID pode ser cadastrado de novo, pelo próprio cliente ou noutro cliente (por exemplo, para refazer a conexão
  da AWS pelo "Conectar com AWS"). Rota explícita, à parte do `DELETE`, para o `DELETE` de sempre continuar só
  desativando (os clientes da API e os testes dependem disso) e para a exclusão nunca sair de um parâmetro esquecido.
  O cliente digita o ID da conta no provedor, e a API confere de novo: outro texto é 400 `ACCOUNT_ID_MISMATCH`, sem
  mudar nada; a conta de outro cliente, 404 (nada muda); quem só lê, 403. Vale para qualquer provedor e **também para
  a conta do console** (decisão do responsável: o cliente manda nas contas da nuvem dele).

A exclusão roda numa transação (a da requisição), sob o lock das vagas do plano, como a desativação: a credencial do
cofre sai primeiro, com o registro `cloud_credential.wipe` (só metadados), e depois a linha da conta, com o registro
`cloud_account.delete` (o estado de antes, com a origem, sem segredo; o estado de depois, vazio). A vaga do plano volta.

| O que                                                                                                    | Na exclusão                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CloudAccount`                                                                                           | Apagada                                                                                                                                                                                                                                         |
| `CloudCredential`                                                                                        | Apagada antes da conta, com a trilha (`wipeCredential`); a chave estrangeira também a levaria                                                                                                                                                   |
| `AwsDiscoveryRun`, `AwsSource`, `CollectorCursor`, `AwsVolumeObject`                                     | Apagadas pela chave estrangeira (`ON DELETE CASCADE`): só existem pela conta. A autorização das fontes não volta numa conta cadastrada de novo: o cliente autoriza outra vez                                                                    |
| As tabelas `Web*` (logs do ALB: configuração, objetos lidos, resumo do dia e tráfego por país)           | Apagadas com as fontes, pela chave estrangeira. A evidência (`FindingEvidence`) fica: é do achado                                                                                                                                               |
| `Finding` (e comentários, notificações), `Incident`, `PostureScan`/`PostureFailure`, `InventorySnapshot` | Ficam: guardam o ID da conta como texto, sem chave estrangeira. O histórico das telas e o expurgo seguem as regras de sempre                                                                                                                    |
| `IngestUsage`, `IngestUsageDay`, `IngestHealth`, `NodeUsageDay`                                          | Ficam: são por cliente e fonte, não por conta. O volume já medido continua contando no mês e no dia                                                                                                                                             |
| `AuditLog`                                                                                               | Fica, inteira (a trilha é só de acréscimo)                                                                                                                                                                                                      |
| `UnownedAlert`                                                                                           | Fica: sem cliente, guarda as contas citadas como texto                                                                                                                                                                                          |
| `CloudWatchAlertOwnership`                                                                               | Fica: a prova do dono dos grupos de logs é sobre a configuração aplicada no manager. Enquanto a lista antiga estiver aplicada, os alertas dela ainda são da conta (como na desativação); a tarefa `wazuh-config` refaz a prova com a lista nova |
| `ControlPlaneSyncItem`                                                                                   | Só na conta do console: a falha `deleted_in_panel` da fonte (abaixo); o item da credencial da fonte sai                                                                                                                                         |

Nada é apagado na nuvem do cliente: a lista do Wazuh é feita das linhas (`findWazuhSourceRows`), e a seguinte só deixa
de ter a conta (o host aplica a lista nova; `remove_from_bucket` e `remove_log_streams` continuam `no`); os coletores
por API e as tarefas do worker leem as contas a cada passagem e não a acham mais. Uma passagem que já estava em curso
pode terminar com um erro de "registro não encontrado" (P2025) ou de chave estrangeira ao gravar o resultado: nada é
recriado, e a seguinte já não tem a conta. Na AWS, a pilha `verax-control-reader` continua na conta do cliente: ele a
apaga no CloudFormation se não for conectar de novo, ou a deixa para reconectar (a mesma pilha serve quando a conta for
cadastrada outra vez).

**Conta do console e a sincronização.** Na conta `origin = control_plane`, a exclusão grava, na mesma transação e antes
de apagar a conta, a falha `deleted_in_panel` no item da fonte (`ControlPlaneSyncItem`, `kind = log_source`), na maior
revisão entre a última aplicada na conta e a do item, sem nova tentativa (`control-plane-sync/deleted-in-panel.ts`):

- a sincronização não recria a conta na mesma revisão (a regra de sempre: a falha de uma revisão só é tentada de novo
  com outra revisão); e a transação da sincronização confere o item de novo depois do lock das vagas, o mesmo da
  exclusão, para uma passagem que leu o item antes da exclusão também não a recriar;
- o relato seguinte leva a fonte como `failed`/`deleted_in_panel`, sem a conta e sem a credencial; o console a mostra
  como "Falhou", com o que fazer (`apps/console/src/features/tenants/log-source-labels.ts`), e a visão do plano de
  controle (`sourceStatusOf`) dá `failed` com esse código;
- uma revisão maior do console (o responsável altera a fonte) cadastra a conta de novo, com o mesmo id, e a credencial
  que o console mandar é aplicada de novo (o item da credencial saiu com a conta). Se o envelope já tinha sido
  consumido no plano de controle, a conta volta sem credencial, e o responsável reenvia a chave (ou o cliente a cola);
- a lápide (`removed`) de uma revisão maior é contada como `removed`, sem erro: a conta já não existe.

O código novo entra em `NODE_SYNC_SOURCE_CODES` (contrato estrito): o plano de controle sobe antes dos nós, então o
nó novo nunca o manda a um plano de controle que não o conheça.

### Regras de detecção: faixas de ID e títulos

Cada regra tem um ID numa faixa própria, e o ID vai para o achado (`ruleId`), para as exceções e para os relatórios.
A escala de nível é a mesma em todas: 12 ou mais é crítica, 10 alta, 7 média e abaixo disso baixa.

| Faixa           | Onde roda                                                               | O quê                                                                                                                          |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 80200 a 80499   | Wazuh do nó (`0350-amazon_rules.xml`, do próprio Wazuh)                 | CloudTrail, GuardDuty e WAF; as correlações 80252, 80255 e 80443 sobrescritas para contar por conta (`verax_aws_rules.xml`)    |
| 100200 a 100299 | Wazuh do nó (`verax_reader_rules.xml`, gerado do modelo com o IP do nó) | O papel de leitura da Verax no CloudTrail do cliente (PR-V4', passo "Coletar")                                                 |
| 100300 a 100399 | Wazuh do nó (`verax_aws_critical_rules.xml`)                            | Regras críticas da AWS no CloudTrail do cliente (PR-V7): root, administrador, CloudTrail, GuardDuty, S3, grupo de segurança... |
| 100400 a 100499 | Wazuh do nó (`verax_aws_flow_rules.xml`)                                | Correlações dos flow logs da VPC: a varredura (100400) e a insistência em porta de administração remota (100401)               |
| 990101 a 990199 | Worker, sem Wazuh (`apps/api/src/gcp/gcp-rules.ts`)                     | Auditoria da GCP                                                                                                               |
| 990201 a 990299 | Não usada                                                               | Era a do coletor próprio do CloudTrail, que saiu do plano; o subconjunto crítico do catálogo dela virou a faixa 100300         |
| 990301 a 990399 | Worker, sem Wazuh (`apps/api/src/cloudflare/cloudflare-rules.ts`)       | Auditoria do Cloudflare                                                                                                        |
| 990501 a 990599 | Worker, sem Wazuh (`apps/api/src/aws/findings/finding-rules.ts`)        | Achados da AWS lidos pela API: Security Hub, Inspector e Access Analyzer (o GuardDuty pela API leva a regra 8030x do Wazuh)    |

**O título do achado é fixo e em português.** Nas regras do worker, é o da tabela de regras. Nas do Wazuh, a
descrição cita campos do evento (o nome da chamada, o IP, o bucket) e, nas regras do próprio Wazuh, é em inglês: o
título vem do dicionário `apps/api/src/alerts/aws-rule-titles.ts`, que cobre toda regra local com nível acima de 0
(1002xx, 1003xx e as correlações sobrescritas) e o login com falha do Wazuh (80254). Sem título no dicionário (o
GuardDuty, cujo título vem da própria AWS, e o CloudTrail genérico), fica a descrição, como nos alertas dos agentes
nas instâncias do cliente (regras do próprio Wazuh). Um teste confere que toda regra local que pode virar achado tem
título e que nenhum título leva campo do evento: é o título, e não a descrição, que o aviso por e-mail (PR-16) pode
usar.

### Cobertura de detecção: o catálogo de cenários (UC-1)

_(UC-1 feito: contratos, catálogo e validação. A construir: o corredor de evidências no CI (UC-2), a API e a situação por
cliente (UC-3), a tela (UC-5) e o artefato do catálogo na versão do nó (UC-6))_

- **Cenário, não regra:** cada entrada do catálogo é um cenário de detecção, agrupado pelo objetivo ("força bruta e
  adivinhação de senha"), com as regras de qualquer fonte que servem a ele. Na interface, a tela se chama "Cobertura de
  detecção"; a aba "Cobertura das fontes" (o relatório `coverage`) mantém o nome. "Cenário" não é o "caso" dos alertas.
- **Onde fica:** `detections/catalog/SC-xxxx.json`, um arquivo por cenário, no schema estrito
  `detectionScenarioSchema` (`packages/shared/src/detection-coverage.ts`): título, objetivo e resposta esperada em
  português, fontes (`FINDING_SOURCES`), regras, MITRE, severidade, dono (apelido ou papel, nunca e-mail), estado,
  `quietExpected` (silêncio é o esperado) e evidências. O repositório só guarda cenários com regra no código, nos
  estados `em_teste`, `homologado` e `aposentado`; `sugerido` e `em_desenvolvimento` existem no enum, mas são da equipe
  e não vêm para o repositório (ele é público). O cliente vê `homologado` e `em_teste`, com o rótulo, só leitura.
- **Detecção do provedor:** GuardDuty, Security Hub, Inspector e Access Analyzer entram com `providerDetection: true` e
  severidade `from_source`: a lógica é do provedor, e a Verax responde só pelo repasse do achado.
- **Estado efetivo** (`effectiveScenarioState`): `homologado` declarado só vale se toda regra do cenário existe na
  versão e tem evidência do CI positiva e negativa, com `pass`, presa à fingerprint atual da regra, e nenhuma evidência
  do CI nessa fingerprint falhou. Senão, `em_teste` com o motivo por regra (`rule_changed`, `rule_missing`,
  `missing_evidence`, `evidence_failed`). A evidência de laboratório é opcional, citada só pelo hash do evento, e não
  homologa.
- **Fingerprint** (`apps/api/test/detection-coverage/rule-fingerprints.ts`, funções puras, sem disco; a API em execução
  não carrega o módulo): XML da Verax pelo elemento `<rule>` canonizado (sem comentários, espaços normalizados,
  atributos em ordem) mais as mães (`if_sid`, `if_matched_sid`) em fecho; a de fábrica pelo ID e pela imagem do manager
  com o digest do `infra/wazuh/docker-compose.yml`; a do worker pelos metadados mais o texto do módulo e do fecho dos
  imports relativos (achados com o `ts.preProcessFile`); o GuardDuty pela imagem do manager mais `finding-keys.ts` e
  `aws-mitre.ts`. Quebra de linha do Windows não muda o hash.
- **O que o teste confere** (`apps/api/test/detection-coverage/catalog.test.ts`, sem banco): toda regra que pode virar
  achado (XML de nível 5 ou mais, as tabelas do worker, as de fábrica que o código cita: 80254, GuardDuty, login nas
  instâncias e as dos agentes) está em exatamente um cenário; nenhum cenário cita regra inexistente ou de nível abaixo
  do mínimo; ID repetido; MITRE que o código não mapeia para as regras do cenário; fontes, severidade e
  `providerDetection` coerentes com as regras; nenhum `@` nem número de 12 algarismos fora de `111111111111` e
  `222222222222` em `detections/`; e as propriedades da fingerprint.
- **Fora do catálogo hoje:** as regras genéricas do Wazuh no CloudWatch Logs e as demais regras de fábrica dos agentes
  (nível 7 ou mais) que o código não cita por ID, como as do detector de vulnerabilidades: viram achado, mas não têm
  lista fechada no repositório. O nó não envia nada do catálogo ao plano de controle.

## Cofre de credenciais

_(fase 2: a tabela, a cifra, a chave do nó e a recifragem estão no código, em `apps/api/src/credentials` e
`infra/node`, e a rota que recebe o token do Cloudflare colado no painel também, no PR-11'. A rota é genérica, por tipo;
a AWS não passa por ela)_

- **O que guarda:** o token do Cloudflare, uma linha por conta cloud (`CloudCredential`), com o mesmo isolamento por
  cliente de todo dado de cliente. Nos nós da GCP, a AWS e a GCP não passam pelo cofre: o papel de leitura não tem
  chave, e o Pub/Sub é lido com a conta de serviço da VM. O tipo `aws_access_key`, feito no PR-V1 para a chave do
  usuário IAM, saiu no PR-V3' e voltou, só para a VM própria do cliente, com o `gcp_service_account_key` (migration
  `20261118120000_vm_read_keys`, que só acrescenta ao enum e aumenta a coluna do texto cifrado para 8 KB).
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

### Chaves de leitura da VM própria do cliente (decisão de 18/11/2026)

Na VM própria (`NODE_PLATFORM=vm`; seção "Ambiente na VM do cliente") não há identidade de nuvem: o nó não pede token
ao Google, e nenhum contêiner alcança o metadata. **Decisão do responsável:** só nesse modo, o admin cola em Contas
cloud a chave de uma identidade **só de leitura** de cada conta AWS e de cada projeto da GCP, cifrada no mesmo cofre do
token do Cloudflare. Os nós da GCP continuam sem chave.

- **Só na VM própria, pela API:** o `start.sh` passa `NODE_PLATFORM=vm` à API e ao worker (só no modo vm; nos nós da
  GCP, o ambiente não muda). A API recusa `aws_access_key` e `gcp_service_account_key` em qualquer outro nó (400
  `CREDENTIAL_KIND_NOT_ALLOWED`, antes do cofre, da conta e da origem; a tentativa entra na trilha). O painel lê a
  plataforma no `GET /v1/auth/client-config` (`nodePlatform`) só para escolher as instruções.
- **Formato (zod, no contrato):** AWS, o ID `AKIA` + 16 do base32 (a chave temporária `ASIA` é recusada com mensagem
  própria) e o segredo de 40 caracteres de base64. GCP, o painel lê o arquivo JSON da chave (até 8 KB; `type` precisa ser
  `service_account`) e manda só quatro campos: o projeto, o e-mail (conta de serviço criada pelo usuário,
  `<nome>@<projeto>.iam.gserviceaccount.com`; agentes do Google recusados), o ID da chave (40 hexadecimais) e o PEM
  PKCS#8 (linhas de base64, até 4 KB). O `token_uri` e o resto do arquivo nunca saem do navegador.
- **Conferência na API, antes de cifrar** (5 s, o mesmo limite de recusas, a mesma trilha): AWS, um `GetCallerIdentity`
  com a chave no STS de us-east-1 (o SDK só é carregado nessa hora): a conta precisa ser a cadastrada e o ARN, de um
  usuário IAM (`:user/`); a chave do root (`:root`) é recusada (`wrong_identity`). GCP, o token do Google com a chave
  (JWT RS256 trocado no `oauth2.googleapis.com`, endereço fixo, só o escopo do Pub/Sub) e um `testIamPermissions` na
  assinatura cadastrada na conta (`pubsub.subscriptions.consume`), que não lê mensagem nenhuma; sem assinatura cadastrada,
  400 antes. O sufixo guardado é o fim do ID da chave (nunca do segredo).
- **Cifra:** a chave da AWS cabe no bloco do RSA-OAEP (`{i,s}`). A da GCP (`{p,e,d,k}`, cerca de 1,9 KB) vai num envelope
  híbrido: uma chave AES-256-GCM aleatória cifrada com a RSA do nó (o mesmo rótulo do OAEP), o IV, a etiqueta e o texto,
  com o rótulo como dado autenticado. O envelope continua `v<versão>:<base64>` (o CHECK não muda; o tamanho do bloco do RSA
  separa os dois formatos), e a recifragem vale para os dois.
- **AWS no worker** (`aws/vault-key-credentials.ts`): a conferência da conexão e o inventário pedem a sessão pelo mesmo
  contrato do papel (`AwsReaderCredentials`); na VM própria, ela é a chave aberta do cofre (guardada enquanto o texto
  cifrado for o mesmo). O `GetCallerIdentity` precisa ser um usuário IAM da conta (senão `account_mismatch`); a chave
  recusada é `key_invalid` e a ausente, `key_missing`; a simulação diária da permissão demais é no próprio usuário.
- **AWS no Wazuh:** o manager nunca recebe a chave. O gerador (`VERAX_AWS_STATIC_KEYS=1`, que o `wazuh-apply.sh` passa no
  modo vm) escreve os profiles só com a região e as tentativas, e o `aws-token.sh` (o mesmo timer de 10 min), no lugar
  do token do Google, roda o job `aws-sessions` (imagem da API, ambiente do worker, o banco, o cofre só leitura e o STS),
  que troca a chave de cada conta do manager por uma sessão de 1 hora (`GetSessionToken`) e imprime o arquivo
  `credentials`; o host o confere linha a linha (só o nome do profile, `ASIA...`, o segredo e o token da sessão) e o grava
  por troca atômica, 0600, na pasta do manager. Uma falha mantém as sessões anteriores, e o sinal `aws-token` do worker
  (`aws_token_stale`) vale igual. O job é o único, além do worker, que monta a pasta do cofre (definido no `compose.vault.yaml`; o CI confere a definição inteira: só leitura,
  endurecido, perfil `setup`).
- **GCP no worker** (`gcp/vault-pubsub-reader.ts`): o cliente cria o tópico, a assinatura e o sink no **próprio projeto**
  (não há projeto do nó na VM própria), e a conta de serviço tem `roles/pubsub.subscriber` só na assinatura. O sync da
  GCP não muda: o leitor escolhe, para cada assinatura, a chave da conta ativa mais antiga que a cadastrou e lê com o
  token de 1 hora dela (`gcp/service-account-token.ts`). Sem chave legível, `gcp_key_missing` na conexão. A fonte `gcp`
  passa a valer no modo vm (o instalador a liga), só com o cofre.
- **Por que assinatura no projeto do cliente, e não ler o Cloud Logging direto:** é o mesmo filtro, o mesmo sync, a
  mesma deduplicação e o mesmo medidor do gerenciado; o `entries.list` pediria `roles/logging.viewer` (e o
  `privateLogViewer` para o acesso a dados) no projeto inteiro, com cota baixa e um cursor próprio. A assinatura guarda 7
  dias se a VM ficar fora do ar.

| Risco                                                                | Mitigação                                                                                                                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A chave de longo prazo vaza (não vence sozinha, como o token)        | Só leitura, com as negações do papel e, com o IP da VM informado, nada de fora dele; nunca sai do worker e do job; recomendação de troca a cada 90 dias; o cliente a revoga no IAM |
| Root na VM lê a chave do cofre local e as sessões do manager         | A VM é do cliente, e a identidade é dele, só de leitura; as sessões do manager valem 1 hora                                                                                        |
| A chave da AWS colada é do root ou de um usuário com mais permissões | O root é recusado na API e na conferência; a simulação diária no próprio usuário avisa a permissão demais                                                                          |
| O `GetSessionToken` a cada 10 min por conta aparece no CloudTrail    | 144 entradas por dia por conta, de leitura; documentado                                                                                                                            |

## Por que papel sem chave

_(fase 2, feito no código: o template, no PR-V2'; o "Conectar AWS" do painel, no PR-V3'; a coleta pelo Wazuh do nó, no
PR-V4'; a conferência da conexão, no PR-V5'. O template está no modelo 2 desde a revisão de 22/11/2026, e o caminho
do cliente passou a ser o "Conectar com AWS" (seção "Onboarding AWS self-service"); o que está aqui é a base que não
mudou: por que o papel não tem chave, a confiança, o token, a conferência da conexão e os riscos. O teste prático na
conta AWS de teste ainda não foi feito: o roteiro é o `docs/runbooks/homologacao-onboarding-aws.md`)_

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
painel deriva do ID da conta. Nenhuma saída é segredo. O template tem cerca de 46 KB, abaixo dos 51.200 bytes que o
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

- `VeraxControlReader` (Allow, que também é o permissions boundary do papel): a descoberta, que vale sempre (a
  configuração da conta, para achar as fontes de log e para Ativos e Postura, as tags e a simulação das permissões
  do próprio papel), e as três autorizações que o cliente liga ou desliga na pilha: os logs que a AWS grava no S3 em
  `AWSLogs/<conta>/` (`kms:Decrypt` só pelo S3), os achados de segurança e os grupos do CloudWatch Logs com a tag de
  leitura. Os buckets e as chaves KMS informados à mão ficam para o que está fora desse padrão. O detalhe está na
  seção "Onboarding AWS self-service", "O template v2 e as três autorizações".
- `VeraxControlGuardrails` (Deny): tudo o que vier de fora do IP do NAT do nó (também com uma sessão já emitida; só
  não a chamada que um serviço da AWS faz em nome do papel, como o S3 pedindo ao KMS para decifrar), qualquer
  alteração de logs e das outras fontes, e qualquer ampliação do próprio acesso, inclusive mexer na confiança e nas
  tags do papel.
- **Confused deputy, sem ExternalId:** a regra é **uma identidade do Google por cliente, nunca dividida entre dois**.
  A confiança do cliente B fixa o `sub` da identidade de B; se o cliente A cadastrar a conta AWS de B, a entrada
  chega com o `sub` de A e é recusada (`trust_denied`), sem que nada da conta de B chegue ao Wazuh. O `sub` não é
  segredo, mas não se forja: o token é assinado pelo Google.
  - **Nó dedicado:** a identidade é a conta de serviço do nó, que atende um só cliente e nunca é reaproveitada entre
    clientes (o módulo `infra/gcp/modules/node` expõe o ID na saída `service_account_unique_id`). Além do `sub`, o
    nó de A sai de outro IP.
  - **Célula** _(a construir, CE-11 e CE-12)_: os clientes dividem o IP de saída, então só o `sub` os separa. Cada
    cliente tem a própria conta de serviço, `vxt-<slug>`, que a VM da célula personifica só para emitir o token
    (`generateIdToken`, com a permissão dada em cada conta, nunca no projeto); o painel mostra em
    `NodeServiceAccountId` o ID dessa conta, e o template, o `Audience` e as quatro condições não mudam. O worker e o
    gerador do Wazuh tiram a identidade da ligação conta → cliente → `TenantCloudIdentity`, gravada só pelo plano de
    controle, nunca da linha da conta nem do que o cliente digita, e cada token emitido é conferido (o `sub` tem de
    ser o do cliente, senão `identity_mismatch`). Detalhes na seção "Célula compartilhada (Plataforma)".
- **Conta de serviço estável:** uma conta recriada, mesmo com o mesmo nome, ganha outro ID único, e o papel de todo
  cliente daquele nó deixa de aceitá-la até cada um atualizar a pilha. A conta não tem `prevent_destroy`, porque a
  homologação é destruída entre as janelas de teste e a exclusão do cliente destrói o ambiente inteiro (o `lifecycle`
  não muda por variável). A proteção é outra: o que a recriaria (`account_id` e `project`) sai só do `name_prefix` e
  do `project_id`, e um teste do módulo (`tests/conta_de_servico.tftest.hcl`) confere que as mudanças de rotina não a
  recriam; e o executor do Terraform do plano de controle recusa o plano que a recrie ou apague fora da exclusão
  (seção "Exclusão em dois tempos").

**O audience** é uma constante do produto, `https://control.veraxsistemas.com.br/aws-reader`: o padrão do parâmetro
`Audience` do template e o valor que o nó pede ao servidor de metadados da GCP. A linha opcional
`AWS_WEB_IDENTITY_AUDIENCE` do `node.conf` a troca num nó (o painel mostra o valor do nó, e o `aws-token.sh` do host o
pede ao Google). Mudá-la exige atualizar a pilha de todos os clientes do nó.

**Ciclo da conexão.** O caminho do cliente é o "Conectar com AWS" (seção "Onboarding AWS self-service"): o painel
baixa o template já preenchido, e o nó valida a conexão sozinho. Os passos abaixo são a base dele, e o passo 1 é o
caminho manual, que continua valendo (a pilha criada pela CLI, ou com o template sem preencher):

1. **Conectar à mão (PR-V3', feito):** o admin cadastra a conta (o ID e a região; os buckets, só os de fora do padrão
   `AWSLogs/`). Em "Alternativa manual", o detalhe da conta em Contas cloud mostra o link "Baixar o template" e os
   valores da pilha, com cópia: o ID único da conta de serviço do nó (`NODE_SA_UNIQUE_ID`), o IP de saída
   (`NODE_EGRESS_IPS`), o audience e as três autorizações. Os dois primeiros vêm do `node.conf`, que o `start.sh`
   passa à API só quando têm a linha; sem eles, a tela os pede à Verax. Mostra também os ARNs dos buckets cadastrados
   (`LogBucketArns`), o link do console do CloudFormation e o comando da CLI. Nenhum valor é segredo, e quem só lê vê
   o mesmo, sem o botão.
   - **O template é servido pelo painel:** o arquivo do repositório entra no build como recurso (`?url` do Vite),
     copiado byte a byte para `assets/` com o hash do conteúdo no nome, e é baixado da mesma origem, com o nome
     `verax-control-reader.yaml`. É o template revisado no commit do painel; o link da alternativa manual o baixa sem
     nada preenchido (o e2e confere byte a byte), e o "Conectar com AWS" lê o mesmo arquivo para montar o
     preenchido. Um link para o GitHub dependeria de saber o commit no navegador (o painel só aceita `VITE_API_URL`),
     não baixaria o arquivo (o atributo `download` não vale para outra origem) e dependeria do GitHub no ar. Uma
     mudança só no template publica a demonstração de novo (o filtro de caminhos do workflow `Painel`).
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
   - **Buckets de log no painel** ("Avançado: buckets fora do padrão"): no máximo um por fonte (CloudTrail, GuardDuty
     e WAF), no cadastro e no detalhe da conta (`cloud_accounts:write`; quem só lê vê a lista). Outra lista de nomes volta a conexão para `waiting` e
     descarta um "Verificar" pendente, sem chamar a AWS: o cliente atualiza o `LogBucketArns` da pilha e pede a
     verificação. Trocar só a fonte de um bucket não muda nada disso, e o `ingestFrom` fica (um bucket incluído
     depois herda o dia da conta).
   - **Nó sem a própria identidade:** sem `NODE_SA_UNIQUE_ID` no `worker.env` (o nó da Verax, o ambiente local), a
     conferência é a `UnavailableAwsConnectionChecker`, que responde `check_unavailable` sem chamar a AWS nem o
     metadata, e o SDK da AWS nem é carregado no worker.
2. **Coletar (PR-V4', feito):** o manager do Wazuh do nó lê os buckets de cada conta conectada com o papel, sem chave.
   - **O token, no host:** o `infra/node/bin/aws-token.sh` (root, `verax-aws-token.timer`: 30 s depois do boot e a
     cada 10 min; o `start.sh wazuh-up` também o roda antes de subir o manager) pede ao servidor de metadados o token
     com o audience do nó e `format=standard` (sem o projeto nem a VM), confere o formato e o grava por troca atômica
     em `/run/verax/wazuh-aws/google-id-token` (tmpfs, 0600, root), a pasta montada só leitura no manager em
     `/root/.aws`. Quem pede é o host: a guarda do metadata só filtra os contêineres, e o worker não ganha escrita na
     pasta do manager. Uma falha mantém o token anterior, que vale 1 hora: renovar a cada 10 min deixa 50 min de
     folga. Sem a pasta (o Wazuh fora do ar), não faz nada, e o `start.sh down` apaga a pasta.
   - **A lista das contas:** o CLI `wazuh-sources` (imagem da API, ambiente do worker, rede do banco; job do
     `compose.wazuh.yaml`) imprime as contas AWS ativas que já passaram pela verificação (`ingestFrom`), cada uma com
     o ID, a primeira região e as fontes autorizadas lidas pelo Wazuh (`AwsSource`): os buckets do cadastro (as linhas
     `legacy`, com o `only_logs_after` do `ingestFrom`) e as fontes do onboarding self-service (seção "Onboarding AWS
     self-service", "Coleta pelo Wazuh"). A conexão de agora não conta: um erro, uma edição de bucket (que volta a
     conta a "aguardando") ou os erros que a própria coleta grava não tiram os buckets do cadastro do manager nem o
     reiniciam; desativar a conta, sim. Nenhum valor é segredo.
   - **O gerador** (`render-manager-config.py`, job `manager-config`, sem rede), o único que escreve na pasta além do
     token: um profile por conta em `/root/.aws/config`, só com as chaves de uma lista (`role_arn` derivado do ID,
     `web_identity_token_file`, `role_session_name = verax-control-wazuh`, `region`, `sts_regional_endpoints =
regional`, `retry_mode = standard`, `max_attempts = 10`), nunca `credential_process`, sem arquivo `credentials`,
     sem `<access_key>`, `<secret_key>` nem `<iam_role_arn>` no `ossec.conf`. Cada bucket com `remove_from_bucket no`
     (o papel também nega qualquer escrita nos logs), o WAF sem as requisições liberadas (`discard_regex` em
     `ALLOW`). No CloudTrail, cada conta lê só a pasta dela (`aws_account_id`); um bucket do GuardDuty ou do WAF
     listado por mais de uma conta é lido uma vez só, pelo papel da conta de menor ID e desde a data mais antiga entre
     elas, para nenhum evento entrar duas vezes. Um bucket que entra depois herda o `ingestFrom` da conta: o Wazuh lê o
     histórico dele desde o início da coleta da conta. O gerador imprime só o hash da configuração que o manager lê ao
     subir (o `ossec.conf` e as regras); a região, que só vai para o profile, não o muda (o boto3 relê o arquivo a cada
     execução do módulo).
   - **A aplicação:** o `infra/node/bin/wazuh-apply.sh` lê a lista (numa variável: um erro do CLI nunca vira "nenhuma
     conta"), passa ao gerador e só reinicia o manager quando o hash muda e ele está no ar. Espera o healthcheck por até
     180 s; sem ele, a configuração anterior volta junto com os profiles da AWS dela (o gerador guarda os dois em `.prev`,
     que o init da imagem não copia, e o token do Google não entra na troca), e o manager reinicia com ela, e a que falhou não é tentada de novo enquanto for a mesma. Indexer, banco, API e painel
     seguem no ar. Roda pelo `verax-wazuh-apply.path` (o worker gravou uma geração nova), pelo timer de 15 min e pelo
     `wazuh-up`, uma execução por vez (`flock`), com no máximo 5 partidas em 5 min (o timer cobre o resto e arma o
     `.path` de novo).
   - **Os sinais, sem segredo**, em `/run/verax/wazuh-signal` (root e o grupo do worker, 1770; montada com escrita só
     no worker, em `WAZUH_SIGNAL_DIR`): a tarefa `wazuh-config` do worker (a cada 30 s) grava a `generation` (o SHA-256
     da lista que o CLI imprime) só quando ela muda; o host grava `applied` (`{generation, status ok|error, at}`),
     `aws-token` (`{tokenAt}`) e `progress` (até onde o módulo leu cada fonte; seção "Onboarding AWS self-service"), e
     o bit t impede que o worker troque os três. O worker grava em cada conta que o
     manager lê o aviso da coleta, `aws_token_stale` (token sem renovar há mais de 40 min) ou `wazuh_apply_failed` (a
     lista de agora não foi aplicada), e o tira quando o problema passa (e da conta que saiu da coleta), com auditoria
     (`cloud_account.aws_collection`) na trilha de cada cliente.
   - **Um campo para cada tarefa:** o aviso da coleta fica em `CloudAccount.collectionError` (só conta AWS e só os dois
     códigos, por CHECK), que só a tarefa `wazuh-config` grava; a conexão (`connection` e `connectionError`, com o
     aviso dela) é só da tarefa `aws-check` (passo 3). Com um campo só, as duas se desfariam a cada conferência (com
     auditoria), e tirar o aviso da coleta apagaria um aviso diário da conferência até o dia seguinte. A API devolve
     os dois, e o painel mostra a coleta numa linha própria, "Coleta no nó", ao lado da conexão.
   - **Regras locais** (`verax_reader_rules.xml`, gerado do modelo com o IP de saída do nó): as leituras e a entrada no
     papel vindas do IP do nó, nível 0 (100200 e 100201); a sessão do papel ou o token usados de outro IP, nível 12
     com MITRE T1078.004 (100202 e 100203); qualquer alteração no papel ou nas duas políticas da pilha, nível 5 (100204
     e 100205). Sem o `NODE_EGRESS_IPS` no `node.conf`, só as de alteração.
   - **Regras críticas** (`verax_aws_critical_rules.xml`, 100300 a 100324, PR-V7): o subconjunto crítico do catálogo
     da AWS (root, permissão de administrador, papel aberto a qualquer conta, CloudTrail e GuardDuty desligados, bucket
     e snapshot públicos, grupo de segurança aberto para a internet, domínio, organização) e o WAF desligado ou
     alterado, com MITRE e o título em português do dicionário (seção "Regras de detecção"). Só o que aconteceu (sem
     `errorCode`); filhas da mesma cadeia do CloudTrail das regras do papel. O papel de leitura só lê, e nenhuma delas
     casa leitura: as leituras do nó seguem no nível 0. Uma alteração crítica vale sobre a regra do papel (o Wazuh tenta
     primeiro a irmã de nível mais alto).
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
     `region_disabled` e `aws_unavailable`; o token do host sem renovar (`aws_token_stale`) é um aviso da coleta, no
     campo dela (`collectionError`, passo 2).
4. **Medir e acompanhar (PR-V6, feito):** a tarefa `wazuh-usage` do worker (`apps/api/src/usage/wazuh-usage.ts`, a
   cada 5 min) lê os contadores do analysisd do Wazuh do nó (`GET /manager/daemons/stats?daemons_list=wazuh-analysisd`,
   usuário `verax_stats`, TLS conferido com a CA e o nome `wazuh.manager`, resposta conferida com zod).
   - **Medidor:** soma ao uso do cliente (`IngestUsage`, fonte `aws`) a diferença desde a leitura anterior dos bytes
     recebidos pelo analysisd (`metrics.bytes.received`, tudo o que ele lê) e dos eventos do módulo da AWS
     (`…modules_breakdown.aws`). Numa partida nova do analysisd (o `uptime` mudou) ou com um contador menor que a base,
     soma o valor inteiro. A base (`WazuhCounter`, dado de sistema) e o uso entram na mesma transação, com a base
     conferida: outra execução no meio desfaz esta. A primeira leitura de um nó vira só a base (a dúvida a favor do
     cliente), e o que chega entre a última leitura e um reinício do analysisd se perde.
   - **Um cliente por nó:** os clientes com conta AWS ativa (e o dos agentes do Wazuh, ligados) são os donos possíveis
     do volume. Com mais de um, a leitura vira só a base, `WazuhCounter.meterBlocked` fica `multiple_tenants`, o log
     avisa a cada execução (só a contagem de clientes) e a Torre da equipe da Verax mostra "Medidor da AWS parado";
     nenhum cliente vê isso. A ambiguidade fica gravada na base também quando a leitura falha, e a primeira leitura
     depois de uma base ambígua é só a base nova: o volume de um intervalo em que havia mais de um cliente nunca é
     cobrado de quem sobra (revisão do PR #87).
   - **Saúde (`IngestHealth`, no escopo do cliente):** com conta AWS conectada, a última vez que os eventos da AWS
     andaram (ou o começo da observação). Parada há mais de 2 h, a Torre mostra "Sem logs novos da AWS" e um aviso
     `aws_ingestion_stalled` vai para a fila de saída (PR-16), uma vez por parada (chave `aws-stalled:<começo>`); os
     eventos de volta rearmam. Sem a leitura (o manager fora do ar), o prazo corre do mesmo jeito. O contador é do nó,
     então a parada é do cliente, não de uma conta: com duas contas conectadas, uma parada só aparece quando as duas
     param. A observação de quem não é o dono de agora (mais de um cliente, nenhuma conta AWS ativa, ou o cliente que
     saiu do nó) é limpa: a conta que volta começa uma observação nova, sem a parada antiga nem um aviso na hora. Desde
     o OP-01, o mesmo andamento é o sinal de vida das contas AWS conectadas e o último dado da fonte na Torre (seção
     "Torre: semáforo, saúde da coleta e pulso da operação").
5. **Desconectar:** o painel para a coleta e mostra os passos no console: "Revoke active sessions" no papel (corta as
   sessões já emitidas, de até 1 hora) e apagar a pilha. Não há chave para apagar. Para tirar só uma parte do acesso,
   o cliente desliga uma autorização na pilha, tira a tag de um grupo de logs ou desautoriza uma fonte no painel
   (seção "Onboarding AWS self-service").

**Riscos residuais e mitigação:**

| Risco                                                                                                                                      | Mitigação                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token do Google vazado: vale até 1 hora e não pode ser revogado                                                                            | Só entra do IP do NAT do nó (`aws:SourceIp` na confiança) e só no papel deste cliente; a sessão emitida também fica presa ao IP (Deny); regra de nível 12 para entrada de outro IP                                                                                                                                    |
| Root no nó lê o token e as sessões em claro (tmpfs e memória do worker e do manager)                                                       | Valem 1 hora; nó dedicado a um cliente; sem porta aberta; acesso só pelo IAP com OS Login auditado; metadata só para o worker; o alcance é leitura de logs e configuração. Na célula, o alcance são os tokens de todos os clientes dela (o raio de impacto da seção "Célula compartilhada (Plataforma)")              |
| Página da memória com segredo em claro (chave privada do cofre, token, sessões) vai para o swap, no disco do snapshot                      | Swap cifrado com chave aleatória a cada boot, nos dois perfis; no `standard`, `vm.swappiness=1` e o heap do indexer travado na memória                                                                                                                                                                                |
| O ambiente de um contêiner fica gravado em `/var/lib/docker`, no disco e no snapshot                                                       | Chaves privadas do cofre só por arquivo do tmpfs montado só leitura no worker, nunca por variável (teste e CI conferem); o token da AWS fica num tmpfs do host                                                                                                                                                        |
| Execução remota de código na API, exposta pelo túnel                                                                                       | A API não alcança o metadata e não emite token; cofre assimétrico para o Cloudflare                                                                                                                                                                                                                                   |
| O manager processa log não confiável e lê o token                                                                                          | Sem acesso ao Postgres nem ao metadata; `cap_drop`; rede de saída só dele; imagem fixada pelo digest; nó dedicado; o token vale 1 hora e só do IP do nó. Na célula, um log forjado por um cliente que explore o manager alcança os tokens dos outros: risco residual aceito e documentado (raio de impacto da célula) |
| Quem emite ID token da conta de serviço do nó entra no papel (operador com `serviceAccountUser`; no plano de controle, o `cp-terraform`)   | Precisa também sair pelo IP do NAT do nó; alertas em `SetIamPolicy` na conta de serviço, em `GenerateIdToken` e em VM criada com a conta de um nó (CP-12); nunca `serviceAccountOpenIdTokenCreator` no Terraform                                                                                                      |
| A conta de serviço do nó é apagada ou recriada, e o ID único muda                                                                          | `account_id` e `project` só do `name_prefix` e do `project_id`, com teste de que as mudanças de rotina não a recriam; o executor do plano de controle (CP-07) recusa recriá-la ou apagá-la fora da exclusão; restauração em até 30 dias com o mesmo ID; depois disso, cada cliente atualiza a pilha                   |
| Google ou o metadata fora do ar (`IDPCommunicationError`, renovação do token falha)                                                        | O token tem 50 min de folga; o wodle retoma do marcador e não perde log; aviso de token sem renovar                                                                                                                                                                                                                   |
| A web identity pelo profile não funcionar no contêiner do manager                                                                          | O CI confere na imagem, sem rede, que o boto3 do manager usa o provedor de web identity e troca o token no STS da região com o papel certo; o roteiro de homologação na conta AWS de teste confirma de ponta a ponta; plano B: o host troca o token por uma sessão e grava um `credentials` temporário de 1 hora      |
| Um bucket do cadastro (fora do padrão) incluído depois do início da coleta é lido desde o `ingestFrom` da conta (semanas ou meses)         | Aceito por ora: a leitura vai para o medidor de uso. As fontes autorizadas no onboarding self-service não têm esse risco: cada uma começa no dia da própria autorização                                                                                                                                               |
| O worker grava na pasta dos sinais, no tmpfs do host                                                                                       | Só sinal sem segredo; o bit t impede que ele troque os arquivos do host, que nunca leem o que ele grava (a geração só dispara o `.path`, com limite de partidas)                                                                                                                                                      |
| O `GetCallerIdentity` não pode ser negado e revela a conta e o ARN da sessão                                                               | Impacto baixo; documentado                                                                                                                                                                                                                                                                                            |
| O IP do NAT muda e a coleta para                                                                                                           | IP reservado com `prevent_destroy`; erro `trust_denied`, que manda conferir o IP de saída                                                                                                                                                                                                                             |
| O cliente amplia o papel (anexa política, tira o boundary)                                                                                 | `SimulatePrincipalPolicy` todo dia, com o IP do nó e uma amostra de escrita, IAM, KMS e leitura fora da política: aviso na conta, sem parar a coleta. Permissão a mais fora da amostra não é detectada                                                                                                                |
| O cliente cria o papel pelo assistente do console e põe o audience no `aud`                                                                | Template e Terraform prontos; o README avisa; a mensagem de papel recusado explica                                                                                                                                                                                                                                    |
| RCP de perímetro de dados do cliente nega a federação do Google                                                                            | O cliente inclui `accounts.google.com` na RCP ou marca o papel como exceção (decisão dele); texto pronto no onboarding                                                                                                                                                                                                |
| STS de sa-east-1 desligado pelo cliente                                                                                                    | O worker cai para us-east-1; no Wazuh, o erro instrui a religar                                                                                                                                                                                                                                                       |
| Objeção de conformidade: o Access Analyzer mostra o papel com acesso externo federado                                                      | Esperado e explicado no onboarding: papel com credencial temporária é o que a AWS recomenda; o CloudTrail registra cada entrada com o `sub` do nó                                                                                                                                                                     |
| Ruído no CloudTrail e no medidor (cerca de 1.700 entradas por dia por conta, estimativa de antes da descoberta e dos coletores de achados) | Medir no roteiro de homologação; se pesar, intervalo de 10 min ou descontar do medidor                                                                                                                                                                                                                                |
| Bucket de organização legível inteiro                                                                                                      | Prefixo opcional na pilha (`LogObjectPrefix`); nó dedicado ao mesmo cliente. Na célula, o papel só aceita a identidade do próprio cliente, e o prefixo continua valendo                                                                                                                                               |
| Na célula, o cliente A cadastra a conta AWS de B _(a construir, CE-11 e CE-12)_                                                            | Uma conta de serviço por cliente (`vxt-<slug>`); a identidade vem de `TenantCloudIdentity`, gravada só pelo plano de controle; o `sub` de cada token é conferido; a confiança de B recusa o `sub` de A (`trust_denied`) e a conta nunca chega ao Wazuh                                                                |
| Na célula, o cliente A cadastra o ID da conta de B antes dele (409 para B, negação de serviço)                                             | Mensagem genérica no 409; depois (CE-23), a unicidade só entre contas verificadas: a verificada vence e as duplicadas não verificadas são desativadas                                                                                                                                                                 |
| Na saída do cliente, o papel segue na conta dele                                                                                           | Roteiro: "Revoke active sessions" e apagar a pilha; sem o papel, o nó não entra                                                                                                                                                                                                                                       |

## Onboarding AWS self-service

_(decisões do responsável de 22/11/2026. Feito no código, na branch de integração `integracao/aws-onboarding`: o
template v2 do papel (PR #169), o backend do nó (#170), os coletores de achados pelas APIs (#171), a tela em Contas
cloud (#172), a coleta pelo Wazuh (#173) e o acabamento (a escolha gravada, a descoberta disponível, as fontes de cada
conferência e o número de sequência do sinal `applied`). **Nada disto foi exercitado numa conta AWS de verdade:** o que
foi conferido, e onde, está na tabela do fim desta seção; o roteiro para conferir o resto numa conta AWS de teste é o
`docs/runbooks/homologacao-onboarding-aws.md`, e o que o operador faz no dia a dia, o
`docs/runbooks/onboarding-cliente.md`.)_

O cliente conecta a conta AWS sozinho: clica em "Conectar com AWS", cria a pilha do papel de leitura no CloudFormation
e, a partir daí, o nó valida a conexão, descobre as fontes de log da conta e mostra o que pode ser coletado. O cliente
não digita bucket, ARN, região, detector nem grupo de logs: escolhe e autoriza. O papel de leitura sem chave e o que
protege a entrada nele continuam os da seção "Por que papel sem chave"; esta seção cobre o que veio depois.

**Decisões do responsável (22/11/2026):**

- **Sem bucket nem conta AWS da Verax no caminho, e sem link de criação rápida.** O botão baixa o template com os
  valores do nó já gravados e abre o console do CloudFormation; o cliente envia o arquivo, revisa e confirma. O
  template sem preencher e o comando da CLI ficam como alternativa manual.
- **Logs no S3:** o papel lê, em qualquer bucket, só os objetos em `AWSLogs/<conta>/` (e, na trilha de organização,
  `AWSLogs/o-…/<conta>/`). O cliente não digita bucket.
- **CloudWatch Logs:** o papel lê só os grupos que o cliente marcar com a tag `verax-control = leitura`. A descoberta
  lista todos (só metadados), e a escolha no painel é grupo a grupo.
- **Nós dedicados primeiro.** Na célula compartilhada, a coleta da AWS ainda não existe (CE-11 e CE-12), e a
  descoberta fica desligada; o código novo não supõe um cliente por nó (toda linha tem `tenantId`, e as credenciais
  passam por `AwsReaderCredentials`).
- **VM própria do cliente:** a conta continua lida com a chave do usuário IAM de leitura (decisão de 18/11/2026). Só
  o "Conectar" muda (os passos são os da chave); a descoberta, as fontes e os coletores são os mesmos.
- **Resposta automática:** nenhuma permissão agora. Fica para um papel separado, com autorização própria.
- **Nenhum log é descartado por plano.** O volume é controlado pela data de início (a da autorização, sem histórico),
  pelos tetos de quantidade, pelos avisos de volume antes de autorizar e pela desautorização a qualquer momento.

### O fluxo, de ponta a ponta

1. **Conectar.** Em Contas cloud, o cliente cadastra a conta (o ID e a região principal), marca o que autoriza e
   clica em "Conectar com AWS": o painel abre o CloudFormation em outra aba, avisa a API (`POST …/aws/connect`), que
   guarda a escolha e o pedido, e, com a resposta, baixa o template preenchido com a escolha que a API confirmou.
2. **Validação.** A tarefa `aws-check` do worker tenta entrar no papel por até 60 min, sem ninguém clicar em
   "Verificar". Na primeira entrada, confere a identidade e lê as tags do papel: a versão do template e as
   autorizações que a pilha concedeu de fato.
3. **Descoberta.** A tarefa `aws-discovery` lê a configuração da conta, região por região, só com chamadas de leitura,
   e grava uma linha por fonte de log (`AwsSource`), com a permissão de cada uma sondada. Uma leitura recusada não
   para as outras: a descoberta termina parcial.
4. **Autorização.** O cliente escolhe as fontes que quer coletar. Nada é lido antes disso, e a coleta de cada fonte
   começa no dia da autorização.
5. **Coletores.** As fontes de bucket e do CloudWatch Logs entram na configuração do manager do Wazuh do nó; as de
   achados (GuardDuty, Security Hub, Inspector e Access Analyzer) são lidas pelo worker, pela API de cada serviço.
6. **Saúde.** Cada fonte tem o estado e os horários da própria coleta, e o estado da conta é derivado deles a cada
   leitura: nunca um "tudo certo" com um passo essencial pendente.

### Regras de segurança

- **A Verax nunca cria nem altera nada na conta do cliente.** A descoberta só faz chamadas `Describe*`, `Get*`, `List*`
  e `BatchGet*`. Além da política do papel (só leitura, com as negações explícitas), os clientes da AWS da descoberta
  têm uma trava própria (`apps/api/src/aws/discovery/read-only.ts`): qualquer outro comando é recusado antes de sair
  para a rede. Ligar um serviço (GuardDuty, Security Hub, Inspector, uma trilha, flow logs, o logging do WAF) é sempre do
  cliente; as fontes desligadas aparecem com o aviso de que ligar tem custo na AWS.
- **A API não fala com a AWS.** Ela grava pedidos (o "Conectar", a descoberta manual, a sondagem de uma fonte); quem
  entra no papel é o worker, o único processo do nó com a identidade. As credenciais passam por `AwsReaderCredentials`
  (o papel sem chave ou, na VM própria, a chave do cofre), a mesma sessão da conferência da conexão e do inventário.
- **Só nomes e configuração.** A descoberta não lê conteúdo de log. A sondagem de um bucket lê o nome de um objeto e 1
  byte dele (para provar a chave KMS), e nada é guardado. Dos erros da AWS, só o nome (nunca a mensagem).
- **Isolamento por cliente:** o painel só alcança a conta e as fontes do cliente da sessão (o resto é 404), e o banco
  recusa a linha de um cliente na conta de outro. Os argumentos, ponto a ponto, estão em "Isolamento entre clientes".
- **Fontes sensíveis:** um grupo do CloudWatch Logs pode trazer dado de aplicação. Só é lido com a tag
  `verax-control = leitura` (posta pelo cliente) e só é autorizado citado um a um na confirmação
  (`sensitiveSourceIds`): não existe "autorizar tudo" para eles.
- **Toda escrita é auditada** na trilha do cliente, com quem, quando e o quê: `cloud_account.aws_connect` e
  `aws_verify` (com a escolha das autorizações, antes e depois), `aws_discovery_request`, `aws_source_authorized`,
  `aws_source_revoked` e `aws_source_retry` (pelo usuário); `aws_check`, `aws_template`, `aws_discovery` e
  `aws_source_collection` (pelo sistema). Na conta que a Verax cadastrou pelo console, o
  cadastro continua do console (409 `CONSOLE_MANAGED`), e conectar, descobrir e autorizar são do cliente.

### O template v2 e as três autorizações

O arquivo é o mesmo, `infra/cloudformation/verax-control-reader.yaml` (o passo a passo do cliente, com cada permissão
explicada, está no README da pasta). O nome, o caminho e a confiança do papel não mudaram, e uma pilha do modelo 1
atualizada com ele continua lendo o que lia. O que mudou:

- **Uma parte que vale sempre, a descoberta**, e três **autorizações** que o cliente liga ou desliga na pilha
  (`true` ou `false`; o padrão é `true`). Com uma autorização desligada, a permissão dela nem entra na política.

  | Capacidade (`verax-control:capabilities`) | Parâmetro              | O que o papel passa a ler                                                                                                                                                                                                                                                                                   |
  | ----------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `discovery`                               | (vale sempre)          | Só configuração e nomes (`Describe*`, `Get*`, `List*`): trilhas, flow logs, Web ACLs e o logging delas, detectores e exports do GuardDuty, o estado do Security Hub, do Inspector e do Access Analyzer, grupos de logs (nome, tamanho, tags), Config, load balancers, RDS, e o que Ativos e Postura já liam |
  | `service-logs`                            | `ReadAwsServiceLogs`   | `s3:GetObject` só em `AWSLogs/<conta>/` e `AWSLogs/o-*/<conta>/`, em qualquer bucket; `s3:ListBucket` nessas pastas e no primeiro nível do bucket (só nomes: é o que o módulo do Wazuh lista para achar a pasta); `kms:Decrypt` só pelo S3                                                                  |
  | `findings`                                | `ReadSecurityFindings` | Os achados do GuardDuty, do Security Hub, do Inspector e do Access Analyzer, pela API de cada um. Não liga serviço e não altera achado                                                                                                                                                                      |
  | `log-groups`                              | `ReadTaggedLogGroups`  | `logs:DescribeLogStreams`, `logs:GetLogEvents` e `logs:FilterLogEvents` só nos grupos com a tag `verax-control = leitura` (condição `aws:ResourceTag`). O papel não consegue pôr a tag                                                                                                                      |

- **Buckets adicionais** (`LogBucketArns`, `LogKmsKeyArns` e `LogObjectPrefix`): os parâmetros do modelo 1 ficam só
  para as exceções, o que a AWS não grava em `AWSLogs/<conta>/` (um prefixo antes de `AWSLogs/`, flow logs com
  partições do Hive, entregas do Firehose, um bucket central). No painel, são os "buckets fora do padrão".
- **Tags do papel:** `verax-control:template = 2` e `verax-control:capabilities` (a lista separada por espaço, porque
  o IAM não aceita vírgula no valor de uma tag; sempre com `discovery`). Não dão permissão: informam. O nó as lê com
  `iam:GetRole` no próprio papel (a declaração `AutoInspecao`, a mesma da simulação das próprias permissões), e o
  papel não pode trocá-las (`NuncaTrocarAsPropriasEtiquetas`). Sem tags, o papel é do modelo 1.
- **Negações:** a do IP de saída do nó (`SoDoNoDaVerax`) ganhou `Bool aws:ViaAWSService = false`: a chamada direta
  continua presa ao IP do nó, e só não é barrada a que um serviço da AWS faz em nome do papel (o S3 pedindo ao KMS
  para decifrar um objeto com SSE-KMS). `NuncaAlterarOutrasFontes` nega a escrita em flow logs, Config, WAF, load
  balancers, RDS, Security Hub, Inspector e Access Analyzer, além do que já era negado em logs e no próprio acesso.
- **Tamanho:** o template tem cerca de 46 KB, abaixo dos 51.200 bytes que o CloudFormation aceita sem bucket; o
  preenchimento confere o tamanho do arquivo que gera.

**O arquivo preenchido (`prefillReaderTemplate`, em `packages/shared/src/aws-reader.ts`).** Uma função pura, que roda
no navegador: grava como `Default` de sete parâmetros os valores do nó (`NodeServiceAccountId`, `NodeEgressIps` e
`Audience`), as três autorizações escolhidas e, na conta que tem buckets do cadastro, `LogBucketArns`. Cada valor
passa pelos validadores de sempre antes de ser escrito (um valor fora do formato recusa o arquivo inteiro, e a tela
diz o que pedir à Verax), e nenhuma outra linha muda: um teste compara a saída com o arquivo do repositório linha a
linha. O arquivo sai com o nome `verax-control-reader-<conta>.yaml` e não tem segredo.

**A escolha do cliente fica gravada (`CloudAccount.awsChosenCapabilities`).** O "Conectar com AWS" manda as
autorizações marcadas (`{capabilities}`, só as três; a descoberta vale sempre), e o "Verificar de novo" depois de
"Atualize a pilha" manda as marcadas naquele bloco. A API só as guarda: é o que a tela devolve depois de recarregada
(as mesmas caixas, o mesmo arquivo em "Baixar o arquivo de novo") e o que ela compara com as tags do papel. **Não é
permissão:** o que o papel pode ler é sempre o que as tags dele dizem. Quando as tags lidas depois do "Conectar" não
são a escolha, a tela avisa, primeiro o que a pilha concede a mais ("Concede mais do que a sua escolha"), depois o
que está desligado, e abre o bloco de atualização já com a escolha do cliente. No console do CloudFormation, uma
atualização mantém o valor anterior de cada parâmetro: é o caso que o aviso pega. Sem escolha gravada (a conta de
antes disto, a conectada sem o painel), a tela parte das tags; sem tags do modelo atual, das três do padrão.

**Na VM própria do cliente** não há pilha: o usuário IAM de leitura tem as mesmas duas políticas, com a mesma
divisão por autorização (`packages/shared/src/read-keys.ts`; um teste confere as ações contra o
`verax-control-reader.policy.json`), e as mesmas duas tags, lidas com `iam:GetUser`. A escolha gravada vale igual
(as políticas mostradas saem com ela).

### Modelo de dados

Tudo de acréscimo (seis migrations, `20261124120000_aws_onboarding` a `20261124170000_cloudwatch_ownership_applied_seq`):
nenhuma coluna existente muda, e os buckets do cadastro continuam valendo como antes.

| Onde                       | O quê                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CloudAccount`             | `awsConnectRequestedAt` (o "Conectar"; com o mesmo horário do `checkRequestedAt`, é a janela de 60 min), `awsChosenCapabilities` (a escolha do cliente), `awsTemplateVersion`, `awsCapabilities` e `awsCapabilitiesCheckedAt` (as tags do papel e quando foram lidas) e `awsDiscoveredRegions`. Só na conta AWS (CHECK)                                |
| `AwsDiscoveryRun`          | Uma linha por execução da descoberta: o gatilho (`connect`, `manual` ou `scheduled`), o estado (`pending`, `running`, `succeeded`, `partial` ou `failed`), as regiões lidas, o que ficou de fora (`serviço × região × código`, até 200) e o retrato da infraestrutura em números                                                                       |
| `AwsSource`                | Uma linha por conta, tipo, região (ou `global`) e recurso: o que a descoberta sabe dela (`details`: só nomes e configuração), a disponibilidade, a permissão da última sondagem, as notas, a autorização (quem, quando, a revogação), `collectFrom`, o estado com o motivo e a saúde da coleta. Única por `[cloudAccountId, kind, region, resourceId]` |
| `CloudWatchAlertOwnership` | Uma linha por nó, do sistema (sem `tenantId` e sem chave estrangeira): a prova do dono dos alertas do CloudWatch Logs, com o último número de sequência do sinal `applied` (`appliedSeq`)                                                                                                                                                              |
| `CollectorCursor`          | O agendamento da descoberta diária (fluxo `aws_discovery`) e o cursor de cada fonte de achados (`aws_findings_guardduty`, `aws_findings_security_hub`, `aws_findings_inspector` e `aws_findings_aa_<resumo>`)                                                                                                                                          |

`AwsDiscoveryRun` e `AwsSource` têm `tenantId`, entram no escopo do cliente e têm chave estrangeira composta com a
conta: o banco recusa a linha de um cliente na conta de outro. Os CHECKs repetem os valores do contrato
(`packages/shared/src/aws-onboarding.ts`), e um teste confere que os dois continuam iguais. Os buckets do cadastro
anterior (`cloudtrailBucket`, `guarddutyBucket` e `wafBucket`) viraram linhas `origin = legacy`, já autorizadas, com a
coleta a partir do `ingestFrom` da conta; quem mantém esse espelho é `aws/onboarding/legacy-sources.ts`, a cada mudança
dos buckets.

### Conectar e validar

`POST /v1/cloud-accounts/:id/aws/connect` (`cloud_accounts:write`, 202) grava o `awsConnectRequestedAt` e o pedido de
verificação com o mesmo horário, e volta a conexão para "aguardando". O corpo é opcional e estrito
(`awsConnectSchema`): com `capabilities`, a escolha do cliente é gravada junto, também no pedido ainda pendente e sem
renovar a janela (o cliente mudou as caixas enquanto esperava a pilha); sem ele, a escolha gravada fica. Um "Conectar"
ainda pendente não é renovado: clicar de novo não adia o fim da janela. O `POST …/aws/verify` de sempre aceita o mesmo
corpo.

**A escolha do pedido é a verdade, e o arquivo só sai com a escolha confirmada.** O que o cliente recebe (o arquivo
da pilha, o comando da CLI) tem de ser o que ficou registrado como a escolha dele. Dos dois lados:

- **Na API:** o "Conectar" e o "Verificar" prendem a linha da conta (`lockAwsAccountRow`, `FOR NO KEY UPDATE`) antes
  de ler o pedido pendente e a escolha gravada, e gravam a escolha do pedido como veio, na ordem do catálogo, sem
  comparar com uma leitura de antes. Dois pedidos quase juntos rodam um depois do outro e terminam com a escolha do
  último a ser gravado, nunca com uma mistura; o mesmo pedido de novo não muda nada; a resposta de cada um traz o que
  ficou gravado depois dele; e o antes e o depois da trilha só mostram mudança quando o valor mudou. É a linha da
  conta, e não o lock das fontes (`lockAwsOnboarding`): a tarefa `aws-check` grava a linha e só depois toma aquele
  lock para pedir a descoberta, e um pedido que o tomasse antes de gravar a linha travaria com ela.
- **No painel** (`features/admin/aws-choice.ts`): as gravações da escolha saem uma de cada vez. Com uma no caminho,
  marcar e desmarcar só muda as caixas; quando ela termina, a seguinte leva a escolha de agora, se não for a que a API
  acabou de confirmar. O arquivo e o comando saem sempre da escolha confirmada: no "Conectar com AWS", o arquivo é
  baixado depois da resposta; na espera pela pilha, "Baixar o arquivo de novo" fica desligado e o comando some
  enquanto a escolha das caixas não é a gravada ("Salvando a escolha…"). Se a gravação falha, as caixas ficam como o
  cliente as deixou, marcadas como não salvas, com "Tentar de novo"; nada sai da tela até gravar. As caixas nunca
  voltam sozinhas para a escolha anterior: isso poderia religar uma autorização que o cliente acabou de desligar.

Nesse pedido, a tarefa `aws-check` tem uma janela de 60 min em que a entrada recusada e o token recusado só dizem que
o papel ainda não existe (a pilha está sendo criada; o nó não vê a pilha, só sabe que ainda não entrou): o pedido fica
pendente, com tentativas a 20 s, 40 s e depois a cada 60 s. Fechada a janela sem o papel, o erro gravado é
`authorization_timeout` ("tentar de novo" abre outra janela). Um erro que não é a falta do papel (outra conta, um
bucket negado) é gravado na hora; o "Verificar" comum segue com a janela de 10 min.

Depois de uma conferência sem erro, no pedido e uma vez por dia, a tarefa lê as tags do papel (`iam:GetRole` no
próprio papel; na VM própria, `iam:GetUser` no usuário de leitura; `aws/reader-tags.ts`): a versão do template e as
capacidades. Sem tags, é o template v1, só com a descoberta. Na primeira entrada, no "Conectar" e quando as tags
mudam, ela pede a descoberta da conta. A entrada no papel, a conferência da identidade e a leitura dos buckets do
cadastro continuam as da seção "Por que papel sem chave" (passo "Conferir").

### Descoberta: cobertura e trava de só leitura

Tarefa `aws-discovery` do worker (`apps/api/src/aws/discovery/`): a cada 30 s, sob concessão no banco, executa os
pedidos pendentes (do "Conectar", do painel e um por dia por conta, pelo `CollectorCursor` do fluxo `aws_discovery`,
com até 1 h de sorteio). No máximo uma execução pendente ou em curso por conta; a manual, no máximo uma a cada 5 min
(429 `DISCOVERY_RATE_LIMITED`).

**As tags primeiro.** Toda execução começa lendo as tags do papel, e são elas que valem até o fim, não as gravadas na
conta: quem atualizou a pilha e pediu a descoberta vê as fontes liberadas na hora. As tags vão para a conta junto com
o resultado (a mudança entra na trilha, `aws_template`). A leitura recusada é o template v1; se a recusa for de uma
sessão que deixou de valer, nada mais é lido, a execução falha e a conta fica como está. Com a leitura sem resposta
(uma falha passageira), valem as gravadas, e a falha fica no registro da execução (`iam × global × código`).

**O que é lido.** As regiões habilitadas da conta (`ec2:DescribeRegions`, até 64) e, em cada uma, 4 regiões por vez,
com no máximo 8 chamadas simultâneas e 15 s por chamada:

| O quê                 | Chamadas                                                                                                 | O que vira                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trilhas do CloudTrail | `DescribeTrails`, `GetTrailStatus`, `GetEventSelectors`                                                  | Fonte `cloudtrail`: o bucket, o prefixo, a chave KMS, se é de organização, se é de todas as regiões, se está gravando e se grava os eventos de gerenciamento                      |
| VPC Flow Logs         | `DescribeFlowLogs` (até 500 por região)                                                                  | Fonte `vpc_flow_logs`: o destino (S3, CloudWatch Logs ou Firehose), o formato (o padrão de 14 campos, ou um formato próprio), o arquivo (texto ou Parquet) e as partições do Hive |
| WAF                   | `ListWebACLs` (as regionais em cada região; as do CloudFront, em us-east-1), `ListLoggingConfigurations` | Uma fonte `waf` por Web ACL com log no S3; sem log, "sem destino"; no Firehose, "destino não lido"; no CloudWatch Logs, o grupo é oferecido                                       |
| GuardDuty             | `ListDetectors`, `GetDetector`, `ListPublishingDestinations`, `DescribePublishingDestination`            | Fonte `guardduty` (a API, a recomendada) e, com export para o S3, `guardduty_export` (marcada "coberta pela API")                                                                 |
| Security Hub          | `DescribeHub`                                                                                            | Fonte `security_hub`, ou "serviço desligado", com o aviso de custo                                                                                                                |
| Inspector             | `BatchGetAccountStatus`                                                                                  | Fonte `inspector`, idem                                                                                                                                                           |
| Access Analyzer       | `ListAnalyzers` (até 50 por região)                                                                      | Uma fonte `access_analyzer` por analisador                                                                                                                                        |
| CloudWatch Logs       | `DescribeLogGroups` (até 500 por região), `ListTagsForResource`                                          | Uma fonte `cloudwatch_log_group` por grupo: o nome, o tamanho guardado, a retenção, a categoria (pelo nome) e se tem a tag de leitura. Nenhum evento                              |
| Config                | `DescribeConfigurationRecorders`, `DescribeConfigurationRecorderStatus`, `DescribeDeliveryChannels`      | Fonte `config`, descoberta e ainda não coletada                                                                                                                                   |
| Load balancers        | `DescribeLoadBalancers` (até 100 por região), `DescribeLoadBalancerAttributes`                           | Fonte `elb_logs` (o log de acesso): ver "Logs de acesso do ALB"                                                                                                                   |
| Infraestrutura        | Os coletores do inventário (instâncias, security groups, usuários IAM, buckets), `DescribeVpcs` e o RDS  | Só o retrato em números da tela (`AwsDiscoveryRun.summary`); os detalhes ficam em Ativos                                                                                          |

**Parcial é um resultado válido.** Cada leitura é isolada por serviço e região: a permissão negada, a região que
recusa a sessão, o limite de requisições e o tempo esgotado viram um registro (`serviço × região × código`, só o nome
do erro, nunca a mensagem), e a execução termina `partial`. A tela mostra o que ficou de fora, e uma leitura recusada
aparece como "não lido", nunca como zero.

**Permissão de cada fonte, sondada.** Depois da leitura, cada fonte é sondada com a chamada mais barata que prova a
leitura: no S3, a listagem do prefixo exato (`MaxKeys = 1`) e 1 byte de um objeto (o que prova a chave KMS); nas APIs,
uma listagem de 1 item; no grupo de logs, a tag e uma listagem de 1 stream. O resultado fica na fonte, com a ação do
IAM que faltou ou o motivo: `capability_off` (a autorização do tipo desligada na pilha), `tag_missing`, `kms_denied`,
`bucket_denied`, `bucket_missing`, `outside_awslogs_prefix` ou `probe_failed`.

**Regiões.** As regiões com recurso ou fonte vão para `awsDiscoveredRegions` e, na conta cadastrada pelo painel,
entram nas monitoradas (que só ganham regiões, nunca perdem).

**A trava de só leitura** (`discovery/read-only.ts`): os clientes do SDK que a descoberta, as sondagens, os coletores
de achados e a conferência da fonte parada usam só aceitam comandos cujo nome começa com `Describe`, `Get`, `List` ou
`BatchGet`. Qualquer outro é recusado antes de sair para a rede, com uma exceção que só leva o nome do comando. É a
segunda linha de defesa (a primeira é a política do papel, com as negações explícitas): protege de um erro nosso, como
um comando de escrita num coletor novo. Um teste confere cada chamada da descoberta e dos coletores contra a lista de
ações que a política do papel concede.

**O que a descoberta não cobre:** os tipos fora da tabela (logs do CloudFront e de acesso do S3, Route 53, Network
Firewall, logs do RDS e do EKS) só aparecem quando gravam num grupo do CloudWatch Logs, como um grupo a etiquetar; e
os tetos por região acima (o que passar deles fica de fora, com o registro `Truncated`).

### Fontes e autorização

Os tipos de fonte: `cloudtrail`, `vpc_flow_logs`, `waf` e `guardduty_export` (S3); `guardduty`, `security_hub`,
`inspector` e `access_analyzer` (API); `cloudwatch_log_group` (CloudWatch Logs, sensível). Descobertos e ainda não
coletados: `config` e, no nó sem os ataques web (o padrão), `elb_logs`. Quem lê cada tipo é o `collector` dele
(`AWS_SOURCE_KIND_INFO`): o Wazuh do nó ou uma tarefa do worker; o método não basta, porque o `elb_logs` também é de
bucket. Cada linha guarda se dá para ler de onde está (`availability`: disponível, serviço
desligado, sem destino, destino ou formato que o nó não lê), a permissão da última sondagem, as notas de custo e de
pré-requisito, a autorização (quem, quando) e a saúde da coleta (gravada pelo coletor dela).

Casos tratados na descoberta: a trilha de organização (o ID da organização sai dos nomes de `AWSLogs/` no bucket), o
prefixo antes de `AWSLogs/` (fora do que o papel lê, a não ser num bucket do cadastro), os flow logs com partições do
Hive, em Parquet ou com campos fora do padrão (formato não lido), os que gravam no CloudWatch Logs (o grupo é
oferecido), o WAF no Firehose (destino não lido) e no S3 (uma fonte por Web ACL).

**Estados da fonte.** `available`, `needs_permission` ou `unavailable` antes da autorização; depois, `authorized`
(aguardando o coletor), `configuring`, `waiting_events`, `collecting`, `stalled`, `permission_error` e
`ingestion_error`; `source_missing` (a fonte autorizada sumiu da conta) e `revoked`. O motivo vai em `stateCode`.

**Autorizar (`POST …/aws/sources/authorize`).** Só vale para a fonte disponível, de tipo coletado, com a permissão
conferida e que não repete um bucket do cadastro. Tudo ou nada: uma fonte recusada recusa o pedido, com o código do
motivo. As fontes sensíveis (os grupos do CloudWatch Logs, que podem trazer dado de aplicação) só entram citadas de
novo, uma a uma, em `sensitiveSourceIds`: não existe "autorizar tudo" para elas. A coleta começa no dia da autorização
(`collectFrom`), sem histórico.

**Desautorizar (`POST …/aws/sources/:sourceId/revoke`).** A fonte sai da coleta na execução seguinte do coletor dela,
e a linha fica, com quem tinha autorizado. Vale também com a conta desativada: tirar uma fonte nunca é bloqueado.
Nada é apagado na origem.

**A descoberta nunca apaga nem muda em silêncio uma fonte autorizada:** a que some (num escopo que a execução leu por
inteiro) fica `source_missing`; a que perde a permissão, `permission_error`; a revogada fica revogada. As linhas dos
buckets do cadastro (`origin = legacy`) não mudam por estas rotas (409 `SOURCE_LEGACY`): mudam no cadastro.

### "Tentar de novo" numa fonte

Em `POST …/aws/sources/:sourceId/retry`, a API só grava o pedido; quem responde é a
tarefa `aws-discovery`, na execução seguinte. O cliente pede a sondagem depois de mudar algo na conta dele, então a
resposta sai do que a AWS diz agora, e nunca do que a última descoberta gravou: (1) as tags do papel são lidas de novo
(`aws/reader-tags.ts`, a mesma leitura da conferência da conexão) e gravadas na conta, e a capacidade ligada numa
atualização da pilha vale na hora (a mudança entra na trilha e pede uma descoberta, para as outras fontes); (2) a
própria fonte é lida de novo (`discovery/source-reading.ts`, com as mesmas leituras e a mesma classificação da
descoberta, só do tipo e da região dela): o destino, o prefixo, o formato, o estado do serviço e, no grupo de logs, a
tag (`ListTagsForResource`); (3) só então a permissão é sondada, e o resultado é gravado com as regras da descoberta
para uma fonte conhecida. No grupo de logs, a leitura das tags negada é a permissão que falta
(`logs:ListTagsForResource`), e não a tag. A fonte que não está mais lá (apagada, desligada, ou com o log num destino
que vira outro tipo de fonte) só desfaz o pedido e pede uma descoberta da conta, que é quem tira ou marca a linha. A
conta que não entra no papel, a leitura recusada e a sondagem que não termina só desfazem o pedido. Essa descoberta é
pedida pelo sistema e não entra no limite de 5 min da manual; o que a contém é o resto: no máximo uma execução pendente
ou em curso por conta, e no máximo um "Tentar de novo" a cada 30 s por fonte (429 `SOURCE_RETRY_RATE_LIMITED`; o
horário do último pedido fica em `lastProbeRequestAt`, que a resposta não desfaz).

### Estado da conta e conferências

`GET …/aws/onboarding` devolve o estado da conta, derivado pela API a cada leitura (`aws/onboarding/onboarding-state.ts`,
uma função pura), nunca guardado nem escrito à mão:

| Estado                   | Quando                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `not_started`            | Ninguém pediu a conexão (ou ela recomeçou: outra lista de buckets, a conta reativada), ou a conta inativa |
| `awaiting_authorization` | Há um pedido de verificação pendente; com a janela do "Conectar", `connect.waitingUntil` diz até quando   |
| `authorization_timeout`  | A janela do "Conectar" fechou sem o papel                                                                 |
| `disconnected`           | A AWS recusa a entrada no papel (removido, alterado), ou o nó não consegue conferir a conexão             |
| `authenticated`          | Entrou no papel, e nenhuma descoberta entrou na conta ainda (ou a primeira falhou inteira)                |
| `discovering`            | A primeira descoberta está pendente ou em curso                                                           |
| `awaiting_sources`       | A descoberta terminou, e nenhuma fonte está autorizada                                                    |
| `configuring`            | Há fonte autorizada, e nenhuma coleta começou ainda                                                       |
| `collecting`             | **Toda** fonte autorizada está coletando                                                                  |
| `partial`                | Só parte delas                                                                                            |
| `permission_error`       | Uma fonte autorizada (ou um bucket do cadastro) não pode ser lida por falta de permissão                  |
| `ingestion_failure`      | A coleta de uma fonte autorizada falha, ou o nó não aplica a configuração da coleta                       |

A primeira regra que vale ganha: a conta inativa; o fim da janela do "Conectar"; o pedido pendente; a conexão
recusada; a falta da primeira descoberta; nenhuma fonte autorizada; e, com fontes autorizadas, a falta de permissão
antes da falha de ingestão, e as duas antes de "configurando", "coletando" e "parcial". Com o papel removido, a conta
fica `disconnected`, e as fontes e as autorizações continuam lá.

Junto vão nove conferências, cada uma com a situação (`ok`, `pending`, `failed` ou `skipped`), o código do motivo e o
horário: `assume_role`, `identity`, `template` e `discovery`, e, das fontes autorizadas, `permission`,
`collector_config`, `events`, `last_sync` e `lag`. Estas cinco citam, em `sourceIds`, as fontes que as deixam
pendentes ou com falha (todas, não só a primeira), para o painel apontar a linha de cada uma. O campo não vem quando o
motivo não é de uma fonte: o aviso da coleta do nó inteiro (`aws_token_stale`, `wazuh_apply_failed`) e o bucket do
cadastro negado sem a linha dele na lista.

A resposta também diz: `connect` (quando o "Conectar" foi pedido, até quando o nó espera o papel e a escolha gravada
do cliente), `template` (a versão e as capacidades lidas das tags, e se o modelo é anterior), a descoberta mais
recente, o retrato da infraestrutura, as fontes (até 2.000) e `discoveryAvailable`: `false` na célula compartilhada,
onde a descoberta e o "Tentar de novo" de uma fonte responderiam 409 `DISCOVERY_UNAVAILABLE`. O schema é estrito
(`packages/shared/src/aws-onboarding.ts`), e toda escrita do onboarding responde com o mesmo corpo, já atualizado.

### O que o painel mostra

A tela (Contas cloud → AWS, `apps/web/src/features/admin/aws-*.tsx`) só mostra o que a API mandou, relido sozinho
enquanto uma mudança é esperada (a cada 5 s na espera pelo papel, na descoberta e na configuração; a cada 60 s com
fontes coletando): ela nunca adianta um passo. A API manda só códigos, e cada código tem o texto dele, com o que fazer
(`aws-onboarding-labels.ts`, tipado contra o contrato: um código novo não compila sem o texto); o que a tela não
conhece aparece como "Tipo do erro".

- **Antes de conectar:** o que a integração faz, as três autorizações com o que cada uma permite e não permite, o
  botão "Conectar com AWS" e a alternativa manual, recolhida. Sem um valor do nó, não sai arquivo quebrado: a tela
  diz o que pedir à Verax.
- **Depois do clique:** os passos pelo estado da API, o aviso de que o Verax não vê a pilha enquanto ela é criada, o
  tempo que falta da janela e "Baixar o arquivo de novo", com a escolha gravada (desligado enquanto uma mudança das
  caixas ainda não foi gravada).
- **Conferências:** as nove, com o "tentar de novo" de cada uma e, nas das fontes, um link para a linha de cada fonte
  citada em "Fontes autorizadas", que fica em destaque (um contorno e a marca "Apontada pela conferência").
- **Pilha na AWS:** a versão do modelo e as autorizações lidas das tags, o aviso quando elas não são a escolha do
  cliente, e "Atualize a pilha" (o arquivo preenchido, os passos e o valor de cada parâmetro).
- **O que encontramos:** o retrato da infraestrutura e, na descoberta parcial, o que ficou de fora e por quê. Onde
  `discoveryAvailable` é `false`, "Descobrir de novo", "Rodar a descoberta" e o "Verificar de novo" de uma fonte não
  aparecem.
- **Fontes de log:** as disponíveis, as que precisam de permissão (com a correção exata de cada motivo, como o
  comando da tag do grupo de logs), as não habilitadas (com o aviso de custo: ligar é do cliente), as que gravam onde
  o nó não lê e as ainda não coletadas. Os grupos do CloudWatch Logs têm lista própria, com busca, seleção um a um e
  confirmação explícita. Antes de autorizar flow logs e grupos de logs, o aviso de volume.
- **Fontes autorizadas:** o estado com o motivo, o último evento, a última leitura, o atraso, o volume das últimas
  24 h, "Tentar de novo" e "Revogar". Na linha dos flow logs, que só o tráfego recusado é lido e que as detecções vêm
  de duas regras; na dos grupos de logs, que os alertas aparecem com pelo menos 10 min de atraso e só são atribuídos
  com a prova do dono.

### Coleta pelo Wazuh

As fontes de bucket e do CloudWatch Logs são lidas pelo manager do Wazuh do nó (`apps/api/src/aws/wazuh-sources.ts`
e `infra/wazuh/scripts/render-manager-config.py`). A lista que o CLI `wazuh-sources` imprime e a geração que a tarefa
`wazuh-config` grava saem das fontes com a autorização valendo e método `s3` ou `cloudwatch`. O formato é o 2
(`{"version": 2, "accounts": [{accountId, region, s3: [...], logGroups: [...]}]}`); o gerador recusa uma versão que não
conhece e ainda aceita a lista simples de antes (a que uma API de versão anterior imprime durante uma atualização).

- **Buckets do cadastro anterior** (`"legacy": true`): a configuração do manager é, byte a byte, a de antes (um teste
  compara a saída do gerador com a do gerador anterior). Entram sempre, como entravam.
- **Fontes descobertas:** cada leitura é exata, sem o módulo listar o bucket à procura de contas e regiões. A trilha, os
  flow logs e o export do GuardDuty levam `aws_account_id` e `regions` (a trilha de organização, também
  `aws_organization_id`; a de todas as regiões, as regiões habilitadas na conta pela última descoberta, que incluem
  `us-east-1`, onde ficam os eventos dos serviços globais). O WAF leva o caminho de uma Web ACL
  (`AWSLogs/<conta>/WAFLogs/<região ou cloudfront>/<nome>/`), montado no gerador dos campos conferidos (esse caminho
  foi derivado do código do módulo, e não conferido com objetos de verdade). Os grupos do CloudWatch Logs viram um
  serviço `cloudwatchlogs` por conta, região e dia de início. Cada fonte começa no dia da própria autorização
  (`only_logs_after`), sem histórico.
- **Nada é apagado na origem:** `remove_from_bucket no` em todo bucket e `remove_log_streams no` em todo serviço, sempre
  escritos (e o papel nega qualquer escrita nos logs).
- **O que entra no analysisd:** os flow logs com o tráfego aceito descartado no módulo (`discard_regex` em `ACCEPT`),
  como o WAF já descarta o liberado: o aceito é a maior parte do volume e contaria no volume contratado. A lista e o
  gerador aceitam `"traffic": "all"` por fonte; a escolha no painel ainda não existe. Nos grupos de logs, a linha em
  JSON que se diz evento do próprio módulo (`"integration": "aws"`) é descartada: no analysisd ela seria lida como um
  evento de bucket, e quem escreve no grupo forjaria um alerta do CloudTrail ou do GuardDuty.
- **Tudo conferido duas vezes:** a API só põe na lista o que passa nos formatos fechados (bucket, região, ID da
  organização, nome de Web ACL, prefixo e nome de grupo só com letras, números, ponto, hífen, sublinhado e barra), e o
  gerador confere de novo, com escape de XML. Um valor fora disso no gerador recusa a lista inteira, e a configuração
  do manager fica como está. A fonte que a API não consegue ler como está fica de fora da lista, com o motivo no
  estado dela (`ingestion_error`): `unsupported_name` (o grupo com `#`, espaço ou vírgula: o módulo recusa o
  argumento inteiro), `region_unsupported` (região fora das que o módulo 4.14.9 aceita), `organization_id_unknown`,
  `custom_prefix_unsupported` (prefixo antes de `AWSLogs/` fora de um bucket do cadastro), `source_limit` (os tetos
  por conta: 200 entradas de bucket e 50 grupos) e `log_group_name_conflict`.
- **Leituras repetidas** saem uma vez só: duas fontes com o mesmo tipo, bucket, prefixo, conta e região (dois flow logs
  da região no mesmo bucket) são uma leitura, desde a data mais antiga; a que o cadastro anterior já faz não sai de
  novo.
- **A fonte que perde a permissão ou some** (`permission_error` e `source_missing`, que a descoberta grava) sai da
  lista até voltar, e a revogada sai de vez. Uma mudança da lista só reinicia o manager quando a configuração dele
  muda.
- **Os tipos do worker não existem para o Wazuh:** a busca da lista e o plano só conhecem os tipos dele
  (`AWS_WAZUH_SOURCE_KINDS`). Com qualquer número de balanceadores autorizados, a lista é, byte a byte, a de sem nenhum (e
  a lista é a única entrada do gerador), a conta que só tem deles não entra, e a saúde, a conferência de fonte parada e o
  aviso das contas nunca tocam nas linhas deles (`wazuh-isolation.test.ts` e `wazuh-web-logs-isolation.test.ts`).

### Marcadores da leitura (sinal `progress`)

O worker não fala com o manager, e um alerta no indexer só existe para o
evento que casou com uma regra. A prova de que o Wazuh leu uma fonte são os marcadores que o próprio módulo guarda em
SQLite (`s3_cloudtrail.db`: uma tabela por tipo de bucket, uma linha por objeto lido; `aws_services.db`: os streams de
cada grupo). A cada 5 min, o host (`infra/node/bin/wazuh-progress.sh`, pelo `verax-wazuh-progress.timer`) roda no
contêiner do manager, com o Python do Wazuh e pela entrada padrão, o `infra/wazuh/scripts/export-aws-progress.py`: ele
abre os bancos só para leitura (`mode=ro`), tolera o banco que não existe, o travado pelo módulo e a tabela ausente, e
imprime um documento de uma linha (por tabela, `bucket_path`, conta e região: o último objeto lido, quando foi lido e o
dia dele; por região e grupo: o horário do último evento e os streams), com teto de linhas e sem conteúdo de log. O
host limita o tamanho (4 MiB), confere o começo e troca o arquivo `progress` de uma vez; o worker confere cada campo
por schema e deixa de usar o sinal com mais de 20 min.

### Saúde de cada fonte lida pelo Wazuh

Gravada pela tarefa `wazuh-config`, em `apps/api/src/aws/wazuh-source-health.ts`:

- `authorized` → `configuring` (`awaiting_apply`: na lista, e o host ainda não aplicou a lista de agora) →
  `waiting_events` (aplicada, sem nada lido desde o início da coleta) → `collecting` (o módulo leu um objeto ou um
  evento dela).
- `lastIngestedAt` é quando o módulo leu o último objeto; `lastEventAt`, o horário do nome do objeto (ou o dia dele) ou
  do último evento do grupo; `lagSeconds`, a diferença entre os dois, medida no último objeto lido. Não é "há quanto
  tempo nada chega": uma conta quieta não fica atrasada. `lastSyncAt` é a última vez que o nó confirmou a fonte na
  configuração que o manager roda, com o token em dia e o marcador dela lido (o módulo passa por todas as fontes a
  cada 5 min e não registra cada passagem). No CloudWatch Logs, o módulo não guarda quando leu: vale o momento em que o
  nó viu o marcador andar.
- `stalled` (`no_progress`) só na trilha e nos flow logs: sem leitura há mais de 2 horas **e** com objeto novo, de mais
  de 30 min, na pasta da conta (uma listagem de `MaxKeys = 1` por pasta de dia, a partir do último objeto lido, com a
  sessão de leitura da conta e a trava de só leitura; no máximo uma por fonte a cada 30 min). Sem objeto novo, a
  conta só está quieta. As outras fontes nunca ficam paradas por silêncio.
- `ingestion_error`: a fonte ficou de fora da lista (o motivo é o código); o token do nó parou (`aws_token_stale`,
  todas as fontes); ou a lista de agora não foi aplicada (`wazuh_apply_failed`) e a fonte ainda não tinha entrado no
  manager. A que o manager já lia segue pelo marcador dela.
- A gravação é pelo escopo do cliente da fonte, só se ela ainda estiver como foi lida. A trilha de auditoria
  (`cloud_account.aws_source_collection`, ator sistema) só recebe a primeira coleta de cada fonte e a entrada e a saída
  de um erro ou de uma parada; a espera e os horários de cada leitura não. Na célula, a tarefa não grava a saúde.

### Regras de Flow Logs

Em `infra/wazuh/config/manager/rules/verax_aws_flow_rules.xml`, faixa 100400 a 100499. O Wazuh só classifica cada registro dos flow logs (80401 no aceito, nível 3; 80402 no rejeitado, nível 4), abaixo do
corte dos alertas do nó (`log_alert_level` 5), e não traz correlação para eles. As duas regras locais abaixo contam os
registros rejeitados e são o que vira alerta e achado; as do Wazuh ficam como estão. **Os limites são estes, e é aqui
que o responsável os ajusta** (o `infra/wazuh/scripts/test-rules.sh` confere cada número no `wazuh-logtest` da imagem
do nó, e quem muda um limite muda o teste, o arquivo das regras, o README do Wazuh e esta tabela):

| Regra  | Nível     | O que conta                                                                                                 | Limite      | Ignore | MITRE |
| ------ | --------- | ----------------------------------------------------------------------------------------------------------- | ----------- | ------ | ----- |
| 100400 | 8 (média) | Varredura: registros rejeitados da mesma conta e do mesmo endereço de origem, para qualquer destino e porta | 40 em 120 s | 60 s   | T1046 |
| 100401 | 10 (alta) | Insistência em porta de administração remota: os mesmos, para o mesmo destino e a mesma porta, 22 ou 3389   | 15 em 120 s | 60 s   | T1110 |

- **Cada registro é um fluxo**, e não um pacote: a AWS soma numa linha os pacotes do mesmo fluxo (origem, destino,
  portas e protocolo) numa interface e numa janela de captura. 15 registros para a porta 22 são 15 conexões diferentes.
- **Os 120 s contam a chegada ao analysisd**, e não o horário do tráfego: o módulo lê os objetos novos do bucket a cada
  5 min e entrega os registros de cada objeto de uma vez. Na prática, o limite vale para o que uma leitura traz (uns 5 a
  10 min de tráfego).
- **Só o tráfego rejeitado conta** (a mãe das duas é a 80402): o aceito casa com a 80401 e, no nó, nem chega ao
  analysisd.
- **Cada regra só soma registros da mesma conta** (`aws.aws_account_id`), como as correlações por conta.
- **A passada pela porta 22 de várias máquinas não é insistência** (o destino tem de ser o mesmo): conta para a
  varredura. As portas 22 e 3389 não somam entre si, e os registros de uma insistência não somam para a varredura (o
  Wazuh não conta de novo o registro que já entrou num alerta de nível igual ou maior).
- **O ignore é da regra, e não do endereço** (é assim no Wazuh): nos 60 s depois de um alerta, uma segunda origem que
  passe do limite também fica sem alerta dessa regra. Como uma leitura do bucket chega em segundos, o efeito é no máximo
  um alerta de cada regra por leitura (a cada 5 min); a origem que continua volta a contar na leitura seguinte. É o
  preço de uma rajada virar um alerta só. Sem o ignore, a mesma rajada daria um alerta a cada 40 (ou 15) registros, e o
  achado continuaria um só.

### Alertas das fontes de bucket

Os flow logs entram no sync da AWS (`aws.source = vpc`): o dono é decidido pelo bucket
autorizado e pela conta da pasta lida (o `account_id` do registro é o dono da interface, que numa VPC compartilhada é
outra conta). O alerta é sempre de uma das duas correlações, e o evento que vem nele é só o registro que fechou a
contagem; por isso o achado não é do registro:

- **A chave do achado** é a conta, o endereço de origem e a regra (`wazuh/<conta>/vpc:<endereço>:<regra>`): toda
  rajada do mesmo endereço na mesma conta é o mesmo achado. Relida (o `--reparse`, um snapshot restaurado), a rajada
  pode fechar noutro registro, e ainda assim cai na mesma chave.
- **A versão** é a hora cheia (UTC) do início da janela do registro que fechou a contagem (o horário do tráfego, e não
  o do alerta). A rajada do mesmo endereço em outra hora segue a regra de reincidência do GuardDuty (decisão de
  04/11/2026): com o achado ainda não triado, só a versão avança (`lastSeenAt`); com ele já triado, vira um achado
  novo, ligado ao original (`...:<regra>@<hora>`). É no máximo um achado em aberto por regra, conta e endereço, e uma
  rajada da mesma hora já conhecida (ou de antes) não muda nada.
- **O título** é o fixo do dicionário ("Possível varredura de rede vinda do mesmo endereço" e "Insistência em porta de
  administração remota vinda do mesmo endereço"), a severidade vem do nível (média e alta), o MITRE vem da regra, o IP
  do achado é o endereço de origem, e o recurso é a interface do registro que fechou a contagem. O destino e a porta
  ficam no evento bruto do detalhe.
- O alerta de um registro sozinho só existiria com o corte do nó abaixo de 5; se chegar, a chave dele é a identidade
  do registro (a interface, a janela, a origem, o destino, o protocolo e a ação).

O cadastro de buckets do sync soma os das fontes de bucket autorizadas (revogada a fonte, o bucket dela deixa de ser
origem conhecida). Nos alertas de bucket, o dono sai do próprio evento: o bucket que o módulo leu e a conta da pasta
(ou a do conteúdo, no GuardDuty e no WAF), conferidos com o cadastro na hora da leitura. Uma mudança no cadastro só
tira o dono de um alerta (a fonte revogada vira `unknown_source`; a pasta da conta de outro cliente, `source_mismatch`),
e nunca o entrega a outro cliente: para isso, a conta AWS citada no evento teria de estar cadastrada para ele.

### Dono dos alertas do CloudWatch Logs

Em `apps/api/src/alerts/cloudwatch-ownership.ts`. Os eventos dos grupos de logs
têm um sync próprio (tarefa `wazuh-cloudwatch-alerts`, fora da célula; nível 7 para cima, como os agentes). O módulo
entrega a linha crua, sem conta nem grupo: nada no evento diz de quem ele é. As autorizações do momento da leitura
também não dizem: quando um de dois clientes tira a autorização, o manager segue coletando o grupo dele até a
configuração nova ser aplicada, e o que sobrou viraria dono de eventos do outro. **A regra: o alerta só é do cliente T,
na conta A, se a configuração aplicada no manager só teve grupos de logs dessa conta desse cliente (ou nenhum) em todo o
intervalo em que o alerta pode ter sido coletado. Na dúvida, não é de ninguém.** São duas condições:

1. pelas autorizações de agora, um único cliente do nó tem grupo autorizado, numa única conta. Senão, a fila sem dono:
   `ambiguous_source` com mais de um cliente, `no_account` com mais de uma conta do mesmo cliente, `unknown_source` sem
   nenhum;
2. a prova, gravada pela tarefa `wazuh-config` (a única que conhece a lista planejada e lê o sinal `applied` do host)
   numa linha do banco (`CloudWatchAlertOwnership`: o dono, a geração que o manager roda, o último número de
   sequência do sinal, `since` e a última conferência; sem `tenantId`, só o sistema a grava, e nenhuma rota a lê).
   Sem a prova, `ambiguous_source`.

A prova, a cada conferência (30 s):

- **nasce** quando o sinal `applied` diz ok para a geração da lista planejada de agora e essa lista tem grupos de logs
  de no máximo um dono. `since` é a hora dessa conferência (ou a do sinal, se for mais tarde);
- **continua**, com o mesmo `since`, enquanto cada conferência seguinte, a no máximo 5 min da anterior, mostra o manager
  numa geração conferida (a do registro ou a planejada de agora), a lista planejada com no máximo esse dono e o número
  de sequência do sinal sem salto. A geração aplicada atrás da planejada não a derruba (as duas são do mesmo dono).
  O registro sem dono (nenhuma configuração aplicada teve grupo de logs) vira do primeiro dono que aparecer, sem
  recomeçar: antes dele não havia de quem coletar. É o cliente que autoriza o primeiro grupo num nó já no ar, e os
  alertas da primeira leitura já são dele;
- **cai**, e só volta nascendo de novo, com outro `since`: no instante em que a lista **planejada** passa a ter grupos
  de mais de um dono (antes de ela chegar ao manager, e antes de a geração nova ir para o host); quando o dono
  planejado é outro (um cliente sai e outro entra depois: nada do que foi coletado para o primeiro passa para o
  segundo); quando o sinal some (o nó reiniciou), sai do formato, vem sem o número de sequência ou cita uma geração
  que a tarefa não conferiu, com ok ou com erro (o host aplicou uma lista que o worker não planejou); quando o número
  de sequência do sinal salta (abaixo); e quando a tarefa fica mais de 5 min sem conferir (o worker parado não viu o
  que o host aplicou; o timer do host aplica a cada 15 min).

**O número de sequência do sinal (`seq`).** O sinal `applied` só guarda a última tentativa do host. Duas trocas da
configuração do manager entre duas conferências (uma lista que o worker nunca planejou, aplicada pelo timer do host,
e logo depois a lista conferida) apareceriam como uma só, com a geração conferida, e a prova continuaria de pé sobre
um intervalo em que o manager rodou outra coisa. Por isso o host conta as trocas:

- **No host (`infra/node/bin/wazuh-apply.sh`):** um contador em `/var/lib/verax/wazuh-apply/seq`, no disco do nó (o
  `/run`, onde ficam os sinais, some no reboot), só de root. Ele aumenta **antes** de cada troca do que o manager
  roda: o reinício com a configuração nova, o reinício da volta à anterior (a tentativa que derrubou o manager conta
  duas) e a configuração deixada para a próxima partida dele, quando ele está parado. Sem troca (a mesma
  configuração, o CLI ou o gerador com erro, a configuração que já tinha derrubado o manager e não é tentada de
  novo), o número fica. Antes de reiniciar, o script esquece o hash do que o manager rodava: se ele parar entre o
  reinício e o sinal, a execução seguinte reinicia de novo e conta outra troca. Sem o arquivo (a primeira execução,
  o contador apagado ou estragado), ele recomeça da hora do host, em segundos, acima de qualquer valor já contado
  (as trocas são muito menos que uma por segundo). O número vai em todo sinal `applied`, com ok ou com erro.
- **No worker:** o registro guarda o último número visto (`appliedSeq`). A prova só continua com **o mesmo número**
  (nada foi trocado; valem as regras de antes: ok para uma geração conferida, ou erro de uma tentativa que nem chegou
  ao manager) ou com **o número seguinte, ok e uma geração conferida** (uma troca só, para uma lista que a tarefa
  conhece). Qualquer outro salto derruba a prova: duas trocas, a tentativa que derrubou o manager e voltou à
  configuração anterior, o contador recomeçado. O número seguinte com erro também: o sinal de erro fala da última
  tentativa, e não diz qual configuração a troca contada deixou no manager. Derrubada, a prova só nasce de novo com
  a lista planejada aplicada com sucesso.
- **Durante a atualização do nó:** o sinal que o script de uma versão anterior gravou não tem o número. Ele continua
  valendo para os avisos da coleta (`wazuh_apply_failed`, a lista aplicada), e nunca como prova: o registro cai e só
  nasce com um sinal que traga o número. A linha gravada antes de a coluna existir também não vale. O pacote do nó e
  as imagens andam juntos na mesma versão, então o caso contrário (o script novo com o worker anterior, que recusa o
  campo que não conhece) dura só o intervalo entre a instalação do pacote e o reinício dos contêineres.

O sync só atribui o alerta cujo horário está **entre `since` mais 15 min e a última conferência menos 10 min**:

| Folga              | Quanto | O que cobre                                                                                                                                                                                                                                                                              |
| ------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Margem, no começo  | 15 min | O que a configuração anterior ainda pode entregar depois de trocada: o módulo lê os grupos a cada 5 min, a troca reinicia o manager e espera o healthcheck dele (até 3 min; com a volta da configuração anterior, mais 3), e o analysisd ainda esvazia a fila. 5 + 6 min, com 4 de folga |
| Espera, no fim     | 10 min | O atraso do sinal: o host só grava o `applied` depois de reiniciar o manager e esperar o healthcheck (até 3 + 3 min), e o timer dele pode aplicar uma lista que o worker ainda não planejou (uma autorização desfeita em menos de 30 s). Nesse meio tempo o manager já roda a lista nova |
| Entre conferências | 5 min  | O worker parado: sem conferir por mais que isso, a tarefa não sabe o que o host aplicou, e a prova recomeça                                                                                                                                                                              |

- **O alerta novo demais** (mais novo que a última conferência menos 10 min) não é decidido ainda: não vira achado nem
  vai para a fila, e a execução seguinte o relê. Todo achado do CloudWatch Logs aparece, então, pelo menos 10 min
  depois do alerta. Se a prova cair nesse intervalo, ele vai para a fila.
- **A primeira decisão vale.** O alerta que já está na fila sem dono nunca vira achado numa releitura, mesmo que passe
  a caber numa prova; e o que já virou achado não ganha uma linha na fila quando a sobreposição o relê sem a prova.
- **Só linha de grupo de logs:** o evento de bucket que passa do tamanho que o analysisd lê chega cortado, não é
  decodificado e fica sem `data.integration`; pelo começo do texto (o envelope do módulo, `{"integration": "aws"`), o
  sync o reconhece e o manda para a fila como inválido, em vez de atribuí-lo ao dono dos grupos. No Wazuh 4.14.9 esse
  evento não casa com regra nenhuma (conferido no `wazuh-logtest`); a conferência é para uma regra futura.
- **Os relógios:** o horário do alerta é o campo `timestamp` do documento no indexer (o relógio do manager, quando o
  analysisd gerou o alerta; o mesmo campo que ordena e pagina a leitura do sync). `since` e a última conferência são do
  relógio do worker, e `since` nunca fica antes da hora do sinal do host. No nó, os três estão na mesma máquina; a
  margem e a espera absorvem uma diferença de minutos.
- **O que isso custa:** depois de cada queda da prova (o nó reiniciado, que apaga os sinais; o worker parado por
  mais de 5 min; outro cliente com grupo de logs no nó; uma aplicação que derrubou o manager e voltou; duas
  aplicações seguidas sem a tarefa ver), os alertas dos 15 min seguintes ao renascimento vão para a fila sem dono e
  não voltam; e, enquanto uma lista nova não for aplicada com sucesso depois de uma aplicação que falhou, nenhum
  alerta de grupo de logs é atribuído. O cliente único do nó dedicado, com a prova de pé desde antes do primeiro
  grupo, não perde nada com as próprias autorizações e revogações: cada uma é uma troca só, para uma geração
  conferida.
- **O que a prova ainda supõe:** o host grava o sinal no fim de cada execução do `wazuh-apply.sh`. A execução
  interrompida depois de reiniciar o manager e antes de gravar o sinal (o processo morto no meio, o Docker recusando
  o reinício) deixa o sinal anterior no lugar até a execução seguinte (pelo timer, em até 15 min), que conta outra
  troca: o salto aparece então, e a prova cai. Nesse intervalo a tarefa ainda vê o sinal antigo, e um alerta dos
  primeiros minutos pode ser atribuído antes de o salto aparecer. É preciso, ao mesmo tempo, a interrupção e uma
  lista que o worker não planejou.

### Limites conhecidos da coleta pelo Wazuh

- **Flow logs: só duas detecções, e no máximo um alerta de cada uma por leitura** (o ignore da regra não separa os
  endereços; ver "Regras de Flow Logs"). Dois endereços que passem do limite na mesma leitura dão um alerta só; o
  outro aparece numa leitura seguinte, se continuar. Só o tráfego rejeitado é lido: a escolha de ler também o aceito
  (`"traffic": "all"`) existe na lista e no gerador, e não no painel.
- **Autorizar um Flow Log lê todos os Flow Logs daquela conta e região que gravam no mesmo bucket:** o módulo lista os
  flow logs da região (`ec2:DescribeFlowLogs`) e lê, na pasta da conta e da região naquele bucket (e prefixo), os
  objetos de cada um, e não só os do flow log autorizado. O flow log que grava em outro bucket não é lido. A fonte
  leva a nota `flow_logs_read_together`, para o painel avisar antes da autorização, e revogar um dos flow logs não
  para a leitura enquanto outro do mesmo bucket continuar autorizado.
- **Grupos do CloudWatch Logs:** o marcador do módulo é por região, grupo e stream, sem a conta: o mesmo nome na mesma
  região em duas contas do nó só é lido na primeira autorizada (a outra fica `log_group_name_conflict`). Um grupo
  negado ou apagado faz o módulo parar a leitura dos grupos seguintes da mesma conta e região até a descoberta tirar a
  fonte da lista (no máximo um dia, ou no "Tentar de novo"). O alerta não diz de que grupo veio, e por isso só é
  atribuído com a prova do dono ("Dono dos alertas do CloudWatch Logs"): o achado sai pelo menos 10 min depois do
  alerta, e os alertas dos 15 min seguintes a uma queda da prova ficam na fila sem dono.
- **Trilha de conta e de organização no mesmo bucket, para a mesma conta:** o marcador do módulo é o mesmo para as duas
  pastas, e a leitura de uma pode pular objetos da outra. Autorize só uma das duas.
- **Export do GuardDuty de várias regiões no mesmo bucket:** pelo código do módulo, o marcador do tipo `guardduty` é
  por bucket e conta, sem a região; depois da primeira passagem, só a última região em ordem alfabética continua
  avançando (vale também para o bucket do cadastro anterior). O caminho recomendado para o GuardDuty é a API (PR-C2).
- **O marcador só aparece quando o módulo termina a leitura do bucket:** numa primeira leitura longa, a fonte fica em
  "aguardando eventos" até o fim dela.

### Achados pela API

Tarefa `aws-findings` do worker, em `apps/api/src/aws/findings/`. As fontes lidas por API
(`guardduty`, `security_hub`, `inspector` e `access_analyzer`) são coletadas pelo worker, sem o Wazuh, pela mesma
sessão de leitura da conferência e da descoberta (`AwsReaderCredentials`) e pelos mesmos clientes com a trava de só
leitura. A tarefa roda a cada 5 min, sob concessão no banco (`SyncState('aws-findings')`, um worker por vez), só no nó
dedicado (na célula ela não é ligada, como a descoberta). A cada execução entram as fontes com a autorização valendo e
dentro da coleta, de conta ativa, já verificada, que entra no papel, de cliente ativo; no máximo 2 contas ao mesmo
tempo, as fontes de cada conta em sequência, e, passados 4 min, as que faltam ficam para a execução seguinte. A fonte
revogada sai na execução seguinte. Uma fonte com falha nunca para as outras.

| Fonte             | Chamadas (todas de leitura)                                                                                          | Filtro na origem                                                                                           | Página | Chave do achado                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `guardduty`       | `ListFindings` e `GetFindings` (50 IDs por chamada)                                                                  | `updatedAt` maior ou igual ao começo da janela; `service.archived = false`                                 | 50     | `wazuh/<conta>/guardduty:<id>:<regra do Wazuh>` (a mesma do caminho do bucket) |
| `security_hub`    | `GetFindings`, no máximo uma chamada a cada 350 ms por conta e região                                                | `UpdatedAt` entre o começo e o fim da janela; `RecordState = ACTIVE`; `WorkflowStatus` `NEW` ou `NOTIFIED` | 100    | `aws/<conta>/securityhub:sha256-<resumo de ProductArn e Id>`                   |
| `inspector`       | `ListFindings` (Inspector2)                                                                                          | `updatedAt` entre o começo e o fim da janela; `findingStatus = ACTIVE`                                     | 100    | `aws/<conta>/inspector:<findingArn>`                                           |
| `access_analyzer` | `ListAnalyzers`, `ListFindingsV2` por analisador autorizado e `GetFindingV2` só do acesso externo novo ou atualizado | `status = ACTIVE` (a API não filtra por data: a listagem é inteira)                                        | 100    | `aws/<conta>/access-analyzer:<região>/<analisador>/<id>`                       |

- **Cursor e janela:** cada fonte tem um cursor em `CollectorCursor` (fluxos `aws_findings_guardduty`,
  `aws_findings_security_hub` e `aws_findings_inspector`, por região; no Access Analyzer, `aws_findings_aa_<resumo>`,
  um por analisador, com o resumo do nome dele), com a posição (`cursorAt`), a próxima leitura, a última leitura sem
  erro, o tipo do último erro e as falhas seguidas. A janela vai da posição menos 10 min (a sobreposição) até agora;
  a primeira começa 24 h antes do dia da autorização (`collectFrom`), e nada mais antigo é buscado, nem depois de uma
  revogação seguida de outra autorização. Cada página é gravada antes de a continuação andar: uma execução que para no
  meio (o worker parado, o orçamento de tempo, uma falha do banco) relê a página em que parou. No teto de 10 páginas
  por fonte e por execução, a continuação da AWS e a janela ficam no cursor, e a execução seguinte segue dali; se a
  AWS não aceitar mais a continuação, a janela recomeça. Lida a janela inteira, a posição vai para o fim dela.
- **Sem duplicar:** `(source, sourceEventId)` é único, como em todo coletor. Antes de gravar, a tarefa busca de uma vez
  as versões já gravadas dos achados da página (pelo escopo do cliente) e só segue com o achado novo ou com `updatedAt`
  mais novo: a sobreposição e a listagem inteira do Access Analyzer não gravam, não pedem detalhe e não medem nada de
  novo.
- **GuardDuty pelos dois caminhos:** o mesmo achado pode chegar pelo export para o S3 (o Wazuh) e pela API. O achado
  lido pela API volta para o formato do export e passa pelas mesmas regras do alerta do Wazuh: sai com a mesma origem
  (`wazuh`), a mesma chave e os mesmos campos, e um caminho nunca duplica o outro. A chave leva o ID da regra do Wazuh,
  então a regra de fábrica é reproduzida (`finding-keys.ts`): 80303 se o texto da severidade tem 7, 8 ou 9; senão 80302
  se tem 4, 5 ou 6; senão 80301; e 80305 a 80307 na sondagem de porta, que vira um achado por IP e porta. A comparação
  é por trecho do texto, como no Wazuh (a severidade 10 cai na 80301, e 3,7 na 80303); a severidade do achado não
  depende da regra. O achado lido só pela API não tem evento bruto no detalhe (o evento bruto fica no indexer do Wazuh).
- **Security Hub sem repetir o GuardDuty e o Inspector, e sem perder nada:** o Security Hub também recebe os achados
  desses serviços. O registro dele só é pulado quando a fonte própria do serviço (`guardduty` ou `inspector`), na
  conta e na região do achado, está de fato sendo coletada, isto é, com a autorização valendo e no estado `collecting`
  (a última leitura deu certo), e além disso o coletor dela já leu essa versão do achado (o `UpdatedAt` está entre o
  começo do que ele lê e a posição do cursor dele) ou o registro é dos últimos 10 min da janela (a sobreposição: o
  coletor próprio ainda vai lê-lo e, se parar antes, a leitura seguinte do Security Hub o traz de novo e o grava). Em
  qualquer outro caso o achado entra pelo Security Hub: a fonte própria nunca autorizada, revogada, sumida
  (`source_missing`, como o detector apagado e trocado por outro, que precisa da própria autorização), com
  `permission_error` ou `ingestion_error`, ainda sem a primeira leitura, de outra região (a agregação entre
  regiões), ou parada há mais tempo do que a sobreposição. A regra é preferir um achado repetido (um pela fonte
  própria, outro pelo Security Hub, nas transições) a um buraco: o cursor do Security Hub nunca passa por cima de um
  achado que ninguém leu. Em cada conta, as fontes próprias são lidas antes da do Security Hub, na mesma execução:
  autorizadas juntas, a primeira leitura da fonte própria (se terminar a janela) já cobre os achados dela, sem repetir
  o histórico inteiro; se ela falhar ou parar no teto de páginas, o Security Hub os grava. Os achados do Access
  Analyzer e do export do GuardDuty para o S3 que também passem pelo Security Hub não são cruzados.
- **Atualização e fechamento:** no GuardDuty vale a regra de sempre (decisão de 04/11/2026): a versão nova de um achado
  ainda não triado só avança o `lastSeenAt`; a de um já triado vira uma recorrência, ligada ao original. Nos outros
  três, o achado descreve uma condição que continua valendo, e a origem o atualiza a cada reavaliação: a versão nova
  nunca vira outro achado, seja qual for o status; ela avança o `lastSeenAt` e, se mudaram, a severidade, a regra e o
  título (`revision`, em `FindingStore`), e avisa por e-mail se a severidade subiu para alta ou crítica (uma vez por
  achado, e nunca o marcado como legítimo). **Nada é fechado sozinho:** o achado arquivado, resolvido, suprimido ou
  fechado na origem só deixa de ser lido; o status no painel é sempre de uma pessoa.
- **Dono:** o achado é do cliente da conta cuja sessão o leu, desde que a conta citada no achado seja a da fonte. Se
  for outra (o detector, o hub ou o analisador que administra contas-membro), vale a regra de sempre: só é do cliente
  se estiver cadastrada, ativa, para ele, e entra na conta dela. A conta de outro cliente (`source_mismatch`), a não
  cadastrada (`unknown_account`) e o campo de conta fora do formato (`invalid_alert`) mandam o achado para a fila sem
  dono, com o mínimo para a triagem.
- **Severidade** (`finding-rules.ts`; o nível da regra segue a escala comum: 12 crítica, 10 alta, 7 média, 3 baixa):

  | Fonte           | Na origem                                                  | No painel                                                                                             |
  | --------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | GuardDuty       | `severity` de 0 a 10                                       | 9 ou mais crítica, 7 ou mais alta, 4 ou mais média, abaixo baixa (como no caminho do bucket)          |
  | Security Hub    | `Severity.Label` (sem ele, `Severity.Normalized`, 0 a 100) | `CRITICAL` (90+) crítica, `HIGH` (70+) alta, `MEDIUM` (40+) média, `LOW` e `INFORMATIONAL` baixa      |
  | Inspector       | `severity`                                                 | `CRITICAL` crítica, `HIGH` alta, `MEDIUM` e `UNTRIAGED` média, `LOW` e `INFORMATIONAL` baixa          |
  | Access Analyzer | tipo do achado e `isPublic` (do detalhe)                   | acesso externo público alta; a outra conta ou identidade média; acesso sem uso e acesso interno baixa |

  O Inspector é lido pela API porque as regras de fábrica do Wazuh não acusam a severidade `CRITICAL`. As regras desses
  achados ficam na faixa 990501 a 990599 (o controle reprovado e o achado de produto integrado do Security Hub; a
  vulnerabilidade em pacote, a porta alcançável e a vulnerabilidade no código do Inspector; o acesso público, o
  externo, o sem uso e o interno do Access Analyzer), com o título em português seguido do título da origem.

- **O que é guardado:** só os campos do achado (título, tipo, região, recurso no formato dos outros achados, IP, as
  táticas do MITRE dos tipos do Security Hub), cada um conferido e cortado no tamanho da coluna. O registro inteiro
  nunca é gravado, e um registro acima de 512 KB é recusado sem ser lido. Nada do achado vai para o log: o relatório da
  tarefa só tem contagens e códigos.
- **MITRE ATT&CK** (`alerts/aws-mitre.ts`): só o que a origem documenta. No GuardDuty, pelo tipo do achado (a finalidade
  da ameaça, e a família quando ela diz mais), igual pela API e pelo bucket; no Security Hub, pelos tipos `TTPs/`; na
  rajada de bloqueios do WAF (80443), varredura ativa (T1595), como a do Cloudflare; nas outras regras do Wazuh, o da
  regra. O Inspector, o controle reprovado e o Access Analyzer ficam **sem tática**, de propósito: são fraquezas, e o
  ATT&CK classifica ações de um atacante. A aba MITRE mostra as 14 táticas num gráfico de radar (`SpiderChart`): a
  participação de cada uma na soma das marcações do período, em escala de raiz quadrada; sem nenhuma, explica a matriz
  vazia e diz quantos alertas não têm tática. O achado já gravado fica com a classificação de quando chegou.
- **Volume:** os bytes do JSON de cada achado novo ou com versão nova entram no medidor da AWS (`IngestUsage` e
  `IngestUsageDay`, fonte `aws`), depois de a página ficar gravada, e somam nos avisos de 80% e 100% do plano. O achado
  de outro cliente, o pulado e a releitura não contam. Nenhum achado é descartado por plano.
- **Estado e saúde da fonte:** a primeira leitura sem erro leva a fonte de `authorized` (aguardando o coletor) a
  `collecting`, mesmo sem achado nenhum (`no_findings_yet` até o primeiro). Fonte de achados nunca fica `stalled`: o
  que conta é a última leitura. A permissão negada vira `permission_error`, com a ação do IAM que faltou (ou
  `capability_off`, sem chamada nenhuma, quando as tags do papel dizem que a leitura de achados está desligada); o
  serviço desligado ou o recurso apagado depois da autorização, `source_missing` (`not_enabled` ou `not_found`), e a
  fonte sai da coleta até a descoberta vê-la de novo; o limite de requisições e as outras falhas só viram
  `ingestion_error` na terceira seguida (`throttled` ou o nome do erro). A saúde fica na própria fonte: `lastSyncAt`
  (a última leitura sem erro), `lastEventAt` (a atualização mais recente de um achado na origem), `lastIngestedAt`, o
  volume das últimas 24 h e o `lagSeconds`, que o painel recalcula a cada leitura (o tempo desde a última leitura sem
  erro; acima de 2 h, a conferência `lag` falha com `sync_delayed`). Só a mudança de estado entra na trilha do cliente
  (`cloud_account.aws_source_collection`, ator sistema).
- **Limites da AWS:** a chamada limitada (`TooManyRequestsException`, `ThrottlingException`) é repetida até 3 vezes,
  com recuo que dobra (1 s, 2 s) e metade sorteada; persistindo, a fonte recua 5 min, dobrando, até 1 h. A recusa
  (permissão, serviço desligado) recua 15 min, dobrando, até 6 h, porque cada tentativa é uma linha de acesso negado no
  CloudTrail do cliente; a fonte que a descoberta devolve à coleta é lida na execução seguinte, sem esperar o recuo.
  No máximo 4 chamadas ao mesmo tempo por conta, e 200 detalhes do Access Analyzer por fonte e por execução.
- **Fica de fora, por enquanto:** está em "O que não está coberto", no fim desta seção.

### Limites e controle de volume

**Nada é bloqueado por plano** (decisão do responsável): acima do volume contratado, a coleta continua, nenhum log é
descartado e nenhuma fonte deixa de poder ser autorizada. O que contém o volume e a carga:

| Controle                         | Quanto                                                                                                                                                                  | Onde                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sem histórico                    | A coleta de cada fonte começa no dia da autorização; nos achados, 24 h antes dele                                                                                       | `collectFrom` (o `only_logs_after` do Wazuh; a primeira janela dos coletores de achados) |
| Grupos do CloudWatch Logs        | 50 autorizados por conta                                                                                                                                                | A autorização (409 `SOURCE_LIMIT_REACHED`) e, de novo, a lista do Wazuh (`source_limit`) |
| Fontes de bucket                 | 200 autorizadas por conta                                                                                                                                               | Idem                                                                                     |
| Fontes por pedido de autorização | 50                                                                                                                                                                      | O contrato da rota                                                                       |
| Tráfego aceito dos flow logs     | Descartado no módulo: só o rejeitado chega ao analysisd                                                                                                                 | `discard_regex` na configuração do manager                                               |
| Requisições liberadas do WAF     | Descartadas no módulo                                                                                                                                                   | Idem                                                                                     |
| Aviso de volume                  | Antes de autorizar flow logs e grupos de logs, e nas fontes marcadas `high_volume`                                                                                      | O painel, na confirmação                                                                 |
| Descoberta                       | Uma execução por vez por conta; a manual, uma a cada 5 min; 500 flow logs, 500 grupos, 200 Web ACLs e 100 load balancers por região                                     | A rota e a tarefa `aws-discovery`                                                        |
| "Tentar de novo" numa fonte      | Um pedido a cada 30 s por fonte                                                                                                                                         | 429 `SOURCE_RETRY_RATE_LIMITED`                                                          |
| Coletores de achados             | A cada 5 min; 2 contas ao mesmo tempo; 4 chamadas por conta; 10 páginas por fonte por execução; 200 detalhes do Access Analyzer; um registro acima de 512 KB é recusado | A tarefa `aws-findings`                                                                  |
| Logs de acesso do ALB            | A cada 5 min por balanceador, 2 ao mesmo tempo, 20 por conta; por execução, 4 min, 500 arquivos, 2 milhões de linhas e 1,5 GB abertos                                   | A tarefa `web-logs`                                                                      |
| Recuo                            | Limite de requisições: 5 min, dobrando, até 1 h; recusa: 15 min, dobrando, até 6 h                                                                                      | Idem (cada tentativa recusada é uma linha de acesso negado no CloudTrail do cliente)     |
| Janela do "Conectar"             | 60 min, com tentativas a 20 s, 40 s e depois a cada 60 s                                                                                                                | A tarefa `aws-check`                                                                     |

O volume lido conta no medidor da AWS do cliente (`IngestUsage`, fonte `aws`) e nos avisos de 80% e 100% do plano: o
que o analysisd recebe, nas fontes do Wazuh, e os bytes de cada achado novo ou com versão nova, nas de API. O cliente
desautoriza qualquer fonte a qualquer momento.

### Isolamento entre clientes

O que impede o dado de um cliente de aparecer para outro, em cada ponto:

- **Na entrada do papel:** uma identidade do Google por cliente, nunca dividida (seção "Por que papel sem chave"). O
  papel do cliente B só aceita o `sub` da identidade de B: se o cliente A cadastrar a conta AWS de B, a entrada é
  recusada (`trust_denied`), e nada da conta de B é descoberto nem coletado.
- **No banco:** `AwsDiscoveryRun` e `AwsSource` têm `tenantId` e chave estrangeira composta com a conta; as rotas
  usam o escopo do cliente da sessão (a conta ou a fonte de outro cliente é 404, sem tocar nela), e as tarefas do
  worker gravam pelo escopo do cliente da conta. A escolha gravada do "Conectar" é uma coluna da própria conta.
- **Nos alertas de bucket** (trilha, flow logs, export do GuardDuty, WAF): o dono sai do próprio evento, o bucket
  que o módulo leu e a conta da pasta (ou a do conteúdo), conferidos com o cadastro na hora da leitura. Uma mudança
  no cadastro só tira o dono de um alerta; para entregá-lo a outro cliente, a conta AWS citada no evento teria de
  estar cadastrada para ele.
- **Nos alertas do CloudWatch Logs:** o evento não diz de quem é, então só é atribuído com a prova de que o manager
  só coletou grupos de uma conta de um cliente em todo o intervalo, com a continuidade do sinal `applied` ("Dono dos
  alertas do CloudWatch Logs"). Na dúvida, não é de ninguém: vai para a fila sem dono, que só a equipe da Verax vê.
- **Nos achados pela API:** o achado é do cliente da conta cuja sessão o leu, desde que a conta citada no achado seja
  a da fonte ou outra conta cadastrada para o mesmo cliente; senão, fila sem dono.
- **No manager do Wazuh:** um profile por conta, com o papel derivado do ID da conta. O manager processa log não
  confiável e lê o token do nó: no nó dedicado, isso é de um cliente só (o risco da célula está na seção "Célula
  compartilhada (Plataforma)").
- **Na célula compartilhada:** a descoberta, os coletores de achados, a saúde das fontes e a prova do dono não são
  ligados; o estado continua legível, e as escritas que dependem deles respondem 409 `DISCOVERY_UNAVAILABLE`.

Os testes negativos (o cliente A não lê, não conecta, não descobre, não autoriza, não revoga e não sonda nada de B;
os achados e os alertas de uma conta de outro cliente vão para a fila sem dono) estão em `apps/api/test/aws-*.test.ts`
e `cloudwatch-alert-ownership.test.ts`.

### O que não está coberto

- **A célula compartilhada** (CE-11 e CE-12): sem a identidade por cliente, a coleta da AWS não existe lá. A
  descoberta e os coletores ficam desligados, e a conferência da conexão segue como antes.
- **A VM própria do cliente** continua com a chave do usuário IAM de leitura no cofre do nó (decisão de 18/11/2026),
  e não com o papel sem chave. O resto do fluxo é o mesmo.
- **Resposta automática:** o papel só lê. Bloquear um IP, isolar uma instância ou desativar uma chave ficam para um
  papel separado, com autorização própria do cliente (decisão do responsável).
- **Security Hub v2** (achados em OCSF, `GetFindingsV2`); o cruzamento dos achados do Access Analyzer e do export do
  GuardDuty com os do Security Hub; o fechamento automático no painel do que foi resolvido na origem; e as
  contas-membro de um administrador delegado que não estão cadastradas para o cliente (os achados delas vão para a
  fila sem dono).
- **Tipos descobertos e ainda não coletados:** o AWS Config e, sem `AWS_WEB_LOGS_ENABLED`, os logs de acesso dos load
  balancers. Os flow logs em
  Parquet, com partições do Hive ou com formato próprio, o WAF no Firehose e o prefixo antes de `AWSLogs/` fora de um
  bucket do cadastro aparecem com o motivo, e não são lidos.
- **Tráfego aceito dos flow logs:** a lista e o gerador aceitam `"traffic": "all"` por fonte; a escolha no painel não
  existe.
- **Histórico anterior à autorização:** nunca é buscado, nem a pedido.
- **Limites do módulo do Wazuh:** estão em "Limites conhecidos da coleta pelo Wazuh".

### O que foi conferido onde

Nenhum teste chama a AWS. O que cada camada prova, e o que só uma conta AWS de teste prova
(`docs/runbooks/homologacao-onboarding-aws.md`):

| O quê                                      | Como foi conferido (sem AWS)                                                                                                                                                                                                                                                                        | O que falta conferir numa conta AWS de teste                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Template v2                                | cfn-lint, cfn-guard (uma regra por declaração de cada autorização), checkov e os testes Python do template (as oito combinações das autorizações, a lista exata de ações, o tamanho das políticas); o preenchimento, por teste linha a linha e pelo e2e do painel                                   | A pilha criada de verdade. Três comportamentos do IAM: `logs:GetLogEvents` com a tag do grupo; `s3:prefix` vazio pelo CloudFormation; SSE-KMS sob a negação por IP com `aws:ViaAWSService` |
| Entrada no papel, identidade e tags        | Unitários e integração com Postgres, com a conferência falsa (`AwsConnectionChecker`): a janela, o tempo esgotado, as tags lidas e mudadas                                                                                                                                                          | `AssumeRoleWithWebIdentity` de ponta a ponta, o `GetRole` nas próprias tags                                                                                                                |
| Descoberta e sondagens                     | Unitários e integração com clientes falsos do SDK e Postgres: completa e parcial, contas sem CloudTrail, GuardDuty ou Security Hub, várias regiões, KMS negado, trilha de organização, Hive, destinos do WAF, grupos com e sem tag; a trava de só leitura; cada chamada contra as ações da política | As respostas reais de cada serviço, os códigos de erro de um serviço desligado, os tetos com uma conta grande                                                                              |
| Rotas e estado da conta                    | Integração com Postgres: o contrato estrito, papéis, A/B, a trilha de auditoria; a derivação do estado e das conferências, unitária                                                                                                                                                                 | Nada próprio (dependem do que está acima)                                                                                                                                                  |
| Lista e configuração do Wazuh              | Testes Python do gerador; na imagem fixada do manager, sem rede (`test-aws-sources.sh`): o `wazuh-modulesd -t` aceita o `ossec.conf` gerado e recusa uma etiqueta desconhecida, cada entrada passa pelos validadores do próprio módulo, as regiões são as do módulo                                 | A leitura real de cada tipo de bucket e dos grupos; o caminho do WAF por Web ACL (derivado do código do módulo, não de objetos de verdade)                                                 |
| Web identity no manager                    | Na imagem, sem rede (`test-aws-profile.sh`): o boto3 do manager usa o provedor de web identity e troca o token no STS da região, com a troca interceptada                                                                                                                                           | A troca de verdade, com o token do Google do nó                                                                                                                                            |
| Marcadores (`progress`) e saúde das fontes | O exportador lê de volta os bancos que o código do próprio módulo grava (na imagem, sem rede); o script do host com o Docker simulado; a saúde, com Postgres e marcadores de exemplo                                                                                                                | Os marcadores de uma leitura real; a fonte parada (`stalled`) com um bucket de verdade                                                                                                     |
| Regras de Flow Logs                        | `test-rules.sh`, no `wazuh-logtest` da imagem do nó: cada limite, as portas, o ignore                                                                                                                                                                                                               | As duas regras disparando com tráfego de verdade, lido do bucket                                                                                                                           |
| Sinal `applied` e a prova do dono          | O script do host num contêiner Linux, com o Docker simulado (cada troca contada, o reboot, o reinício interrompido); o contrato do formato entre o host e o worker; a prova, unitária e com Postgres e um relógio só                                                                                | A prova num nó de verdade (os tempos do reinício do manager, a margem de 15 min e a espera de 10 min)                                                                                      |
| Coletores de achados                       | Integração com clientes falsos do SDK e Postgres: paginação, cursor com sobreposição, deduplicação, o limite de requisições, a permissão negada, o serviço desligado, a retomada, a revogação, o dono                                                                                               | Os achados de exemplo de cada serviço; o GuardDuty pelos dois caminhos; os códigos de erro reais                                                                                           |
| Painel                                     | Unitários (cada estado, cada código com o texto dele, a escolha gravada, o aviso de diferença, as fontes das conferências) e o e2e sobre a demonstração, nos dois temas, com axe                                                                                                                    | O fluxo no navegador contra um nó de verdade                                                                                                                                               |

## Ativos e Postura da AWS

_(fase 2: o inventário de Ativos (PR-14') e a postura nativa com 18 checagens (PR-15') estão feitos no código, numa
coleta só; falta o teste prático na conta AWS de teste)_

As duas telas só cobrem contas AWS: a postura filtra `provider: 'aws'` (a de GCP e Cloudflare não existe), e o cliente
sem conta AWS vê "em breve" em Postura e em Ativos.

**Inventário (tarefa `aws-inventory` do worker, `apps/api/src/inventory/`):**

- **Quem e quando:** as contas AWS ativas já verificadas ao menos uma vez (`ingestFrom`), conectadas ou com erro só de
  bucket (ou `aws_token_stale`, que é do host). Nunca as em "aguardando", nem as com erro na entrada do papel, que
  esperam a conferência da conexão voltar a conectada. A tarefa olha as contas a cada 5 min; a que nunca coletou entra
  na volta seguinte, e a que coletou, quando a última coleta bem-sucedida tem mais de 24 h, mais um sorteio de até 1 h
  (para as contas de um nó não coletarem todas na mesma hora). No máximo 5 contas por volta, as mais atrasadas
  primeiro, uma de cada vez. O agendamento fica no banco (`CollectorCursor`, fluxo `aws_inventory`): uma partida nova
  do worker não refaz os inventários. A concessão `SyncState('aws-inventory')` deixa um worker por vez: ela é
  renovada durante a coleta (a cada terço da validade de 15 min) e conferida de novo, com a linha presa, na transação
  que grava o retrato. Perdida (venceu e outra réplica a tomou), a execução para sem gravar e sem mexer no cursor
  (`lease_lost` no relatório).
- **Sessão:** a mesma `WebIdentityCredentials` da conferência da conexão (`credentialsFor`), sem chave e sem
  ExternalId: a entrada no papel vem primeiro (recusada, nenhuma outra chamada) e é dividida com o `aws-check` (uma por
  hora por conta). Os clientes do SDK pedem outra sessão ao provedor numa coleta longa. O `assumeReadOnlyRole` do
  conector antigo saiu.
- **Coleta** (`collectInventory`): só List, Get e Describe da política `PosturaEAtivos` do template. A conta root
  (`GetAccountSummary`), os usuários IAM com console, MFA e chaves (com o último uso), os buckets (política, ACL e
  bloqueio de acesso público, cada bucket pelo S3 da região dele, sem redirecionamento) e, só nas regiões cadastradas
  (sem `DescribeRegions`), instâncias e security groups. No máximo 2 chamadas do IAM ao mesmo tempo (é global e
  dividido com a automação do cliente), modo adaptativo de novas tentativas e teto de 1.000 itens por tipo. Na ordem
  de uma centena de chamadas por conta por dia (20 usuários, 15 buckets e 2 regiões dão cerca de 120).
- **Coleta parcial:** cada parte (root, IAM, S3 e, por região, EC2 e security groups) entra inteira ou fica de fora. A
  recusa da AWS (permissão, SCP, região desligada) e outro erro que não passa sozinho deixam a parte de fora, com o
  nome do erro em `InventorySnapshot.errors` (`ec2:us-east-1:UnauthorizedOperation`, nunca a mensagem), e o retrato é
  gravado. A mesma regra vale para cada leitura de um bucket (a política, a ACL e o bloqueio): a recusa deixa a
  configuração dele "não lida" e entra em `errors` (`s3:AccessDenied`); o bucket que sumiu entre a listagem e a
  leitura fica de fora. Uma falha passageira (limite, 5xx, rede), a sessão perdida no meio ou nenhuma parte lida param
  a coleta sem gravar nada, inclusive numa leitura de bucket: o retrato anterior continua na tela, e a tarefa recua
  (30 min, dobrando, até 6 h). Nenhuma parte lida (`inventory_refused`) também descarta a sessão guardada da conta.
- **Retrato** (`snapshot-mapper.ts`): os itens no formato do contrato (`assetSchemas`), com o risco das regras v1, cada
  um conferido pelo zod antes de gravar. Um item fora do formato fica de fora, é contado e marca a parte dele
  (`iam:invalid_items`). `truncated` diz que uma parte passou do teto. A gravação é pelo escopo do cliente da conta, só
  se a conta ainda é a mesma (ativa e AWS), e a chave única com o início da coleta (`collectedAt`) a torna idempotente.
- **Painel:** a visão geral de Ativos traz `errors` e `truncated` de cada conta, e a faixa "Coleta parcial" diz o que
  ficou de fora (o resto continua nas abas). Nada da conta vai para o log do worker: o relatório da tarefa só tem
  contagens e códigos.

**Postura nativa (a mesma tarefa, `apps/api/src/posture/`; o catálogo em `packages/shared/src/posture-catalog.ts`):**

- **Catálogo:** 18 checagens com texto em português escrito por nós e os IDs e as severidades do Prowler Hub (a nota
  segue a mesma escala). A das portas de banco é a única com ID próprio no mesmo formato (o Prowler tem uma por
  banco).

  | Parte                  | Checagens                                                                                                          |
  | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | Root                   | MFA no root (crítica); root sem chave de acesso (crítica)                                                          |
  | IAM                    | MFA nos usuários com console (alta); chave ativa trocada em até 90 dias e usada nos últimos 90 (médias)            |
  | Política de senha      | no mínimo 14 caracteres; sem reúso das 24 últimas (médias)                                                         |
  | Security groups        | nada aberto para a internet em todas as portas (crítica), no SSH, no RDP e nas portas de banco (altas)             |
  | EC2 e EBS              | IMDSv2 obrigatório (alta); criptografia padrão do EBS em cada região (alta)                                        |
  | S3                     | nenhum bucket público (crítica); bloqueio de acesso público no bucket ou na conta (alta); bloqueio da conta (alta) |
  | CloudTrail e GuardDuty | uma trilha multirregião gravando (alta); GuardDuty ligado em cada região monitorada (alta)                         |

- **Leituras:** a maior parte sai do que o inventário leu. As próprias da postura (`posture-reads.ts`) são poucas e
  todas já estão nas políticas `PosturaEAtivos` e `ValidarFontes` do template, sem mudança nele:
  `GetAccountPasswordPolicy`, o `GetPublicAccessBlock` do S3 Control (o bloqueio da conta, o único cliente novo,
  `@aws-sdk/client-s3-control`), por região `GetEbsEncryptionByDefault`, `ListDetectors` e `GetDetector`, e
  `DescribeTrails` com `GetTrailStatus` das trilhas multirregião até achar uma gravando. Com duas regiões, cerca de 10
  chamadas a mais por conta por dia.
- **Resultados e nota** (`native-posture.ts`): um resultado por recurso (usuário, chave, grupo, instância, bucket), por
  região (EBS e GuardDuty) ou da conta, como o Prowler: aprovado, reprovado ou não lido. Sem recurso a conferir, a
  checagem não se aplica. **A leitura recusada (permissão, SCP, região desligada) deixa a checagem "não lida"
  naquele escopo: fora da nota e nunca aprovada.** A parte do inventário que passou do teto de 1.000 itens também:
  ela ganha um resultado não lido no escopo cortado, então a checagem dela só sai aprovada se tudo foi conferido (uma
  reprovação achada nos itens conferidos continua reprovando), e a varredura sai parcial com o motivo
  (`sg:sa-east-1:truncated`). No S3, as travas valem trava a trava, combinando o bucket e a conta (o S3 aplica a mais
  restritiva das duas: ignorar ACLs no bucket e restringir buckets públicos na conta protegem), com lógica de três
  valores: uma trava lida que decide sozinha vale mesmo com outra leitura recusada. A nota é a de sempre
  (`summarizePosture`, crítica 10, alta 5, média 2, baixa 1). A falha passageira em qualquer leitura da postura para a
  coleta inteira, como no inventário (nem retrato nem varredura).
- **Gravação:** a varredura (`PostureScan`, com `scannedAt` igual ao `collectedAt` do retrato) e as reprovações
  (`PostureFailure`) entram na mesma transação do retrato, com a mesma conferência da concessão e da conta, e as
  chaves únicas tornam a gravação idempotente. A varredura guarda também os resultados não lidos (`unknown`), cada
  checagem com as contagens (`checks`, conferido pelo contrato ao gravar e ao ler) e as leituras recusadas (`errors`,
  `parte[:região]:código`). Cada resultado passa pelo zod antes; o fora do formato fica de fora e marca a parte com
  `invalid_items`. O expurgo do PR-19 não mudou: a varredura sai pelo `scannedAt`, com as reprovações, e a mais
  recente de cada conta fica.
- **Painel:** a tela de Postura explica que a nota usa o catálogo próprio, mostra a faixa "Varredura parcial" (as
  leituras recusadas, por conta) e a tabela "O que a nota confere", com a situação de cada checagem (aprovada,
  reprovada, não lida, não se aplica), somada nas contas ou de uma conta pelo filtro. A faixa de Ativos continua só
  com as partes do inventário.

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
serve para a redefinição de senha pelo link e para os avisos de incidente e de volume do plano (seção "Avisos por
e-mail").

A infraestrutura da Verax roda na GCP. O nó da Verax coleta:

- **Cloud Logging:** auditoria (Admin Activity e acesso a dados, onde estiver ligado), requisições das APIs (Cloud
  Run e balanceador) e, se existir, o WAF (Cloud Armor). A entrega é feita por um _sink_ de log para um tópico do
  Pub/Sub, só com o filtro de segurança. O nó lê a assinatura com uma identidade sem chave: a conta da VM, se o nó
  rodar na GCP, ou federação de identidade, se rodar fora. Nenhuma chave JSON de conta de serviço é criada.
- **Cloudflare:** como na seção abaixo.

## Logs do Cloudflare

_(fase 2: a auditoria está no código desde o PR-12, e os eventos de segurança, desde o PR-13)_

O Cloudflare é lido pela API dele, por um coletor nativo no worker, sem o Wazuh. Vale para o nó da Verax e para os
nós de clientes:

- **Auditoria da conta** (audit logs v2), com cursor por conta (detalhes abaixo);
- **Eventos de segurança das zonas** (WAF, regras próprias, limite de taxa, DDoS de camada 7, bots), pela API GraphQL
  de analytics, em janelas de 15 min (detalhes abaixo). O Cloudflare amostra esses eventos, então as contagens são
  aproximadas. Ele os guarda por um prazo que vale por zona (`notOlderThan`; a documentação diz ao menos 31 dias em
  todos os planos). Uma parada do nó mais curta que esse prazo não perde dados; numa parada mais longa, o que passou
  dele se perde.

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

### Eventos de segurança (`apps/api/src/cloudflare/`, PR-13)

- **Onde roda:** na mesma tarefa `cloudflare` do worker, como o terceiro fluxo de cada conta (`CollectorCursor`
  `cloudflare_security`), com o mesmo token do cofre e o mesmo cliente HTTP (host fixo). Uma conta por vez: a
  conferência, a auditoria e os eventos nunca disputam o token.
- **O que lê:** `POST /graphql`, o conjunto de dados `firewallEventsAdaptiveGroups`, agregado por `clientIP`, `action`,
  `source` e `clientRequestHTTPHost`, em ordem decrescente de contagem. As zonas vêm de `GET /zones` da conta
  (`Zone: Read`), filtradas pela lista cadastrada (vazia é todas, até 50). Antes, o nó `settings` de cada zona diz se o
  plano dá o conjunto de dados (`enabled`), o maior intervalo por consulta (`maxDuration`), o máximo de linhas
  (`maxPageSize`) e até onde se pode voltar (`notOlderThan`).
- **Janelas e consultas:** janelas de 15 min alinhadas em UTC, lidas 5 min depois de fechar; a primeira leitura pega
  24 h, e cada execução recupera no máximo 24 h, nunca antes da retenção da zona (com 15 min de folga). Cada janela é
  lida em lotes de até 10 zonas (`zoneTag_in`), uma consulta por lote, com até 1000 linhas por zona (ou o
  `maxPageSize`, se menor) e, no mesmo pedido, o total das 24 h anteriores (a base da regra de pico, dentro do
  `maxDuration`). Os valores vão nas variáveis da consulta; só o limite de linhas entra como literal inteiro conferido.
  A resposta 200 com `errors[]` é erro, mesmo com parte dos dados.
- **Cursor:** cada lote é gravado inteiro (achados, exceção e incidente) antes do pedido seguinte; o progresso da
  janela fica na continuação do cursor, e o cursor vai para o fim da janela só quando o último lote dela está gravado.
  Uma falha no meio (da origem, do banco, do orçamento de tempo) recomeça do lote que não terminou, mesmo na primeira
  leitura e mesmo depois de outra janela fechar, e a chave única do achado não deixa a releitura duplicar. Lida a última janela, a próxima leitura é quando a seguinte fechar há 5 min.
- **Orçamento de consultas:** o Cloudflare aceita 300 consultas GraphQL a cada 5 min por token, e cada zona de cada nó
  conta uma. O coletor se limita a 250: o gasto fica em baldes de um minuto na continuação do cursor, gravado antes de
  cada envio (também das novas tentativas do cliente em 5xx, rede e tempo esgotado), e vale a soma dos últimos 6
  minutos (qualquer intervalo de 5 min cabe neles). Sem orçamento, a
  execução para e marca a próxima leitura para quando ele voltar.
- **Falhas e conexão:** o 429 (do HTTP ou a mensagem "rate limiter budget depleted" no corpo) esvazia o orçamento e
  adia os três fluxos da conta até o `retry-after` (5 min sem ele); o 429 da auditoria ou da conferência também adia os
  eventos. O 401 para a coleta, como na auditoria. Token sem `Analytics: Read` (`security_events_forbidden`), plano
  sem o conjunto de dados em nenhuma zona (`security_events_not_entitled`) e token sem `Zone: Read`
  (`zones_forbidden`) ficam no cartão da conta, sem parar a auditoria, e o fluxo confere de novo a cada hora (sem laço
  de erro). Uma zona sem acesso não esconde as outras: o lote recusado é conferido zona a zona, e só as zonas com o
  conjunto de dados são lidas. A janela além da retenção (`cannot request data older than`) é pulada. Resposta fora do
  formato (zod), zona que não foi pedida ou repetida e erro desconhecido recusam a resposta inteira, e o cursor recua.
  As mensagens de erro do GraphQL só servem para escolher o código; nada delas vai para o log ou para o banco.
- **Regras (990330 a 990335)** e agregação, em `cloudflare-security-rules.ts` (ação e origem comparadas só por letras e
  números em minúsculas, porque o GraphQL e o Logpush escrevem diferente):

  | ID     | Nível  | Casa com                                                                                      |
  | ------ | ------ | --------------------------------------------------------------------------------------------- |
  | 990330 | 7 / 10 | um IP com 500 bloqueios ou mais na janela (10 a partir de 5000), sem os da proteção DDoS      |
  | 990331 | 7      | um IP barrado 20 vezes ou mais pelo WAF gerenciado (bloqueio ou desafio)                      |
  | 990332 | 7 / 10 | limite de taxa disparado por um IP; 10 quando foi contra rota de login                        |
  | 990333 | 10     | 1000 requisições ou mais mitigadas pela proteção DDoS de camada 7 na zona                     |
  | 990334 | 7      | 500 eventos ou mais na zona e 10 vezes a média por janela das 24 h anteriores                 |
  | 990335 | 4      | um IP com 50 desafios resolvidos ou mais e 90% de acerto (**desligada**: ligar com dado real) |

  Uma rajada nunca vira um achado por requisição: cada regra vira no máximo um achado por zona, IP e janela, com a
  contagem no nome do evento (`6000 requisições bloqueadas em 15 min`). Por regra, zona e janela, só os 10 IPs com
  mais eventos têm achado próprio; os demais acima do limite viram um achado de resumo. A rota de login da 990332 vem
  de uma consulta a mais (os IPs com limite disparado e as rotas deles), só quando a janela teve limite de taxa; se ela
  falhar ou o orçamento não cobrir, o achado sai com o nível 7. O achado é do cliente da conta (`source='cloudflare'`,
  `logSource='cloudflare_waf'`, chave `cf/<conta>/sec:<sha256(regra|zona|IP|início da janela)[0..40]>`), com a zona
  em `resource` e o IP em `sourceIp`, e passa pela exceção do cliente (por IP ou pela zona) e pelo incidente.

- **Medidor:** os bytes de cada resposta GraphQL e as linhas lidas entram no uso do cliente (`cloudflare`), depois de o
  cursor avançar.

### Conectar com Cloudflare (OAuth, CF-1 a CF-9)

_(no código, desligado: nenhum cliente é liberado antes da homologação com o app registrado,
`docs/runbooks/cloudflare-oauth.md`)_

No servidor dedicado que a Verax gerencia, a conta do Cloudflare passa a ser conectada pelo botão **Conectar com
Cloudflare**: o cliente autoriza a leitura na tela do próprio Cloudflare, sem criar nem colar token. Decisões do
responsável (finais):

- **Só OAuth no nó gerenciado**, com a configuração ligada; com ela, token colado novo é recusado (409
  `CLOUDFLARE_OAUTH_ONLY`), e as contas que já usam token seguem coletando até o cliente migrar. **Na VM do cliente, só
  o token colado** (ameaça do consentimento enganado: a API é do cliente, e a defesa da sessão não vale). Célula e nó da
  própria Verax (`PLAN=interno`) também ficam no token.
- **Todas as zonas da conta**, inclusive as novas (`zones = []`); conta antiga com lista fica como está e ganha
  "Monitorar todas as zonas".
- **O token colado sai** do cofre do nó depois da migração bem-sucedida (o cliente apaga o dele no Cloudflare).
- **O app é da Verax e público** (registrado na conta Cloudflare da Verax; privado só durante a homologação).
- **Nó anterior** (que não anuncia a capacidade `cloudflare_oauth`): a tela é exatamente a de antes.

**Fluxo.** O painel chama `POST /v1/cloudflare-oauth/start` (permissão `cloud_credentials:write`) e navega
(`location.assign`) só para uma URL que comece por `https://dash.cloudflare.com/oauth2/auth?` (o contrato confere na API
e de novo no painel). O `state` é `<subdomínio>.<32 bytes aleatórios>`, preso a cliente, usuário e sessão, com PKCE S256
e prazo de 10 min. O Cloudflare devolve ao endereço fixo do plano de controle
(`https://conta.<domínio>/v1/public/cloudflare/callback`), que confere tudo, não guarda nada e responde 303 para
`https://<subdomínio>.<domínio do painel>/conexao-cloudflare#code=…&state=…&iss=…` (ou `#error=…&state=…[&iss=…]`): o
destino sai só do subdomínio validado e do sufixo fixo, nunca da requisição.

**A página de retorno** (`apps/web/src/pages/cloudflare-return-page.tsx`, rota `CLOUDFLARE_OAUTH_PANEL_PATH`, fora do
`RequireSession`):

1. lê o fragmento uma vez (`features/cloudflare/oauth-return.ts`) e o apaga da barra de endereço com
   `history.replaceState` antes de qualquer chamada; só aceita exatamente os campos de um formato, uma vez cada
   (campo a mais, repetido ou fora do alfabeto: descartado, sem chamar a API). O `iss` que vem junto do erro é
   descartado;
2. sem sessão, o cliente HTTP leva ao login, e o retorno se perde (nada vai para armazenamento, nem para depois do login);
3. com sessão, `POST /v1/cloudflare-oauth/complete` (chamada direta, sem `useMutation`, para o código não ficar nas
   `variables`). A recusa é uma só (outra sessão, outro usuário, vencida, repetida, emissor errado);
4. troca o endereço por `?tentativa=<id>` (não é segredo: a API só mostra a tentativa à mesma sessão) e acompanha
   `GET /v1/cloudflare-oauth/attempts/:id` a cada 2 s enquanto o worker troca o código ou liga as contas.

Estados na tela, cada um com a mensagem em foco (anunciada ao leitor de tela): conferindo; **escolha das contas**
(mais de uma conta autorizada: nome e ID de cada uma, só como texto, a situação dela, e o endereço do ambiente do Verax
que vai ler; a única que pode ser monitorada já vem marcada; sem lista do Cloudflare, o ID digitado); **pronta** (links
para as contas ligadas e o lembrete de apagar o token antigo no Cloudflare); **falha** (um texto fixo por código de
`CLOUDFLARE_OAUTH_ATTEMPT_ERRORS`, nunca a descrição do Cloudflare) e **vencida**, as duas com "Começar de novo".

**Contas cloud** (`apps/web/src/features/cloudflare/`): com `GET /v1/cloudflare-oauth/options` respondendo `oauth`, a
tela ganha o botão "Conectar com Cloudflare" ao lado de "Cadastrar conta", e o detalhe da conta do Cloudflare mostra a
conexão (`GET /v1/cloud-accounts/:id/cloudflare-connection`) no lugar dos passos do token:

- **por OAuth:** situação da autorização, data, última renovação, escopos e quantas contas a usam; com
  `oauth_reconnect_required` ou concessão em `reconnect`, "Conectar de novo";
- **por token colado:** "Migrar para Conectar com Cloudflare" (o `start` com `cloudAccountId`). A coleta segue com o
  token até a prova da mesma conta passar pela autorização nova; só então o token sai, na transação que liga a conta;
- **sem conexão:** "Conectar com Cloudflare" para a conta;
- **desconectar** é desativar o monitoramento ou excluir a conta (botões de sempre): a conta sai da concessão, e a
  última conta manda revogar no Cloudflare.

A **saúde das zonas** (`GET /v1/cloud-accounts/:id/cloudflare-zones`) aparece embaixo: auditoria da conta, todas ou só a
lista, as zonas além do limite de 50 (nomeadas) e cada zona com a situação, o plano, a última leitura e o código do último
erro. No nó sem OAuth (que pode ser anterior e não ter a rota), ela só aparece com os dados já lidos: nem carregando, nem
com erro, e o 404 some.

**Versões.** Painel anterior com nó novo: rotas próprias, nada muda (`cloudAccountSchema` não ganhou campo). Painel novo
com nó anterior: `options`, `cloudflare-connection` e `cloudflare-zones` respondem 404, e o painel mostra a tela do token
colado, sem o botão. O CF-4 (o nó anuncia a capacidade) e a rota `/conexao-cloudflare` saem na mesma versão do nó.

**Demonstração** (`apps/web/src/mocks/cloudflare-oauth.ts`): desligada por padrão; `localStorage['verax.mock.cloudflare-oauth']`
liga (`one`, `multi` ou `manual`) ou simula o nó anterior (`legacy`). O Cloudflare de mentira só existe no e2e
(`apps/web/e2e/cloudflare-oauth.mock.spec.ts`), que intercepta a navegação para a autorização e devolve o fragmento.

**O que falta para ligar para um cliente** (detalhe em `docs/STATUS.md`, CF-8 e CF-9): a homologação com um app
registrado (escopos, renovação sem segredo, `iss`, listas de contas e zonas, limites) e aplicar a exclusão do log de
requisição do caminho do retorno (`cloudflare-oauth-callback`, em `infra/gcp/envs/control-plane/logging.tf`).

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
host do nó (timer, a cada minuto) ──docker exec──► API do manager (wazuh.manager:55000) ──► /run/verax/wazuh-agents/agents.json
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
- **Como o painel sabe dos agentes sem falar com o manager:** a API não divide rede com ele, e o worker só lê os
  contadores do analysisd (`verax_stats`, PR-V6). O host, que já fala com o contêiner do manager pelo Docker, pede a
  lista à API dele (`wazuh.manager:55000` pelo loopback, TLS conferido com a CA do nó, usuário `wazuh-wui`, a senha
  pela entrada padrão do curl) a cada minuto, só com os campos do painel, e grava o arquivo em `/run/verax`
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
  alta, 7 média; abaixo de 7 não vira achado, pelo "Nível mínimo dos agentes" abaixo), MITRE da regra e, do log, só o
  IP (`data.srcip`) e o usuário (`srcuser`, `dstuser` ou o `targetUserName` do Windows), conferidos no formato e
  usados só para mostrar e agrupar. A chave única é `wazuh/agent:<id>/alert:<id do alerta>:<regra>`: o log da
  instância não tem um id próprio em todas as fontes, e o id do alerta é o mesmo a cada releitura do documento (reler
  a janela não duplica). O detalhe busca o evento bruto no indexer pelo id do alerta, saneado como os outros.
- **O mesmo tratamento dos outros achados:** exceção do cliente (por regra e usuário, IP ou recurso, como
  `host:web-01`) e agrupamento em incidente (os achados da mesma instância se juntam pelo recurso), na mesma transação,
  pelo `FindingStore` de sempre. A cobertura das contas (último evento, conta silenciosa) não muda: agente não é conta.
- **Leitura separada:** a tarefa `wazuh-agent-alerts` tem estado e concessão próprios no `SyncState`, com as regras de
  leitura do sync da AWS (sobreposição de 10 min, cursor, até 100 páginas) e um nível mínimo próprio. Uma instância
  barulhenta não atrasa os achados das contas, e o caminho da AWS não muda.
- **Nível mínimo dos agentes: 7** (`AGENT_MIN_LEVEL`, decisão do responsável de 05/11/2026), contra 5 da AWS. Os
  níveis 5 e 6 de uma instância são rotina que só encheria a lista de achados (o arquivo novo do FIM depois de uma
  atualização de pacotes, regra 554; o resumo do SCA, 19003; a conexão SSH malformada de um robô, 5706): ficam no
  indexer (que guarda do nível 5 para cima) e não viram achado nem vão para a fila. A consulta pede o nível ao
  indexer, e o sync confere de novo em cada alerta lido (`belowLevel` no relatório da execução), como faz com o
  `agent.id`. A checagem do SCA com falha (19007), o arquivo alterado ou apagado (550 e 553) e o pacote instalado
  (2902) são nível 7 no Wazuh 4.14 e continuam virando achado médio: o primeiro SCA de cada instância ainda gera um
  achado por checagem com falha, juntos no incidente da instância.

## Evento bruto no detalhe do achado (`apps/api/src/alerts/raw-alert.ts` e `raw-url-mask.ts`)

O detalhe relê o alerta no indexer (30 dias) e o devolve saneado. Nada disto muda o que o indexer guarda.

- **Sai inteiro:** `full_log`, `previous_output`, as chaves de protótipo e o que passa da profundidade.
- **Cabeçalhos:** o valor dos de credencial (`authorization`, `cookie`, `x-api-key`...) e dos com nome de segredo ou de
  dado pessoal (`x-auth-token`, `x-forwarded-email`), no objeto do WAF lido do bucket e na lista `{ name, value }` do
  WAF lido do CloudWatch Logs.
- **URL e query:** em `httpRequest.uri` e `args`, `Referer`, `Location`, nos logs de acesso e em qualquer campo que cite
  uma URL com query, só o **valor** que é, ou parece, segredo ou dado pessoal vira `[removido]`: parâmetro com nome de
  segredo ou de dado pessoal (em qualquer codificação), e-mail, CPF, CNPJ, cartão, JWT, UUID, valor longo e aleatório e
  `usuario:senha@`. Os nomes, a estrutura e o ataque (SQL injection, XSS, travessia) ficam legíveis; num parâmetro de
  segredo, o marcador diz que ataque parece (`[removido: parece SQL injection]`). O que não decodifica sai mascarado
  (`[removido: codificação inválida]`).
- **Como:** varredura de caracteres em tempo linear, até três camadas de codificação, 16 mil caracteres por texto, sem
  expressão regular sobre o texto do atacante.
- **Limites:** é redução de exposição, e não prova de que nada pessoal sobra. Nome de pessoa, endereço ou segredo curto
  num parâmetro de nome neutro não tem como ser visto; um id aleatório que não é segredo e um número de 11 ou 14 dígitos
  saem mascarados. A lista completa está no começo de `raw-url-mask.ts`.

## País de um endereço IP (`apps/api/src/geo/`)

_(decisão de 24/11/2026: embutir a base pública; no código, ainda sem uso. Vai alimentar o mapa de origem das requisições,
com os endereços dos logs de acesso do ALB.)_

Uma tabela embutida diz o país de um endereço, sem rede: a consulta é uma busca binária síncrona em arrays na memória, e
nenhum endereço sai do nó.

- **Fonte:** a base `user-country` do projeto sapics/ip-location-db, em domínio público (PDDL). O registro fica ao lado do
  dado, em `apps/api/src/geo/data/README.md`.
- **O que entra na imagem:** `ip-country.bin.gz` (0,57 MB) e `ip-country-meta.ts` (data, SHA-256 dos CSV e do arquivo). O
  `nest build` copia o primeiro para `dist` (`assets` do `nest-cli.json`); na imagem ele é só leitura, como o resto. No
  git, `*.gz` é binário.
- **Carga:** `loadIpCountry()`, só por quem usa e uma vez por processo. Confere o SHA-256 e a estrutura inteira e lança se
  algo não bate; quem chama decide seguir sem o país. Cerca de 30 ms com a CPU livre (até
  0,5 s com ela disputada: descompressão e conferência são síncronas) e 4,5 MB, fora do heap do V8.
- **Consulta:** `countryOf(texto)` nunca lança. O caminho quente é numérico (`countryOfV4`, `countryOfV6`,
  `countryOfWords`): não aloca, não cria texto e devolve um índice; `code(indice)` dá o código. O IPv4 mapeado e o NAT64
  (64:ff9b::/96) valem pelo IPv4 embutido.
- **Sem país (null):** texto que não é endereço (octeto com zero à esquerda incluído), faixa que a base não conhece e
  endereço reservado (privado, CGNAT, loopback, link-local, multicast, documentação, 6to4, Teredo e tudo que está fora de
  2000::/3). Os reservados são gravados na tabela como "sem país", qualquer que seja a fonte.
- **IPv6 por /64:** a tabela guarda o prefixo /64, a mesma chave do motor de ataques web. Um /64 dividido entre países (732
  na versão de 24/11/2026) fica com o que tem mais endereços dentro dele; no empate, com o primeiro.
- **Códigos:** ISO 3166-1 alpha-2, mais `XK` (Kosovo). `AC` e `TA` viram `SH`, de que fazem parte; `AN` (retirado em 2010)
  fica sem país. Um código desconhecido para o gerador (`country-codes.ts`).
- **Precisão:** é o país do **endereço**, e não da pessoa: VPN, proxy, operadora móvel e nuvem aparecem no país de onde o
  endereço é anunciado. Segundo o próprio projeto, a base concorda com o GeoLite2 em 97,5% dos endereços. Serve para um
  mapa; não serve para acusar nem para bloquear.
- **Atualização:** a cada versão do nó, com `scripts/update-ip-country.mjs` (offline, lê os CSV já baixados; os mesmos CSV
  dão os mesmos bytes). `generatedAt`, `ageDays` e `isStale` (mais de 180 dias) são para o aviso honesto na tela.

## Casos: agrupamento dos alertas (`apps/api/src/cases/`)

_(partes 1 a 8: o banco, a chave, a atribuição, a leitura e a triagem em massa pela API, a tela, o e-mail, e os números na
Torre, no radar e nos relatórios. Sem a linha no nó vale `shadow`, a medição: só a equipe da Verax vê os casos, e o e-mail não muda)_

Um **caso** (`AlertCase`) reúne os alertas pendentes com a mesma chave (`case-key.ts`). Quem abre e sela caso é o worker
(a pessoa só divide um que juntou coisas demais); a pessoa trata alertas, um por um ou em massa, e as contagens do caso são
de gatilhos da tabela de alertas.

- **Interruptor:** `CASES_MODE`, o mesmo valor no ambiente do worker e no da API, conferido na partida (valor fora da
  lista não sobe).

  | Valor    | No worker                                                                                  | Na API                                                                                           |
  | -------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
  | `off`    | Nenhuma tarefa dos casos roda, e nada é gravado (o expurgo só confere se há caso a apagar) | As rotas dos casos respondem 404, iguais a uma rota que não existe, para todos os papéis         |
  | `shadow` | Os alertas ganham caso (a medição no nó piloto)                                            | Só a equipe da Verax (`admin_verax`) lê, no cliente escolhido; para os outros papéis, como `off` |
  | `on`     | O mesmo que `shadow`, mais a fila da triagem em massa (`triage-ops`) e os avisos por caso  | Todos os papéis leem os casos do próprio cliente, e quem faz triagem opera em massa              |

  O `start.sh` passa a linha do `node.conf` à API e ao worker; sem ela, vale o padrão da versão. O nó gerenciado já instalado
  não recebe linha nova: nele, quem liga é o padrão da versão (`docs/runbooks/casos.md`). A API lê o que houver no banco: com o worker em `off` e a API em `on`, os casos ficam parados no tempo (a
  situação mostra a última passagem).

- **Tarefas do worker** (só com `shadow` ou `on`):
  - `case-assign` (a cada 10 s, concessão no `SyncState`): lotes de 200 alertas por cliente, na ordem de chegada, no
    máximo 2 s de trabalho por cliente em cada passagem. A fila é o próprio predicado (`caseId` vazio, fora de
    incidente, novo ou em análise), com o índice parcial `Finding_case_outbox_idx`: o alerta novo, o histórico e o que
    chegou com a versão anterior do nó passam pelo mesmo caminho. O esperado por exceção nasce legítimo e não entra.
  - `case-watch` (a cada minuto): a idade do alerta alto ou crítico mais antigo ainda sem caso, no log; passou de
    10 min, é aviso no log. O e-mail desse atraso sai da tarefa `notifications`, com `on` (abaixo).
  - `case-reconcile` (uma vez por semana): refaz as contagens de cada caso e corrige a que não bate. É a única escrita
    de contagem fora dos gatilhos, e qualquer correção vai para o log.
  - `triage-ops` (a cada 5 s, concessão no `SyncState`; **só com `on`**): as operações de triagem em massa que não cabem na
    requisição (abaixo).

- **Um lote é uma transação**, com a ordem de travas do projeto: o lock dos alertas do cliente (o dos coletores), as
  linhas dos alertas (`FOR UPDATE SKIP LOCKED`, todas de uma vez) e só então os casos. O alerta preso por uma triagem em
  curso fica para a passagem seguinte; o lote espera no máximo 1 s por um caso preso, e o coletor espera no máximo um
  lote. O UPDATE não mexe no `updatedAt` do alerta, que a retenção lê como atividade.

- **Ciclo do caso, pelo horário de chegada no servidor** (`Finding.createdAt`), nunca pelo do log. Como a chegada fica
  gravada, o agrupamento é o mesmo com o alerta atribuído na hora, no histórico ou depois de uma volta de versão.

  | Situação do caso aberto da chave                         | O alerta que chega                                        |
  | -------------------------------------------------------- | --------------------------------------------------------- |
  | Detecção, até 24 h de silêncio e 7 dias de idade         | Entra nele                                                |
  | Detecção, além disso (mesmo em análise ou promovido)     | Sela (`window`, continua pendente e listado) e abre outro |
  | Vulnerabilidade ou postura, com pendência                | Entra nele, sem prazo                                     |
  | Sem pendência, com um incidente dele ainda não resolvido | Entra nele, como novo (o incidente não é alimentado)      |
  | Sem pendência, tratado (ou com o incidente resolvido)    | Sela (`treated`) e abre outro                             |
  | Sem alerta nenhum (saíram na retenção)                   | Sela (`idle`) e abre outro                                |

  O caso novo leva o anterior da chave (`previousCaseId`) e quantas vezes ela já voltou (`recurrence`).

- **Limites, só na hora de abrir** (nas 24 h anteriores à chegada): passados 8 casos da mesma família, conta e alvo com
  rede da internet, o seguinte vai para um caso distribuído (não vale para origem privada, item da lista de proteção
  nem crítico; este, a partir do 101º, vai para um caso próprio). Com 40 casos na fila de detecção ou de postura, a
  chave média ou baixa nova vai para um caso por fonte; a alta, a crítica e a de item protegido, nunca. A fila de
  vulnerabilidade não tem teto (decisão D1).

- **Título:** sempre de um dicionário em português (`case-titles.ts`), nunca do evento. O que vem do evento fica nas
  partes da chave e nas amostras (limitadas em quantidade e tamanho), que são dado a mostrar.

- **Severidade já avisada** (`noticedSeverity`): com `shadow`, em que o aviso por e-mail é alerta por alerta, o caso nasce
  com a severidade já avisada e a acompanha. Com `on`, a atribuição não a toca: quem decide, avisa e marca são os avisos
  por caso (abaixo).

- **Falhas:** o erro de um cliente não para os outros nem a coleta. O lote que falha por culpa de um alerta é partido ao
  meio até isolar qual; ele fica de fora de 1 min a 1 h (dobra a cada falha), com o id e o SQLSTATE no log. Falha de
  banco ou espera longa só adiam o cliente; a passagem seguinte continua depois do trecho que falhou e volta ao começo.

### Leitura dos casos pela API

_(`cases.controller.ts`, `cases.service.ts` e `case-read-store.ts`; contrato em `packages/shared/src/cases.ts`)_

Só leitura, com a permissão `findings:read` (todos os papéis) e o cliente da sessão. Caso ou alerta de outro cliente é 404,
igual a um que não existe. Parâmetro desconhecido é 400. O `CASES_MODE` é conferido num guard, antes da query e do id.

| Rota                          | O que devolve                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /v1/cases/status`        | `mode`, a última passagem da tarefa (`asOf`) e há quantos minutos espera o alerta mais antigo sem caso |
| `GET /v1/cases`               | Os casos, com filtros, ordem e página (até 100 por página e 10.000 páginas)                            |
| `GET /v1/cases/groups`        | A fila de vulnerabilidades agrupada por pacote, recurso ou conta                                       |
| `GET /v1/cases/:id`           | O caso inteiro, o que sai dos alertas dele, os casos anteriores, os incidentes e as operações          |
| `GET /v1/cases/:id/findings`  | Os alertas do caso, por cursor                                                                         |
| `GET /v1/cases/:id/timeline`  | Os alertas por hora ou por dia                                                                         |
| `GET /v1/findings/:id/triage` | As operações de triagem em massa que mexeram num alerta                                                |

- **Situação:** é a única rota que responde com os casos desligados (`off`, sem ler o banco). É por ela que o painel sabe
  se os casos valem: o `/v1/me` é do módulo `auth` e não mudou.
- **Estados da lista:** `pending` (o padrão: há alerta fora de incidente, novo ou em análise), `investigating`, `treated`
  (nada pendente) e `all`. O caso sem nenhum alerta guardado não entra em lista; abre pelo id.
- **Prioridade** (a ordem padrão), sempre total: a pior severidade pendente; nela, quem toca um item da lista de proteção;
  dentro disso, a chegada do último alerta (relógio do servidor), a mais recente primeiro; no empate, o id. O item
  protegido sai das amostras de recurso, usuário e IP (até 20 valores de cada; a chave de acesso não é amostra). As outras
  ordens são `recent` e `volume` (alertas pendentes). As contagens não têm índice de propósito: a ordem é feita em memória,
  sobre os casos do cliente que saem do índice `(tenantId, queue, pending)`.
- **Severidade:** há alerta pendente dela. Só com `pending` e `investigating`: o caso não guarda a severidade do que já foi
  tratado, e a combinação com `treated` e `all` é 400, em vez de uma lista que esconde casos.
- **Período:** o caso ativo em algum momento da janela, pelo horário do evento **ou** pelo da chegada no servidor. Um caso
  que acabou de receber alertas com data antiga (ou forjada) não some das últimas 24 h. O começo não passa do histórico do
  plano, como nos alertas.
- **Fonte:** sai da família da chave e, nas famílias de mais de uma fonte, das regras (`case-sources.ts`). A família que não
  se conhece aparece em todo filtro de fonte.
- **Conta, tática e técnica:** pelas amostras do caso (até 50 contas, 20 táticas e 50 técnicas).
- **Busca:** no título, nas partes da chave e nas amostras, nunca nos alertas, com os curingas do `ILIKE` escapados.
- **Grupos (decisão D1):** o pacote e o recurso saem das partes da chave, e a conta, da amostra (na fila de vulnerabilidades
  cada caso é de um pacote, um recurso e uma conta): nenhum alerta é lido. O valor nulo reúne os casos sem ele (a
  vulnerabilidade no código não tem pacote). A lista aceita o grupo: `groupBy` com `group` (o valor exato), ou `groupBy`
  sozinho para os sem valor. Um recurso com mais de 256 caracteres está cortado na chave: dois iguais até ali ficam no
  mesmo grupo.
- **Detalhe:** os 50 mil alertas mais recentes do caso são lidos uma vez, com prazo de 1,5 s no banco (`statement_timeout`,
  transação só de leitura): os 10 IPs e os 10 usuários menos frequentes, os 50 subgrupos mais graves, os resolvidos que a
  origem voltou a ver (`lastSeenAt` depois de `triagedAt`), os incidentes e as operações em vigor. Passou do prazo, sai
  `analysis: null`, e o resto do detalhe vale. Passou dos 50 mil, sai `complete: false`.
- **Casos anteriores:** a corrente de `previousCaseId`, até 10, dentro do cliente; para no que já saiu pela retenção.
- **Alertas do caso:** do mais recente para trás, pelo índice `(tenantId, caseId, occurredAt, id)`, sem limite de
  profundidade. O horário e o id de um alerta não mudam: um alerta novo não empurra os outros. O cursor é opaco e conferido
  (formato, faixa, escrita única e a marca do caso com os filtros); montado à mão, só muda o ponto de partida dentro do
  caso que a pessoa já pode ler, porque a consulta filtra sempre pelo cliente e pelo caso.
- **Linha do tempo:** por hora cheia até 7 dias; além disso, por dia de Brasília (UTC-3 o ano todo, vira às 03:00 UTC), no
  máximo 366 dias até o alerta mais recente. Sem buracos. Horário no futuro e alerta antigo demais ficam fora, avisados em
  `truncated`. Prazo de 3 s no banco; passou, 503.
- **Operações:** as em vigor nos alertas do caso (`Finding.triageOpId`) e as que elas desfizeram, até 20, cada uma com o que
  quem vê pode fazer (`can`, a mesma conta de `GET /v1/triage-operations`: `operationCan`). O `can` do caso e o das operações
  seguem o modo: com `shadow`, nada, nem para a equipe da Verax.
- **Voltas depois de tratado** (`recurrenceTreated`, na lista e no detalhe): das vezes que a chave voltou, quantas foram depois
  de o caso anterior ter sido selado por `treated`. Sai do motivo do selo dos anteriores da mesma chave (índice
  `(tenantId, groupKey)`), numa consulta só por página; conta os anteriores ainda guardados, e nunca mais que `recurrence`.
- **Texto do evento** (amostras, partes da chave, subgrupos, títulos dos alertas) sai só como dado, limitado em quantidade e
  tamanho; o título do caso é do dicionário.

### Triagem em massa

_(`triage-operations.{controller,service}.ts`, `triage-{engine,store,view}.ts`, `triage-ops-job.ts`, `case-split*.ts`;
contrato em `packages/shared/src/triage-operations.ts`)_

Uma pessoa trata muitos alertas de uma vez, com desfazer. Uma operação é um `TriageOperation` (o pedido e o andamento) e um
`TriageOperationItem` por alerta mudado (o que ele era antes).

| Rota                                      | O que faz                                                                                           | Quem                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /v1/triage-operations`              | `status`, `promote`, `attach` ou `undo_all_of`. 201 feita, 202 na fila, 200 repetida                | `findings:triage`; incidente, também `incidents:write` |
| `GET /v1/triage-operations[/:id]`         | Lista (por página, com autor) e detalhe, com andamento e o que quem vê pode fazer                   | `findings:read`                                        |
| `GET /v1/triage-operations/preview`       | Quantos casos e alertas um filtro da lista alcança agora                                            | `findings:triage`                                      |
| `GET /v1/triage-operations/authors`       | Quem pediu operações nos últimos 30 dias (até 100, só o id e o nome), para o filtro do histórico    | `findings:read`                                        |
| `POST /v1/triage-operations/:id/undo`     | Desfaz. A resposta é a operação que desfaz (201, 202 ou 200)                                        | quem pediu, ou quem administra                         |
| `POST /v1/triage-operations/:id/cancel`   | Para uma na fila ou em curso, ou desiste de uma parada; o que já foi feito fica e pode ser desfeito | quem pediu, ou quem administra                         |
| `POST /v1/triage-operations/:id/continue` | Retoma uma que parou antes do fim (o que faltou e o que falhou)                                     | quem pediu, ou quem administra                         |
| `POST /v1/cases/:id/split`                | Divide um caso                                                                                      | `findings:triage`                                      |

- **Modos:** com `off`, 404 em todas; com `shadow`, a equipe da Verax só lê, e as escritas são 404 para todos; com `on`, tudo.
  A escrita recusada pelo modo, de quem tem sessão, fica na trilha (`denied`, 404). Na medição ninguém opera: a fila não roda.
- **Alvo:** até 50 casos (ou um subgrupo deles, o valor inteiro de `caseGroup`), até 500 alertas, ou um filtro da lista de
  casos. O filtro é o **mesmo `WHERE`** da lista (`caseSetWhere`), sem a página: escolhe casos, e a operação alcança os
  alertas pendentes deles (a severidade do filtro não estreita os alertas). Só os estados `pending` e `investigating`, e com
  um campo que estreite além da fila, do estado e do período. Um id de outro cliente recusa o pedido inteiro com 404.
- **Conjunto congelado:** os alertas do alvo que chegaram até a hora do pedido (`cutoffAt`) e estão pendentes (novos ou em
  análise, fora de incidente, ainda sem o status pedido), num comando só, os piores primeiro. Os ids ficam em
  `TriageOperation.target.ids` até a operação terminar: só o corte não bastaria, porque a atribuição pode pôr no caso, no meio,
  um alerta mais antigo que ninguém viu ao confirmar, e o filtro deixa de achar um caso que a própria operação já mudou.
  Teto de 50 mil alertas (2 MB de ids).
- **Confirmação:** se o conjunto passa do que a pessoa confirmou em mais de 10% e 20 alertas, 409 `TRIAGE_SCOPE_CHANGED` com a
  contagem nova (`details.count`). Crítico só entra com `includeCritical`; sem ele fica de fora, e a resposta e a trilha dizem
  quantos (`excludedCritical`). O motivo é obrigatório para marcar mais de um como legítimo ou resolvido.
- **Prévia de um filtro:** além dos casos e dos alertas por severidade, quantos casos tocam a lista de proteção (pelas amostras,
  a mesma marca da lista) e os novos e os em análise por severidade (`byStatus`), para a conta de "em análise" ser exata. As
  contagens dos casos bastam, menos nos que têm alertas novos e em análise ao mesmo tempo: neles, os alertas são lidos, com
  prazo de 1,5 s no banco; passou, a prévia vem sem `byStatus`.
- **Idempotência:** `requestId` único por cliente. O mesmo pedido devolve a operação que ele criou; o mesmo id num pedido
  diferente (ou de outra pessoa) é 409. Os pedidos de um cliente são conferidos um por vez (um lock próprio, que os coletores
  não esperam).
- **Cotas de quem não administra** (o analista): 2.000 alertas por operação e 5.000 em 24 h, somados no banco. São por
  **papel** (`isMassTriageRole`), sem permissão nova: o `/v1/me` devolve as permissões como um enum fechado, e um painel aberto
  de antes recusaria a resposta inteira. Na fila, até 10 operações por cliente.
- **O que muda num alerta:** `status`, com a mesma regra de `triagedAt` da triagem de um só (a primeira saída de "novo" marca);
  ou `incidentId` (o status não muda, como ao promover à mão); `triageOpId`; e o `updatedAt`, de propósito: é atividade de uma
  pessoa, que a retenção lê. `PATCH /v1/findings/:id/status` tira o `triageOpId`: a decisão mais nova vale. Tirar o alerta do
  incidente à mão também, se foi a operação que o pôs lá: posto de volta por alguém, desfazer não o tira de novo.
- **Um lote é uma transação** (até 500 alertas): o lock dos alertas do cliente, a linha da operação, a do incidente, as dos
  alertas (`FOR UPDATE`, todas, por id) e só então, pelos gatilhos, as dos casos. O item e a mudança de cada alerta são o mesmo
  comando. Até 200 alertas, o lote roda na requisição; além disso, no worker, com 100 ms entre dois lotes, um lote por cliente
  de cada vez e uma operação por cliente (na ordem do pedido).
- **Exatamente uma vez:** o cursor avança na mesma transação em que os alertas mudam, sob a linha da operação travada. Uma
  queda desfaz os dois, e a retomada recomeça do mesmo lugar; duas réplicas se serializam no lock, e a segunda vê o cursor
  adiante. Por baixo, um alerta só muda se o item dele acabou de nascer (chave primária). Não depende da concessão.
- **O que muda no meio** (alguém tratou, promoveu, a origem deixou crítico, saiu na retenção) conta como `skipped` e não é
  tocado. Uma triagem em curso num alerta segura só aquele lote, por no máximo 1 s, e ele volta na passagem seguinte.
- **Falhas:** o lote que falha por culpa de um alerta é cortado ao meio até sobrar ele, que conta como pulado e fica anotado;
  com 50 assim, a operação para. O que falha por culpa do banco é tentado em dez passagens seguidas. Parada antes do fim, a
  operação fica `partial` (ou `failed`, se não mudou nada), com o motivo em `stop`, e aceita "continuar" por 24 h; a seguinte
  da fila roda. Uma que nem encerrar deixa sai da vez por 10 min.
- **Promover:** o incidente abre na requisição, pelo mesmo caminho de promover à mão (`IncidentsService.open`), com o alerta que
  abriu o caso (num caso só) ou o pior, e até 49 dos piores; os outros entram nos lotes. Um aviso por e-mail só, o da abertura:
  os piores já estão nele. O caso promovido inteiro aponta para o incidente (`AlertCase.incidentId`). **Anexar:** a um incidente
  não resolvido; se a severidade sobe, um aviso.
- **Resumo do incidente:** acima de 500 alertas é feito no banco (`aggregateIncidentSummary`), com o mesmo resultado do feito em
  memória (os textos são comparados byte a byte nos dois), também ao anexar e tirar à mão. Nos lotes de um incidente grande,
  o resumo dele é juntado com o dos alertas do lote (`mergeIncidentSummary`, exato ao anexar); ao desfazer, só a contagem
  acompanha. No fim da operação (ou quando ela para, ou um desfazer é cancelado), refaz-se tudo.
- **Desfazer**, até 24 h depois do fim: volta só o alerta em que a operação ainda é a última (`triageOpId`) e que está como ela
  deixou; o resto conta como pulado, e o que saiu na retenção nem entra na conta. O alerta volta ao status e ao `triagedAt` de
  antes (ou sai do incidente) e passa a apontar para o desfazer: o histórico mostra os dois. Desfazer não se desfaz; para
  refazer, um pedido novo. Duas operações sobre o mesmo alerta se desfazem da última para a primeira, e só um nível: o
  desfazer da primeira, depois do da segunda, já não é dono do alerta.
  - **Promover desfeito:** saem todos menos o alerta que abriu o incidente, que é encerrado (registro `incident.update` do
    sistema, com o motivo). Com outro alerta nele (posto por alguém), o incidente fica aberto. O aviso que saiu não volta
    (`warnings` na resposta). Incidente resolvido não perde alerta: reabre-se antes.
  - **Caso selado:** o caso tratado é selado só quando chega o alerta seguinte da chave. Desfeita a operação, os alertas voltam
    a ele como pendentes; se ele estava selado por `treated` e ninguém está aberto com a chave, reabre (o selado por último);
    com um sucessor aberto, continua selado e listado, e os alertas seguintes são do sucessor. O selado por janela ou divisão
    não reabre.
  - **`undo_all_of`** (só quem administra): cancela o que a pessoa tem na fila e põe um desfazer para cada operação dela no
    prazo (até 100), da mais recente para a mais antiga.
- **Dividir um caso:** os alertas escolhidos (até 500, ou um subgrupo de até 2.000) vão para um caso novo, com a mesma chave, que
  nasce selado (`split`), com o original como anterior: a chave só tem um caso aberto, e os alertas seguintes continuam no
  original. As amostras e os horários dos dois se refazem; o `updatedAt` dos alertas não muda. O caso nunca fica sem alerta.
- **Trilha (decisão D7):** `triage.bulk.request` (o alvo, o corte, as contagens de antes por status e severidade, o motivo) e um
  `triage.bulk.finish` do sistema; mais `triage.bulk.{undo,undo_all,cancel,continue,replay}`, `case.split` e, ao promover,
  `incident.create`. O alerta não ganha registro próprio: a trilha dele é o item, que vive enquanto ele viver. O alvo de muitos
  alertas vai com a contagem e os 100 primeiros ids, para caber nos 16 KB de um estado.
- **Banco ocupado:** na requisição, a espera pelo lock do cliente tem 3 s; com ele na mão (os coletores esperam por ele), a de uma
  linha presa, 1 s; e cada comando, 6 s. Passou, 503 sem mudar nada (o limite da requisição de escrita é de 15 s).

### A tela dos casos (`apps/web/src/features/cases/`)

_(a visão na tela Detecções, o detalhe no painel ao lado, a triagem em massa e o histórico; `pages/detections-page.tsx` só
encaixa as peças)_

- **Quem decide é a API:** o painel pergunta `GET /v1/cases/status` uma vez por visita (vale por 5 min). `off`, 404 (nó de
  antes), erro ou resposta que não se entende: a tela é a de sempre, com esse pedido a mais e nada mais. `shadow`: a equipe da
  Verax ganha as visões, só de leitura, e o padrão continua nos alertas. `on`: os casos são a visão padrão.
- **Endereço:** `visao=casos|alertas|incidentes|vulnerabilidades` e `caso=<id>`. Com `on`, sem `visao`, são os casos, menos no
  endereço com `status`, que só a lista de alertas tem (os atalhos da Torre e os favoritos de antes). `/achados` e
  `visao=achados` são os alertas. `alerta`, `achado` e `incidente` abrem o painel sobre qualquer lista; com `caso` junto, o
  painel ganha "Voltar ao caso". Enquanto a situação não chega, a lista padrão espera: pedir os alertas para trocar em seguida
  seria à toa.
- **Filas:** "Casos" tem a fila de detecção (o padrão) e a de postura. "Vulnerabilidades" tem a dela, agrupada por pacote (o
  padrão), recurso ou conta, que a API agrupa, ou sem agrupar (a lista corrida, com todas as situações). Cada grupo abre os
  casos dele e se trata inteiro, por um filtro com `groupBy` e `group`. A severidade some nos tratados e em todos: a API a
  recusa.
- **"Voltou depois de tratado":** a API diz quantas das voltas foram depois de tratado (`recurrenceTreated`); as outras são
  "Voltou (N×)". De um nó que não manda o campo, o caso só diz quantas vezes a chave voltou, e na fila de detecção ela também
  volta quando a janela de 24 h ou de 7 dias passa: a detecção diz "Voltou (N×)"; as outras filas, que não têm janela, "depois de
  tratado"; o detalhe confere nos casos anteriores.
- **Seleção:** até 50 casos ou 500 alertas (os tetos da API), de uma página para outra; some quando o filtro muda. A caixa do
  cabeçalho marca só a página. "Selecionar os N casos do filtro" é outro botão, que só existe com um filtro que estreite (o
  contrato é quem diz: `triageFilterSchema`). Só o que tem pendência se marca.
- **Confirmação:** casos, alertas e a conta por severidade; os críticos só com a caixa que diz quantos são; os casos que tocam a
  lista de proteção (num filtro, quantos são); o motivo, quando a API o exige; a quantidade digitada acima de 1.000; o limite do
  analista antes de pedir. O `expectedCount` é o que o botão diz. Para "em análise", sai da conta quem já está (quando não dá para
  saber quantos, é um teto, e o botão diz "até"). O diálogo não é um formulário: um Enter perdido não confirma nada.
- **Recusas:** `TRIAGE_SCOPE_CHANGED` mostra a contagem nova e pede outra confirmação (pedido novo); 503, 5xx e falta de
  conexão dizem que repetir é seguro, e repetem com o **mesmo** `requestId` (um por conteúdo do pedido); cota, fila cheia,
  incidente resolvido e item que sumiu dizem o que fazer. O `ApiRequestError` passa a levar os números de `details`.
- **Andamento:** o diálogo mostra o resultado na hora ou acompanha a fila; fechar não para nada. "Operações recentes" fica acima
  da lista, recolhida numa linha (some se não há operação): o andamento, cancelar, continuar, desfazer com o prazo, o filtro por
  pessoa (quem pediu algo nos últimos 30 dias, lido ao abrir) e, para quem administra, desfazer tudo de uma pessoa (nome digitado e motivo). Só se relê sozinha enquanto há operação
  andando (3 s; 1,5 s no diálogo). Quando uma termina, as listas, o detalhe e a Torre são relidos.
- **Detalhe:** resumo, o que os alertas têm em comum em português, o que foge do padrão, linha do tempo, subgrupos, alertas por
  cursor (um que não vale mais recomeça e avisa), casos anteriores, incidentes e operações. O alerta abre no mesmo painel e
  volta com o filtro e o foco. `analysis: null`, `complete: false` e o 503 da linha do tempo não derrubam o resto. No alerta, a
  trilha das operações em massa (`GET /v1/findings/:id/triage`).
- **Texto do evento** (amostras, partes da chave, subgrupos, nomes, motivos) é sempre texto do React: quebrado ou cortado na
  largura, nunca HTML nem link. No CSV (`exportCases`, até 2.000 linhas), as mesmas proteções das outras listas.
- **Demonstração** (`src/mocks/{case-fixtures,case-store,triage-engine,cases-handlers}.ts`): casos ligados, montados dos mesmos
  alertas das outras telas, com as contagens calculadas na hora. `localStorage['verax.mock.cases']` (`off`, `shadow`, `on`),
  `verax.mock.triage` (`lenta`, `parcial`, `falha`, `ocupada`, `mudou`, `cheia`) e `verax.mock.cases.volume` trocam o cenário.
  Com `off`, os alertas a mais não existem.
- **Auditoria:** as ações `triage.bulk.*` e `case.split` têm nome, e as áreas "Casos" e "Triagem em massa" entram no filtro só
  quando os casos valem (um nó de antes recusa o valor com 400).

### Casos na Torre, no radar e nos relatórios

_(`case-summary-store.ts`, `case-radar.ts`, `tower/`, `reports/`; contrato em `packages/shared/src/{tower,reports}.ts`)_

- **Só para quem pede e pode ver.** `GET /v1/tower?cases=true` e `GET /v1/reports/{summary,mitre}?cases=true`, com a mesma regra de
  `GET /v1/cases/status` (`casesVisibleTo`): `on`, todos os papéis; `shadow`, a equipe da Verax; `off`, ninguém. Sem o pedido, ou
  sem poder ver, a resposta é a de sempre, byte a byte.
- **Versões diferentes.** As respostas são estritas, e um painel recusa a resposta inteira por um campo (ou um valor de enum) que
  não conhece:

  | Painel               | Nó                                      | O que acontece                                                                      |
  | -------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
  | De antes (ou aberto) | Novo, com casos                         | Não pede, e recebe a resposta de sempre                                             |
  | Novo                 | De antes dos casos                      | `GET /v1/cases/status` é 404: o painel não pede                                     |
  | Novo                 | Com casos, sem este pedido              | 400 (parâmetro desconhecido): o painel pede de novo sem ele, e a tela é a de sempre |
  | Novo                 | Mais novo, com algo que ele não conhece | A resposta não é entendida: pede de novo sem os casos                               |

  Nas rotas dos casos, os campos novos (`recurrenceTreated`, o `can` das operações, `protectedCases`, `byStatus`) são opcionais, e o
  painel sem eles faz o de antes. Nenhuma versão com as rotas dos casos tinha saído: não há painel antigo delas.

- **Semáforo: a regra não muda, nem a conta dela.** Vermelho com incidente crítico aberto; amarelo com incidente alto aberto, postura
  abaixo do limite, coleta parada ou **alerta alto ou crítico em "novo"**; verde nos demais. O último continua contado por alerta,
  todos, em caso ou não, dentro ou fora de incidente, do mesmo jeito em qualquer modo: a cor e os motivos são iguais com e sem os
  casos (o teste compara). O caso pesa pelo pior alerta pendente dele: um crítico e mil baixos são um caso crítico.
- **Decisões, com os casos ligados (`on`) e pedidos.** Cada alerta que o semáforo olha está numa decisão só, então o amarelo sem
  motivo sempre tem uma que o explica:
  - `untriaged_case`: os casos de detecção e de postura com algum alerta alto ou crítico em "novo", fora de incidente;
  - `untriaged_vulnerability_case`: os da fila de vulnerabilidades;
  - `untriaged_finding`: só os alertas que nenhum desses casos cobre: à espera da atribuição (segundos) ou dentro de um incidente
    (promover não muda o status do alerta). Um caso só com altos em análise não é decisão, como hoje um alerta em análise não é.
  - Na medição (`shadow`), a equipe da Verax vê os casos, e as decisões continuam contando alertas: ninguém decide por caso ainda.
- **`cases`:** os casos pendentes por fila, cada um pela pior severidade pendente, e a abertura do mais antigo de cada fila.
- **Custo:** as decisões e os casos pendentes saem das contagens dos casos, num comando só, e **não são guardados**: depois de tratar
  um caso, a Torre relida já diz o novo. Só o caso em que os altos podem estar todos em análise tem os alertas procurados. O MITRE com
  casos passa pela memória de 30 s por cliente, numa memória à parte da do MITRE de sempre (quem não pede nunca recebe).
- **Radar** (`radar.cases`): os casos de detecção ativos nas últimas 24 horas, pelo mesmo `WHERE` da lista (o evento ou a chegada: o
  total bate com o da lista no período, e um alerta com data antiga não esconde o caso), até 100, os mais graves primeiro.
  `detections`, `total`, `bySeverity` e `bySector` continuam contando alertas; `alerts` é quantos dos alertas da janela estão nesses
  casos, contados pelo índice `(tenantId, caseId, occurredAt, id)`, sem ler as linhas. O setor vem da primeira fonte do caso (na
  família que não diz a fonte, do formato da conta), e a distância é a da atividade mais recente, nunca depois de agora.
  - O caso com alerta num incidente aberto traz o incidente (o mais grave): sem nada pendente, a gravidade dele no radar, e na ordem,
    é a do incidente. Um crítico confirmado não some para trás dos médios.
  - No painel, o ponto é o caso: a forma é a gravidade (um círculo vazado, sem nada pendente), o tamanho são os alertas
    guardados (logarítmico, com teto) e o clique ou o Enter abre `?caso=`. A frase diz "N alertas em M casos de detecção" e onde estão
    os outros. A tabela tem os mesmos números. A animação é a de antes: uma varredura, um brilho por ponto e o pulso do que chegou,
    só com `transform` e `opacity`.
- **Relatórios:** `summary.cases {opened, treated, pending, medianMinutesToTreat}` são os casos abertos no período e em que pé estão
  agora (`treated` mais `pending` dá `opened`; o caso sem alerta guardado não entra). A mediana vai da abertura até o último alerta do
  caso sair de "novo" (`triagedAt`) ou entrar num incidente: é por caso, porque tratar 20 mil alertas de uma vez distorce o
  `meanTimeToTriageMinutes`, que é por alerta. O banco não guarda quando um alerta em análise foi encerrado: vale a primeira triagem.
  No MITRE, cada tática ganha `cases` (os casos com alerta dela no período); o alerta sem caso conta só nos alertas.
  - No painel, o gráfico do MITRE passa a mostrar a participação por casos (a mesma escala), com os alertas na dica, na lista e na
    tabela; se nenhum alerta do período tem caso (o histórico de antes), conta alertas. O CSV do MITRE ganha a coluna "Casos", e o dos
    casos do período sai do Resumo.
- **Atalhos:** com os casos, as decisões levam à lista de casos (detecção e postura, uma fila por vez) e às vulnerabilidades; desligados,
  os de sempre.

### Avisos por caso

_(`case-notices.ts`, `case-notice-{policy,store,regime,mail,setup}.ts`; **só com `CASES_MODE=on`**. Com `off` e `shadow`, o aviso
é alerta por alerta, como na seção seguinte, sem diferença numa linha ou num e-mail)_

Com `on`, o alerta que chega não põe nada na fila de avisos (`CaseAlertNotices`). No começo de cada execução da tarefa
`notifications` (60 s), antes da entrega, `CaseNotices` decide os avisos a partir do que está no banco, e grava cada um e a
severidade avisada do caso na mesma transação, sob o lock dos alertas do cliente, decididos de novo com ele na mão: duas
réplicas, ou uma queda no meio, nunca avisam duas vezes nem deixam de avisar. É outra tarefa que não a `case-assign`, para avisar
mesmo com ela parada. Os limites são todos constantes de `case-notice-policy.ts` (a decisão D4 ainda espera a confirmação do
responsável pelo produto).

| Aviso                                     | Quando                                                                                                                          | Chave de deduplicação                | Tipo da linha (severidade)        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------- |
| Caso de detecção                          | A pior severidade pendente (alta ou crítica) passa da avisada                                                                   | `case:<id>:<severidade>`             | `critical_finding`/`high_finding` |
| A onda seguinte do mesmo caso             | Nada do que foi avisado está pendente, e há alerta que ninguém avisou (inclusive se o aviso de antes não chegou a ninguém)      | `case:<id>:<severidade>:<instante>`  | idem                              |
| Crescimento (no máximo um por caso e dia) | 10 vezes mais alertas em 1 h (a partir de 100), uma tática do MITRE que ele não tinha, ou um crítico novo com o caso em análise | `case:<id>:growth:<dia de Brasília>` | idem                              |
| Casos críticos de vulnerabilidade/postura | Há caso com crítico que ninguém avisou: todos num aviso, no máximo um por hora e cliente (os outros esperam)                    | `cases-critical:<hora cheia>`        | `critical_finding`                |
| Resumo diário de vulnerabilidades/postura | Às 09:00 de Brasília (12:00 UTC), se algo alto ou crítico pendente chegou desde o último enviado, ou faz 7 dias que não sai     | `cases-daily:<dia>`                  | `high_finding` (`high`)           |
| Alerta por alerta (nunca calado)          | Alto ou crítico sem caso há mais de 10 min; ou a severidade que sobe na origem num alerta que nenhum caso avisa                 | `finding:<id>`                       | o do alerta                       |

- **Formato:** nenhum valor de enum novo e nenhuma coluna nova. A linha leva o alerta da âncora em `findingId` (o que abriu o caso,
  se ainda está nele; senão, o pior pendente mais antigo) e o caso em `caseId`: cumpre as regras do banco, e uma versão anterior do
  nó a envia como um aviso de alerta, com o link `?alerta=`. Só um índice parcial novo, `Notification_caseId_idx`.
- **Já avisado**, alerta por alerta (`announced`, em `case-notice-store.ts`): o aviso do caso (ou o do incidente para onde ele foi
  promovido) é de depois da chegada do alerta; ou o aviso dele, alerta por alerta, já saiu, com severidade igual ou pior; ou ele é
  do passado (a virada, abaixo); ou voltou de um incidente por um desfazer; ou chegou há mais de 14 dias (o aviso do caso sai com
  o alerta da âncora, na retenção: sem isso, um caso de semanas atrás avisaria de novo). O aviso pulado porque o caso foi tratado, ou trocado por
  outro, não vale como dado; o que falhou nas cinco tentativas vale por 6 h, e o caso ainda pendente avisa de novo.
- **Por isso:** desfazer uma triagem não avisa de novo o que já foi avisado, e avisa o que ninguém recebeu; o caso dividido herda os
  avisos do original até a divisão; a reincidência (outro caso da chave) avisa; e um alerta a mais num caso avisado e pendente, não.
- **O que ainda não tem caso:** a fila parada (ou o alerta isolado pela atribuição) avisa alerta por alerta depois de 10 min, em
  lotes, os críticos primeiro, e o log diz quantos; só o alto de vulnerabilidade e de postura espera o caso e o resumo diário.
  Quando o alerta ganha caso, o aviso ainda na fila dá lugar ao do caso, e o já enviado marca o caso.
- **Falhas:** o erro de um cliente, de um passo ou de um trecho de casos não segura os outros nem a entrega; o que não coube no
  tempo da execução (30 s) continua na seguinte, de onde parou. Um caso que não deixa decidir é isolado, e o alerta mais novo dele
  avisa sozinho. Se a decisão dos casos de detecção falha para um cliente, o alerta alto ou crítico de até um dia, há mais de
  10 min sem aviso nenhum, também avisa sozinho (`unnoticedOfCases`, uma consulta simples, sem nada da decisão), e a tarefa fica
  com erro (`CaseNoticesFailed`). Se a leitura do caso falha na entrega, o aviso sai como o do alerta, em vez de ficar calado. O tipo do erro fica
  em `SyncState('notifications').lastError` e no relatório da tarefa, só com contagens.

**A virada.** Liga-se e volta-se sem perder nem repetir:

- **Ligar:** na partida, antes dos coletores, o worker grava o começo dos avisos por caso, uma vez só, em
  `SyncState('case-notices').cursorTimestamp` (e `cursorId = on`). Só depois de gravado o aviso por alerta para: com o banco fora do
  ar, ele continua. Daí em diante, o alerta alto ou crítico ou tem a linha do aviso dele (`finding:<id>`), que diz o que aconteceu,
  ou chegou depois do começo, com uma hora de folga para o que estava sendo gravado na hora. O que já saiu marca o caso sem e-mail; o
  que não tem linha e é de antes da folga é do passado. O aviso de alerta ainda na fila, que não chegou a ninguém, só sai dela
  (`superseded_by_case`, em lotes) depois que o alerta tem caso **e** o aviso do caso está gravado; sai também o do alerta já
  tratado (`case_treated`) ou que foi para um incidente aberto depois (`superseded_by_incident`). Na vulnerabilidade e na postura, só
  os críticos dão lugar ao aviso imediato; os altos da fila saem como antes.
- **Voltar** (`off` ou `shadow`): a tarefa `notifications` vê que os avisos por caso valiam e devolve o que ficou no meio, uma vez: o
  alerta sem caso avisa alerta por alerta, o caso ainda não avisado avisa uma vez (como um aviso de alerta, sem ler o caso), e a
  vulnerabilidade crítica, alerta por alerta. O aviso imediato e o resumo diário que estavam na fila saem inteiros, com todos os
  casos (`CaseNoticeMail` com `aggregatesOnly`); só a versão anterior do nó os mandaria como o de um alerta. Depois grava `cursorId = off`. No nó que nunca ligou, é uma leitura por minuto.
- **Voltar a versão do nó:** na parada, o worker faz uma última passagem (até 5 s) que dá caso e aviso ao que acabou de chegar, e a
  versão anterior envia o que achar na fila. Só uma queda sem parada, seguida da versão anterior, deixa sem aviso os alertas do
  último minuto, e eles avisam quando os casos voltam.

**Na entrega** (`CaseNoticeMail`): o conteúdo sai do caso na hora do envio: o título do dicionário, as contagens de alertas críticos e
altos pendentes e o link (`/?caso=<id>`; a fila, `/?visao=vulnerabilidades` ou `/?visao=casos&fila=postura`), e nunca no assunto, que é
fixo. O contato de escalonamento recebe os avisos de caso críticos e o imediato, sem título nem lista, e nunca o resumo diário. Os
limites são os de sempre (5 por pessoa e hora, o resumo da hora com o título e as contagens, 5 por hora ao contato, as faixas por
severidade). O aviso que deixou de valer é fechado antes, de uma vez (`case_treated`, `superseded_by_incident`, `case_gone`), e
conferido de novo no envio de cada um e quando o resumo da hora sai: um caso já tratado não vai em e-mail nenhum.

### Exceções a partir de um caso (`apps/api/src/scoped-exceptions/`, PR-9)

Do detalhe de um caso, **Criar exceção** (com `CASES_MODE=on`, para quem tem `alert_exceptions:write`):

- **Usuário, IP ou recurso** (as exceções de sempre, `AlertException`): o painel lê o que é constante nos alertas do caso
  (`GET /v1/cases/:id/exception-draft`, as combinações de regra, fonte, conta e evento, e os valores de usuário, IP e recurso
  até 20 cada) e cria uma por valor de uma vez (`POST /v1/cases/:id/alert-exceptions`, até 20; a que já existe fica como
  estava). Acima de 20 valores, o painel recusa e sugere a ampla. Um registro na auditoria (`alert_exception.create_batch`).
- **Ampla** (`ScopedException`, só administradores, decisão D8): regra, fonte de log e conta obrigatórias; evento e começo do
  recurso (o repositório do ECR) opcionais; severidade máxima (padrão média, até alta; crítico nunca); motivo; validade
  obrigatória de até 90 dias. Antes de salvar, a prévia (`GET /v1/scoped-exceptions/preview`): "teria coberto N alertas nos
  últimos 30 dias, M altos", contando os alertas que chegaram na janela. O painel só salva com a prévia dos valores de agora.
  Revogar (`POST /v1/scoped-exceptions/:id/revoke`) não apaga: a exceção para de valer na hora e fica listada, com quem revogou.
  Auditoria: `alert_exception.scoped_create` e `alert_exception.scoped_revoke` (área `alert_exception`, sem tipo novo no filtro).

**Travas** (`packages/shared/src/scoped-exceptions.ts`, conferidas no zod, de novo no worker e, as de severidade e validade, em
CHECKs do banco): o evento é obrigatório nas regras que são uma classe (990501, 990502, 990511 e 80300-80309); a ampla não
existe nas regras de identidade e acesso (100300-100324) nem nos ataques web pelos logs do ALB (990403, 990406, 990407); no
máximo 50 em vigor por cliente. O prefixo do recurso é texto: na prévia, `%` e `_` são escapados (o `startsWith` do Prisma não
escapa) e, no worker, a comparação é `String.startsWith`.

**Permissão pelo papel.** Não há permissão nova: a lista de `/v1/me` é um enum fechado no painel, e um valor novo quebraria o
painel de antes (o teste `web-logs-skew.test.ts` guarda isso). As rotas pedem `alert_exceptions:write` (ou `:read`, na lista), e o
service recusa com 403 quem não é administrador (`canWriteScopedExceptions`, como `isMassTriageRole`); a recusa vai para a
trilha. Todas as rotas só existem com `CASES_MODE=on` (`CasesOperableGuard`): com `off` ou `shadow`, 404 para todos.

**Na coleta** (`apps/api/src/alerts/scoped-exception-match.ts`): separada das exceções de sempre e lida à parte. O worker só
cria a fonte (`ScopedExceptionSource`) com `CASES_MODE=on`; os coletores a repassam ao `FindingStore`. Para cada alerta sem a
exceção de sempre, a fonte devolve a lista do cliente (guardada por 30 s) e, se uma casa, confere no banco que ela ainda vale
(a revogação vale na hora). Tudo isso fora da transação do alerta: uma leitura que falha vira lista vazia e um aviso no log, só
com o tipo do erro, e o alerta entra na fila. Só o alerta **novo** (e a recorrência nova do GuardDuty) é marcado: nasce
`legitimate`, com `scopedExceptionId`, sem aviso, e a contagem da exceção sobe na mesma transação. O alerta que já existe nunca
é tocado. Se a origem revisa um alerta marcado e a severidade passa da máxima (ou vira crítica), ele volta para `new`, sem a
exceção, e avisa como qualquer subida.

**Migration `20261204120000_scoped_exceptions`**, só acrescenta: a tabela, `Finding.scopedExceptionId` (anulável, sem valor
padrão), a chave estrangeira composta com o cliente (`ON DELETE SET NULL ("scopedExceptionId")`: só a coluna vira nula, nunca o
`tenantId`; no Prisma fica `NoAction`, porque ele não declara a lista de colunas) e um índice parcial. Nenhum enum muda. A imagem
anterior do nó grava, triaga e expurga alertas no esquema novo (testado), ignora a tabela, e o alerta que a ampla marcaria volta
para a fila: o lado seguro.

**No painel:** o diálogo (`features/cases/case-exception-dialog.tsx`) e a seção "Exceções amplas" na tela Exceções
(`pages/admin/scoped-exceptions-section.tsx`), com a lista e o revogar. Com os casos desligados, ou um nó de antes (404), a tela é
a de sempre, sem pedido a mais. Tudo o que veio dos logs (evento, recurso, usuário, IP) é texto.

## Ataques web pelos logs do ALB: o que fica guardado (`apps/api/src/weblogs/`)

_(PR-1, o motor; PR-2, o banco, migration `20261130120000_web_logs`; PR-3, os contratos, e PR-4, a leitura, nas seções
seguintes; as telas, PR-5, na última delas. Desligado por padrão.)_

O worker lê cada linha do log de acesso do ALB do bucket do cliente, conta e **não guarda linha nenhuma** (decisão D2). O
original fica no S3 do cliente, pela retenção dele; a evidência aponta o objeto e o minuto.

| Tabela                                              | O que guarda                                                                                                                                                                                                 | Por quanto tempo                                                                                           | Quem grava                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `FindingEvidence`                                   | A evidência de um achado: contagens, caminhos mascarados, endereços dos atacantes, até 10 amostras mascaradas e 5 ponteiros para o bucket do cliente. JSON estrito (zod na gravação e na leitura), até 16 KB | Os agregados, com o achado (o histórico do plano); as amostras e os ponteiros, 30 dias da última atividade | Só o sistema (`alerts/finding-evidence.ts`, na transação do achado) |
| `WebLogObject`                                      | Os objetos já tratados: o hash do bucket e da chave (nunca a chave), o intervalo, as contagens e o estado (`read`, `late`, `quarantined`, `gap`)                                                             | 10 dias                                                                                                    | Só o sistema (`weblogs/store/web-object-ledger.ts`)                 |
| `WebEngineState`                                    | O resumo do dia de cada balanceador, entre reinícios do worker: contagens por endereço (IP ou /64), de até dois dias. Até 4 MiB                                                                              | Até a fonte deixar de ser coletada, ou 3 dias parado                                                       | Só o sistema (`weblogs/collect/web-logs-job.ts`)                    |
| `WebTrafficSlot`                                    | Requisições por país e classe de cliente em intervalos de 5 minutos (o mapa): total, barradas, 4xx, 5xx e as que contaram como sonda, ferramenta ou falha de login. Nunca IP, caminho nem host               | 48 h (em horas cheias); depois, passam para as horas                                                       | Só o sistema (`weblogs/store/web-traffic-store.ts`)                 |
| `WebTrafficHour`                                    | O mesmo, por hora                                                                                                                                                                                            | 35 dias                                                                                                    | Só o sistema                                                        |
| `WebSourceSettings`, `WebTrustedSource`, `WebRoute` | A configuração do cliente, por balanceador: o modo (`observe` no começo, depois `alert`) e o multiplicador; as fontes confiáveis; as rotas declaradas                                                        | Enquanto a fonte existir                                                                                   | O cliente, pela API (`/v1/web-logs`), com trilha                    |
| `WebSourceEstimate`                                 | A estimativa de volume antes da autorização: o pedido pendente e o último resultado (arquivos e bytes por dia). Só contagens                                                                                 | Enquanto a fonte existir                                                                                   | O pedido, o cliente; o resultado, o worker                          |

- **Isolamento:** todas têm `tenantId`, e as chaves estrangeiras de fonte, conta e achado são compostas com ele e não se
  propagam na troca do cliente: nada cruza, venha a escrita de onde vier. As do sistema são só leitura no escopo do cliente
  (`SYSTEM_WRITTEN_MODELS`).
- **Volta de versão:** a migration só acrescenta, e toda chave nova é em cascata. A imagem anterior lê, grava, expurga e
  exclui como sempre; o que é das tabelas novas sai junto.
- **Evidência:** gravada com o achado e trocada inteira, só por uma mais nova (a atividade mais recente ou, no mesmo
  instante, a contagem maior): reavaliar, o objeto atrasado e a releitura de um reinício não a encolhem nem a fazem oscilar.
  A do achado ainda não triado acompanha a atividade; a do triado fica como a pessoa a viu, e a atividade nova é outro
  achado. O resumo do dia (990400) também troca o texto, que traz as contagens. Evidência fora do schema ou do teto é
  recusada, e o achado entra sem ela. O achado sem evidência (todas as outras fontes) é gravado com as mesmas consultas de
  antes. Um nível maior é outro achado: o nível está na chave (`weblogs/draft.ts`).
- **Leitura:** `GET /v1/findings/:id/evidence` (`findings:read`), à parte do detalhe: o contrato do detalhe é estrito, e um
  painel de antes perderia a tela com um campo novo. Sem evidência, `{"evidence": null}`; num nó de antes, 404. O que está
  no banco passa pelo schema estrito antes de sair; o que não passa não é mostrado.
- **Cada requisição conta uma vez:** o tráfego de um objeto é somado na transação da linha dele no `WebLogObject` (e do
  volume medido): o objeto relido, ou lido por duas réplicas, acha a linha e não soma. A passagem para as horas apaga as
  linhas de 5 minutos e soma na hora na mesma instrução: parar no meio não perde nem dobra, e o objeto que chega depois
  passa na vez seguinte. Cada contagem está numa tabela só, e a leitura soma as duas numa instrução, sem marca d'água.
- **Custo medido** (2 clientes, cada um com 2 dias, 2 balanceadores, 120 países e 3 classes em todo intervalo, 829 mil
  linhas, o pior caso): os últimos 15 minutos, 4 ms; as últimas 24 h, de 55 a 75 ms, com o índice `(tenantId, slotStart)`;
  somar um objeto (360 linhas), 43 ms; passar uma hora (4.320 linhas), 56 ms. Com um cliente só no nó, as 24 h são metade
  da tabela, e o banco a lê inteira, no mesmo tempo.

## Logs de acesso do ALB: autorização, configuração e diferença de versão

_(PR-3: os contratos e o isolamento do Wazuh, migration `20261201120000_web_logs_contracts`. Desligado por padrão. A leitura
está na seção seguinte.)_

Três portões: a linha `AWS_WEB_LOGS_ENABLED` do nó (a API e o worker, o mesmo valor; na célula ela não liga nada), que desde a
1.5.0 vem aberta e sozinha não lê nada, a autorização de cada balanceador e o modo `observe`, estes dois fechados no começo.
O `start.sh` passa a linha do `node.conf` à API e ao
worker; sem ela, vale o padrão da versão. O nó gerenciado já instalado não recebe linha nova no `node.conf` (a atualização da
frota não o reescreve): nele, quem liga é o padrão da versão (`docs/runbooks/ataques-web.md`).

**Desligado.** O balanceador é o de sempre: só o que tem o log ligado aparece, de qualquer tipo, como "ainda não
coletado" e sem sondagem; nenhuma rota o autoriza (409 `SOURCE_NOT_COLLECTABLE`); tudo em `/v1/web-logs` é 404
(`WEB_LOGS_DISABLED`, depois de 401 e 403 e antes de olhar o corpo). Desligar vale na hora, sem esperar a descoberta: o que
ficou gravado de quando estava ligado é mostrado como um nó que nunca os teve mostraria (`gatedSource`), sem mudar nada no
banco. A fonte autorizada continua à vista, como "aguardando" e nunca "coletando", e tirar a autorização segue possível.

**Ligado: a descoberta.** As mesmas chamadas de sempre (`DescribeLoadBalancers` e os atributos), mais a sondagem de bucket das
outras fontes (uma listagem da pasta `AWSLogs/<conta>/elasticloadbalancing/<região>/` e 1 byte de um objeto), que o papel de
leitura já cobre: nenhuma mudança no template.

| Balanceador                                    | Como aparece                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| ALB com o log ligado                           | Disponível (nota `high_volume`) ou com a permissão que falta (`bucket_denied`...)   |
| ALB com prefixo antes de `AWSLogs/`            | Precisa de permissão: `additional_bucket_required`, `outside_awslogs_prefix`        |
| ALB com o log desligado                        | Sem destino, com `aws_cost_alb_logs`: ligar tem custo na AWS; só a pedido no painel |
| NLB e GWLB, com ou sem log                     | Formato não lido: o log do NLB é só de TLS e sem URL; o GWLB não tem log            |
| Atributos não lidos (recusados, estrangulados) | Como estava: não entra, não some                                                    |

Os que aceitam conexão da internet (`details.internetFacing`) vêm primeiro. A fonte é a conta, a região e o nome do
balanceador; o `app/<nome>/<id>` sai do ARN. Apagado e recriado com o mesmo nome, é a mesma fonte (com a autorização); como
NLB, vira `source_missing`.

**Autorizar** é a rota das outras fontes (`POST …/aws/sources/authorize`), com a ciência da estimativa em `webLogs` (D1: os
bytes descompactados contam no plano):

- A estimativa é pedida antes (`POST /v1/web-logs/sources/:id/estimate`, 202, uma a cada 5 min) e calculada pelo worker, que
  é quem fala com a AWS. Vale 7 dias.
- O pedido cita qual estimativa o cliente viu e os dois números dela (GB por dia e a porcentagem do plano). A API confere
  com o gravado e com o plano de agora, com a mesma função do painel (`projectWebLogs`: 30 dias contra o volume do mês, ou o
  dia contra a franquia): número diferente, 409 `WEB_LOGS_ESTIMATE_CHANGED`; sem estimativa que valha, 409
  `WEB_LOGS_ESTIMATE_REQUIRED`.
- Acima de 20% do plano (pelo valor exato), sem amostra ou com a listagem cortada, só com `acknowledged` (409
  `WEB_LOGS_ACKNOWLEDGEMENT_REQUIRED`). O plano nunca bloqueia.
- Até 20 balanceadores por conta, dentro das 200 fontes de bucket, que continuam contando com eles.
- Autorizado, nasce a `WebSourceSettings` em `observe`, com `observeUntil` 72 h à frente, na mesma transação e na trilha,
  com o que o cliente viu.

**Retirar e remover.** Retirar a autorização não apaga nada na hora: a configuração, as rotas e as fontes confiáveis ficam e
voltam a valer na próxima autorização (que recomeça a observação e guarda o multiplicador); o tráfego, os objetos tratados e
a evidência saem pela retenção deles; o resumo do dia (o único com IP) sai no expurgo seguinte, em até um dia. Apagada a
fonte (a descoberta esquece a que nunca foi autorizada), a conta ou o cliente, tudo o que é do balanceador sai em cascata; a
fonte confiável de todos os balanceadores só sai com o cliente.

**Configuração (`/v1/web-logs`, `apps/api/src/weblogs/settings/`).** Todos leem (`cloud_accounts:read`); administradores
mudam (`cloud_accounts:write`); tudo na trilha, com antes e depois, na área da conta (ou do cliente, na fonte confiável de
todos os balanceadores). A projeção contra o plano só vai para quem lê o plano (`plan:read`): a porcentagem diria o tamanho
dele.

| Rota                                                    | O quê                                                                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET sources`, `GET sources/:id`                        | Os balanceadores de todas as contas, com a configuração e a estimativa                                     |
| `GET sources/:id/health`                                | A leitura das últimas 24 h e o resumo da observação: só contagens e códigos (PR-5)                         |
| `PATCH sources/:id/settings`                            | Modo e multiplicador (0,5 a 10). `alert` só depois de `observeUntil` (409 `WEB_OBSERVATION_PENDING`)       |
| `POST sources/:id/estimate`                             | O pedido da estimativa                                                                                     |
| `GET`/`POST trusted-sources`, `PATCH`/`DELETE …/:id`    | Até 200 por cliente (as de todos e as de cada um, vencidas inclusive); /16 a /32 e /32 a /64; até 365 dias |
| `GET`/`POST sources/:id/routes`, `PATCH`/`DELETE …/:id` | Até 50 por balanceador; caminho literal em minúsculas, até 8 segmentos, `*` por segmento inteiro           |

A rota do mapa (`GET traffic`) está em "Mapa de origens": é da tela Detecções, com a permissão do resumo dela.

O que a API aceita, o motor aceita, com o mesmo significado (`web-logs-contract.test.ts`): a faixa é guardada na forma
canônica (a mesma escrita de dois jeitos é uma só), e o cadastro é mais estrito onde o motor calaria (`.` e `..` no caminho,
o mesmo código como falha e sucesso).

**O achado.** A fonte é `alb` (`FINDING_SOURCES`), no setor da AWS do radar. Não é fonte de "Saúde da coleta" nem sinal de
vida da conta: o tráfego do ALB não pode esconder uma trilha parada.

**Diferença de versão** (a aba aberta desde antes; o painel da Verax e a VM do cliente em versões diferentes). Nenhuma
resposta ganhou campo e nenhuma permissão nova existe (a lista dela vai no `GET /v1/me`, que um painel de antes recusaria
inteiro). Com os ataques web desligados, o nó responde o que sempre respondeu. O que muda com eles ligados:

| Quem é de antes            | O que chega                                                       | O que acontece                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| O painel                   | Achado `alb` numa página da lista, no detalhe ou nos relacionados | Aquela chamada mostra "O servidor respondeu algo inesperado"; as páginas sem ele abrem. Recarregar a aba resolve                                                                           |
| O painel                   | Achado `alb` nas últimas 24 h, entre os 100 do radar              | O resumo da Torre não abre (o radar vai dentro dele)                                                                                                                                       |
| O painel                   | Nota `aws_cost_alb_logs` ou `internetFacing` numa fonte           | A tela das fontes daquela conta não abre                                                                                                                                                   |
| O painel                   | Balanceador disponível                                            | A caixa aparece; autorizar volta 409 com o texto da API (sem a estimativa), o pedido inteiro                                                                                               |
| O painel                   | Relatórios                                                        | Abrem: o resumo e a cobertura não usam lista fechada (a fonte aparece como `alb`)                                                                                                          |
| O nó                       | Filtro `fonte=alb`, `webLogs` na autorização, `/v1/web-logs`      | 400 no filtro escolhido; o painel só manda `webLogs` com um balanceador, que aquele nó não oferece; 404 sem código, tratado como desligado (o mapa de origens não aparece)                 |
| A imagem (volta de versão) | Achados `alb` no banco                                            | Listas, detalhe e incidentes que os contenham dão 500 (`logSourceOf`); a Torre abre. A fonte autorizada ganha `ingestion_error` (`invalid_details`) do Wazuh, sem mudar a lista do manager |

Por isso a ordem: **esta versão sai, no painel e no nó, uma versão inteira antes de a linha ser ligada** (e de qualquer achado
`alb` ser gravado); ligar só depois de o painel do cliente estar nela. Com achados `alb` gravados, não se volta para antes
desta versão; para parar, desliga-se a linha.

## Ligar o log de acesso do ALB pelo painel (`apps/api/src/weblogs/alb-logging/`)

_(Migration `20261205130000_web_alb_logging`, só aditiva. Decisão do responsável: em vez do comando para o cliente rodar, a
Verax liga o log a pedido no painel, com uma permissão de escrita opcional no papel do cliente.)_

**A pilha.** O parâmetro `EnableAlbAccessLogs` do `verax-control-reader.yaml` (desligado por padrão, sem mudar a versão do
modelo: a pilha v2 sem ele continua atual) cria, na região da pilha:

- um bucket só para o log dos ALB: privado (bloqueio de acesso público, `BucketOwnerEnforced`), SSE-S3 (o ALB não grava com
  chave do KMS), versionado, com retenção de `LogRetentionDays`, e que fica na conta (`Retain`, ele e a política) se a opção
  for desligada: nenhum ALB perde o log. A política só aceita TLS e só deixa
  `logdelivery.elasticloadbalancing.amazonaws.com` gravar em `AWSLogs/<conta>/`, de balanceadores desta região e conta
  (`aws:SourceArn`). É a política atual da AWS, que vale em toda região; a antiga, com a conta do ELB de cada região, só
  existe nas regiões de antes de 08/2022 e não é usada;
- no papel, `elasticloadbalancing:ModifyLoadBalancerAttributes` em `loadbalancer/app/*` desta região e conta, numa declaração
  da `VeraxControlReader` (`LigarLogDosAlb`). Ela é também o limite do papel: numa política separada, a ação precisaria estar
  repetida no limite (e o template já está perto do limite de 51.200 bytes). Na negação, só essa ação sai do `Modify*` do
  balanceador: o resto do `Modify*` fica negado fora dos ALB da região, e `ModifyCapacityReservation` e `ModifyIpPools`
  negados em tudo;
- a leitura do bucket pelo papel (as declarações dos buckets criados pela pilha) e a etiqueta
  `verax-control:alb-logs-bucket` (`<região>/<bucket>`), que diz ao nó para onde ligar.

**O pedido** (`/v1/web-logs/sources/:id/access-logs`, atrás do mesmo portão `AWS_WEB_LOGS_ENABLED`):

| Rota             | Quem                   | O quê                                                                                                      |
| ---------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET`            | `cloud_accounts:read`  | O pedido pendente, o último resultado e o que a Verax ligou (`WebAlbLogging`)                              |
| `POST …/enable`  | `cloud_accounts:write` | Só `{ "confirm": true }`. ALB com o log desligado (`no_destination`), conta conectada, sem pedido pendente |
| `POST …/disable` | `cloud_accounts:write` | Só o que a Verax ligou (`enabledByVerax`), com a autorização do balanceador já retirada                    |

Recusas: `WEB_ALB_LOGGING_PENDING`, `WEB_ALB_LOGGING_ALREADY_ON`, `WEB_ALB_LOGGING_NOT_ALB`, `WEB_ALB_LOGGING_NOT_VERAX`,
`WEB_ALB_LOGGING_SOURCE_AUTHORIZED` e `ACCOUNT_NOT_CONNECTED` (409). O pedido entra na trilha, com quem pediu.

**A tarefa `web-logs-alb-logging`** (worker, a cada 15 s, cinco pedidos por vez) é a única escrita da Verax na conta do cliente:

1. Lê a etiqueta do papel (`iam:GetRole`), na hora. Sem ela (a pilha sem a opção, ou o papel do modelo 1), ou com a chave de
   um usuário de leitura (a VM própria do cliente), `stack_update_required`; bucket de outra região, `other_region`.
2. Lê os atributos do balanceador de novo. Com o log já ligado, em qualquer bucket: nada muda (`already_enabled`), e o painel
   diz qual é o bucket.
3. Manda `ModifyLoadBalancerAttributes` com só `access_logs.s3.enabled=true`, `access_logs.s3.bucket=<bucket da pilha>` e
   `access_logs.s3.prefix=` (vazio). Para desligar, só `access_logs.s3.enabled=false`, e só se o ARN, o bucket e o prefixo ainda
   forem os que a Verax deixou (senão, `released`: alguém mudou fora do painel, e a Verax não mexe mais). O IAM não filtra qual
   atributo muda: a trava é do código (`alb-access-logs.ts`), que recusa, antes de sair para a rede, qualquer outro comando,
   chave, valor, bucket ou balanceador.
4. Grava o resultado, quem pediu, quando e os atributos de antes; a trilha do cliente (ator sistema, antes e depois); e, se algo
   mudou, pede a descoberta da conta, que mostra o balanceador entre os disponíveis. Daí em diante, o caminho é o de sempre:
   a estimativa, a autorização e as 72 h de observação.

A recusa da AWS vira código, nunca 500: `permission_denied`, `bucket_rejected` (o ELB grava um arquivo de teste no bucket antes
de aceitar), `balancer_missing`, `throttled`, `account_not_connected` e `failed`. Só o nome do erro vai para o log.

**O painel.** No ALB sem log, o botão "Ligar logs", com a confirmação do que muda (só o log daquele balanceador, num bucket
novo da pilha, o custo e como desfazer); os comandos de antes ficam recolhidos, em "Prefere fazer você mesmo?". Com
`stack_update_required`, `permission_denied` ou `bucket_rejected`, "Atualize a pilha da Verax", com o arquivo preenchido (a
mesma pilha, com `EnableAlbAccessLogs=true`). O ALB que a Verax ligou mostra, entre os disponíveis, de quando é e o
"Desligar log".

**Diferença de versão.** Nenhuma resposta ganhou campo (as rotas são novas). O painel novo num nó de antes recebe 404 sem código
na leitura do estado e mostra a tela de antes, os comandos; o painel de antes num nó novo nunca chama as rotas. Voltar o nó
para antes desta versão deixa a tabela sem uso (a cascata a leva com a fonte), e o log ligado continua ligado, como um que o
cliente tivesse ligado.

## Leitura dos logs do ALB: as tarefas `web-logs` e `web-logs-estimate` (`apps/api/src/weblogs/collect/`)

_(PR-4. Só existem no worker com `AWS_WEB_LOGS_ENABLED` ligado, fora da célula e com identidade na AWS: desligadas, nenhum
módulo é carregado e nenhuma chamada sai. Sem migration.)_

**Quem é lido.** A fonte `elb_logs` autorizada e não retirada, num estado de coleta, de conta ativa já verificada que entra
no papel, de cliente coletado; até 20 por conta. A permissão gravada não decide: quem prova é a leitura. O motor, o limite e
a configuração (modo, multiplicador, fontes confiáveis, rotas) são lidos do banco a cada passagem: a mudança no painel vale
na seguinte.

**O S3.** Só `ListObjectsV2` e `GetObject`, por um lugar só (`alb-bucket.ts`), com os clientes da descoberta (a trava de só
leitura) e a sessão de leitura da conta; o bucket fica na região do balanceador. O prefixo é o do balanceador até o id
(`[<prefixo>/]AWSLogs/<conta>/elasticloadbalancing/<região>/<dia>/<conta>_elasticloadbalancing_<região>_app.<nome>.<id>_`),
e a chave que volta da listagem só vira objeto se seguir a gramática (`alb/alb-key.ts`) e for dele: logs de conexão, de
health check, de NLB, de outro balanceador e objetos plantados nunca são abertos. Nada é gravado, marcado ou apagado na conta
do cliente, e nenhum log é sobrescrito.

| Chamada                                         | Quando                                                              | Teto                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Listagem ao vivo (a partir de 70 minutos atrás) | a cada passagem (5 min por balanceador)                             | 30 páginas de 1.000                                         |
| Conferência das pastas de ontem e de hoje       | de hora em hora, contra o registro; o que não cabe segue depois     | 40 páginas por passagem                                     |
| Atraso e lacuna                                 | só com atraso                                                       | 20 páginas por janela de 3 h; 100 por dia de lacuna         |
| Leitura de um arquivo                           | uma vez por arquivo (e a releitura das janelas, depois de reinício) | 64 MB compactados, 512 MB abertos, razão 200, 2 M de linhas |
| Estimativa                                      | só a pedido do cliente                                              | 10 páginas e 20 leituras de 4 bytes                         |

Tempo por chamada de 15 s; por objeto, 150 s no total e 20 s sem pedaço novo. Por execução (a cada 2 min, dois balanceadores
ao mesmo tempo), 4 minutos, 500 objetos, 2 milhões de linhas e 1,5 GB abertos, conferidos antes de abrir cada objeto; na
primeira vez, cada balanceador fica com no máximo um quarto disso. Linha maior que 64 KB é pulada e contada. O corpo vem em
pedaços, do S3 ao gunzip e às linhas, e quem dita o ritmo é a contagem: medido com 512 MB abertos, 15 MB de memória a mais e
13 ms no maior bloqueio do laço de eventos.

**Cada coisa uma vez só.** A ordem é: as linhas de um lote de objetos entram no motor; ele é avaliado e os achados são
gravados (a chave é sempre a mesma); só então cada objeto entra no registro (`WebLogObject`), com o volume medido e o tráfego
por país, numa transação. Parar antes do registro relê o objeto, e os achados caem nas mesmas chaves; parar no meio da
transação desfaz tudo; depois dela, o objeto nunca mais conta. A autorização (com a conta ativa e o cliente coletado) é
conferida antes de abrir cada objeto e, sob o lock da conta, dentro de cada transação, inclusive a do achado: depois de
confirmada a retirada, nada mais é aberto nem gravado. Um objeto cuja leitura foi cortada recomeça do zero na conta dele, e o
motor sabe quantas linhas já viu: nenhuma entra duas vezes. O mês do volume é o da leitura; o dia, o do tráfego.

**A memória e a concessão.** O motor vive na memória do processo. Por isso a concessão (`SyncState`, 5 min) não é devolvida
entre as execuções: duas réplicas que se revezassem veriam metade dos objetos cada uma. O processo que a perde, mesmo por um
instante, joga fora a memória. Num reinício, o resumo do dia volta do `WebEngineState` (gravado no máximo uma vez por slot
fechado) e os objetos dos últimos 70 minutos são relidos, sem cobrança, sem tráfego e sem achado novo. Os endereços que saíram
da memória entre a última gravação e a volta podem faltar no resumo do dia (990400).

**Ao vivo primeiro.** Os objetos dos últimos 70 minutos, em ordem; com objeto à espera, a avaliação usa o relógio dele, e o
slot que falta ler não fecha. O objeto que chega depois de o slot fechar é avaliado sozinho (`late`, contagem de piso). O que
ficou para trás, até 24 h, é lido do mais antigo para o mais novo num motor à parte com relógio virtual (até dois ao mesmo
tempo, com uma fração da memória), com a janela de 60 minutos de antes e de depois relida; o resumo do dia de hoje conta só o
que o motor ao vivo viu. Com mais de 24 h, nada é lido: cada arquivo vira uma linha `gap` no registro, na trilha (quantos e o
intervalo) e no estado.

**Início.** O primeiro intervalo inteiro depois da autorização: nada anterior é aberto (até 5 minutos depois dela também
não). Retirada e refeita, o intervalo sem autorização não é lido nem vira lacuna.

**Balanceador recriado.** A fonte é pelo nome. Com outro `app/<nome>/<id>`, o estado guardado sai, o modo volta a `observe`
por 72 h e a troca entra na trilha (`web_logs.settings_update`, ator sistema). A autorização continua. Sem estado guardado (a
fonte parada por mais de 3 dias), a troca não é percebida.

**Observar e alertar.** Em `observe`, nenhum achado, evidência ou aviso é gravado. O que abriria fica contado por regra e
nível, uma vez por achado, em `WebEngineState.state -> 'observation'` (`since`, `rules`, `truncated`), junto do que as fontes
confiáveis calaram nas últimas 24 h (`'suppressed'`) e das notas do motor (`'notes'`). Nada vira `alert` sozinho.

**Tráfego por país.** Toda linha do balanceador conta, antes de qualquer teto de memória, num vetor por objeto: requisições,
barradas, 4xx, 5xx e `flagged` (a linha que contou como sonda a caminho sensível, como ferramenta de ataque ou como falha de
login, uma vez). O país é o do endereço (`geo/`), `ZZ` sem ele; se a tabela não abrir, tudo sai `ZZ` e a detecção segue. De
hora em hora, as contagens com mais de 48 h passam para as horas.

**Saúde da fonte.** `authorized` → `waiting_events` (listou, nada lido desde a autorização) → `collecting`. `stalled`
(`web_unread`) só com arquivo à espera e nada lido há 2 h; `ingestion_error`: `web_gap` por 24 h depois de uma lacuna, o
código do erro na terceira falha seguida, ou `invalid_details` e `web_prefix_unsupported` já na primeira (nada é pedido à
AWS); `permission_error` com o motivo. `collecting` com `web_quarantined`: nas últimas 24 h, algum arquivo foi recusado
(quebrado, grande demais, arquivado, data absurda, ou que falha em cinco passagens em que outros foram lidos): fica no registro
(`quarantined`), sem cobrança nem tráfego; as linhas lidas antes da recusa seguem na detecção, com as contagens marcadas como
piso, para um ataque que estoura o limite do arquivo não sumir dos achados. O atraso é de agora ao fim do último intervalo lido. Nas últimas 24 h, linhas e
bytes saem do registro, com as tortas, as grandes demais e as alheias à parte. Um site quieto não para. O tráfego do ALB nunca
conta como sinal de vida da conta (`LastEvents`).

**A estimativa** (`web-logs-estimate`, a cada 30 s, até 5 pedidos por execução) é a única chamada à AWS por um balanceador
ainda não autorizado, e só porque o cliente a pediu: os nomes e os tamanhos dos arquivos de ontem e os 4 últimos bytes de até
20 (o tamanho descompactado do gzip), o que a sondagem da descoberta já alcança. Nenhum conteúdo é lido. Responde `ready`,
`no_sample` ou `failed` com o motivo (`bucket_denied`, `account_not_connected`, `source_not_available`...).

**O que não faz:** chamar o Wazuh, gravar em `AwsSource` de outro tipo, avisar por conta própria (só o achado alto ou crítico,
como sempre), ou guardar linha, chave, caminho ou endereço no log do worker (só contagens e códigos).

## Ataques web no painel (`apps/web/src/features/web-attacks/`)

_(PR-5. Nada muda num nó com os ataques web desligados, num nó de antes deles ou na célula: `/v1/web-logs` responde 404, e o
painel trata como inexistente, sem erro e sem pedir nada quando o onboarding diz que o tipo não é coletado.)_

**A leitura nova da API.** `GET /v1/web-logs/sources/:id/health` (a de `cloud_accounts:read`, atrás do mesmo guard): as contagens
de `WebLogObject` nas últimas 24 h (arquivos lidos, atrasados, recusados e sem leitura, com o intervalo da lacuna; linhas
analisadas, tortas, grandes demais e alheias; bytes), pelas mesmas regras da saúde da fonte (o lido pelo horário do tráfego; o
recusado e a lacuna por quando foram tratados). Da memória do motor (`WebEngineState`), o banco devolve só a observação sem as
chaves, o calado pelas fontes confiáveis e as notas (`readWebEngineView`): o resumo do dia, o único lugar com endereços fora dos
achados, nem chega à API. O que não é desta autorização, deste balanceador ou desta versão do formato não aparece
(`observed-since.ts` é a conta que a tarefa e a tela dividem); o pedaço fora do formato fica de fora sozinho. O atraso e a última
leitura continuam no onboarding (`AwsSource.health`).

**Fontes de log.** O balanceador que o Verax lê mostra o passo da estimativa, e a caixa dele só liga com uma estimativa que vale
(calculada, de até 7 dias, com a projeção):

| Situação        | O que a tela mostra                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Nunca pedida    | O que é lido para estimar (nomes e tamanhos) e o botão                                                   |
| Pedida          | A espera, relida a cada 4 s; depois de 3 min, o aviso de demora e a releitura a cada 30 s; e a anterior  |
| Pronta          | O volume por dia, quanto é do plano e de quê (mês ou franquia), o dia medido e até quando vale           |
| Sem amostra     | Que não deu para medir; dá para autorizar com a confirmação                                              |
| Falhou          | O motivo (o catálogo da estimativa, da permissão e da conexão; o resto, pelo nome do erro) e o que fazer |
| Mais de 7 dias  | Que não vale mais                                                                                        |
| Sem ler o plano | Que foi calculada; o volume e a porcentagem, nunca                                                       |

Na confirmação, o volume de cada um, o que é feito com o log e, acima de 20% (ou sem amostra, ou com a listagem cortada), uma caixa
por balanceador. A ciência é da estimativa vista (`estimateKey`): refeita, ou com o plano mudado, a caixa volta desmarcada. O campo
`webLogs` só vai no pedido que tem um balanceador. Recusado por a estimativa ter mudado, os números são relidos.

O que não dá para ler diz por quê: ALB sem log, com o "Ligar logs" (no nó que tem a rota; "Ligar o log de acesso do ALB pelo
painel") e os passos do cliente, recolhidos como alternativa (console e linha de comando; o nome do bucket entra nos comandos só
se seguir as regras da AWS, e o ARN só se for de um ALB desta conta e desta região); NLB e GWLB; bucket de outra conta; e o
prefixo, que se tira (os "buckets fora do padrão" são de outras fontes). Fora o log do ALB pedido no painel, **o Verax não liga
nada.**

**"Ataques web"**, na conta AWS, com um quadro por balanceador autorizado (a leitura só é pedida com o quadro aberto):

- o modo, com quanto falta das 72 h, o que teria virado alerta por regra e nível, e a janela que confirma antes de alertar;
- a leitura: o estado, o atraso, o que foi lido, o que ficou de fora e por quê, as notas do motor e o que foi calado;
- o multiplicador, as rotas declaradas e, do cliente inteiro, as fontes confiáveis, com o que elas nunca calam;
- o que a detecção não vê, sempre à vista.

Todos leem; os controles só aparecem para quem administra, com o monitoramento da conta ativo (quem decide é a API). As janelas
(`components/ui/confirm-dialog.tsx`) devolvem o foco a quem abriu ou, se ele saiu da tela, à lista; sem o overlay do Radix, que
injeta um `<style>` que a CSP recusa.

**O alerta.** No detalhe de um achado `alb`, a evidência fica no lugar do evento bruto, que não existe: contagens, respostas,
caminhos mascarados, endereços, User-Agent, amostras e a chave do arquivo no bucket do cliente (com o botão de copiar; nunca um
link). Tudo passa pelo schema estrito e é mostrado como texto. Código desconhecido (nota, família, classe, regra) aparece pelo
próprio nome. Com as amostras expiradas, a tela diz quando saíram e onde está o original. A exceção e a triagem são as de sempre.

**Demonstração (`dev:mock`).** Ligados, com um balanceador em cada situação na conta de produção da Alfa e quatro alertas; a
imitação da API está em `apps/web/src/mocks/web-logs.ts`. `localStorage['verax.mock.web-logs'] = 'off'` mostra o nó sem eles.

## Avisos por e-mail (`apps/api/src/notifications/`)

_(fase 2, PR-16: no código; o aceite é um achado crítico de teste no nó da Verax, com o SMTP ligado. PR-17': a
preferência de cada pessoa e o resumo por hora. D8: o contato de escalonamento, com a confirmação do endereço e o
descadastro)_

O nó avisa por e-mail, sem depender de quem está com o painel aberto. O aviso passa por uma fila de saída (_outbox_) no
Postgres, a tabela `Notification`, e o worker entrega. Nenhum e-mail sai de dentro da transação que grava o achado.

- **Quando nasce um aviso**, sempre com uma chave de deduplicação única por cliente (o mesmo fato avisa uma vez só,
  por mais que seja relido):

  | Tipo                      | Quando                                                                        | Chave                               | Quem recebe                   |
  | ------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- | ----------------------------- |
  | `incident_opened`         | um incidente abre alto ou crítico                                             | `incident:<id>:<severidade>`        | admin e analista¹; o contato² |
  | `incident_escalated`      | um incidente sobe para alto (de baixo ou médio) ou para crítico               | `incident:<id>:<severidade>`        | admin e analista¹; o contato² |
  | `critical_finding`        | um achado crítico fica fora de incidente (sem usuário, chave, IP nem recurso) | `finding:<id>`                      | admin e analista¹; o contato² |
  | `plan_usage`              | o volume do mês chega a 80% e a 100% do limite do plano                       | `usage:<AAAA-MM>:<80\|100>`         | só o admin                    |
  | `aws_ingestion_stalled`   | com conta AWS conectada, os eventos da AWS parados há mais de 2 h (PR-V6)     | `aws-stalled:<começo>`              | só o admin                    |
  | `escalation_confirmation` | o contato de escalonamento ganha um endereço novo ou a confirmação é pedida   | `escalation-confirmation:<geração>` | só o contato                  |

  ¹ Quem não desligou os avisos de incidente em Minha conta (PR-17', abaixo).
  ² O contato de escalonamento confirmado, só nos de severidade crítica (abaixo).

  Com `CASES_MODE=on`, o aviso de alerta é por caso, e não por alerta ("Avisos por caso", acima).

  Os três primeiros nascem no `FindingStore`, na mesma transação do achado e do incidente: todo coletor (Wazuh, agentes,
  GCP, Cloudflare) ganha o aviso sem mudança, e uma falha no meio não deixa nem o achado nem o aviso. O agrupamento
  (`IncidentGrouping.place`) devolve a severidade do incidente antes e depois do achado; a junção que não muda a
  severidade não avisa. O achado com exceção (esperado) nunca avisa.

- **Volume do plano:** a cada execução, a tarefa soma o uso do mês de cada cliente (`IngestUsage`, o medidor do PR-03,
  no mês do calendário de Brasília) e compara com o limite do plano do cliente (`TenantPlan`, CE-02; no nó dedicado, o
  `PLAN` e o `PLAN_MONTHLY_GIB`; o GiB é 2^30 bytes). Cada faixa avisa uma vez por mês. Num salto direto para 100%, o
  aviso de 80% nasce `skipped` (`superseded`) e sai um e-mail só. O aviso só informa: acima de 100%, a coleta, os
  achados e os incidentes continuam. O plano `interno` (nó da Verax) não tem limite, e nada é calculado; a Plataforma
  mede o volume por dia contra a franquia (CE-09), e o cliente da célula ainda sem plano fica de fora.
- **Entrega (tarefa `notifications` do worker, a cada 60 s, com a concessão `notifications` no `SyncState`):**
  - lê os avisos `pending` vencidos por faixa (`NOTICE_LANES`), a severidade primeiro: incidente crítico, alerta crítico,
    incidente alto, os demais incidentes e os avisos de operação (poucos por natureza) e, por fim, os alertas altos; em
    cada faixa, os mais antigos. Cada faixa com aviso vencido tem uma parte guardada da execução (um décimo, no mínimo
    1): a rajada de uma nunca deixa as de baixo esperando para sempre;
  - até 20 por execução **pedem e-mail**. O aviso que só entra em resumo (todos que recebem já passaram do limite da hora,
    ou ele tem 24 h ou mais na fila, e o contato de escalonamento, se é dele, fica de fora pelas mesmas regras) não conta
    nos 20: até mil por execução, em lotes de até 500, cada lote numa transação que só toma os avisos ainda intactos e só
    grava em resumo aberto. 12.836 avisos pendentes saem da fila em 14 execuções (eram 643, quase 11 horas, com o crítico
    que chegou por último na 642ª);
  - os resumos das horas que fecharam saem antes dos avisos novos (abaixo);
  - resolve os destinatários na hora do envio, pelo escopo do cliente do aviso: pessoas `active`, com MFA, sem troca de
    senha pendente, do papel que o tipo pede, com o cliente ativo e, nos três avisos de incidente, com a preferência
    ligada. `leitura` não recebe (decisão D8); a equipe da Verax não é do cliente;
  - um e-mail por pessoa, pelo mesmo transporte da API (`mailTransport`, SMTP com TLS no nó). O id de quem já recebeu
    fica no aviso, e a nova tentativa não repete o e-mail;
  - falha do envio: nova tentativa depois de 1, 5, 15 e 60 min; a quinta que falha deixa o aviso `failed`. Só o tipo
    do erro fica gravado (a resposta do servidor pode citar o endereço);
  - a tentativa que não chega a todos também conta, com o mesmo recuo, e quem já recebeu fica guardado: o prazo de
    envio de um aviso numa execução (1 min) esgotado (`delivery_timeout`, e o lote segue para o aviso seguinte) ou a
    execução interrompida no meio (orçamento de 5 min da tarefa ou parada do worker: a tentativa é gravada antes de a
    interrupção subir). Um aviso preso volta para o fim da fila e chega ao `failed` na quinta, sem segurar os outros;
  - sem e-mail no nó (`MAIL_TRANSPORT=none`; no nó de cliente, sem o e-mail dos nós configurado no plano de controle,
    seção "O e-mail dos nós de clientes") ou sem ninguém para receber, o aviso fica `skipped` (`mail_disabled`,
    `no_recipients`, ou `opted_out` quando havia quem recebesse e todos desligaram). Ligar o e-mail depois não dispara os
    avisos antigos;
  - uma falha no cálculo do volume não segura os avisos de incidente.
- **Preferência de aviso (PR-17', `NotificationPreference`):** cada pessoa escolhe, em Minha conta
  (`GET` e `PUT /v1/notification-preferences`, corpo estrito `{ incidentEmails }`), se recebe os avisos de incidente e
  de achado crítico. Sem linha, recebe. Só a própria pessoa muda a dela (a rota não recebe id), a mudança entra na
  trilha (`user.notification_preference`, com o estado anterior e o novo), e a lista de Usuários mostra a coluna
  "Recebe alertas" só para ler. `leitura` e a equipe da Verax leem `eligible: false`, e a mudança é recusada (403). Os
  avisos do volume do plano e da coleta parada não dependem dela: sem eles, ninguém do cliente saberia que a coleta
  parou ou que o plano encheu.
- **Resumo por hora (PR-17', `NotificationDigest`):** uma linha por pessoa e hora cheia (UTC, que bate com a de
  Brasília) conta os e-mails avulsos da hora. Até 5 saem avulsos; do 6º aviso da hora em diante, o aviso entra no
  resumo da pessoa (o id do aviso na linha e a pessoa em `digestedUserIds` do aviso, na mesma transação), e o resumo
  sai uma vez, quando a hora fecha, com até 10 itens (os críticos primeiro, depois na ordem da fila) e "e mais N" com
  o link do painel. O resumo não conta na hora seguinte, e a contagem recomeça a cada hora.
  - **retomada:** o aviso com 24 h ou mais na fila (o worker parado, o e-mail falhando) nunca sai avulso: entra no
    resumo da hora, que vira "Retomada dos avisos atrasados";
  - **as mesmas regras do aviso:** assunto fixo, os títulos fixos dos tipos, a hora de cada item e o link do painel,
    nada do achado, HTML escapado; 1, 5, 15 e 60 min de recuo e `failed` na quinta; a concessão de sempre (os resumos
    saem na mesma tarefa, até 20 por execução, e param se outra réplica a toma). A pessoa e a preferência são
    conferidas de novo no envio: quem perdeu o acesso não recebe (`no_recipients`), e quem desligou os avisos de
    incidente não recebe os que estavam reunidos (`no_items`);
  - a interrupção no meio de um aviso grava a tentativa como antes, e quem já foi para o resumo fica guardado: não é
    reunido de novo;
  - o resumo de milhares é barato: a linha é regravada uma vez por lote, o e-mail é montado lendo os avisos em lotes de
    mil e diz o total de verdade ("12.835 avisos no total").
- **Contato de escalonamento (D8; `apps/api/src/escalation/`):** o contato do cadastro do cliente (nome, e-mail e
  telefone) não é usuário: não tem login, MFA nem Minha conta. Por isso ele só recebe e-mail depois de confirmar que a
  caixa é dele, recebe só os críticos e sai por um link em qualquer e-mail.
  - **Quem muda:** a equipe da Verax, no cadastro de clientes (`PATCH /v1/tenants/:id`, auditado como `tenant.update`),
    e quem administra o cliente, na tela Administração → **Escalonamento** (`GET` e `PUT /v1/escalation-contact`,
    sempre o cliente da sessão, permissões `escalation_contact:read` e `:write`, auditado como
    `escalation_contact.update` com o contato anterior e o novo). Nos nós de clientes, o cadastro é feito pelo próprio
    cliente, sem a Verax no meio. Analista e leitura não veem nem mudam.
  - **Estados** (`Tenant.escalationState`): `pending` (aguardando confirmação), `confirmed` e `unsubscribed`. Endereço
    novo (sem diferença de maiúsculas) volta a `pending`, sobe a geração (`escalationGeneration`), apaga os links das
    gerações anteriores e põe o pedido `escalation_confirmation` na fila, na mesma transação; mudar só o nome ou o
    telefone não mexe em nada disso. Os contatos que já existiam antes deste controle começam em `pending`, sem pedido
    na fila: quem administra pede a confirmação pelo painel. Toda troca e todo pedido travam antes a linha do cliente
    (`SELECT ... FOR NO KEY UPDATE`, a mesma trava do `UPDATE`) e só então leem o contato: duas requisições ao mesmo
    tempo nunca decidem sobre um endereço que a outra já trocou (sem isso, uma troca só de nome que leu A gravaria A de
    volta depois da troca para B, sem recomeçar a confirmação, e o link mandado a B confirmaria A).
  - **Pedir a confirmação de novo** (`POST /v1/escalation-contact/confirmation` e, para a Verax,
    `POST /v1/tenants/:id/escalation-contact/confirmation`, auditados como `escalation_contact.resend`): só com o
    contato aguardando ou descadastrado (o confirmado recebe 409 `ESCALATION_CONTACT_CONFIRMED`; sem contato, 409
    `ESCALATION_CONTACT_MISSING`). Sobe a geração, e os links anteriores deixam de valer. Entre dois e-mails de
    confirmação do mesmo cliente, no mínimo 5 min (`ESCALATION_CONFIRMATION_INTERVAL_MINUTES`), contados do último que
    **saiu de fato** (o `sentAt`), não do pedido: um pedido entregue com atraso (o worker parado, a fila atrasada, as
    novas tentativas) não abre espaço para outro logo em seguida. A fila segura o novo até lá e encerra os pendentes
    das gerações anteriores (`superseded`), e o worker confere o intervalo de novo no envio: dentro dele, o pedido volta
    para a fila até o fim do intervalo, sem gastar tentativa e sem ser descartado (`postponed` no relatório da tarefa).
    Trocas seguidas viram um e-mail só, para o último endereço.
  - **O e-mail de confirmação** sai pelo worker, como os avisos (mesmas tentativas, recuo e `failed`). O endereço vem
    do cadastro na hora do envio; o pedido de uma geração que já não é a atual, com o contato fora de `pending` ou com
    o cliente desativado sai como `skipped` (`superseded` ou `tenant_inactive`). Os dois links (confirmar, de uso único
    e 72 h; descadastrar, um ano) nascem no envio: 32 bytes aleatórios, e no banco só o SHA-256
    (`EscalationContactToken`, com o cliente, a finalidade, a geração e a validade). Se o e-mail não sai, os links saem
    do banco. O texto diz o que ele vai receber e que, sem a confirmação, nada mais chega.
  - **Os links** levam o valor no fragmento (`<painel>/escalonamento/confirmar#token=...` e `/descadastrar`), que
    nenhum servidor vê. A página pública do painel o tira da barra de endereço e pede um clique (um verificador de links
    do e-mail que abre o endereço sozinho não confirma nem descadastra) antes do `POST` em
    `/v1/public/escalation-contact/confirm` ou `/unsubscribe`, com `{ token }` no corpo. As rotas são públicas, mas só
    aceitam a origem do painel e JSON, e têm limite por IP (10 em 15 min, somadas as duas, `PublicLinkAttempt`, o mesmo
    interruptor das rotas de autenticação). Confirmar exige o link de confirmação, dentro da validade, da geração
    atual, com o contato aguardando; apaga todos os links de confirmação do cliente. Descadastrar exige o link de
    descadastro da geração atual e é idempotente (o segundo clique responde o mesmo). Qualquer outro caso recebe a
    mesma recusa (400 `ESCALATION_LINK_INVALID`, "Link inválido ou vencido"), e a resposta nunca diz o cliente nem o
    endereço. Só a mudança de estado entra na trilha do cliente (ator anônimo, `escalation_contact.confirm` e
    `.unsubscribe`); a recusa e o segundo clique ficam fora dela, como as recusas anônimas dos guards (a rota é
    `@SelfManaged` por isso, e o meta-teste de rotas a lista).
  - **O que ele recebe:** os avisos de severidade crítica (`incident_opened` e `incident_escalated` críticos e
    `critical_finding`), nunca os altos, o volume do plano nem a coleta parada. Na entrega do aviso, depois das
    pessoas, com o mesmo prazo, a mesma interrupção e o mesmo recuo, o contato é lido do cadastro: só o `confirmed`, com
    o cliente ativo. A decisão fica no aviso (`escalationDelivery`, com a hora), e a nova tentativa não repete o e-mail:
    `sent`; `limited`, do 6º e-mail da hora em diante (ele não recebe resumo, então o que passa disso ele não recebe,
    e as pessoas continuam com o resumo); ou `stale`, o aviso com 24 h ou mais na fila (as pessoas recebem a retomada).
    Se só o contato receberia e ficou de fora, o aviso fecha `skipped` (`escalation_limited` ou `escalation_stale`).
    Quem é contato e também pessoa do cliente que recebe aquele aviso recebe um e-mail só (o de pessoa).
  - **O e-mail ao contato:** o mesmo título e o mesmo texto fixos do aviso das pessoas, o link do painel (com login) e,
    no lugar da dica de Minha conta, o link de descadastro, novo a cada e-mail (só o hash fica no banco).
- **O que o e-mail diz:** assunto fixo por tipo e severidade (sem CR nem LF), um texto fixo e o link do painel
  (`${WEB_ORIGIN}/incidentes/<id>`, `/achados?achado=<id>`, `/cadastros/contas` ou `/cadastros/plano`). Nenhum IP, usuário,
  chave, recurso, conta, título de regra ou região: o e-mail pode ser encaminhado, e os detalhes ficam atrás do login
  com MFA. O nome de quem recebe vai escapado no HTML. Nos avisos de incidente, o fecho diz como deixar de receber
  (Minha conta).
- **Nada de endereço no log nem na fila:** a fila e o resumo guardam só o id de quem recebeu (ou de quem foi para o
  resumo) e, do contato de escalonamento, só a decisão; o log do worker leva só as contagens da execução (`folded`,
  `digests` e `escalation` incluídos). Os links do contato não vão para o log da API nem para a trilha.
- **Isolamento e expurgo:** `Notification`, `NotificationPreference`, `NotificationDigest` e `EscalationContactToken`
  entram no escopo do cliente (`TENANT_SCOPED_MODELS`); a busca do link pelo hash, na rota pública, é a única sem
  escopo, e tudo o que vem depois vai pelo escopo do cliente do link. A chave estrangeira do achado inclui o cliente, um gatilho confere o cliente do incidente,
  e outro confere que a pessoa da preferência e do resumo é do mesmo cliente (a equipe da Verax, sem cliente, nunca
  passa). Apagar o incidente ou o achado apaga o aviso junto, e o expurgo diário (seção "Expurgo do histórico") apaga
  os avisos resolvidos e as horas de avisos (o resumo resolvido e a hora só de contagem) sem mudança há 90 dias.
- **Configuração:** o worker recebe o mesmo bloco de e-mail da API (`MAIL_TRANSPORT`, `MAIL_FROM`, `SMTP_*`) e a
  origem do painel (`WEB_ORIGIN`), que o `start.sh` escreve no `worker.env` só com `MAIL_TRANSPORT=smtp` no
  `node.conf`. Sem o e-mail, o `worker.env` não muda, e o worker sobe com `none`. Nos nós de clientes, o SMTP é o da
  Verax (decisão D-16, sem SES).

## Torre: semáforo, saúde da coleta e pulso da operação

_(T5.10 e T7.6; a saúde da coleta e o pulso são a fase P1 da "Operação ao vivo", OP-01 e OP-02, de 05/11/2026)_

`GET /v1/tower` (`apps/api/src/tower/`) responde, para o cliente da sessão, "está tudo bem?" e "o que decidir agora?".
As regras ficam em `tower-rules.ts`, e o contrato em `packages/shared/src/tower.ts`. O painel consulta a cada 60 s
(TanStack Query, sem consulta com a aba em segundo plano). Tudo é lido pelo escopo do cliente (`prisma.scoped()`), com
o teste negativo A/B; só a fila sem dono e o medidor parado do nó, que não são de cliente nenhum, vão só para a equipe
da Verax.

- **Custo** (todo painel aberto pede a Torre a cada 60 s): o MITRE de 30 dias é contado pelo banco por combinação de
  táticas e técnicas (`ReportsService.mitre`, SQL com parâmetros e o cliente da sessão) e passa pelo mesmo cálculo do
  relatório; a Torre repete o resultado por até 30 s por cliente e processo (`TenantCache`, até 500 clientes, um cálculo
  só para pedidos juntos), e o relatório nunca. A contagem dos alertas altos e críticos em "novo" usa o índice
  `(tenantId, status, severity)`. As demais leituras usam os índices da janela de 24 h. Com 750 mil achados: a Torre vai
  de 6,5 a 7,9 s para 0,3 s (0,1 s com o MITRE guardado), e dez painéis juntos, de 63 s para 0,7 s.
- **Semáforo** (pendência 9, com a coleta parada aprovada em 05/11/2026):
  - **vermelho** com incidente crítico aberto;
  - **amarelo** com incidente alto aberto, nota de postura abaixo de 70 ou **coleta parada** (`collection_stalled`):
    uma fonte configurada sem dado novo há mais que o prazo de parada dela. Silêncio não é segurança: sem isso, o verde
    de um cliente cuja coleta parou mentiria. Fonte **não configurada** (o cliente sem Cloudflare, sem agentes) ou
    ainda **sem nenhum dado** (conta recém-cadastrada) nunca deixa a Torre amarela;
  - **amarelo** também com **alerta alto ou crítico para validar** (em "novo"): desde 17/11/2026, um incidente só existe
    depois que uma pessoa promove um alerta, e "nenhum incidente aberto" com a fila cheia não é calma. A contagem é a da
    decisão `untriaged_finding`, e a lista de motivos não ganha um valor novo: ela é fechada, e um painel de antes
    recusaria o resumo inteiro. O amarelo pode, então, vir sem motivo, e o painel tira a frase das decisões ("24.321
    alertas altos ou críticos para validar"), inclusive de um nó de antes, que ainda responde verde;
  - **com os casos**, a regra e a conta são as mesmas; só as decisões passam a contar casos ("Casos na Torre, no radar e nos
    relatórios");
  - **verde** nos demais casos. No verde, a frase traz a prova: "Tudo calmo. (...) Coleta ativa em 4 de 4 fontes,
    último dado há 2 minutos" só quando todas as fontes configuradas coletam e nada espera uma decisão do cliente (a fila
    sem dono, da Verax, não conta); com uma atrasada ou aguardando, a mesma prova, sem o "Tudo calmo". O cartão de
    decisões vazio faz o mesmo ("Tudo calmo: nada para decidir agora", ou o estado vazio que aponta a fonte parada).
  - Os limites ficam na configuração (`DEFAULT_TOWER_THRESHOLDS`): postura 70; conta silenciosa 24 h; e, por fonte,
    os prazos de atrasada e de parada.
- **Saúde da coleta** (no lugar da antiga "Cobertura"): uma linha por fonte, com o estado (coletando, atrasada, parada,
  aguardando o primeiro dado, não configurada) e o último dado que prova a coleta. O estado é da fonte: basta uma conta
  entregando, e a conta com problema aparece na conexão dela (Contas cloud) e entre as silenciosas.

  | Fonte                | Configurada com   | Último dado (prova de vida)                                                       | Atrasada / parada |
  | -------------------- | ----------------- | --------------------------------------------------------------------------------- | ----------------- |
  | AWS                  | conta AWS ativa   | o andamento dos eventos da AWS no Wazuh do nó (`IngestHealth`) ou o último alerta | 30 min / 2 h      |
  | GCP                  | projeto ativo     | a última leitura bem-sucedida da assinatura (a cada minuto) ou a última entrada   | 15 min / 1 h      |
  | Cloudflare           | conta ativa       | a última leitura bem-sucedida ou a última entrada                                 | 30 min / 2 h      |
  | Agentes              | agente registrado | o keepalive mais recente                                                          | 15 min / 1 h      |
  | Postura e inventário | conta AWS ativa   | a mais antiga entre a última varredura e o último retrato (as duas têm de andar)  | 26 h / 50 h       |

  O prazo de parada da AWS é o mesmo de "Sem logs novos da AWS" e do aviso `aws_ingestion_stalled` (PR-V6). **Nenhuma
  fonte exige evento para estar viva:** uma conta ou um projeto calmo passa dias sem evento com a coleta saudável, e só
  a leitura que deixa de dar certo atrasa e para a fonte. O último evento das fontes de contas cloud aparece à parte,
  na linha de cada uma (`lastEventAt`: na AWS, o último alerta; na GCP, a última entrada do Pub/Sub; no Cloudflare, a
  última entrada da auditoria).

- **Sinal de vida da AWS (OP-01):** o índice `wazuh-alerts-*` é de alertas, não de tráfego. Os eventos comuns de uma
  conta calma (CloudTrail genérico, bloqueio do WAF, GuardDuty de baixa gravidade) têm nível 3 no Wazuh e nunca viram
  alerta (`log_alert_level` 5), então o `lastEventAt` de uma conta AWS é o **último alerta**, não o último dado. Antes do
  OP-01, uma conta calma e saudável aparecia "sem eventos há mais de 24 horas". Agora, com a conta conectada, o
  andamento dos eventos do módulo da AWS no analysisd (`IngestHealth.lastProgressAt`, a cada 5 min) também é sinal de
  vida da conta e é o último dado da fonte; o último alerta aparece à parte, na linha da AWS. O contador é do nó (o
  analysisd não separa contas), então vale para cada conta AWS conectada do cliente; a conta com erro de conexão depende
  do próprio alerta. No começo da observação, `lastProgressAt` é a hora em que ela começou: por até 30 min, a fonte pode
  aparecer coletando antes do primeiro evento de fato. O resumo leva `coverage.lastDataAt` (o último dado entre todas
  as fontes) e `coverage.sources`; `lastEventAt` continua o mesmo campo, com a semântica dita.
- **Sinal de vida da GCP (OP-02, revisão):** o sink só encaminha auditoria (atividade de administração, sistema,
  política e acesso a dados, onde ligado) e as negações do Cloud Armor, e um projeto calmo passa dias sem entrada
  nenhuma. Com a última entrada como prova, a Torre do nó da Verax ficaria amarela com a coleta saudável. A prova é a
  **última leitura bem-sucedida da assinatura** (`CloudAccount.lastCollectedAt`, que o sync grava a cada leitura sem
  erro, com ou sem entrada; a leitura que falha só grava o erro na conexão), sem migration. A tarefa lê a cada minuto
  (`SYNC_INTERVAL_SECONDS`): atrasada com 15 min sem leitura bem-sucedida, parada com 1 h. A conta silenciosa da GCP
  segue a mesma regra (a leitura ou o evento, como no Cloudflare). O selo da conexão em Contas cloud não muda: a conta
  da GCP só passa a "Conectada" com o primeiro evento. O que se perde é o aviso de um sink apagado com a assinatura
  ainda lida: a última entrada, à parte na linha da GCP, mostra há quanto tempo nada chega.
- **Pulso da operação:** uma faixa de cartões de número, com o que já existe, sem coleta nova:
  - os **achados** das últimas 24 horas cheias (da hora cheia de 23 horas atrás até agora, pelo índice
    `(tenantId, occurredAt desc)`), quantos chegaram esperados por exceção e o minigráfico por hora. O total e os
    esperados são contagens exatas; as horas e a mediana vêm dos 5.000 mais recentes;
  - o **tempo até detectar**: a mediana de `createdAt − occurredAt` desses achados, que inclui o atraso de entrega da
    fonte;
  - os **agentes online** (ativos) de registrados;
  - os **eventos lidos no mês** pelo medidor (`IngestUsage`), só AWS e GCP: o Cloudflare mede entradas de auditoria e
    linhas agregadas, não eventos.
    Uma fonte que o cliente não tem (nenhum agente, nenhum volume) some, em vez de aparecer como zero.
- **Contrato entre painel e nó:** os campos novos (`coverage.lastDataAt`, `coverage.sources` e `pulse`) são opcionais,
  e o painel sem eles mostra a Torre de antes (as datas da cobertura, sem a faixa). O schema é estrito, então um painel
  de antes recusa a resposta de um nó novo (o motivo `collection_stalled` e os campos novos): painel e nós sobem juntos,
  como em toda mudança do contrato. Os campos dos casos são a exceção: só vêm para quem os pede (`cases=true`).
- **Interface:** os gráficos são SVG próprio, sem biblioteca (`components/charts/`): o cartão de número (`StatTile`) e o
  minigráfico por hora (`MiniBars`, na rampa neutra validada, com setas, mouse e toque e a mesma tabela de "Ver
  tabela"); a linha de saúde da fonte (`SourceHealthRow`) usa ícone de forma própria e rótulo, com o tom de "ok" em
  coletando, o de médio em atrasada e o de alto em parada. Todos estão no `/catalogo`.

### Mapa de origens (a faixa no topo da tela Detecções)

_(decisão do responsável pelo produto, 24/11/2026: um mapa-múndi com um ponto por país de onde vêm as requisições, em faixa
larga e recolhível no topo da tela Detecções, com o volume real dos logs do load balancer. Só existe para quem tem a fonte.)_

**A rota.** `GET /v1/web-logs/traffic?window=24h|7d|30d` (24 horas sem pedir outra), contrato estrito em
`packages/shared/src/web-traffic.ts`. Só leitura, do cliente da sessão (nenhum id vem do request), com `tower:read`: a permissão
do resumo do topo da tela, que todos os papéis têm; quem vê um vê o outro. Como tudo em `/v1/web-logs`, 404 com
`AWS_WEB_LOGS_ENABLED` desligado. A resposta tem só contagens: nenhum nome de balanceador, conta, endereço, caminho ou host.

| Grupo          | O que entra                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `countries`    | Só o cliente direto (`direct`) com país na tabela, do maior volume ao menor, com o "agora"      |
| `unknown`      | Cliente direto sem país (`ZZ`)                                                                  |
| `throughProxy` | `proxy` (CDN e proxy do cliente): o país seria o da borda                                       |
| `internal`     | `private`                                                                                       |
| `unverified`   | Endereço público lido sem a lista das CDNs: no painel, conta como origem desconhecida, com nota |

- **O "agora"** são os 15 minutos até `lastClosedAt`, e não até a hora do pedido: a AWS entrega o log de 5 a 10 minutos depois,
  e contados de agora os últimos minutos estariam sempre vazios. `lastClosedAt` é a posição do leitor (`CollectorCursor`), do
  balanceador mais em dia: o intervalo com o registro mais novo não serve, porque num site quieto ele pode ser de horas atrás.
  (Só enquanto o leitor recupera um atraso vale o do registro mais novo: a posição fica no atraso, e os minutos de agora já
  foram lidos, porque a leitura ao vivo vem primeiro.)
  Na prática, a onda mostra o que aconteceu de 10 a 35 minutos atrás, e o painel diz até que hora. O intervalo já lido e ainda
  não fechado conta no total, e não no agora.
- **Estados:** `no_source` (nenhum balanceador com a leitura autorizada, num estado de coleta e de conta ativa: nada do tráfego
  é lido), `waiting` (nenhum arquivo lido desde a autorização, e nada na janela), `stale` (nenhum balanceador lido há mais de 45
  minutos: em dia, são de 10 a 20) e `ok`. `sources` diz quantos estão autorizados, em dia, só observando e com problema.
- **Janelas:** 24 horas pelos intervalos de 5 minutos; 7 e 30 dias por hora inteira (o que passa de 48 h já está nas horas). As
  três cabem no menor histórico de plano (30 dias) e nos 35 dias do tráfego: nenhum plano limita nada aqui.
- **Custo:** memória por cliente e janela, de 30 s (24 horas) e 2 min (7 e 30 dias); pedidos juntos fazem um cálculo só. São
  duas leituras do `byCountry`, o recente antes do total (o que entra no meio só pode estar a mais no total). Medido com 2
  balanceadores: num site com cerca de 57 linhas por intervalo e balanceador (66 mil linhas de 5 minutos, 152 mil horas), o
  recente 1 ms, 24 horas 10 a 13 ms, 7 dias 22 a 25 ms, 30 dias 52 a 55 ms; no pior caso (120 países e 3 classes em todo
  intervalo, 2 clientes, 830 mil linhas e 1,1 milhão de horas), 5 a 8 ms, 72 a 110 ms, 240 a 320 ms e 340 a 450 ms.

**A faixa** (`features/detections/origin-band.tsx`), acima do resumo e da lista:

- **Quem não a tem vê a tela de sempre:** com 404 (o nó desligado, ou um nó de antes), `no_source` ou a primeira resposta
  falhando, nada aparece e nada pula. O nó sem a rota é perguntado uma vez por visita; sem balanceador, de 5 em 5 minutos.
- **Quem a tem:** pedida a cada 60 s com a aba à vista (em segundo plano, nada; ao voltar, na hora). A atualização que falha
  mantém os números, com o aviso, e nada pulsa. Recolhível, com a escolha guardada neste navegador por pessoa; no celular começa
  recolhida; por um link direto (alerta, incidente, análise) também, só daquela vez: quem chega por ele vem pelo que ele abre.
- **A lista não pula:** o navegador guarda, por pessoa e cliente, que a faixa existia e a altura dela com aquela largura de janela
  (`origin-place.ts`), e a visita seguinte reserva o lugar. Só na primeira visita depois de autorizar a fonte o lugar não existe
  ainda.
- **Pacote:** o desenho do mundo (à parte, 41 KB) só é baixado com a faixa aberta.
- **Clicar num país não filtra a lista:** a API das listas não tem filtro por país. A dica é só informação.

**A marca do país** (`isFlagged`, em `world-map-model.ts`): todo site recebe sondagem o tempo todo, de todo lugar, e com uma só
bastando o mapa ficaria vermelho. O país é marcado com 50 suspeitas ou mais na janela (`FLAGGED_MIN`), ou com 10 ou mais
(`FLAGGED_MIN_WITH_SHARE`) que sejam pelo menos 1% das requisições dele (`FLAGGED_MIN_SHARE`). Os dois números são de um dia e
crescem com a janela (350 e 70 em 7 dias, 1.500 e 300 em 30). A onda só sai na cor do crítico em país marcado; o número de
suspeitas de todos continua na dica, na lista e na tabela.

**O componente** (`components/security/world-map*`), também no `/catalogo`:

- **Desenho:** `WORLD_LAND_PATH`, um caminho SVG de 17 KB, sem fronteiras (nada de político é desenhado), na projeção de
  Robinson centrada em 11° L e recortada de 83,7° N a 57° S, num quadro de 2000 por 820 (2,44 por 1). O corte cai em 169° O, no
  estreito de Bering: a Rússia, Fiji e a Nova Zelândia ficam inteiras. A Antártida fica fora.
- **Pontos:** 246 dos 250 códigos que a API pode produzir (ISO 3166-1 mais `XK`). `AQ`, `BV`, `GI` e `UM` não têm ponto e
  aparecem só na lista e na tabela. O ponto é o de rótulo do Natural Earth, conferido contra o contorno do país ao gerar; o
  rótulo de arquipélago que cai no mar vai para a maior ilha, e os territórios que o arquivo desenha dentro de outro país
  (Guiana Francesa, Reunião, Svalbard e outros) saem do pedaço deles.
- **Fonte e licença:** Natural Earth 5.1.2, domínio público, sem exigência de atribuição. Os dois arquivos e o SHA-256 de cada
  um estão no cabeçalho de `apps/web/src/components/security/world-map-data.ts`.
- **Regerar:** `node scripts/update-world-map.mjs ne_110m_land.geojson ne_50m_admin_0_countries.geojson` (o comando inteiro
  está no cabeçalho do script). Não acessa a rede, recusa arquivo fora do formato, não copia texto do arquivo para o código e
  dá sempre a mesma saída. Código novo na API, ou dado que mude a lista dos sem ponto, para o gerador: quem revisa decide.
- **Dados:** `WorldTraffic` (`world-map-model.ts`). Cada requisição está em um grupo só (um país, origem desconhecida, endereço
  interno ou CDN e proxy), e o percentual é sobre a soma de todos: o que não tem lugar no mapa fica numa linha à parte.
- **Animação:** a onda é só CSS (`transform` e `opacity`), em no máximo 60 pontos, com 12 fases num período de 2,4 s, dez
  períodos por volta da animação (cada volta acorda a página) e botão de pausa lembrado por pessoa. Com menos movimento
  pedido, começa parada, com um anel fixo. Sem log novo, nada pulsa.
- **Pacote:** a página usa `LazyWorldMap`; o desenho fica num arquivo à parte, fora do pacote principal.
- **Demonstração:** dados fictícios que andam com o relógio e são sempre os mesmos no mesmo minuto (`mocks/web-traffic.ts`); só
  a Alfa tem a fonte. `localStorage['verax.mock.traffic']` escolhe outra situação (`stale`, `waiting`, `no_source`, `off`,
  `error`, `slow`).

## Plano do nó: limites e uso

Cada nó tem um plano (fase 2, PR-03 e PR-18). Quem vale é o ambiente: `PLAN` e os ajustes `PLAN_*` do `node.conf`,
escritos pelo `start.sh` no `api.env` e no `worker.env`, sobre a tabela de `packages/shared/src/plans.ts`. A API lê o
plano na partida (`apps/api/src/plan/plan.service.ts`); trocar de plano é trocar o `node.conf` e reiniciar. O painel só
mostra o plano, nunca o edita, e o nó da Verax é `interno`, sem limite nenhum.

**O plano é de cada cliente** (CE-02, para a célula da Plataforma): uma linha `TenantPlan` por cliente (o id, os quatro
limites e a franquia contratada em GB/dia, só na Plataforma), lida pelo `TenantPlanResolver`
(`apps/api/src/plan/tenant-plan.ts`). As vagas, o histórico das telas, a evolução da postura, o expurgo e os avisos de
volume leem o plano do cliente, e não mais o do ambiente.

- **Nó dedicado** (`NODE_MODE=dedicated`, o padrão; sem a linha no `node.conf`, nada muda): o `node.conf` continua
  sendo a fonte. Na primeira leitura de cada cliente no processo (da API ou do worker), a linha dele é semeada do
  ambiente (gravada se falta ou se difere, com `source = env`, na transação da requisição quando houver), e a leitura
  devolve o plano do ambiente; trocar o `node.conf` e reiniciar continua trocando o plano. A semeadura não vai para a
  trilha: quem muda o plano é o `node.conf`.
- **Célula** (`NODE_MODE=cell`): vale a linha que o comando do plano de controle gravou (CE-05, `source =
control_plane`), e o `PLAN` e os ajustes do ambiente são recusados na partida. O cliente ainda sem linha fica do lado
  seguro: criar e reativar são recusados com 409 `TENANT_PLAN_MISSING` (desativar passa), "Plano e uso" responde o
  mesmo 409, o histórico das telas fica no piso (30 dias), e o expurgo e os avisos de volume o deixam de fora.
- **Só o sistema grava:** a única escrita é `writeTenantPlan` (um meta-teste procura outra no código-fonte), o plano é
  conferido antes (`parseTenantPlan`, em `packages/shared/src/plans.ts`) e de novo por CHECK no banco (a faixa de cada
  limite e a combinação de plano, limites e franquia), o escopo do cliente lê a linha mas recusa gravá-la
  (`SYSTEM_WRITTEN_MODELS` em `tenant-scope.ts`), e outro meta-teste confere que nenhuma rota aceita, em nenhuma
  profundidade do corpo, da query ou dos parâmetros, um campo do plano (`apps/api/test/tenant-plan.test.ts`).
- **A Plataforma** (`plataforma`, plano de cliente que o `node.conf` não aceita): contas, usuários, histórico e a
  franquia sempre vêm do plano de controle, sem padrão no repositório, e ela não tem volume do mês (o volume é a média
  diária no ciclo contra a franquia: seção "Célula compartilhada (Plataforma)", "Medição e franquia"). Em "Plano e
  uso", o volume do mês dá lugar ao contador da franquia (CE-10).

- **Vagas** (`packages/shared/src/plan-usage.ts`): contas cloud ativas (AWS, GCP e Cloudflare) e usuários do cliente
  convidados ou ativos. A equipe da Verax (`admin_verax`) nunca conta. Criar e reativar pedem vaga; desativar e
  excluir liberam.
  Descer de plano com o uso acima do novo limite não desativa nem apaga nada: só a próxima criação é recusada, e o
  painel mostra "acima do limite do plano".
- **Onde a vaga é conferida:** `assertWithinPlan` (`apps/api/src/plan/plan-limits.ts`), sempre na transação que grava,
  sob `pg_advisory_xact_lock(hashtext('verax:plan:<vaga>:<cliente>'))` (`lockPlanSeats`). Duas criações simultâneas no
  limite menos 1 terminam com uma aceita. Toda escrita que muda o status (ativar ou desativar, inclusive o `DELETE`)
  pega o mesmo lock **antes** de ler o recurso: a decisão tomada sobre o status lido vale até a gravação, e uma
  desativação que corre junto com uma reativação e uma criação não deixa as duas usarem a mesma vaga. O lock do plano
  vem antes dos das origens de log e da credencial (as contas cloud), sempre na mesma ordem. Os pontos:
  - cadastro, reativação, desativação e exclusão de conta cloud (`POST`, `PATCH` e `DELETE /v1/cloud-accounts`, e
    `POST /v1/cloud-accounts/:id/delete`);
  - cadastro, reativação e desativação de usuário (`POST`, `PATCH` e `DELETE /v1/users`), inclusive o primeiro
    administrador de um cliente novo (`POST /v1/tenants`, que sempre tem vaga);
  - o bootstrap do nó: as contas da GCP (no limite, a conta fica de fora com `plan-limit`, e o resto segue) e, no modo
    `customer`, o `admin_cliente` (no limite, um e-mail novo é recusado; o primeiro sempre tem vaga).
- **Recusa:** 409 com o código `PLAN_LIMIT_REACHED` e a mensagem que diz o limite do plano do cliente ("Seu plano
  permite até 3 contas cloud ativas. Desative uma conta ou fale com a Verax para ampliar."), na trilha do cliente como
  falha, com a ação de sempre (`cloud_account.create`, `cloud_account.update`, `user.create` ou `user.update`).
- **Volume do mês:** o medidor de uso (PR-03) soma os bytes lidos por cliente, mês do calendário de Brasília e fonte
  (`aws` pela tarefa `wazuh-usage`, PR-V6: os bytes que o analysisd do nó recebe, que incluem os dos agentes do Wazuh
  quando ligados; na célula, pela medição na origem de cada cliente, a tarefa `aws-volume` do CE-09, no mês em que o
  objeto foi criado).
  Acima do plano nada é bloqueado nem descartado: a coleta continua, e os achados continuam sendo gravados. O painel
  mostra uma faixa a partir de 80%; os avisos por e-mail de 80% e 100% estão na seção "Avisos por e-mail".
- **Histórico:** `historyDays` é o prazo do expurgo (PR-19) e o alcance das telas (PR-20, abaixo).
- **`GET /v1/plan`** (permissão `plan:read`, só administradores): o plano resolvido do cliente da sessão (rótulo e os
  quatro limites) e o uso dele (contas ativas, usuários convidados ou ativos, o mês e os bytes lidos nele). Tela: Administração
  → **Plano e uso** (`/cadastros/plano`), só leitura, com uma barra por contador.

### Histórico nas telas (PR-20)

As telas não prometem mais do que o banco guarda. Os filtros de período de achados, auditoria e relatórios têm
`24h`, `7d`, `30d`, `90d` e `12m` (365 dias; os relatórios começam em `7d`), com os dias de cada um em
`HISTORY_PERIOD_DAYS` (`packages/shared/src/history.ts`).

- **Recusa na API:** o período mais longo que o histórico do plano é recusado com 400, o código
  `PERIOD_BEYOND_PLAN_HISTORY` e a mensagem "Seu plano guarda 90 dias de histórico. Escolha um período menor ou fale
  com a Verax para ampliar." (`assertPeriodWithinHistory`, `apps/api/src/plan/plan-history.ts`, chamada pelos
  controllers de `GET /v1/findings`, `GET /v1/audit` e `GET /v1/reports/:kind`). No Essencial, `12m` é recusado; no
  Profissional e no Interno (sem limite), aceito; um ajuste do Enterprise abaixo de 90 dias recusa também `90d`. A
  auditoria segue a mesma regra, embora a trilha fique ao menos 13 meses: o filtro é o do plano em todas as telas.
- **`GET /v1/plan/history`** (permissão nova `plan_history:read`, todos os papéis): só `{ historyDays }`, o do plano
  do cliente da sessão (CE-02), sem outro dado de cliente. A equipe da Verax lê sem escolher cliente: no nó dedicado,
  o histórico do ambiente; na célula, o menor entre os planos gravados (a visão de todos não promete mais do que o
  cliente que guarda menos). O `GET /v1/plan` continua só dos administradores; o histórico saiu à parte porque os
  filtros de achados e relatórios são de todos os papéis.
- **Painel** (`apps/web/src/features/plan/plan-history.ts`): cada seletor de período mostra só os períodos que cabem
  no histórico. Enquanto o plano não chega (ou se a leitura falha), só os que todo plano tem (até 30 dias, o piso dos
  ajustes); um período da URL que não cabe é ignorado e nunca vai para a API, e um período da URL além do piso espera
  o plano chegar, em vez de pedir outro antes.
- **Postura:** a evolução da nota segue o histórico do plano, até 365 pontos (`postureHistoryDays`): 90 no Essencial,
  365 no Profissional; sem limite ou acima de 365 dias, os últimos 365.
- **Textos:** o detalhe do achado diz "Evento bruto do log disponível por 30 dias" (`RAW_EVENT_RETENTION_DAYS`, a
  retenção do índice do Wazuh) e, com o plano conhecido, quantos dias os dados do achado ficam; "Plano e uso" diz o que
  o histórico guarda, que a trilha fica ao menos 13 meses e o evento bruto 30 dias. Os prazos para a Privacidade e o
  DPA do site estão em [`retencao-de-dados.md`](retencao-de-dados.md).

## Expurgo do histórico

_(fase 2, PR-19: a tarefa `retention` do worker, em `apps/api/src/retention/`, e a migration
`20261109120000_history_retention`; por cliente desde o CE-02, migration `20261110180000_tenant_plan`.)_

O banco de cada nó guarda o histórico de cada cliente pelo prazo do plano dele (`TenantPlan`; no nó dedicado, o `PLAN`
e o `PLAN_HISTORY_DAYS`: 90 dias no Essencial, 365 no Profissional, sem limite no Interno). O cliente da célula ainda
sem plano fica fora do expurgo do histórico e da auditoria (o inventário, os avisos e as tabelas de operação seguem
regras que não dependem do plano). Uma vez por dia o worker apaga o que passou do prazo. O expurgo só mexe no
Postgres do nó: nada na nuvem do cliente, nos buckets dele, nos logs na origem nem no índice do Wazuh, que tem a
retenção própria de 30 dias (política ISM, `infra/wazuh/README.md`).

- **Agenda:** depois das 04:00 UTC (01:00 de Brasília), no máximo uma vez por dia (`SyncState('retention')`), com a
  concessão do banco (uma réplica por vez), em lotes de 500 linhas por transação, com pausa entre eles e no máximo
  10 minutos por execução. O que sobrar fica para o dia seguinte. A parada do worker interrompe entre dois lotes, e o
  dia roda de novo na próxima partida.
- **Triagem ao mesmo tempo:** cada lote de achados e incidentes toma o lock por cliente dos coletores e trava com
  `SELECT ... FOR UPDATE` as linhas que vai apagar (incidentes e depois os achados deles), e só então confere de novo,
  numa consulta nova. Uma triagem, mudança de incidente ou comentário em curso faz o lote esperar e é vista na
  conferência; uma que chega depois espera o lote. Assim nada que a API confirmou sai junto.
- **O que sai** (o corte é o prazo mais um dia de folga, para o relatório do período sair completo; o próprio corte
  fica):

  | Dado                                                                     | Regra                                                                                                                                                                                                                                                                                       |
  | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Incidentes                                                               | Saem inteiros, com os achados e os comentários, quando não tiveram atividade desde o corte: o último achado e a última mudança são anteriores a ele, e nenhum achado teve evento, mudança ou comentário depois. O que fica guarda a linha do tempo inteira                                  |
  | Achados soltos                                                           | Fora de incidente, sem atividade depois do corte e sem recorrência apontando para eles (a recorrência sai antes)                                                                                                                                                                            |
  | Casos                                                                    | Sem nenhum achado guardado, sem achado novo desde o corte (pelo relógio do servidor) e fora de incidente; o que ficou aberto também, porque só o alerta seguinte o selaria. Vale com qualquer `CASES_MODE`                                                                                  |
  | Operações de triagem em massa                                            | O cabeçalho, 13 meses depois do pedido, se nenhum achado que ela mudou está guardado (o item sai em cascata com o achado). Vale com qualquer plano e qualquer `CASES_MODE`                                                                                                                  |
  | Postura                                                                  | Varreduras e reprovações pelo prazo do plano; a varredura mais recente de cada conta fica sempre                                                                                                                                                                                            |
  | Inventário                                                               | 30 dias; o retrato mais recente de cada conta fica sempre                                                                                                                                                                                                                                   |
  | Fila sem dono                                                            | 90 dias                                                                                                                                                                                                                                                                                     |
  | Avisos por e-mail                                                        | Enviados, com falha ou pulados, sem mudança há 90 dias (a chave de deduplicação não deixa o aviso sair de novo nesse tempo); o pendente fica, e o de um incidente ou achado que sai vai junto. As horas de avisos (o resumo resolvido e a hora só de contagem, PR-17'), pelo mesmo prazo    |
  | Sessões, links, tentativas de login, códigos TOTP usados e limite por IP | Vencidos há mais de um dia (as janelas vão de 2 minutos a 12 horas). Os links do contato de escalonamento (D8) não passam por aqui: os vencidos saem a cada e-mail novo ao contato, e os de um endereço anterior na troca; o limite por IP dos links, na chamada seguinte, depois de um dia |
  | Auditoria                                                                | 13 meses, ou o prazo do histórico do cliente se for maior (com histórico sem limite, fica). Os registros sem cliente seguem o corte mais antigo entre os clientes                                                                                                                           |
  | Fica sempre                                                              | Clientes, usuários, contas, lista de proteção, exceções, credenciais, agentes, uso por mês e o estado dos coletores                                                                                                                                                                         |

  | Dado                                                                     | Regra                                                                                                                                                                                                                                                                                                                                                 |
  | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Incidentes                                                               | Saem inteiros, com os achados e os comentários, quando não tiveram atividade desde o corte: o último achado e a última mudança são anteriores a ele, e nenhum achado teve evento, mudança ou comentário depois. O que fica guarda a linha do tempo inteira                                                                                            |
  | Achados soltos                                                           | Fora de incidente, sem atividade depois do corte e sem recorrência apontando para eles (a recorrência sai antes)                                                                                                                                                                                                                                      |
  | Postura                                                                  | Varreduras e reprovações pelo prazo do plano; a varredura mais recente de cada conta fica sempre                                                                                                                                                                                                                                                      |
  | Inventário                                                               | 30 dias; o retrato mais recente de cada conta fica sempre                                                                                                                                                                                                                                                                                             |
  | Ataques web pelos logs do ALB                                            | As amostras e os ponteiros das evidências, 30 dias depois da última atividade (os agregados ficam com o achado); os objetos já tratados, 10 dias; o tráfego por país, 48 h em intervalos de 5 minutos, que passam para as horas, e 35 dias por hora; o resumo do dia de uma fonte que não é mais coletada, ou parado há 3 dias. Não dependem do plano |
  | Fila sem dono                                                            | 90 dias                                                                                                                                                                                                                                                                                                                                               |
  | Avisos por e-mail                                                        | Enviados, com falha ou pulados, sem mudança há 90 dias (a chave de deduplicação não deixa o aviso sair de novo nesse tempo); o pendente fica, e o de um incidente ou achado que sai vai junto. As horas de avisos (o resumo resolvido e a hora só de contagem, PR-17'), pelo mesmo prazo                                                              |
  | Sessões, links, tentativas de login, códigos TOTP usados e limite por IP | Vencidos há mais de um dia (as janelas vão de 2 minutos a 12 horas). Os links do contato de escalonamento (D8) não passam por aqui: os vencidos saem a cada e-mail novo ao contato, e os de um endereço anterior na troca; o limite por IP dos links, na chamada seguinte, depois de um dia                                                           |
  | Auditoria                                                                | 13 meses, ou o prazo do histórico do cliente se for maior (com histórico sem limite, fica). Os registros sem cliente seguem o corte mais antigo entre os clientes                                                                                                                                                                                     |
  | Fica sempre                                                              | Clientes, usuários, contas, lista de proteção, exceções, credenciais, agentes, uso por mês e o estado dos coletores                                                                                                                                                                                                                                   |

- **Imutabilidade (revisão linha a linha):** a trilha de auditoria e os comentários dos achados continuam só INSERT,
  com uma exceção estreita. UPDATE e TRUNCATE ficam sempre bloqueados pelos triggers. DELETE só passa no trigger com a
  flag `verax.retention` ligada **e** o registro mais velho que o piso de idade, conferido no banco linha a linha: 13
  meses na auditoria e 30 dias nos comentários (o menor prazo que um plano aceita). Quem liga a flag, e só em volta
  do próprio DELETE, são as funções `verax_purge_audit_log(corte, lote)`, `verax_purge_tenant_audit_log(cliente,
corte, lote)` (CE-02) e `verax_purge_finding_comments(achados)`:
  `SECURITY DEFINER`, com o papel das migrations (dono das tabelas) como dono, `search_path` fixo e o piso conferido
  por elas mesmas, então um corte mais novo é recusado pelo banco, não só pela aplicação. O EXECUTE não é de PUBLIC:
  o db-bootstrap concede só ao papel da aplicação, que continua sem DELETE direto nas duas tabelas (nem com a flag
  ligada na sessão). Nem o dono das tabelas apaga um registro mais novo que o piso sem derrubar o trigger. Nenhum
  endpoint altera ou apaga a auditoria (o critério da T1.3 continua valendo).
- **Auditoria com prazos diferentes (CE-02):** a função global apaga com o corte mais antigo entre os clientes (o de
  quem guarda mais, que vale também para os registros sem cliente), e a função do cliente apaga, de cada cliente com
  corte mais novo, o que passou do dele. Um cliente sem limite (o `interno` da Verax na célula) ou sem plano segura o
  corte global: nesse caso só a função de cada cliente roda, e os registros sem cliente ficam. No nó dedicado, todos os
  clientes têm o mesmo prazo, e só a global roda, como antes.
- **Trilha do expurgo:** cada execução grava `retention.purge` (ator sistema) na trilha de cada cliente, com o prazo
  em vigor para ele, os cortes e as contagens por tabela, sem nenhum conteúdo (o cliente da célula sem plano, com
  `planMissing`), e um registro global da Verax com as tabelas sem cliente. A trilha passa a dizer que, antes do corte, os registros saíram pela política. Uma execução interrompida
  registra o que já saiu, como falha.
- **Carência quando o plano diminui:** o job guarda o prazo aplicado a cada cliente (`TenantRetentionState`; antes do
  CE-02, um só para o nó, em `RetentionState`, que a migration copiou para cada cliente). Quando o plano do cliente
  pede um prazo menor (do Profissional para o Essencial, por exemplo), o anterior continua valendo para ele por 30
  dias, contados da primeira execução que viu a redução, para o cliente exportar; depois, vale o novo. Aumentar vale na
  hora e cancela a redução. A carência de um cliente não mexe no prazo dos outros.
- **Backups:** um dado expurgado continua nos backups do banco e nos snapshots do disco até a retenção deles vencer:
  eliminação em até D + 97 dias (90 do ciclo de vida do bucket e 7 de exclusão reversível), com D o dia em que saiu do
  banco. A conta, a frase para a Privacidade e o DPA e o que o ensaio geral confere estão em
  [`retencao-de-dados.md`](retencao-de-dados.md).

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

## Célula compartilhada (Plataforma) _(fase 3, a construir)_

**Decisão de 10/11/2026**, tomada pelo responsável pelo produto. O plano **Plataforma**, vendido no site, roda numa
**célula compartilhada**: um nó `standard` em São Paulo que atende vários clientes. A Plataforma é cobrada só pelo
volume de logs, em GB/dia, com uma **franquia contratada**: a base inclui uma franquia mínima, o cliente amplia a
franquia pelo painel quando quiser, e o que passar dela é cobrado sozinho, na fatura seguinte. Os valores (da base, do
GB/dia adicional e do excedente) ficam na tabela de preços do plano de controle, fora deste repositório, como todo
preço (seção "Preço configurável"). **Dedicado** e **vCISO** continuam com um nó por cliente, como até aqui. O **SOC
da própria Verax** muda para a célula como o primeiro cliente dela e é o teste de aceite da célula.

A primeira célula, `verax-celula`, é o `envs/celula` (`infra/gcp/GUIA.md`), criada no **projeto do nó da Verax**, e
não num projeto próprio das células, por decisão do responsável: por ora, uma célula só não chega à cota de contas de
serviço por projeto (cerca de 100) nem pede um orçamento à parte. O que é de cada cliente da célula (a conta de
serviço, o cofre do primeiro acesso e os tópicos da GCP) fica no projeto dos nós de clientes, onde o plano de controle
já administra os nós dedicados (o porquê está em "Ameaças de isolamento e mitigação"); a cota de contas desse projeto
passa a ser dividida entre os nós dedicados e os clientes da célula. Um projeto das células volta à mesa quando a cota
ou o orçamento pedirem. Esta seção é o registro da decisão (ADR); o detalhamento por PR está no estudo da fase 3, fora do
repositório, e o que já está no código tem a marca de feito.

```
<slug>.control.veraxsistemas.com.br   (um site do Firebase por cliente, como hoje)
api-<slug>.veraxsistemas.com.br ──CNAME──► túnel da célula (um por célula, ingress único → api:3000)
                                                │
GCP da Verax, projeto do nó da Verax (por ora)
  célula verax-celula: módulo node, perfil standard, IP do NAT reservado
    API (host → cliente) · worker · Postgres · Wazuh (manager e indexer) · cloudflared
  Pub/Sub: comandos do plano de controle (só o cp-worker publica) · relatórios da célula (só a VM publica)
  buckets: backups da célula (85 dias) e exportações (<célula>/<cliente>/..., 31 dias)
GCP da Verax, projeto dos nós de clientes (o dos nós dedicados; o cp-terraform não tem nada no projeto da célula)
  uma conta de serviço por cliente da célula, vxt-<slug> (a VM só emite o token dela; a permissão fica em cada conta)
  o cofre do primeiro acesso de cada cliente, vxt-<slug>-admin-bootstrap (a VM só grava)
  tópicos da GCP por cliente e projeto, com o UUID da conta no nome (nunca reaproveitado; só a VM lê)
```

**Dedicado e Plataforma lado a lado:**

|                   | Dedicado e vCISO                                      | Plataforma (célula)                                                       |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Onde roda         | Um nó por cliente (`envs/tenant`)                     | Uma célula, vários clientes                                               |
| Preço             | Pela configuração contratada (porte, contas, volume)  | Pelo volume em GB/dia, com franquia ampliável e excedente automático      |
| Identidade na AWS | A conta de serviço do nó, só dele                     | Uma conta de serviço por cliente, `vxt-<slug>`                            |
| IP de saída       | O do nó, só dele                                      | O da célula, dividido                                                     |
| Plano no nó       | O `node.conf` (`PLAN`), que semeia o plano do cliente | O `TenantPlan` de cada cliente, gravado pelo comando do plano de controle |
| Painel e API      | `<slug>.control...` e `api-<slug>`, túnel do nó       | Os mesmos endereços; a API amarra cada requisição ao cliente do host      |
| Cancelamento      | A VM para; o nó inteiro sai em D+30                   | Exportação em D; os dados do cliente saem do banco em D+1                 |
| Backups           | Até cerca de D+99 (90 dias de retenção)               | Até cerca de D+95 (85 dias de retenção na célula)                         |
| Raio de impacto   | O nó do cliente                                       | A célula inteira (o risco residual, abaixo)                               |

### O que o código supunha de um cliente por nó

Cada ponto muda, ou fica atrás de `NODE_MODE=cell` (no nó dedicado, nada muda):

- o medidor da AWS para com `multiple_tenants`, e a saúde da AWS vem do contador do nó inteiro (`usage/wazuh-usage.ts`)
  (**feito no CE-09** para o medidor: na célula, o analysisd é só o contador do nó; a saúde por cliente é do CE-13);
- uma identidade só para a AWS: o worker pede o token da conta de serviço da VM, e o painel mostra o
  `NODE_SA_UNIQUE_ID` do ambiente (`aws/web-identity.ts`, `cloud-accounts.service.ts`); o Wazuh tem um arquivo de
  token só (`aws-token.sh`, `render-manager-config.py`);
- o plano é do nó, vem do ambiente e decide também o expurgo e os avisos de volume (**feito no CE-02**: o plano é de
  cada cliente, seção "Plano do nó: limites e uso");
- uma origem do painel só (`WEB_ORIGIN`: CORS, links, hostname do Turnstile);
- o ingress do túnel é trocado inteiro, com um nome só (`putTunnelIngress` no plano de controle);
- o primeiro acesso lê o metadata da VM, e a ativação lê os guest attributes;
- a exportação e a exclusão são do nó inteiro (o dump do banco e o `destroy` do `envs/tenant`);
- os tópicos da GCP têm o nome do projeto (`<prefixo>-security-<projeto>`), que pode voltar depois de uma exclusão;
- os agentes do Wazuh são de um cliente (`WAZUH_AGENTS_TENANT`): **ficam desligados na célula (v1)**;
- o cliente só tinha `active` e `inactive` (**feito no CE-02**: os estados do ciclo de vida, abaixo), e o
  `User.email` é único no banco inteiro (CE-01).

Já servem para vários clientes: a atribuição dos alertas (`alerts/alert-owner.ts`: bucket e conta têm de concordar),
a regra de que cada origem de log é de um cliente só (`assertOriginsFree`), o `source_mismatch` da GCP, o rótulo OAEP
por cliente no cofre, o `scoped()` e o `forTenant()`, e a troca de cliente auditada do `admin_verax`.

### Ameaças de isolamento e mitigação

- **Confused deputy na AWS (a principal)** _(a construir, CE-11 e CE-12)_. Se todo papel confiasse na conta de
  serviço da célula e no IP do NAT dela, o cliente A cadastraria o ID da conta AWS de B, e a célula leria os logs de B
  para A com a identidade dividida. Por isso, **uma conta de serviço por cliente**, `vxt-<slug>`, criada pelo
  `envs/cell-tenant` no provisionamento (**feito no CE-07**: o ambiente, as permissões só na conta, no cofre e nos
  tópicos do cliente e o executor, que recusa recriar a conta fora do expurgo). As contas, os cofres e os tópicos dos
  clientes da célula ficam no **projeto dos nós de clientes**, e não no da célula: a GCP não aceita condição do IAM pelo
  nome de uma conta de serviço nem de um tópico, e o `setIamPolicy` de contas no projeto da célula (o do nó da Verax)
  alcançaria a conta que assina as versões do nó. No projeto dos nós, o cp-terraform já administra contas, cofres e
  Pub/Sub (com o mesmo risco que já tem sobre as contas dos nós dedicados, vigiado pelo alerta do CP-12); no projeto da
  célula, ele não tem permissão nenhuma:
  - a VM da célula ganha `serviceAccountOpenIdTokenCreator` **só nessa conta** (nunca no projeto); o ID único dela
    vai do Terraform ao Firestore e chega à célula pelo comando do plano de controle, em `TenantCloudIdentity`, que
    nenhum schema de requisição aceita (meta-teste);
  - o painel mostra esse ID em `NodeServiceAccountId`, com os IPs da célula; o template, o `Audience` e as quatro
    condições exatas não mudam;
  - o worker emite o token pela personificação (`generateIdToken`, sem `includeEmail`) e tira a identidade da ligação
    conta → cliente → `TenantCloudIdentity`, nunca da linha da conta; o `sub` de cada token emitido tem de ser o do
    cliente, senão `identity_mismatch`. O nó dedicado continua pelo metadata;
  - no Wazuh, um arquivo de token por identidade, gravado pelo host a partir de um `identities.json` que só o gerador
    escreve (o host nunca lê o que o worker grava), e o aviso `aws_token_stale` passa a ser por cliente;
  - resultado: a conta de B cadastrada por A recebe o token de A, a confiança de B recusa (`trust_denied`), o
    `ingestFrom` não é gravado e a conta nunca chega ao Wazuh. Quem cadastrar o ID de B antes dele causa um 409 a B
    (negação de serviço, com mensagem genérica); a unicidade só entre contas verificadas vem depois (CE-23);
  - a conferir na conta AWS de teste: o token do `generateIdToken` traz `azp` e `sub` iguais ao ID único da conta do
    cliente, como o do metadata com `format=standard`.
- **Tópicos da GCP reaproveitáveis.** Com o nome tirado só do projeto, depois da exclusão de B o cliente A cadastraria
  o projeto de B e herdaria o sink que B esqueceu. Na célula, o tópico e a assinatura são
  `vxc-<célula>-gcp-<UUID da conta>`, nunca reaproveitados; a exclusão apaga os tópicos, e o e-mail dela pede ao
  cliente que apague o sink. A identidade do sink colada por outro cliente já é recusada (`assertOriginsFree`), e o
  `source_mismatch` continua. O tópico nasce de um pedido do nó ao plano de controle, que reaplica o `envs/cell-tenant`
  do cliente (cerca de 2 minutos): o nó não ganha permissão de administrar o Pub/Sub.
- **Cloudflare.** Sem mudança no modelo: o token é por conta, cifrado com o rótulo OAEP de cliente, conta e tipo, e a
  conferência prova o acesso. O filtro de IP do token é o da célula, o que não abre nada, porque o segredo é o token. A
  lacuna é a cripto-destruição por cliente: uma chave do cofre por célula não deixa destruir só a de um cliente (chave
  por cliente no CE-22, ou antes, se o DPA exigir).
- **Painel e API** _(a construir, CE-01)_. Cada cliente mantém `<slug>.control...` e `api-<slug>`; todos os `api-*`
  apontam para o túnel da célula. Na célula, a API amarra cada requisição ao cliente do host: login só dentro do
  cliente do host (a mesma recusa genérica de sempre), sessão válida só no host em que nasceu, CORS, CSRF, Turnstile e
  links dos e-mails por cliente, host desconhecido 404, e o `admin_verax` só no host da equipe (`api-verax`), com a
  troca de cliente auditada e marcada como acesso do suporte da Verax. Um meta-teste falha se uma rota ficar fora da
  guarda do host. A unicidade entre clientes (e-mail, ID de conta) responde com mensagem genérica.
- **Banco.** O proxy de escopo (`scopeToTenant`), o meta-teste de `TENANT_SCOPED_MODELS` e os testes A/B continuam. O
  que só o sistema grava (`TenantPlan`, feito no CE-02; `TenantHost`, no CE-01; `TenantCloudIdentity` e o estado do
  canal, no CE-05) tem meta-teste de que nenhuma rota o aceita, e o escopo de cliente recusa a gravação. O RLS do
  Postgres fica como defesa em profundidade, depois da primeira venda (CE-21).
- **Vizinho barulhento.** Um `analysisd` e uma execução do módulo da AWS para todos: na célula, o `only_logs_after` é
  o mais recente entre o `ingestFrom` e ontem, cada bucket tem a própria data de início, e a configuração do manager é
  aplicada no máximo a cada 15 minutos; o worker reveza os clientes, com um orçamento por cliente em cada tarefa; a API
  tem limite por cliente nas rotas caras. **Nenhum log é descartado** (princípio 4): os freios do volume são o
  excedente e um aviso ao responsável acima de 5 vezes a franquia por 24 horas.
- **Logs e métricas.** Os logs dos contêineres já só levam IDs e códigos, então um destino só do Cloud Logging serve;
  a célula informa ao plano de controle CPU, memória, fila do `analysisd`, atraso do módulo e os maiores clientes em
  GB/dia, para a página "Células" do console. O item "Medidor da AWS parado" da Torre deixa de valer na célula.

### Canal entre o plano de controle e a célula _(feito: CE-05 e CE-06; os tópicos, no CE-03)_

**Pub/Sub nos dois sentidos**, sem nada novo exposto na internet. Os comandos (`tenant.upsert`, com o estado desejado
inteiro e uma `generation` crescente por cliente; `tenant.export`, `tenant.purge` e `tenant.collection_pause`) seguem
um contrato zod estrito e versionado (`packages/shared/src/cell-protocol.ts`), e o worker da célula aplica cada um numa
transação, ignorando uma geração já aplicada, com o relatório na mesma transação (outbox). Os relatórios
(`tenant.applied`, `tenant.status`, `usage.daily`, `export.ready`, `tenant.purged`, `franchise.requested`,
`gcp_source.request` e `cell.status`) chegam ao `cp-worker` por uma assinatura push com OIDC, aceita só numa rota
(`@WorkerCallers('cell-push')`), e o plano de controle confere que **todo cliente citado está nesta célula**: uma
célula comprometida só mente sobre os próprios clientes. O IAM dos tópicos prova quem publicou. A senha do primeiro
administrador nunca passa pelo worker: o host a escreve no cofre `vxt-<slug>-admin-bootstrap`.

**O contrato** (`packages/shared/src/cell-protocol.ts`, versão 1, os dois lados o importam):

- **Envelope.** Todo comando leva `v`, `commandId` (ULID), `cellId`, `tenantId` (o id do cliente **no plano de
  controle**, um ULID: a célula guarda o mapa para o id do banco dela em `CellTenantState.controlPlaneId`) e `issuedAt`.
  Todo relatório leva `v`, `reportId` (UUID, a idempotência do lado do plano de controle), `cellId` e `emittedAt`.
  Objetos estritos dos dois lados: um campo a mais, outro tipo ou outra versão é recusado inteiro, e a recusa diz só o
  caminho e o motivo, nunca o valor. Teto de 256 KiB por mensagem.
- **`tenant.upsert`** com `generation` (1 a 2³¹−1) e `state`: o subdomínio, a razão social, os dois endereços (`api-<slug>`
  e `<slug>.control`, conferidos contra o subdomínio e no mesmo domínio), o estado (`active`, `suspended` ou
  `canceled`; o `purging` é só do `tenant.purge`), o plano do cliente (`TenantPlan`, com a mesma regra de combinação),
  a franquia agendada (`[{from, gbPerDay}]`, em ordem, obrigatória só na Plataforma), o ciclo de cobrança em dias de
  Brasília, a identidade na nuvem (`{saEmail, saUniqueId}`, a conta `vxt-<slug>`), as fontes da GCP já prontas, os IPs
  da célula, o último ciclo cobrado, os preços do diálogo de ampliação (em centavos, repetidos da tabela publicada,
  nunca calculados na célula) e o e-mail do primeiro administrador (`firstAdmin`, null no cliente adotado).
- **`tenant.export`** (`exportId`), **`tenant.purge`** (`purgeId` e a confirmação do subdomínio) e
  **`tenant.collection_pause`** (`paused` e, só com a pausa, o motivo: `runaway_volume` ou `owner`).
- **Relatórios:** `tenant.applied {generation}`, `tenant.status {accountsConnected, lastEventAt}`,
  `usage.daily` (o corpo do CE-09, `usageDailyReportSchema`, com o envelope do canal: `{day, final, sources{aws, gcp,
cloudflare: {bytes, events}}}`, as três fontes sempre, valores absolutos do dia),
  `export.ready {exportId, object, sha256, bytes}`, `tenant.purged {purgeId}`,
  `franchise.requested {requestId, targetGbPerDay, requestedBy}`, `gcp_source.request {cloudAccountId, projectId,
writerIdentity}`, `cell.status` (só agregados da célula) e **`command.refused {commandId, command, code}`**: a célula
  leu um comando válido e não o aplicou (o subdomínio de outro cliente, a conta de serviço de outro cliente, a transição
  fora da tabela, o expurgo sem a exportação, o pedido que a célula ainda não sabe cumprir).

**O lado da célula (CE-05, `apps/api/src/cell/`).** No worker, só com `NODE_MODE=cell` e as três variáveis do canal
(`CELL_ID`, `CELL_COMMANDS_SUBSCRIPTION`, `CELL_REPORTS_TOPIC`, todas ou nenhuma, e só na célula), com o token da VM:

- **`cell-commands`** (a cada 10 s) lê a assinatura de comandos pelo mesmo cliente REST do Pub/Sub da GCP
  (`gcp/pubsub.client.ts`). A mensagem fora do contrato, ou de outra célula, é confirmada e descartada, com o motivo no
  log. Cada comando válido é aplicado numa transação do banco, com uma trava por cliente (duas réplicas nunca aplicam o
  mesmo cliente juntas), e confirmado só depois do commit; uma falha do banco não confirma a mensagem e para o lote (a
  ordem por cliente não é furada).
  - O `tenant.upsert` ignora uma geração menor que a aplicada; a igual não muda nada e repete o `tenant.applied`. Senão,
    cria o cliente (nasce `active`) ou atualiza o nome, e aplica o resto **só pelas escritas de sistema**:
    `assignTenantHost`, `writeTenantPlan` (`source = control_plane`), `applyTenantLifecycleStatus` (a mesma transição
    auditada do CE-02, agora também numa transação de quem chama) e `writeTenantCloudIdentity`, a única escrita de
    `TenantCloudIdentity` (uma conta por cliente e um cliente por conta, no banco e no CHECK do formato). O resto do
    estado vai para `CellTenantState.desired`, conferido pelo contrato de novo em toda leitura (`readCellTenantState`:
    o contador da franquia, a medição, o "Conectar AWS" e as fontes da GCP leem daqui). A trilha do cliente ganha
    `tenant.cell_state_applied` (ator sistema, `control-plane`), e o `tenant.applied` entra na caixa de saída na mesma
    transação.
  - A recusa (`TenantHostConflict`, a conta de serviço de outro cliente, `TenantTransitionRefused`, o cliente em
    `purging`) desfaz a transação inteira e grava só o `command.refused`.
  - O `tenant.export` e o `tenant.purge` passam pelas guardas: o cliente existe; no expurgo, a confirmação é o subdomínio
    dele, ele está `canceled` (ou já `purging`, a repetição) e a exportação está gravada (`exportReadyAt`). Só então o
    expurgo é registrado (`CellPurge`, pelo `purgeId`, sem chave para o cliente), o cliente vai a `purging` e o
    expurgador apaga (`TenantPurger`, idempotente); a conclusão do registro e o `tenant.purged` saem numa transação só.
    Se o processo cai depois de o expurgador apagar o cliente e antes do relatório, a reentrega acha o expurgo começado
    sem cliente e o conclui (nunca `tenant_unknown`); um expurgo concluído repete o relatório. A exportação chama o exportador (`TenantExporter`) e registra o resultado com o `export.ready`
    (`recordTenantExport`); o mesmo `exportId` de novo repete o relatório sem exportar. **O exportador e o expurgador
    são do CE-16**: até lá, o pedido que passa nas guardas volta `export_unavailable` ou `purge_unavailable`, sem mudar
    o estado do cliente.
  - O `tenant.collection_pause` grava a pausa (com o motivo) em `CellTenantState`, e `COLLECTING_TENANT` passa a exigir
    também a coleta sem pausa: o cliente sai do Wazuh, da GCP, do Cloudflare, das conferências da AWS e do inventário,
    sem mudar o estado nem o acesso. No nó dedicado não há linha da célula, e nada muda.
- **`cell-reports`** (a cada 10 s) publica a caixa de saída (`CellReport`) no tópico de relatórios, em ordem de
  criação, em lotes de até 100, só com o tipo e a versão nos atributos; o lote que falha espera 1 min, e os publicados
  saem da tabela depois de 7 dias. Com duas réplicas, um relatório pode sair duas vezes: o plano de controle ignora pelo
  `reportId`. **`CellReportOutbox.enqueue` e `enqueueForTenant`** são a porta de entrada dos relatórios para o resto da
  célula (o pedido de franquia do CE-19 e o de tópico da GCP do CE-08 entram por aí), e o cliente que não veio do canal
  não tem a quem relatar.
- **`cell-tenant-status`** (a cada 5 min) relata, por cliente do canal, as contas conectadas e o último evento, as mesmas
  contas do `node-status` do nó dedicado (que a célula não usa).
- **`cell-usage-reports`** (a cada hora) põe na caixa de saída o `usage.daily` de hoje e de ontem de cada cliente do canal
  (`usageDailyReports` do CE-09), com o id do plano de controle. Só entra o relatório que difere do último do mesmo
  cliente e dia na caixa de saída (os contadores ou o `final`): o dia sem leitura nova não gera linha, e ontem sai de
  novo uma vez, quando fecha às 06:00 de Brasília.
- **O primeiro administrador do cliente novo:** o `tenant.upsert` leva `firstAdmin {email}` (null no cliente adotado,
  o SOC da Verax). O pedido (`CellTenantBootstrap`) nasce na transação que cria o cliente, e cada passagem do
  `cell-commands` o entrega ao host pelo contrato de arquivos do CE-04: `slug=` e `email=` em
  `TENANT_BOOTSTRAP_DIR/<id do cliente>` (escrito de uma vez, com `rename`), e a resposta do host (`ok` ou `error`) em
  `TENANT_BOOTSTRAP_STATUS_DIR/<id>`. O pedido ainda na pasta espera o host; a resposta `ok` com o pedido atendido
  confirma, e o e-mail sai da linha; sem pedido nem `ok` (nunca escrito, ou o `/run` sumiu num reinício), o pedido é
  escrito de novo. Uma queda do worker logo depois do commit, ou uma falha na pasta, não perde o pedido, e a falha não
  para os comandos. A senha nunca passa pelo worker.

**O lado do plano de controle (CE-06, `apps/control-plane/src/cells/`).** Só no cp-worker:

- **O registro `cells/{id}`** (gravado pelo responsável, no console, com a escolha da célula do CE-15): o estado, a
  região, o projeto, os IPs, e os nomes do canal tirados da saída `cell` do `envs/celula` (o tópico de comandos, a
  assinatura push dos relatórios e a conta de push da célula, `vxc-<célula>-push`). A capacidade, a reserva e as
  medições chegam opcionais (CE-15). O cliente ganha `placement {kind: 'cell', cellId}` (gravado pelo CE-15, nunca muda
  sozinho) e `cell` (a geração mandada e a aplicada, os agregados do `tenant.status` e a última recusa de comando).
- **O publicador** (`CellCommandPublisher`): a célula de destino sai sempre do `placement` do cliente, nunca de quem
  chama. O `tenant.upsert` sobe a geração numa transação do Firestore (com a auditoria `cell.command_sent`) antes de
  publicar; se a publicação falha, a geração fica gasta e a próxima tentativa usa outra maior. Os comandos pontuais
  (exportação, expurgo, pausa) passam pela mesma trilha. Tudo é conferido pelo contrato antes de sair e publicado com a
  chave de ordenação = o cliente, pela API REST do Pub/Sub com o token do cp-worker. Quem chama são os passos do
  provisionamento e do ciclo de vida na célula (CE-15 e CE-16).
- **A rota `POST /internal/cells/:cellId/reports`**, atrás de `@WorkerCallers('cell-push')`: o token OIDC de uma das
  contas de push (`CELL_PUSH_SA_EMAILS`, que o Terraform deriva de `cell_push_service_accounts`), e esse token só vale
  nesta rota (nem o responsável chama). Depois, `CellReportsService` confere, nesta ordem: a célula está no registro, o
  token é o da conta de push **dela** e a entrega veio da assinatura **dela** (senão 403, sem ler o relatório: uma
  célula comprometida não fala pela rota de outra); o relatório é do contrato e diz ser desta célula; **todo cliente
  citado tem `placement.cellId` igual a esta célula** (um relatório sobre cliente de outra célula, ou que não existe, é
  recusado). As recusas de conteúdo respondem 200 (o Pub/Sub não precisa repetir), ficam em `cellReports` e na
  auditoria (`cell.report_refused`, fora da trilha do cliente de outra célula), e o log leva só a célula, o tipo, o
  código e os ids.
- **Idempotência:** `cellReports/{célula}_{reportId}` é criado na mesma transação do efeito; a repetição responde
  `duplicate` e não muda nada. Os registros ficam 90 dias (TTL).
- **Tratados aqui:** `tenant.applied` (a geração aplicada só sobe, e nunca acima da mandada: a geração inventada é
  recusada, `generation_unknown`), `tenant.status` (só o mais novo pelo `emittedAt`: o atrasado não volta o estado) e
  `command.refused` (a última recusa, para o console e o provisionamento). Os outros (`usage.daily`, `export.ready`,
  `tenant.purged`, `franchise.requested`, `gcp_source.request`, `cell.status`) ficam guardados inteiros, `stored`, para
  o CE-08, o CE-09, o CE-16 e o CE-19.
- **Infra** (`infra/gcp/envs/control-plane/cell_channel.tf`): o `run.invoker` no cp-worker da conta de push de cada
  célula e a lista delas no cp-worker. A assinatura push, a conta e os tópicos são do `envs/celula` (CE-03), no projeto
  da célula.

### Medição e franquia _(CE-09 e CE-10 feitos; a construir: CE-11/CE-13, CE-19 e CE-20)_

- **Unidade:** bytes descomprimidos (a regra do `usage-meter.ts`), **GB = 10⁹ bytes**, por dia do calendário de
  Brasília (vira às 03:00 UTC), numa tabela diária por cliente e fonte (`IngestUsageDay`). Contam os logs da AWS, da
  GCP e a **auditoria do Cloudflare**; os eventos de segurança do Cloudflare (agregados do GraphQL, do tamanho da
  consulta da Verax) não contam e ficam só no mês (`IngestUsage`, que segue igual para o plano dos nós dedicados e as
  telas). O ciclo é o mês: do dia 1º ao último dia.
- **Como cada fonte entra no dia** _(feito no CE-09)_:
  - **GCP:** os bytes do `data` de cada mensagem, depois do ack, no dia do `publishTime` (não no da leitura);
  - **Cloudflare:** os bytes UTF-8 do JSON de cada entrada da auditoria, no dia da entrada (a inválida, no da leitura);
  - **AWS na célula:** medida **na origem**, por cliente, pela tarefa `aws-volume` (`usage/aws-volume.ts`): lista as
    pastas de dia da conta nos buckets cadastrados (`AWSLogs/<conta>/CloudTrail|GuardDuty|WAFLogs/<região>/…`, a trilha
    de organização e o WAF do CloudFront também), lê os 4 últimos bytes de cada objeto novo (o ISIZE do gzip, com a
    estimativa marcada quando ele é impossível) e conta o objeto no dia em que ele foi criado, só a partir da primeira
    verificação bem-sucedida da conta (`CloudAccount.meteredFrom`: o histórico nunca é cobrado). Cada objeto fica
    registrado por 62 dias (`AwsVolumeObject`, pelo hash do bucket e da chave) e conta uma vez só; a leitura nunca
    volta mais de 60 dias (o que é relido ainda está no registro), e o total do dia é regravado como a soma do registro
    (valor absoluto), sob um lock por cliente (duas execuções juntas nunca fazem o total regredir). **A identidade é a do cliente** (`TenantAwsIdentity`): até o
    CE-11, a célula não tem identidade de cliente nenhum, e a tarefa não chama a AWS (a identidade da célula nunca serve
    para ler a conta de um cliente);
  - **AWS no nó dedicado:** continua pelo analysisd (`wazuh-usage`), que agora também grava o dia da leitura.
- **O analysisd na célula** _(feito no CE-09)_: sem `multiple_tenants` e sem dono; a diferença dos contadores vai só
  para o contador do nó por dia (`NodeUsageDay`, métrica `analysisd`), a conferência do volume medido na origem (a
  faixa e a marca `reconcile_divergent` são do CE-13, com a saúde da AWS por cliente; até lá, a célula não avisa
  parada da AWS).
- **Relatório `usage.daily`** _(o conteúdo é do CE-09; o canal, do CE-05)_: `usageDailyReports(db, clientes, agora)`
  (`usage/usage-daily.ts`) devolve, por cliente e dia (hoje e ontem), as três fontes com os valores **absolutos** do
  dia (zero quando não houve leitura), no contrato `usageDailyReportSchema` (`packages/shared/src/usage-day.ts`);
  `final` só depois das 06:00 de Brasília do dia seguinte. Mandar de novo não soma nada. A tarefa `cell-usage-reports`
  (canal da célula) os põe na caixa de saída a cada hora, só quando mudaram.
- **Só o sistema grava** o volume por dia: o escopo do cliente lê o `IngestUsageDay` e o `AwsVolumeObject`, mas recusa
  gravá-los (`SYSTEM_WRITTEN_MODELS`), e um meta-teste confere que só o medidor e a medição na origem os gravam.
- **Contador no painel** _(feito no CE-10)_: no `GET /v1/plan`, o cliente com franquia no plano (a Plataforma, só na
  célula) recebe o bloco `franchise` (`franchiseUsageSchema`, `packages/shared/src/franchise.ts`): o ciclo, o dia `k`
  de `D`, a franquia de hoje e a agenda do ciclo, o orçamento `B = Σ F_d`, o volume do ciclo `U_k`, a média `U_k / k`,
  a projeção `U_k / k × D`, o excedente projetado em centésimos de GB/dia e os últimos 30 dias por fonte. Nenhum
  valor em dinheiro. Em Administração → Plano e uso, o cartão da franquia mostra a barra `U_k / B` com a marca em
  `k / D`, os números e as colunas por dia e fonte (com a tabela), e o botão "Ampliar franquia" desligado, com o aviso
  de que chega em breve. Até a agenda chegar pelo estado desejado (CE-19), a franquia do `TenantPlan` vale para o
  ciclo inteiro.
- **Excedente** _(a construir, CE-20)_: a média diária do ciclo menos a franquia ponderada pelos dias em que valeu,
  arredondada para baixo (a dúvida a favor do cliente), em centésimos de GB/dia (`overageUnits`, a mesma conta da
  projeção do painel). Vai à Stripe como um evento de medidor por ciclo fechado, com identificador idempotente, e cai
  na fatura seguinte. Um ciclo estranho (dia sem fechamento, divergência na conferência, excedente muito acima da
  franquia) espera a aprovação do responsável.
- **Ampliar a franquia** _(a construir, CE-19)_: pelo painel (Administração → Plano e uso), só o `admin_cliente`, com
  um código TOTP novo; o plano de controle muda a quantidade na Stripe, com a cobrança proporcional na hora, e só
  aplica se o pagamento passar. Reduzir vale no ciclo seguinte. Toda mudança gera auditoria nos dois lados e um recibo
  por e-mail.

### Provisionamento e escolha da célula _(a construir, CE-15)_

O webhook não muda. Para a oferta `platform`, o `preflight` escolhe a célula numa transação do Firestore: só as
`open` com as métricas medidas abaixo dos limites, com `reservado + pedido ≤ capacidade`, enchendo uma até 70% antes
de passar à próxima; a reserva e o `placement` do cliente (que nunca muda sozinho) são gravados juntos. Sem lugar,
`provisioning_failed: cell_capacity` e um alerta ao responsável, nunca um nó dedicado no lugar. Os passos: o CNAME
`api-<slug>` para o túnel da célula, o site do Firebase com o painel **na versão da célula**, o `envs/cell-tenant`
(conta de serviço, permissões e cofre do primeiro acesso), o comando `tenant.upsert`, a espera do `tenant.applied`, o
`/health` pelo host do cliente e a revelação da senha de sempre. A capacidade de cada célula sai do ensaio de carga
(CE-18); uma célula nova é um `apply` do ambiente da célula e uma linha no registro.

### Ciclo de vida do cliente na célula

O plano de controle continua dono dos estados (seção "Ciclo de vida depois da venda"); a célula guarda o espelho em
`Tenant.status`, que agora tem `suspended`, `canceled` e `purging`, além de `active` e `inactive` _(o estado e o que
ele bloqueia no nó estão no código desde o CE-02; quem o grava na célula é o comando do CE-05)_:

- **Suspender** (carência vencida, `unpaid`, fraude): sessões revogadas, login recusado com a mensagem de pagamento,
  coleta parada (fora do Wazuh, da GCP, do Cloudflare e das conferências da AWS), dados guardados; o plano de controle
  desativa a conta de serviço do cliente. O `node_power` do `tick` não age em cliente de célula.
- **Reativar:** a conta de serviço volta, e depois `active`.
- **Cancelar:** `canceled`, com o mesmo efeito da suspensão (o login recusado com a mensagem genérica), e a exportação.
- **Expurgar** (D+1): `purging`, a única porta para apagar os dados de um cliente da célula.

A transição é só do sistema: o cadastro de clientes da API (`admin_verax`) continua só com `active` e `inactive` e
recusa mudar o estado de um cliente que está num estado do ciclo de vida.

**O que já está no nó (CE-02):**

- **Transições** (`apps/api/src/tenants/tenant-lifecycle.ts`, `setTenantLifecycleStatus`): `active` → `suspended` ou
  `canceled`; `suspended` → `active` ou `canceled`; `canceled` → `purging`; nada sai de `purging` (o expurgo apaga o
  cliente) nem de `inactive` (a exclusão lógica do cadastro). Repetir o estado atual não grava nada (o comando repetido
  do plano de controle). Cada transição trava a linha do cliente, grava, derruba o acesso quando ele sai de `active`
  (as sessões dos usuários dele e a seleção da equipe da Verax nele) e vai para a trilha do cliente como
  `tenant.lifecycle_suspend`, `tenant.lifecycle_reactivate`, `tenant.lifecycle_cancel` ou
  `tenant.lifecycle_purge_start` (ator sistema, com o estado antes e depois). Nenhuma rota chega aqui.
- **Login:** só cliente `active` recebe sessão, como antes. Ao suspenso, depois da senha certa (e antes do código do
  MFA), a API responde 401 `TENANT_SUSPENDED`, e o painel diz que o acesso da empresa está suspenso por uma pendência
  de pagamento e que a pessoa procure quem cuida da contratação, sem valor nem detalhe; a senha errada continua com a
  resposta de sempre. O cancelado e o em expurgo ouvem a resposta da senha errada. A sessão aberta cai na requisição
  seguinte (`session-validation.ts`), além da revogação na transição.
- **Coleta:** só as contas de cliente `active` são lidas (`COLLECTING_TENANT`, em `tenants/tenant-status.ts`): a lista
  do Wazuh (`wazuh-sources`), as assinaturas da GCP, as contas do Cloudflare, as conferências da AWS (o "Verificar" e
  a periódica) e o inventário e a postura. Isso vale também para o cliente `inactive` do cadastro, que antes continuava
  sendo coletado. A atribuição de um alerta que já estava a caminho continua pelo cadastro (a conta segue sendo do
  cliente), e os dados ficam. A dona de uma assinatura da GCP é decidida antes do filtro, com os clientes de todas as contas
  cadastradas: a assinatura em dois clientes continua ambígua (sem dono e sem medição) mesmo com um deles fora de
  `active`, e só a que não tem nenhum cliente `active` deixa de ser lida. Nos outros coletores, cada conta é lida pela
  própria identidade ou token, e a origem compartilhada entre clientes já é recusada no cadastro (`assertOriginsFree`):
  não há dona a decidir.
- **Cadastro da API:** `PATCH /v1/tenants/:id` só aceita `active` e `inactive` no `status` (o schema), e mudar o estado
  de um cliente suspenso, cancelado ou em expurgo, ou desativá-lo pelo `DELETE`, é 409 `TENANT_STATUS_MANAGED`; o resto
  do cadastro continua editável. O painel mostra os três estados ("Suspenso", "Cancelado" e "Em exclusão") e não
  oferece o botão de desativar ou reativar para eles. O escopo do cliente recusa gravar o `status` do próprio cadastro.

### Exclusão e a promessa dos 100 dias na célula _(a construir, CE-16; a infraestrutura, feita no CE-03)_

Na célula, a VM continua no ar depois do cancelamento. Com o calendário do nó dedicado (dados até D+30), os backups da
célula com o cliente viveriam até cerca de D+129, e a frase do site ("eliminados também dos backups em até 100 dias")
deixaria de valer. Por isso a célula tem calendário próprio e backups de 85 dias (**feito no CE-03**: o
`backup_retention_days` do módulo do nó, 85 no `envs/celula`, que recusa mais que isso, e o bucket das exportações, com
31 dias de ciclo de vida e a VM só criando objetos na pasta da célula):

| Quando                 | O que acontece                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D (cancelamento)       | `canceled`: sessões revogadas, login recusado, toda coleta do cliente parada, conta de serviço desativada. A célula exporta cada tabela do cliente (NDJSON compactado, sem segredo) para o bucket de exportações da célula e avisa `export.ready`                                                                         |
| D+1 (com a exportação) | `tenant.purge`, com a confirmação do subdomínio: `purging`, e os dados do cliente saem do banco da célula em lotes, pela função `verax_purge_tenant` (a auditoria e os comentários só saem com o cliente em `purging`, conferido no banco); depois, a conta de serviço, os cofres, os tópicos, o DNS e o site do Firebase |
| até D+30               | O responsável gera um link de 24 h para **aquela** exportação; o ciclo de vida do bucket (31 dias) é o limite, e o plano de controle a apaga em D+30                                                                                                                                                                      |
| até cerca de D+95      | O último backup com o cliente é de D+1: 85 dias de retenção, 7 de exclusão reversível e o assíncrono do ciclo de vida. Os snapshots (7 dias), o índice do Wazuh (30 dias, com a coleta parada em D) e o Pub/Sub (7 dias) saem antes                                                                                       |
| D+97                   | Com a chave do cofre por cliente (CE-22), as versões dela são destruídas                                                                                                                                                                                                                                                  |

Restaurar um cliente só, a partir de um backup da célula, vem com a ferramenta de mudança de célula (CE-24); até lá,
restaurar um backup volta a célula inteira.

### Risco residual: o raio de impacto é a célula

O manager do Wazuh processa os logs de todos os clientes como root e guarda o token de 1 hora de cada um; o worker e o
host emitem token para todos. Uma exploração do manager por um log forjado de um cliente alcançaria a leitura dos logs
da AWS dos outros (só do IP da célula e só leitura). As mitigações são as de sempre (sem banco nem metadata para o
manager, `cap_drop`, imagem pelo digest, tokens de 1 hora presos ao IP, regras de nível 12 para uso de outro IP), mas
**o raio de impacto é a célula**. Essa é a diferença entre a Plataforma e o Dedicado, e vai assim para o DPA e os
Termos. Outros riscos: o reinício do manager atinge todos os clientes; uma migration ou uma versão vale para todos ao
mesmo tempo (janela de manutenção por célula, com o painel no mesmo passo); a medição vira fatura (por isso a medição
na origem, a conferência e a aprovação do responsável); e o acesso da equipe da Verax fica concentrado num banco.

### PRs da célula

| Fase                                | PRs                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: antes de a Verax mudar           | CE-00 (esta seção), CE-01 (host → cliente na API), CE-02 (plano por cliente e estados do cliente), CE-03 (ambiente da célula: tópicos, exportações, backups de 85 dias), CE-04 (pacote do nó em `NODE_MODE=cell`), CE-05 e CE-06 (o canal), CE-07 (`envs/cell-tenant`), CE-08 (tópicos da GCP), CE-09 (medição diária) e CE-10 (contador da franquia no painel) |
| Portão V                            | O SOC da Verax muda para a célula: um segundo sink em cada projeto (os antigos ficam, rodando junto), 7 dias de comparação (achados por regra, uso por dia, Torre), a troca do CNAME `api-verax`, contas por cliente para os analistas e o desligamento do nó `lean` (o projeto da Verax fica, com a chave de release e o Artifact Registry)                    |
| B: antes da primeira venda online   | CE-11 e CE-12 (identidade da AWS por cliente), CE-13 (auditor de objetos da AWS), CE-14 (preço e checkout da Plataforma), CE-15 (provisionamento na célula), CE-16 (ciclo de vida e expurgo), CE-17 (revezamento e limites por cliente), CE-18 (ensaio de carga) e CE-19 (ampliar a franquia)                                                                   |
| C: antes de o primeiro ciclo fechar | CE-20 (fechamento do excedente)                                                                                                                                                                                                                                                                                                                                 |
| D: depois da primeira venda         | CE-21 (RLS), CE-22 (chave do cofre por cliente), CE-23 (unicidade só entre contas verificadas), CE-24 (mudar de célula e restaurar um cliente) e CE-25 (segunda célula)                                                                                                                                                                                         |

## Plano de controle _(fase 3, a construir)_

O plano de controle é o que transforma uma compra no site num nó de cliente no ar sem operador: calculadora de preço,
checkout, webhook da Stripe, máquina de estados do cliente, provisionamento passo a passo e exclusão, mais o console do
responsável (tabelas de preços e de custos e DRE). Vive em `apps/control-plane` (NestJS 12 + zod 4, as mesmas regras
do monorepo) e roda no projeto da Verax na GCP, dentro do nível gratuito. Os nós continuam como na fase 2; o plano de
controle só os cria, para, liga e destrói. O detalhamento (fluxos, limites e PRs) está no plano da fase 3 e no estudo
do preço configurável, documentos internos.

### Peças

| Peça                                           | Onde                                                                                | Faz                                                                                                                                                                                                                                                                                                                       | Não faz                                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Site estático** (repo privado)               | `veraxsistemas.com.br`, Firebase Hosting                                            | Calculadora de preço (lê a tabela pública e pede a cotação), formulário de compra, página de status com a revelação única da senha, link do Portal do cliente                                                                                                                                                             | Nunca toca chave da Stripe nem dado de cliente além do que o usuário digita; nunca manda preço (só a cotação)                             |
| **`cp-public`** (Cloud Run, 0 a 2 instâncias)  | Projeto da Verax, atrás de `conta.veraxsistemas.com.br` (Hosting com rewrite `/**`) | Tabela pública de preços e cotação, textos legais vigentes, checkout pela cotação, consulta de subdomínio, página de status (claim, status, reveal), webhook da Stripe, `/health`                                                                                                                                         | Nenhuma rota interna nem do console: aceita invocação anônima (exigência do rewrite do Hosting)                                           |
| **`cp-worker`** (mesma imagem, `ROLE=worker`)  | Projeto da Verax, só IAM                                                            | Um passo do provisionamento por task, `tick` horário, `reconcile` diário, operações do responsável (`resume`, `delete-now`, `export` e, no contrato direto, `cancel`, `suspend` e `reactivate`), chamadas pelo console (`cp-admin`)                                                                                       | Não é alcançável sem token de identidade do Google; o app ainda confere `aud` e `email` do token                                          |
| **`cp-admin`** (mesma imagem, `ROLE=admin`)    | Projeto da Verax, atrás de `admin.veraxsistemas.com.br` (Hosting com rewrite `/**`) | Console do responsável: as telas (`apps/console`) e a API das tabelas de preços e dos modelos de custo, simulador de DRE, os clientes (lista, linha do tempo, contrato direto) e os botões das operações, pedidas ao `cp-worker`; os textos legais; o provedor de identidade do SIEM da Verax (`/sso/*`, "Entrada única") | Login próprio (e-mail de `OWNER_PRINCIPALS`, senha e TOTP, com bloqueio); invocação anônima; nada da Stripe                               |
| **`cp-terraform`** (Cloud Run Job)             | Projeto da Verax; identidade com papéis no projeto dos nós                          | `init`, `plan` e `apply`/`destroy` de `infra/gcp/envs/tenant` com Terraform fixado, estado por tenant no bucket                                                                                                                                                                                                           | Não lê Stripe, Cloudflare nem Firestore; só recebe variáveis já validadas por regex                                                       |
| **Firestore** (banco `(default)`, modo nativo) | Projeto da Verax                                                                    | Estado: `tenants` (com `transitions` e `invoices`), `slugs`, `stripeEvents`, `statusTokens`, `provisioningRuns`, `auditLog`, `rateLimits`; preço configurável: `pricingTables`, `costModels`, `quotes` (24 h); textos legais: `legalTexts`; console: `admin*`                                                             | Nunca guarda segredo em claro, cartão, token do túnel nem corpo bruto do webhook; a senha do console só como hash scrypt e o TOTP cifrado |
| **Cloud Tasks** e **Cloud Scheduler**          | Projeto da Verax                                                                    | Filas `provisioning` e `lifecycle` com nova tentativa e recuo, OIDC para o `cp-worker`; `tick` a cada hora e `reconcile` às 03:00                                                                                                                                                                                         | Nada de longa duração: o `apply` roda no Job, a task só dispara e espera                                                                  |
| **Secret Manager** e **bucket de releases**    | Projeto da Verax                                                                    | Chaves da Stripe (teste e produção separadas), token do Cloudflare, senha SMTP, chave do cookie, chave e token do console; manifesto e bundle                                                                                                                                                                             | —                                                                                                                                         |
| **Projeto dos nós** e **Firebase dos painéis** | Pago, criado na 1.ª venda; 1 a N projetos do Firebase (36 sites por projeto)        | Recursos `vx-<slug>` do módulo `node` (perfil `standard`); um site por cliente em `<slug>.control.veraxsistemas.com.br`, API em `api-<slug>`                                                                                                                                                                              | Sem o projeto dos nós, o provisionamento falha com `provisioning_disabled` (sem laço) e retoma quando configurado                         |

### Identidades

- **`cp-public`:** lê e escreve no Firestore, enfileira tasks e lê as chaves da Stripe e do cookie. Nada mais.
- **`cp-worker`:** Firestore, tasks, execução do Job, Firebase Hosting nos projetos do pool, leitura do bucket de
  releases e, no projeto dos nós (`envs/nodes-platform`), um papel personalizado que só para, liga e lê atributos de
  VMs cujo nome começa com `vx-` (`cpNodeLifecycle`), outro que grava os metadados delas (`cpNodeUpdater`, o pedido de
  versão da frota) e a leitura de `runs/` no bucket do estado; no projeto da célula, o mesmo pedido só na VM da célula
  (`cpCellNodeUpdater`). Por tenant, o `serviceAccountUser` na conta da VM daquele nó (o Compute o exige para gravar os
  metadados) e, ainda por tenant, o
  `envs/tenant` concede, cada permissão num cofre só: adicionar a versão do token do túnel (`secretVersionAdder`); com
  o e-mail do nó, adicionar a versão da senha da caixa de envio no `smtp-password` (`secretVersionAdder`, sem ler de
  volta); ler uma vez e destruir a versão do `admin-bootstrap` (`secretAccessor` e `secretVersionManager`); listar e
  destruir as versões de `credentials-key` (`cpSecretVersionDestroyer`, sem ler nem gravar). Nunca ler o cofre de
  credenciais, e nada no `support-bootstrap`. No projeto do plano de controle, lê os segredos que monta (a chave da
  Stripe, o token do Cloudflare e a senha do SMTP dele) e, pela API, a senha da caixa de envio dos nós
  (`cp-nodes-smtp-password`, nunca montada como variável).
- **`cp-terraform`:** os papéis de criar e destruir os recursos do módulo `node` no projeto dos nós
  (`envs/nodes-platform`; o mais sensível é `projectIamAdmin`, para a SA de cada nó escrever logs e métricas; mitigado
  pelo projeto isolado, pela imagem fixada e por alerta em `SetIamPolicy` fora da lista). Cofres e buckets por papéis
  personalizados que não alcançam o conteúdo. Não lê Stripe, Cloudflare nem Firestore.
- **`cp-deployer`:** Workload Identity Federation para o environment `control-plane` da `main`; publica a imagem e
  troca a imagem dos serviços (`run.developer` em cada serviço e no Job, nunca no projeto; `iam.serviceAccountUser`
  nas SAs de execução; escrita no registro). Não cria serviço nem toca o Firestore: índices e TTL são do Terraform.
  Nenhum segredo.
- **`cp-admin`:** lê e escreve no Firestore (tabelas de preços, modelos de custo, clientes, auditoria e as coleções do
  console: `adminAccounts`, `adminSessions`, `adminLoginThrottle`, `adminEnrollments` e `adminSsoCodes`), lê pela API
  do Secret Manager só as duas chaves dele (`cp-admin-totp-key` e `cp-admin-sso-signing-key`, a da entrada única no
  SIEM; nunca montadas) e
  invoca o `cp-worker` (`run.invoker` só nele, com `admin_enabled` e `services_enabled`) com o token de identidade da
  própria conta, para as operações do responsável; nenhum `actAs` na cp-invoker (não enfileira nada). Nenhum segredo
  montado: a configuração recusa a chave da Stripe. A invocação é anônima (o rewrite do Hosting de
  `admin.veraxsistemas.com.br` exige); quem entra é o login do próprio app: e-mail de `OWNER_PRINCIPALS`, senha (hash
  scrypt) e código TOTP (segredo cifrado com AES-256-GCM, código de uso único, códigos de recuperação em HMAC), com
  bloqueio de 15 minutos depois de 5 erros por e-mail e limite por IP (`req.ip`, a regra de `client-ip.ts`). A sessão
  é um id aleatório de 32 bytes no cookie `__session` (`HttpOnly`, `Secure`, `SameSite=Strict`), guardado só como
  hash, com 30 minutos de inatividade e 12 horas no máximo. O console não tem tela nem rota de cadastro (decisão do
  responsável de 12/11/2026: a antiga `/configurar` era superfície de ataque): a conta nasce, ou é refeita numa
  emergência, pela linha de comando `cadastro-responsavel` (`apps/control-plane/src/cli`), rodada por quem tem as
  credenciais de dono do projeto, com as mesmas chaves do login. A sessão nunca sai do `cp-admin`.
- **Responsável:** invoca o `cp-worker` com token de identidade, entra no `cp-admin` com e-mail, senha e TOTP,
  administra os segredos e cria a conta do console pela linha de comando; tudo auditado (`owner:<e-mail>`).

O que o plano de controle **não** pode fazer: ler o banco do nó, abrir o cofre de credenciais, entrar na VM (sem OS
Login), ver dados de cartão (Checkout hospedado) ou usar a chave completa da Stripe (chave restrita). Desde a atualização
da frota (16/11/2026), o `cp-worker` grava os metadados das VMs dos nós: não entra na VM por SSH, mas o `setMetadata`
alcança o script de boot (o risco aceito está em "Atualização da frota", "As permissões novas do cp-worker").

### Estados do cliente

Toda mudança de estado é uma transação no documento `tenants/{id}` que relê o estado, confere a tabela de transições,
grava a transição em `tenants/{id}/transitions` e a auditoria em `auditLog`. O evento da Stripe só dispara: o objeto
que decide é relido na API; `event.id` é único (`stripeEvents`). Os passos do provisionamento usam uma trava por
tenant (`lock{owner, expiresAt}`, 20 min renovados; vencida, é tomada), que os campos de cobrança nunca disputam.

| Estado                        | Entra quando                                                                                                                                                               | Ação                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pending`                     | `checkout.session.completed`: a reserva do subdomínio vira tenant; ou o cadastro de um contrato direto pelo console                                                        | Cartão pago segue direto; boleto espera a compensação; contrato direto, o `provision` do console         |
| `provisioning`                | `invoice.paid` do 1.º ciclo, `checkout.session.async_payment_succeeded` ou, no contrato direto, o `provision` do responsável                                               | Enfileira o `preflight`; 10 passos idempotentes, um por task                                             |
| `provisioning_failed`         | Um passo esgotou as tentativas ou falhou sem repetição (`provisioning_disabled`, `ready_timeout`, `node_error`)                                                            | Alerta à Verax; o site diz "estamos finalizando"; `resume` pelo responsável retoma do passo registrado   |
| `waiting_customer_install`    | O cadastro de um contrato direto com o ambiente na VM do cliente (`hosting = customer`), direto da criação                                                                 | Nada roda na Verax até o primeiro código de instalação, que leva a `provisioning` (a sequência reduzida) |
| `waiting_customer_connection` | Passo `access.ready`                                                                                                                                                       | E-mail "ambiente pronto" com o link da página de status; a senha é revelada ali (ou no console), uma vez |
| `active`                      | O `tick` lê no nó `verax/accounts-connected >= 1`                                                                                                                          | Monitoramento normal                                                                                     |
| `past_due`                    | `invoice.payment_failed` numa renovação                                                                                                                                    | Carência de 7 dias (relógio próprio: o Smart Retries não cobre boleto); e-mail com o Portal; nó no ar    |
| `suspended`                   | Assinatura `unpaid`, carência vencida (`tick`), disputa ou alerta de fraude (decisão humana); no contrato direto, só o responsável                                         | VM parada (`node.stop`); disco e snapshots ficam; `invoice.paid` (ou o responsável) reativa e liga a VM  |
| `canceled`                    | `customer.subscription.deleted`, reembolso integral na garantia, boleto do 1.º ciclo vencido, 30 dias suspenso sem pagar (`tick`, D+37) ou o responsável (contrato direto) | VM parada; exportação sob pedido por 30 dias; relógios de D+30 e D+97                                    |
| `deleted`                     | `tick` com `deleteAfter` vencido, ou `delete-now` pelo responsável                                                                                                         | Exclusão em dois tempos (abaixo)                                                                         |

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
  cp-public, cp-admin e o responsável). O app tira a identidade do cabeçalho que o Cloud Run conferiu (o
  `X-Serverless-Authorization` quando houver, senão o `Authorization`; os dois juntos são recusados, porque com os dois
  o Cloud Run só confere o primeiro), confere de novo a assinatura com as chaves públicas do Google (sem assinatura, só
  no `X-Serverless-Authorization`, onde o Cloud Run a remove depois de conferir), o emissor, `aud = WORKER_URL`, o prazo
  e o e-mail por rota. O token do `cp-public` (`PUBLIC_SA_EMAIL`) só vale na revelação; o da cp-invoker e o do
  responsável, só nos passos (`POST /internal/steps/<passo>`); o do `cp-admin` (`ADMIN_SA_EMAIL`), só nas operações do
  responsável, com quem agiu no corpo (seção "Ciclo de vida depois da venda"), entre elas a revelação pelo console
  (`/internal/tenants/:id/reveal-access`, item seguinte). A chamada do `cp-public` sai pela internet, então a revelação depende da decisão
  sobre a entrada do `cp-worker` no GUIA ("Revelação da senha e a entrada do cp-worker"); até lá, ela responde 503.
- **Revelação pelo responsável, no console (desde 22/11/2026):** o responsável pode ver a senha uma vez para copiar
  e mandar ao cliente, na página do cliente (`/clientes/:id`, bloco "Acesso do administrador", botão "Mostrar senha
  inicial…", só em `waiting_customer_connection` sem revelação). É **a** revelação única, não uma cópia dela: o console
  chama `POST /v1/admin/tenants/:id/reveal-access` `{confirmSlug}` (o subdomínio digitado, o limite das operações do
  responsável e a auditoria `tenant.console_request` sem a senha), e o `cp-admin` chama
  `POST <WORKER_URL>/internal/tenants/:id/reveal-access` `{confirmSlug, actor}` com o token da conta dele (só
  `ADMIN_SA_EMAIL`, com um responsável em `actor`, ou um responsável direto; nem a cp-invoker nem o `cp-public`). No
  `cp-worker` a transação que marca confere o subdomínio (400 `confirmation_mismatch`, nada marcado), o cliente
  (existente, não excluído, sem revelação, em espera) e grava `access.passwordRevealedAt` com a auditoria
  `access.revealed` de quem agiu (`owner:<e-mail>`, `via: owner`); os passos (2) a (4) são os mesmos da revelação do
  cliente (`RevealService.deliver`), e o desfazer também. Depois dela, o cookie da página de status e o link do e-mail
  respondem 409 `already_revealed`, e a do cliente, antes, faz o mesmo com a do responsável. A senha passa pelo
  `cp-admin` na máscara do logger, volta ao navegador com `Cache-Control: private, no-store`, e o console a guarda só no
  estado da tela (fora do cache das consultas), até fechar.
- **Plano B por e-mail:** 48 h depois de o cliente entrar em `waiting_customer_connection` sem ver a senha (e antes das
  72 h em que ela vence), o `tick` do CP-11 chama `RevealEmailService.dispatchDue`, que enfileira o passo
  `access.reveal_email`; o passo cria um link de uso único (`statusTokens` do tipo `email_reveal`, 24 h), manda o
  e-mail "ambiente pronto" pelo SMTP do `cp-worker` com o link no fragmento (`#acesso=<valor>`, que o navegador não
  envia a servidor nenhum) e marca `access.revealEmailSentAt`. O e-mail nunca leva a senha.
- **Contrato com o bootstrap do nó (CP-10):** cada versão de `admin-bootstrap` é um JSON com exatamente `email`,
  `password` (16 a 256 caracteres) e `expiresAt` (ISO 8601 com fuso). O segredo guarda só o admin do cliente: a senha
  de outra conta (a de suporte) vai para outro segredo, `vx-<slug>-support-bootstrap` (seção seguinte), senão a
  `latest` a mostraria ao cliente.

### Primeiro acesso do nó de cliente e estado do nó (CP-10)

O nó que o plano de controle cria liga o **modo cliente** (`CUSTOMER_MODE=true` no `node.conf`). O nó da Verax não liga
e não muda nada.

- **Entradas:** três metadados da instância, gravados pelo Terraform do tenant: `verax-tenant-name`,
  `verax-admin-email` e `verax-support-email`. O mapa chave → variável fica num lugar só do `start.sh`
  (`CUSTOMER_BOOTSTRAP_INPUTS`). Nenhum é segredo; o plano do cliente é o `PLAN` do `node.conf`, como sempre.
- **Quem roda:** o serviço `verax-customer-bootstrap` (depois do `verax-node`, a cada partida) chama
  `start.sh customer-bootstrap`. O host lê os metadados e roda o `node-bootstrap` com `BOOTSTRAP_MODE=customer`; as
  entradas vão pelo ambiente do `compose run`, nunca por argumento nem pelo `bootstrap.env`, que não aceita aspas
  simples num nome. O CLI cria o cliente (com o rótulo do plano), o `admin_cliente` e um `admin_verax` de suporte, pelo
  mesmo caminho de toda conta (`provisionUser` + `setTemporaryPassword`), com a auditoria de sistema (o cliente e o admin
  na trilha do cliente; a conta de suporte, global, fora dela). Tudo é conferido antes da primeira escrita: e-mail de
  outro cliente ou de outro papel, e conta desativada com pedido de senha, param sem criar nada. Idempotente e mais
  estrito que o bootstrap do nó da Verax: conta que já tem senha não ganha outra, mesmo antes do primeiro login (a senha
  está no cofre, à espera da revelação), a não ser a pedido (`BOOTSTRAP_RENEW_ADMIN_PASSWORD` ou
  `BOOTSTRAP_RENEW_SUPPORT_PASSWORD`).
- **Onde a senha passa:** gerada no contêiner do bootstrap, entra na máscara do logger antes do próximo `await` e vai
  direto para um arquivo 0600 (`<nome>.json`, o JSON do contrato) numa pasta de `/run/verax` (tmpfs, 0700 de root)
  montada só nele. Nunca vai para a saída padrão, o log, a auditoria, uma mensagem de erro ou um argumento de comando.
  O host lê o arquivo (recusa link e conteúdo fora do formato), pede o token da conta de serviço da VM ao servidor de
  metadados e grava a versão pela API REST do Secret Manager (`:addVersion`), com o token e o corpo em arquivos 0600 do
  tmpfs; tenta de novo a falha de rede, o 429 e o 5xx, e para no resto. O arquivo sai só depois de o Secret Manager
  confirmar; numa falha, fica no tmpfs e vai antes de qualquer outra senha na próxima tentativa (o serviço tenta a cada
  minuto). **Por que no host:** o contêiner da API e o do bootstrap não alcançam o servidor de metadados (a guarda do
  `metadata-guard.sh` só libera o worker), e levar a senha ao worker seria um caminho a mais; o host já é root, tem a
  identidade da VM e é quem lia a linha marcada do bootstrap do nó da Verax.
- **Segredos:** `vx-<slug>-admin-bootstrap` (revelado uma vez ao cliente pelo `cp-worker`) e
  `vx-<slug>-support-bootstrap` (só o responsável lê e destrói com o `gcloud`; `docs/runbooks/onboarding-cliente.md`,
  item 7). A VM só tem `secretVersionAdder` nos dois: grava e não lê de volta.
- **Estado do nó nos guest attributes:** a tarefa `node-status` do worker (`NODE_STATUS=true` e `VERAX_NODE_COMMIT` no
  `worker.env`, escritos pelo `start.sh` no modo cliente) grava a cada 5 min, por `PUT` no servidor de metadados com
  `Metadata-Flavor: Google`, `verax/version` (o commit instalado), `verax/accounts-connected` (contas ativas
  conectadas), `verax/last-event-at` (o evento mais recente em ISO 8601 UTC, ou `none`) e `verax/disk-free` (porcentagem
  livre do disco de dados, inteiro de 0 a 100). Só agregados, nada que identifique cliente, conta ou pessoa. O worker é o
  único contêiner com acesso ao servidor de metadados. O disco é medido pelo `statfs` da CA do banco, um arquivo de
  `/var/lib/verax` já montado só leitura no worker: dá o espaço do sistema de arquivos onde ficam o banco, os backups e
  os volumes do Docker, sem montagem nova. Com os atributos desligados na VM (403 ou 404 no `PUT`; a documentação da GCP
  não fixa o código), a tarefa avisa uma vez e para no primeiro `PUT` de cada execução, sem ler o banco.
  **Ritmo:** a GCP pede no máximo uma rajada de 3 consultas por segundo nos guest attributes (e 10 por minuto por VM) e
  pode descartar atributos que estão sendo gravados acima disso; todo `PUT` do processo passa por um ritmo único
  (`WritePacer`, 500 ms entre um começo e o seguinte), então nenhuma janela de 1 s tem mais de 3. São 4 gravações a
  cada 5 min, menos de 1 por minuto.

### Sincronização com o plano de controle: o lado do nó (fontes de log e usuários do console)

O responsável cadastra as fontes de log do cliente (AWS e Cloudflare; projetos da GCP só na VM própria) e pede usuários
do cliente no console, e o nó dedicado os aplica. O contrato está em `packages/shared/src/node-sync.ts` (estrito dos
dois lados); os envelopes da credencial e da senha, em `packages/vault-envelope`. Aqui, só o lado do nó
(`apps/api/src/control-plane-sync/`).

- **Quem liga:** o `start.sh`, no modo cliente (`CUSTOMER_MODE=true`), nas duas plataformas, nunca na célula (que tem o
  canal dela): `CONTROL_PLANE_SYNC=true` e `VERAX_NODE_COMMIT` no `worker.env`; `CONTROL_PLANE_ORIGIN` do `node.conf`
  quando está no formato (sem a linha, `https://conta.veraxsistemas.com.br`); `CONTROL_PLANE_USERS=false` só quando o
  `node.conf` traz a linha com `false` (o interruptor do cliente para os usuários pedidos no console; outro valor que não
  `true` também desliga, com o aviso; sem a linha, o worker os cria). A configuração do worker recusa a
  sincronização com `NODE_MODE=cell`, sem o `NODE_SA_UNIQUE_ID` num nó da GCP, sem a chave na VM própria e sem o commit;
  o `start.sh` deixa a sincronização de fora, com o aviso, quando falta a identidade, para o worker subir.
- **Identidade do nó:** num nó da GCP, o token do Google da conta de serviço do nó, pedido ao metadata com o audience da
  própria rota (`<origem>/v1/node-sync`) e `format=full` (o plano de controle confere o `sub`, o projeto e a VM), guardado
  até faltarem 5 min para vencer (`fetchNodeSyncToken`). Na VM própria, a chave do nó que o registro deixou em
  `/etc/verax/vault/node-key`: o `start.sh` a copia para `/run/verax/cp/node-key` (tmpfs, 0440 de root e do grupo do
  worker), montada só leitura só no worker (`compose.yaml`, `/run/cp`), fora de `/run/verax/vault`, que o job
  `aws-sessions` também monta; o worker a lê na partida (`CONTROL_PLANE_NODE_KEY_FILE`) num objeto que não vira JSON
  nem texto de log. A chave nunca passa pelo ambiente do contêiner.
- **Ritmo:** a tarefa `control-plane-sync` acorda a cada 15 s e só chama quando a próxima chamada chegou: a cada 5 min
  ±30 s (o `pollAfterSeconds` da resposta manda), guardada em `ControlPlaneSync` (sobrevive à partida do worker). A
  reserva de cada chamada roda sob `pg_advisory_xact_lock('verax:control-plane-sync')` e adia a próxima pelo orçamento
  (60 s), para duas réplicas não chamarem juntas. A sequência é a maior entre a anterior mais um e o relógio em ms: um
  banco que voltou de um backup não repete uma sequência já aceita.
- **Pedido:** o commit, a plataforma, o cliente do banco do nó (o do rótulo dos envelopes; com mais de um cliente,
  `tenant_ambiguous` e nada é aplicado), a chave pública corrente do cofre (o PEM do SPKI em base64, a versão e a
  impressão digital SHA-256 do DER), o ID da conta de serviço (GCP), os IPs de saída, o audience da AWS e o que aconteceu
  com cada fonte do console (as contas `origin = control_plane` e os itens de `ControlPlaneSyncItem`: a revisão, o
  resultado, o código da falha, a credencial vigente, só metadados, e a situação da conta) e com cada pedido de usuário
  (a conta criada, com a situação de agora, em todas as chamadas: ativa, convidada ou desativada, o MFA e se ainda está
  na senha temporária; ou a recusa, com o código). Capacidades anunciadas: `log_sources` e `users` (também com
  `CONTROL_PLANE_USERS=false`, para o console mostrar o motivo de cada recusa). Sem seguir redirecionamento, em até
  20 s, lendo no máximo 1 MB da resposta, conferida pelo contrato estrito. O corpo inteiro cabe em
  `NODE_SYNC_REQUEST_MAX_BYTES` (256 KiB, o limite da rota no `cp-public`): vão antes os relatos que mudaram desde o
  último aceito (o SHA-256 dele fica no `ControlPlaneSyncItem`) e, entre os outros, os aceitos há mais tempo, para os
  que ficam de fora irem nas chamadas seguintes. Os relatos dos usuários entram primeiro, com a mesma régua e o teto
  de `NODE_SYNC_MAX_USERS` (200 relatos de perto de 150 bytes, cerca de 30 KiB): são pequenos e são o que faz o plano
  de controle mostrar o resultado e apagar o envelope; as fontes ficam com o resto do limite. Deixar um relato de fora
  é seguro: o plano de controle só atualiza o relato dos itens que vieram no pedido.
- **Credencial colada no painel numa conta do console:** o `PUT` da credencial grava `origin = panel` e a revisão do
  console vazia; o nó conta de volta `revision: null`, e a revisão já aplicada do console não volta, só uma mais nova.
- **Cada fonte numa transação** (`apply-source.ts`), no escopo do cliente do nó:
  - criar: a vaga do plano (`lockPlanSeats`/`assertWithinPlan`; sem vaga, `plan_limit_reached`, tentado de novo a cada
    hora), a mesma conta do provedor já cadastrada pelo cliente (`account_exists_panel`; o nó nunca toca numa conta do
    painel), as origens de log livres (`assertLogOriginsFree`, a mesma régua do painel; `origin_conflict`) e a conta
    com o id da fonte, `origin = control_plane` e `controlPlaneRevision`;
  - alterar: só com revisão maior que a aplicada, só os campos do console, com as regras de conexão do painel (outra
    lista de buckets ou outra assinatura recomeçam a conexão); outro provedor ou outro ID é `immutable_changed`;
  - lápide (`removed`): como o "Desativar" do painel (a conta inativa, a credencial apagada); a conta que já não
    existe (o cliente a excluiu no painel) é contada como removida;
  - a fonte que o cliente excluiu no painel (`deleted_in_panel`) só volta com uma revisão maior (seção "Desativar e
    excluir uma conta");
  - a credencial, depois da conta e só quando a revisão do console é mais nova que a última do console aplicada (uma
    colada no painel vale até o console mandar outra): aberta com as chaves do cofre (prova a amarração ao cliente, à
    conta, ao tipo e ao ID no provedor; senão `credential_unreadable`), o tipo tem de valer na plataforma
    (`credential_kind_not_allowed`), conferida na origem pelas mesmas conferências do painel, fora de transação
    (`credential_rejected_<motivo>`; a origem fora do ar, `source_unavailable`, tentada de novo em 1, 2, 4... min até 30)
    e gravada com o envelope exatamente como veio, sem recifrar.

  Uma revisão que falhou só é tentada de novo com outra revisão (menos as duas falhas que passam sozinhas).

- **Cada usuário pedido** (`apply-user.ts`), depois das fontes, cada um na sua vez. O resultado de um pedido é final e
  fica em `ControlPlaneSyncItem` (`kind = user`, o ULID do pedido): o plano de controle apaga o envelope com qualquer
  relato, um pedido recusado não é tentado de novo (o console faz outro pedido), e o mesmo pedido que chegar de novo só
  é contado outra vez. Na ordem:
  - a conta com este `User.controlPlaneRequestId` já existe no cliente: `created` (o mesmo pedido nunca cria duas
    contas; a de outro cliente do banco não é contada nem tocada);
  - o prazo do pedido passou (`notAfter`; no próprio instante a senha já nasceria vencida): `expired`;
    `CONTROL_PLANE_USERS=false`: `users_disabled`; o nó sem o cofre: `vault_disabled`; o envelope que não abre com a
    amarração `{cliente do nó, pedido, e-mail}` (`openUserPassword`): `envelope_unreadable`;
  - a senha entra na máscara do logger assim que o envelope abre e vira o hash (scrypt do Better Auth) fora da
    transação; numa transação: a vaga do plano sob o lock das vagas (`lockPlanSeats`/`assertWithinPlan('users')`;
    `plan_limit_reached`, `tenant_plan_missing`), o e-mail livre na plataforma inteira (`email_taken`) e a conta, pelos
    mesmos auxiliares do painel (`insertUser` e `writeTemporaryPassword` em `apps/api/src/auth/`): o papel do pedido, o
    cliente do nó, o e-mail em minúsculas, `controlPlaneRequestId`, a senha do pedido como senha temporária com a
    validade `notAfter` (troca de senha e MFA no primeiro acesso, como a conta criada no painel) e a trilha
    `user.create`. Nenhum e-mail sai para o cliente (D8). No fim, a senha sai da máscara; ela nunca volta ao plano de
    controle, nem vai para o log ou para a trilha.

  Os IDs da conta e da conta de senha são os do Better Auth sem a instância (o worker não sobe a autenticação):
  `defaultAuthIds`, o mesmo sorteio do gerador padrão da biblioteca (32 caracteres de `a-z`, `A-Z` e `0-9`, pelo
  `generateRandomString` de `better-auth/crypto`), já que a configuração não define outro gerador; o teste
  `user-provisioning.test.ts` falha se ela passar a definir.

  Se algo mudou numa fonte, ou um pedido de usuário teve resultado, o nó chama mais uma vez na mesma execução, para
  contar logo (no máximo duas chamadas).

- **Trilha:** toda mudança entra na trilha do cliente como sistema, com o ator fixo `verax-control-plane`, que a tela
  Auditoria mostra como **"Verax (administrativo)"** (o e-mail de quem cadastrou no console fica só na auditoria do plano
  de controle), com a origem no estado novo (na conta criada, `origin: 'control_plane'` e o id do pedido; nunca a
  senha).
- **Painel:** a conta do console sai com `managedBy: 'verax'` e o selo "Cadastrada pela Verax"; alterar a fonte ou o
  monitoramento dela pelo painel dá 409 `CONSOLE_MANAGED` ("Cadastrada pela Verax: peça a alteração à Verax"). A
  credencial (colar e remover), o "Verificar" da AWS e a exclusão da conta (`deleted_in_panel`) continuam com o
  cliente.
- **Falhas da chamada:** 401, log de erro `control_plane_unauthenticated` e nova tentativa em 1 h; 404 (cliente não
  apto), 6 h; 409 `stale_sequence`, a sequência avança e a chamada é repetida na mesma execução; 429, o `Retry-After`;
  400 com o relógio do nó fora dos 10 min aceitos, log de erro `clock_skew`; 5xx, rede ou resposta fora do contrato,
  1, 2, 4... min até 30; sem o token do metadata, a próxima chamada no intervalo de sempre. No log, só ids de fonte e de
  pedido, contagens e códigos (nunca o e-mail, o nome ou a senha do usuário pedido).
- **Atualização dos nós instalados:** o `update.sh` (nós da GCP) e o `verax-install.sh --atualizar` (VM própria) rodam o
  `install.sh` do pacote novo, que reinstala o `bin/start.sh` e o `compose.yaml` em `/opt/verax`: a sincronização liga
  na primeira partida depois da atualização, sem mudar o `node.conf`.

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
  `mail_from`, `subnet_cidr` (uma /24 em 10.0.0.0/8), `bootstrap_admin_email`, `bootstrap_tenant_name` (de 2 a 120
  caracteres, a regra do checkout e o limite do `Tenant.name` do nó), `bootstrap_support_email` (a conta de suporte da
  Verax, CP-10), `smtp_host`, `smtp_port` e `smtp_user` (o e-mail do nó: os três ou nenhum; vazios, o nó sem
  e-mail),
  `control_plane_sa` (só a conta `cp-worker@...`), `images_repository` (o registro das imagens do Verax: o GHCR por
  padrão desde o CP-07, ou o Artifact Registry, que só então ganha a leitura da conta da VM) e `deletion_protection`.
  As saídas, que vão para
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
   | `vx-<slug>-smtp-password`           | o `cp-worker`, com o e-mail do nó (passo `secrets.smtp_password`) | a VM, na partida (`start.sh`)                                  |

   No `support-bootstrap`, a única permissão do Terraform é `secretVersionAdder` para a conta da VM.

2. **Atributos de convidado** (`guest_attributes`): metadado `enable-guest-attributes = "TRUE"`. O worker do nó grava
   no espaço `verax/` (`verax/version`, `verax/accounts-connected`, `verax/last-event-at`, `verax/disk-free` pelo
   CP-10; `verax/ready` e `verax/error` pela instalação), e o `cp-worker` lê com `getGuestAttributes`
   (`cpNodeLifecycle`). Só o worker fala com o servidor de metadados dentro da VM.

3. **Configuração nos metadados da VM** (`install_config` e `install_metadata`): a instalação lê cada chave em
   `instance/attributes/<chave>` do servidor de metadados e monta o `node.conf` e as contas do cliente. As 23 chaves
   existem sempre; valor vazio é "não definido" (a instalação não escreve a linha). Nada é segredo; os e-mails e o
   nome do cliente são dados de cadastro, que ficam nos metadados enquanto o nó existir, e a instalação os trata como
   dado (nunca os interpreta num shell). O projeto vem de `project/project-id`. O IP de saída (`NODE_EGRESS_IPS`)
   fica de fora: o checkov 3.4.0 não avalia os metadados da VM com uma referência ao IP reservado do NAT, e deixaria
   de conferir as chaves de segurança dela; a instalação o descobre pela própria saída (seção seguinte, PR-N7). O ID
   único da conta da VM também está no `sub` do token de identidade que ela pede ao servidor de metadados.

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
   | `verax-smtp-host`               | `SMTP_HOST` (vazio: `MAIL_TRANSPORT=none`)    | `smtp_host`               |
   | `verax-smtp-port`               | `SMTP_PORT`                                   | `smtp_port`               |
   | `verax-smtp-user`               | `SMTP_USER`                                   | `smtp_user`               |
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

### Instalação sem operador (PR-N7)

O nó de cliente se instala sozinho no primeiro boot, sem SSH, a partir do release assinado da versão que o Terraform
pôs nos metadados. É o interruptor `unattended_install` do módulo (desligado por padrão; o `envs/tenant` liga; exige
os três contratos acima, os dois cofres das senhas e o perfil `standard`). Desligado, a chave `startup-script` é o
`startup.sh.tftpl` de sempre, byte a byte: o nó da Verax (que nem usa o script do módulo) e a homologação não mudam.

**Cadeia de confiança.** Tudo o que roda antes de o release ser conferido vem do Terraform, nos metadados da VM (quem
escreve os metadados já manda na VM): o script de boot (`unattended.sh.tftpl`) leva, em base64, o script de boot de
todo nó (swap cifrado e kernel), o instalador (`infra/node/bin/boot-install.sh`), o verificador do manifesto
(`infra/node/bin/verify-release.sh`, o do SH-02) e as chaves públicas de release (`infra/node/keys/release-*.pem`). Ele
os escreve em `/run/verax-boot` (tmpfs, 0700) e roda o instalador de lá, uma execução por vez (`flock`). Do GitHub vêm
só dados, conferidos nesta ordem antes de qualquer execução: a assinatura do `manifest.json` com aquelas chaves, depois
os campos do manifesto, depois o SHA-256 do pacote (que tem de ser o mesmo nos metadados e no manifesto assinado).
Só então o `install.sh` do pacote roda. As imagens são as do manifesto, pelo digest: a API e as migrations com os
digests de `images.api` e `images.migrate` (o `install.sh` recebe `--api-digest` e `--migrate-digest`), e as de
terceiros pelo digest dos compose do pacote, que o instalador confere serem exatamente as de `thirdPartyImages`.
O executor do plano de controle (CP-07) leva o `infra/node` ao lado do `infra/gcp` (o instalador, o verificador e as
chaves públicas de release): o módulo lê esses arquivos no `plan`.

**O que a instalação faz, na primeira vez** (o marcador `/var/lib/verax/boot/installed` ainda não existe):

1. apaga `verax/ready` e `verax/error` (o plano de controle só vê `ready` quando o nó estiver de pé neste boot) e roda
   o script de boot de todo nó (swap cifrado e kernel);
2. lê as chaves `verax-*` (tabela acima) e o projeto, e confere cada valor antes de usar: só ASCII visível, tamanho
   máximo e uma expressão regular por campo (as do `envs/tenant`, do `install.sh` e do `node-release.sh`). O
   `verax-config-version` tem de ser `1` e o `verax-node-profile` tem de ser o perfil do script de boot. Nome do cliente
   e e-mails (CP-10) só têm a presença conferida, e nada deles vai para a tela, para variável do instalador nem para
   guest attribute. O `MAIL_FROM` com apóstrofo, que o `envs/tenant` aceita, é recusado: o arquivo de ambiente do
   `start.sh` não o comporta;
3. instala o `jq` pelo apt, se faltar (pacote do Debian), baixa `manifest.json` e `manifest.json.sig` do release
   `verax-node-version` do GitHub (só HTTPS, também nos redirecionamentos, com teto de tamanho) e confere a assinatura;
4. confere o manifesto: `schema` 1, `kind`, `release` igual à versão pedida, `version` (o commit), a URL do pacote do
   próprio release, `package.sha256` igual ao dos metadados e as duas imagens do Verax no GHCR pelo digest;
5. baixa o pacote, confere o SHA-256, confere que só há caminhos dentro de `verax-node/` e abre;
6. descobre o IP de saída (abaixo) e escreve o `node.conf` do modo cliente só com valores conferidos; cada linha passa
   de novo por um formato sem nada que o `source` do `install.sh` e do `start.sh` interprete (letras, dígitos e
   `@._+:/,-`);
7. com o e-mail do nó (as três chaves `verax-smtp-*`), espera a senha da caixa de envio chegar ao cofre
   `vx-<slug>-smtp-password`, a cada 60 s por até 60 min (`smtp_password_missing` depois disso): o `start.sh` não sobe
   sem ela, e o plano de controle a grava logo depois do `apply`. Confere só que a versão `latest` abre (o gcloud com
   a identidade da VM e `--format=value(name)`, a saída descartada): a senha não passa pela instalação;
8. roda o `install.sh` do pacote com o commit, os dois digests, `--release <versão>` e o `node.conf` (com o apt
   esperando a trava, em vez de falhar, só nessa execução) e grava o marcador.

**Em todo boot, depois:** espera o `verax-node`, o `verax-wazuh` e o `verax-customer-bootstrap` (o primeiro acesso do
CP-10, que grava a senha no `admin-bootstrap`) ficarem ativos; se o `start.sh up` subiu sem o token do túnel (o
`cloudflared.env` vazio), relê o cofre a cada 60 s por até 60 min com o `start.sh tunnel`, que sobe só o
`cloudflared`; e grava `verax/ready=<versão>`. Uma falha grava `verax/error=<código>` e o boot seguinte tenta de novo.
A saída do instalador vai para o journal e para a saída serial da VM (`gcloud compute instances
get-serial-port-output`), sem nenhum valor pessoal: é o diagnóstico sem SSH.

**Versão.** O `node-vX.Y.Z` (a tag do release, o `verax-node-version` dos metadados e o `release` do manifesto) e o
commit (o `version` do manifesto) convivem: o `install.sh` grava em `/etc/verax/images.env` o `NODE_VERSION` (o commit,
como sempre: é o que o `start.sh` confere, o `env.schema.ts` aceita e o worker publica em `verax/version`) e, só quando
recebe `--release`, o `NODE_RELEASE`. O `verax/ready` é o `NODE_RELEASE` (o que o plano de controle pediu e compara no
`node.wait_ready`); num nó atualizado depois pelo `deploy.sh`, que não passa `--release`, vira o commit. O nó da Verax
e o `deploy.sh` não mudam: sem `--release`, o `images.env` é o de antes, linha a linha.

**A instalação não atualiza.** Instalado o nó, uma versão diferente em `verax-node-version` (um `apply` do tenant com
outra `node_version`) só aparece no log do boot; nada é baixado nem instalado. Instalar sozinho, num reboot qualquer,
rodaria migrations sem backup, sem janela e sem volta. A atualização é a da frota (seção "Atualização da frota", abaixo):
outra chave dos metadados (`verax-node-release`), o atualizador do host com backup e volta, e o plano de controle em
ondas. O `deploy.sh` continua valendo para o operador, com o `node.conf` que a instalação escreveu
(`/etc/verax/node.conf` da VM). Uma instalação que parou no meio (o marcador `installing`) é refeita do começo no boot
seguinte: o `install.sh` pode rodar de novo, e o atualizador espera por ela.

**Valores que a instalação decide** (não estão nos metadados):

- `NODE_EGRESS_IPS`: o IP de saída com `/32`, perguntado a `https://checkip.amazonaws.com` (só HTTPS), que responde o
  IP de origem como a AWS o vê. É esse IP que a AWS compara com o `aws:SourceIp` da pilha do papel de leitura, e todo
  o tráfego do nó `standard` sai pelo IP reservado do NAT. Um valor fora do formato (ou nenhum) para a instalação
  (`egress_ip_unknown`); um valor errado só faria a AWS recusar o nó (a pilha libera um IP só, e entrar no papel ainda
  exige o token da conta da VM). Alternativas descartadas: a API do Compute (uma permissão nova da VM no projeto dos
  nós inteiro, porque endereço não aceita IAM por recurso) e uma segunda aplicação do tenant com a saída `nat_ip`;
- `MAIL_TRANSPORT`: `smtp` com `SMTP_HOST`, `SMTP_PORT` e `SMTP_USER` quando as três chaves `verax-smtp-*` têm valor
  (uma sem as outras é `metadata_invalid`); `none` quando estão vazias, como antes (contas com senha temporária,
  avisos por e-mail pulados). A senha nunca está nos metadados nem no `node.conf`: o `start.sh` a lê do cofre na
  partida;
- `SYNC_SOURCES=gcp,wazuh,cloudflare` (sem `cloudflare` se o cofre de credenciais estiver desligado);
- `WAZUH_AGENTS=false` e `CUSTOMER_MODE=true`.

**Códigos de `verax/error`** (só o código; o motivo fica na saída serial):

| Código                      | Quando                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| `metadata_missing`          | uma chave `verax-*` (ou o projeto) falta ou, no CP-10, está vazia               |
| `metadata_invalid`          | um valor fora do formato, o contrato ou o perfil errado, enterprise sem limites |
| `metadata_unavailable`      | o servidor de metadados não respondeu                                           |
| `prepare_failed`            | o script de boot de todo nó (swap cifrado e kernel) falhou                      |
| `dependencies_failed`       | o `jq` não instalou                                                             |
| `release_download_failed`   | o manifesto, a assinatura ou o pacote não baixaram                              |
| `release_signature_invalid` | a assinatura não fecha com as chaves de release                                 |
| `release_verifier_failed`   | o verificador não rodou (chave fora do formato, arquivo ausente)                |
| `release_manifest_invalid`  | o manifesto assinado é de outra versão ou está fora do formato                  |
| `package_sha256_mismatch`   | o SHA-256 dos metadados não é o do manifesto, ou o pacote baixado não fecha     |
| `package_invalid`           | o pacote não abre, tem caminho fora, ou imagens de terceiros fora do manifesto  |
| `egress_ip_unknown`         | o IP de saída não foi descoberto                                                |
| `install_failed`            | o `install.sh` falhou                                                           |
| `node_start_failed`         | o `verax-node` não subiu                                                        |
| `wazuh_start_failed`        | o `verax-wazuh` não subiu                                                       |
| `customer_bootstrap_failed` | o primeiro acesso do cliente falhou de vez (ou não terminou no prazo)           |
| `tunnel_token_missing`      | o token do túnel não chegou ao cofre em 60 min                                  |
| `smtp_password_missing`     | com o e-mail do nó, a senha da caixa de envio não chegou ao cofre em 60 min     |
| `install_state_invalid`     | o nó instalado perdeu o `/etc/verax/images.env`                                 |

**Origem das imagens do Verax.** O `envs/tenant` manda `verax-images-repository` com o registro da variável
`images_repository`, e o `install.sh` baixa de lá pelo digest do manifesto (o mesmo nos dois registros). Desde o CP-07
o padrão é o GHCR público do repositório (`ghcr.io/williandotdev/verax-control`, o do próprio manifesto), sem o
ajudante de credenciais do `gcloud` e sem permissão nenhuma; o plano de controle manda o valor de
`NODE_IMAGES_REPOSITORY` (com o mesmo padrão). O Artifact Registry do projeto da Verax continua aceito, e só com ele o
tenant dá à conta da VM a leitura do registro. **Por que o GHCR (decisão do CP-07, a confirmar pelo responsável):** a
limpeza do Artifact Registry (`envs/verax/images.tf`) apaga, depois de 30 dias, toda versão que não está entre as 3
mais recentes nem marcada `no-`; um release promovido há mais tempo pode não estar mais lá, e a instalação de um
cliente novo nessa versão pararia em `install_failed`. A outra saída seria marcar as imagens de cada release com uma
tag `no-` no Artifact Registry (mais uma permissão no workflow de release).

**Imagens de terceiros: pela origem, sem espelho (decisão em aberto).** O plano da fase 2 previa espelhar no Artifact
Registry as imagens do Wazuh, do PostgreSQL e do cloudflared, para o nó gerenciado não depender do Docker Hub. O SH-02
decidiu baixá-las da origem pelo digest (o manifesto as lista assim), e este passo segue essa decisão:

- **a favor do espelho:** o Docker Hub limita o pull anônimo por IP e pode estar fora do ar no boot de um cliente (as
  quatro imagens de terceiros vêm de lá; cada nó tem o próprio IP de saída e baixa cada uma uma vez, bem abaixo do
  limite, e o `start.sh` não baixa de novo o que já está no disco);
- **contra:** o armazenamento pago no Artifact Registry (o manager e o indexer do Wazuh têm cerca de 2,7 e 2,6 GB
  descompactados, por versão), um workflow e uma permissão a mais para copiar, e a redistribuição de imagem GPL
  (Wazuh), cujas obrigações não foram verificadas.

O espelho não muda o manifesto (o digest é o mesmo), só o registro de onde os compose baixam.

**Ainda fora:** observar o metadado `verax-renew-admin-password` (o Terraform é dono dos metadados: precisa virar
variável do tenant) e as partes do modo próprio (código de ativação, chave do nó).

### Provisionamento: os passos e o executor Terraform (CP-07)

Do pagamento ao ambiente pronto, sem operador: o webhook (CP-04) põe o cliente em `provisioning` com um `runId` e
enfileira o `preflight`; cada passo é uma task `POST /internal/steps/<passo>` com `{tenantId, runId}` (e, nos que
esperam, o número da consulta, `poll`) e o token da cp-invoker; o código fica em `apps/control-plane/src/provisioning`.

| Passo                   | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Para de vez com                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight`             | Configuração completa; o que foi vendido cabe no nó (modo gerenciado, porte P, sem agentes, limites nas faixas do `envs/tenant`); o manifesto da versão no bucket de releases, com a assinatura conferida pelas chaves de `infra/node/keys`; o e-mail do nó (com `SMTP_HOST_NODES`, a senha em `cp-nodes-smtp-password` no formato que o nó aceita; sem ele, o aviso `node_mail_disabled`); a faixa de rede (contador `counters/subnets`); o projeto do Firebase com vaga (36 sites); os nomes (`vxc-<slug>-<hex>`) | `provisioning_disabled`, `configuration_unsupported`, `release_manifest_*`, `smtp_password_missing`, `smtp_password_invalid`, `firebase_pool_full` |
| `cloudflare.tunnel`     | O túnel `vx-<slug>` gerenciado pelo Cloudflare, o ingresso `api-<slug>` → `http://api:3000` (o resto 404) e o CNAME com proxy para `<id>.cfargotunnel.com`                                                                                                                                                                                                                                                                                                                                                          | `cloudflare_denied` (token), `cloudflare_rejected`                                                                                                 |
| `firebase.site`         | O site, o bundle do painel (CP-09) conferido pelo SHA-256 do manifesto e publicado com a CSP do cliente (o marcador `{tenant}` trocado), o domínio `<slug>.control...` e os registros que o Firebase pede, sem proxy                                                                                                                                                                                                                                                                                                | `panel_bundle_missing`, `panel_bundle_sha256_mismatch`, `panel_bundle_invalid`, `firebase_site_conflict`                                           |
| `terraform.apply`       | Dispara o Job `cp-terraform` (`jobs.run` com as variáveis do cliente; a execução fica no documento do passo, uma só por entrega)                                                                                                                                                                                                                                                                                                                                                                                    | `executor_input_invalid`                                                                                                                           |
| `terraform.wait`        | Consulta a execução a cada 30 s; concluída, lê `runs/<slug>/<runId>/<execução>/outputs.json` e guarda os recursos; falhou, repete o `apply` uma vez; passou de 35 min, conta como falha                                                                                                                                                                                                                                                                                                                             | `terraform_refused:<código>`, `terraform_failed`, `terraform_outputs_invalid`                                                                      |
| `secrets.smtp_password` | Com o e-mail do nó nesta execução, lê a senha da caixa de envio em `cp-nodes-smtp-password` (projeto do plano de controle) e a grava como versão de `vx-<slug>-smtp-password`; sem o e-mail, não faz nada. A senha vive só na memória do passo, na máscara do logger                                                                                                                                                                                                                                                | `smtp_password_missing`, `smtp_password_invalid`, `secretmanager_denied`                                                                           |
| `secrets.tunnel_token`  | Lê o token do túnel no Cloudflare e o grava como versão de `vx-<slug>-cloudflare-tunnel-token`; o token vive só na memória do passo, na máscara do logger                                                                                                                                                                                                                                                                                                                                                           | `secretmanager_denied`                                                                                                                             |
| `node.wait_ready`       | Lê os guest attributes a cada 60 s: `verax/ready` igual à versão pedida (mesmo com um `verax/error` antigo) segue; `verax/error` para; aviso em 40 min (`node_ready_slow`), prazo de 90 min (a releitura do cofre do túnel vai até 60 min e o Wazuh tem até 40 min de partida, PR-N7)                                                                                                                                                                                                                               | `node_error:<código>`, `ready_timeout`                                                                                                             |
| `node.health`           | `GET /health` e `/health/ready` na API pelo túnel e o HSTS do painel em `https://<site>.web.app`, 10 tentativas de 30 s                                                                                                                                                                                                                                                                                                                                                                                             | `health_failed`                                                                                                                                    |
| `panel.domain_wait`     | O domínio a cada 2 min, criando os registros que o Firebase passar a pedir (só nomes dentro do domínio do painel do cliente), até `CERT_ACTIVE` e `HOST_ACTIVE`; aviso em 2 h (`panel_domain_slow`; a página de status já diz "o endereço está sendo emitido"), prazo de 24 h                                                                                                                                                                                                                                       | `domain_timeout`                                                                                                                                   |
| `access.ready`          | A versão mais nova do `admin-bootstrap` habilitada (o estado, sem ler a senha) → `waiting_customer_connection`; o e-mail "ambiente pronto" é o plano B do CP-05 (48 h)                                                                                                                                                                                                                                                                                                                                              | `bootstrap_missing`                                                                                                                                |

**O motor (`provisioning-engine.ts`), para todo passo:** relê o cliente (fora de `provisioning`, ou de outra execução
depois de um `resume`, termina sem fazer nada e sem enfileirar); confere a ordem (um passo já passado só garante o
atual na fila; uma consulta já feita é ignorada); toma a trava do cliente (dono `runId`, 20 min); executa; grava o
avanço no cliente antes de enfileirar o seguinte (se a fila falhar, a repetição enfileira o atual: o id da task é
determinístico, `<passo>-<runId>` e `-p<n>` nas consultas). Erro repetível (rede, 408, 429, 5xx, a trava de outro dono)
responde 503 e o Cloud Tasks repete com recuo; na última tentativa da fila (a 8.ª, `X-CloudTasks-TaskRetryCount`), vira
`retries_exhausted`. Erro definitivo (401/403 é `<serviço>_denied`, outro 4xx `<serviço>_rejected`, e os da tabela)
leva o cliente a `provisioning_failed` com o código em `provisioning.lastError`, solta a trava, não enfileira nada e
escreve a linha `event=provisioning_failed` (cliente, passo e código) que o alerta do CP-12 vai procurar. Nada é
desfeito numa falha: o `resume` recomeça do `preflight` com outro `runId`, e cada passo reconhece o que já existe
(o túnel pelo nome, o site deste projeto, o domínio, os registros, o estado do Terraform; um 409 de um id de site de
outro projeto, que é global no Firebase, sorteia outro). `provisioningRuns/{runId}` e `steps/{passo}` guardam o
andamento (a execução do Job, as consultas, o código), nunca segredo, por 180 dias.

**`resume` do responsável:** `POST /internal/tenants/:id/resume`, só para `OWNER_PRINCIPALS` (nem a cp-invoker nem o
cp-public), em `provisioning_failed` ou parado em `provisioning`; auditado como `owner:<e-mail>`. **A versão do nó fica
presa no primeiro `apply`:** o `terraform.apply` grava `provisioning.nodeVersion` e `provisioning.nodeVersionPinnedAt`
no cliente antes de disparar o Job, e daí em diante o `preflight` usa essa versão, mesmo com outro `NODE_RELEASE`. Um
`apply` que criou a VM e falhou depois (ou cujas saídas não chegaram) não grava `resources.instanceName`, mas a VM pode
já estar instalando aquela versão; trocar pela nova só mudaria os metadados (a instalação não atualiza sozinha), e o
`node.wait_ready` esperaria uma versão que nunca chega. Sem nenhum `apply` começado (uma parada no `preflight`, no
túnel ou no bundle do painel), o `resume` usa a versão da configuração.

**O executor (`infra/control-plane/terraform`):** a imagem oficial `hashicorp/terraform:1.17.1` pelo digest do índice,
sem `git` e `openssh`, com `bash`, `curl` e `jq` do Alpine; o provider `google` do lock do tenant espelhado no build
(`terraform providers mirror`; o `terraform.rc` só aceita o espelho, então nada é baixado em execução); o
`envs/tenant`, o módulo do nó e o que ele lê de `infra/node` (o instalador, o verificador e as chaves públicas de
release); usuário sem privilégio. O `entrypoint.sh` (`bash -p`):

1. recusa argumento e variável que mude o Terraform, o Go, o shell, o curl ou as credenciais (`TF_*`, `GO*`, `GCE_*`,
   `LD_*`, `BASH_ENV`, proxy, `CURL_*`, `SSL_CERT_*`, ...): quem pode disparar o Job com `overrides` (o cp-worker e o
   `cp-deployer`, que tem `run.developer` no Job) só escolhe as variáveis do cliente;
2. confere cada variável com a mesma regra do cp-worker (`executor-env.ts`) e do `envs/tenant` (a terceira conferência),
   sem nunca mostrar o valor; os valores chegam ao Terraform só por `TF_VAR_*`;
3. `init` com `bucket=<TFSTATE_BUCKET>` e `prefix=tenants/<slug>` e o lock só leitura; `plan -out`; `show -json`;
4. **recusa o plano** que apaga, recria ou esquece a conta de serviço do nó fora da exclusão do cliente, e um plano que
   não dá para ler; a ação é amarrada ao tipo da execução (`apply` em `provision`/`resume`, `destroy` em `delete`,
   `purge` em `crypto_destroy`; a Exclusão 1 e a 2 estão em "Exclusão em dois tempos", CP-11);
5. `apply` do plano conferido; as saídas da lista fixa do `envs/tenant` em `outputs.json`;
6. grava `result.json` (`succeeded`, `invalid`, `refused` ou `failed`, com o código) e `outputs.json` em
   `runs/<slug>/<runId>/<execução>/` no bucket do estado, com o token da conta do Job pelo servidor de metadados num
   arquivo 0600, nunca em argumento.

A saída do Terraform (que mostra os metadados da VM, com o e-mail do admin e o nome do cliente) fica num arquivo da
pasta de trabalho, apagada no fim; o log do Job leva só o resumo do plano (quantos recursos por ação) e, numa falha, as
linhas `Error:` cortadas. O cp-worker só repete uma execução que falhou sem recusa (`failed`), uma vez.

**Configuração (cp-worker):** com `PROVISIONING_ENABLED=true`, a partida exige o grupo do projeto dos nós
(`NODES_*`, `TFSTATE_BUCKET`, `TERRAFORM_JOB_NAME`, `RELEASE_BUCKET`, `NODE_RELEASE` no formato `node-vX.Y.Z`,
`MAIL_FROM_NODES` só com o endereço e sem apóstrofo) e, no worker, o Cloudflare, o pool do Firebase e
`BOOTSTRAP_SUPPORT_EMAIL`. `NODE_IMAGES_REPOSITORY` tem padrão (o GHCR). O e-mail dos nós (`SMTP_HOST_NODES`,
`SMTP_PORT_NODES`, `SMTP_USER_NODES`) é opcional (abaixo, "O e-mail dos nós de clientes"). O Job mora no projeto e na
região do plano de controle (`TASKS_PROJECT_ID` e `TASKS_LOCATION`). Os endereços das APIs são constantes do código,
nunca variáveis: um endereço trocado por variável levaria o token da conta do serviço junto.

**O e-mail dos nós de clientes.** Uma caixa de envio comum a todos os nós gerenciados, de qualquer provedor SMTP com
TLS (465, ou outra porta com STARTTLS obrigatório; a GCP bloqueia a saída pela 25), para os avisos por e-mail (PR-16 e
PR-17') e o "esqueci minha senha" de cada nó:

- **o que o responsável configura uma vez:** em `worker_env`, `SMTP_HOST_NODES`, `SMTP_PORT_NODES` (padrão 465) e
  `SMTP_USER_NODES` (o servidor e o usuário andam juntos; a partida do cp-worker recusa um sem o outro), com o
  remetente `MAIL_FROM_NODES` de sempre; e a senha como versão do segredo `cp-nodes-smtp-password` do projeto do
  plano de controle (o `envs/control-plane` cria o cofre vazio e dá ao `cp-worker` só a leitura dele). O segredo não
  é montado como variável: o cp-worker o lê pela API do Secret Manager na hora de copiar (sempre a `latest`, sem
  revisão nova do serviço), e o cofre vazio não impede o serviço de subir;
- **uma caixa à parte da do plano de controle** (`cp-smtp-password`, a dos e-mails de cobrança, de "ambiente pronto"
  e do plano B da revelação): a senha dos nós fica no cofre de cada nó de cliente, que a VM lê, e um nó comprometido
  não deve levar a caixa que manda a revelação aos clientes (nem, com uma senha de aplicativo que abre IMAP, a caixa
  de entrada dela); o limite de envio de uma não esgota o da outra, e cada uma troca de senha sozinha. Nada impede
  usar a mesma conta nas duas, mas não é o recomendado;
- **no provisionamento:** o `preflight` decide o e-mail da execução e guarda o servidor, a porta e o usuário no
  `provisioningRuns/{runId}` (`nodeMail`; nunca a senha), depois de conferir que a senha está no cofre e no formato
  que o nó aceita (`isNodeSmtpPassword`: 1 a 512 caracteres de ASCII visível, sem aspa simples, que o arquivo de
  ambiente do `start.sh` não comporta; uma quebra de linha no fim sai, como no `start.sh`). Sem a senha,
  `smtp_password_missing` antes de criar qualquer coisa: um nó criado com o e-mail ligado e sem a senha não sobe, e um
  criado sem o e-mail não o ganha depois. O `terraform.apply` manda `SMTP_HOST`, `SMTP_PORT` e `SMTP_USER` ao Job
  (vazias sem o e-mail), que o `entrypoint.sh` e o `envs/tenant` conferem de novo e põem nos metadados
  (`verax-smtp-*`); com o e-mail, o `envs/tenant` dá ao `cp-worker` o `secretVersionAdder` no `smtp-password` do nó,
  e o passo `secrets.smtp_password` grava a senha lá logo depois do `apply` (antes do token do túnel), marcando
  `resources.nodeMailPasswordAt` no cliente. A instalação espera essa versão antes de subir o nó (seção "Instalação
  sem operador");
- **sem o e-mail configurado**, o provisionamento segue e o nó nasce com `MAIL_TRANSPORT=none` (os avisos ficam
  `skipped`); a partida do cp-worker e o `preflight` de cada cliente avisam no log (`node_mail_disabled`);
- **troca da senha (rotação):** o responsável cria a senha nova no provedor sem revogar a antiga, grava uma versão
  nova em `cp-nodes-smtp-password` e chama `POST /internal/nodes/smtp-password/sync` (só `OWNER_PRINCIPALS`, como o
  `resume`): o cp-worker varre todos os clientes em páginas, pelo subdomínio (único e imutável: a ordem não muda com
  as gravações da própria varredura), grava a `latest` no cofre de cada um com `resources.nodeMailPasswordAt` (menos
  os excluídos) e atualiza o campo com a auditoria `owner:<e-mail>`. Cada chamada tem um orçamento de 10 minutos,
  abaixo do prazo do Cloud Run: esgotado com clientes pela frente, responde `complete: false` e `next`, e o
  responsável continua com `?after=<next>`. `complete: true` só quando a varredura chegou ao fim e nenhum cofre
  recusou (os ids dos que recusaram vêm em `failed`): uma troca pela metade nunca responde como concluída. O nó lê o
  cofre na partida: a senha nova vale no próximo reinício do `verax-node` ou da VM (o deploy de uma versão também
  reinicia); só depois de uma recópia completa e de todos reiniciarem a antiga pode ser revogada
  (`docs/runbooks/provisionamento.md`, "Trocar a senha do e-mail dos nós");
- **limites:** só a senha chega a um nó que já existe. Um servidor, uma porta ou um usuário novos valem só para os nós
  criados depois (o `node.conf` é escrito na instalação, e a instalação não roda de novo); um nó criado sem o e-mail
  também continua sem ele. Mudar isso num nó existente é o caminho de atualização (o `deploy.sh` com o `node.conf`
  ajustado, ou o atualizador do SH-06).

**Bundle do painel (CP-09, feito com a atualização da frota):** o contrato que o `firebase.site` lê é
`panel: {url, sha256}` no manifesto, como `package` (o arquivo `panel-<commit>.tar.gz` do release, num tar ustar com
`dist/` e o `dist-hosting.json` do build único do CP-08, montado pelo `scripts/node-release.sh panel` no workflow
`Versão do nó`), e o arquivo na pasta da versão do bucket de releases. Uma versão de antes, sem o campo, o
passo para com `panel_bundle_missing` antes de criar qualquer coisa no Firebase (o túnel, gratuito, já existe e é
reaproveitado). **Por que parar, e não esperar:** o manifesto é imutável por versão, então o bundle não aparece
sozinho; só uma versão nova (com o bundle) resolve, e esperar esconderia do responsável um erro que só ele corrige,
com o cliente numa página "preparando" para sempre. Parar avisa na hora e não custa nada (nenhuma VM criada); depois
da versão nova, `NODE_RELEASE` e o `resume`.

### Ciclo de vida depois da venda: suspensão, reativação, cancelamento (CP-11)

O relógio é o `tick` (`POST /internal/tick`, Cloud Scheduler a cada hora, token da cp-invoker; código em
`apps/control-plane/src/lifecycle`). Cada parte decide de novo dentro da transação de cada cliente (`lifecycle-rules.ts`,
regras puras), e a falha de uma não impede as outras (`event=tick_section_failed`):

| Parte              | Quem                                                                                                   | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grace`            | `past_due` com `billing.graceUntil` vencido (D+7), cobrança pela Stripe                                | `suspended` (`grace_expired`), `unpaidSince` = o fim da carência                                                                                                                                                                                                                                                                                                                                                             |
| `unpaid`           | `suspended` por `unpaid`/`grace_expired` há 30 dias (D+37), cobrança pela Stripe                       | Logo antes de cancelar, tudo conferido de novo: o cliente relido (duas vezes) ainda suspenso por falta de pagamento, a assinatura relida `past_due` ou `unpaid` e uma fatura em aberto há mais que a carência; qualquer dúvida pula o cliente (`unpaid_cancel_skipped`). Então a assinatura cancelada na Stripe (`cancel-unpaid-<tenantId>`) e `canceled` com os prazos contados de D+37. Suspenso por `fraud_review`, nunca |
| `contract_end`     | Contrato direto com `lifecycle.cancelScheduledFor` vencido                                             | `canceled` com essa data (o responsável a marcou)                                                                                                                                                                                                                                                                                                                                                                            |
| `deletion`         | `canceled` com `lifecycle.deleteAfter` vencido                                                         | Exclusão 1 (abaixo)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `crypto_destroy`   | `deleted` com a Exclusão 1 terminada e `cryptoDestroyAfter` vencido                                    | Exclusão 2 (abaixo)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `deletion_redrive` | Exclusão em andamento, sem erro                                                                        | O passo atual de volta na fila (o mesmo id de task: o Cloud Tasks recusa o repetido)                                                                                                                                                                                                                                                                                                                                         |
| `node_power`       | `suspended`/`canceled` com VM e sem `lifecycle.nodeStoppedAt`; `nodeStoppedAt` num estado de VM ligada | `node.stop` ou `node.start`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `activation`       | `waiting_customer_connection` com `verax/accounts-connected >= 1` no nó                                | `active`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `reveal_email`     | O plano B da revelação (CP-05)                                                                         | `RevealEmailService.dispatchDue`                                                                                                                                                                                                                                                                                                                                                                                             |

**A VM (`node.stop` e `node.start`, fila `lifecycle`):** cada pedido é uma task com execução própria; o passo relê o
cliente e só age se o estado ainda pede (uma task atrasada não para a VM de quem voltou a pagar), confere que o
subdomínio é dele (`slugs/{slug}`) e usa só o `cpNodeLifecycle` (`instances.get/stop/start`, VMs `vx-*`). Parar consulta
a cada 30 s até `TERMINATED` e grava `lifecycle.nodeStoppedAt`; antes de pedir a parada à Google, grava
`lifecycle.nodeStopRequestedAt`, e um cliente reativado no meio da parada é religado (o próprio `node.stop` pede o
`node.start`, e o `tick` religa quem tem a parada pedida ou feita num estado de VM ligada, mesmo que o pedido de ligar
se perca). Ligar espera `RUNNING` e o `/health` da API pelo túnel, e só então apaga as duas marcas. O disco e os snapshots ficam. O webhook (CP-04) pede o passo na hora da transição
(suspenso ou cancelado → parar; `suspended` → `active`/`waiting_customer_connection` → ligar), sem derrubar a entrega se a
fila falhar; o `tick` repete o pedido enquanto a VM não chega lá. O `tick` religa só a VM que o plano de controle
parou ou mandou parar: uma VM parada à mão pelo responsável num cliente ativo fica parada.

**Contrato direto (`billing.mode = contract`):** cliente criado pelo responsável no console, sem assinatura na Stripe
(sem o campo, `stripe`). O relógio nunca o suspende, cancela nem exclui por falta de evento da Stripe (`grace` e `unpaid`
o ignoram, mesmo com os campos forjados). Suspender, reativar e cancelar (agora, ou numa data futura de até 2 anos, o fim
do contrato; data no passado é recusada, para não encurtar o prazo da exclusão) são operações do responsável; o
cancelamento segue os mesmos D+30 e D+97. Num cliente da Stripe, as três respondem 409 `stripe_managed`.

**Operações do responsável no cp-worker:** `POST /internal/tenants/:id/{resume,delete-now,export,cancel,suspend,reactivate}`.
Quem chama é o console do responsável (`cp-admin`, com login próprio), com o token de identidade da conta dele
(audiência `WORKER_URL`; a conta é `ADMIN_SA_EMAIL`) e quem agiu no corpo (`actor`, o e-mail da sessão do console,
conferido contra `OWNER_PRINCIPALS`), ou um responsável direto (`OWNER_PRINCIPALS`). Nunca a cp-invoker nem o
cp-public, e o console nunca repassa a sessão de quem está no navegador. Todas são auditadas como `owner:<e-mail>` e, menos a exportação
e o `resume`, pedem o subdomínio do cliente de novo (`confirmSlug`): um id trocado não age no cliente errado. O cliente
HTTP que o console usa é `apps/control-plane/src/admin/worker-owner-client.ts`, com o token da conta pelo
`google-auth-library` (`admin/google-id-token.ts`).

### Cliente de contrato direto pelo console

Quando o responsável negocia direto com um cliente (sem o checkout do site), ele cadastra o cliente no console
(`apps/console`, "Clientes" → "Novo cliente (contrato direto)") e escolhe **onde o ambiente roda** (obrigatório, sem
padrão no formulário): na **infraestrutura da Verax**, o ambiente sobe pelos mesmos passos de uma compra paga; na
**infraestrutura do cliente**, nada é criado na Verax. Código em `apps/control-plane/src/admin/admin-tenants.*`,
`src/provisioning/provisioning-start.ts` e `src/provisioning/installation.ts`.

**Marketplace = infraestrutura da Verax; a do cliente, só por contrato direto** (decisão do responsável, 06/11/2026).
O cliente guarda o lugar em `tenants/{id}.hosting` (`verax` ou `customer`; ausente é `verax`, todo cliente do site e
os contratos de antes), sem nome de provedor: hoje a infraestrutura da Verax é a GCP, e pode mudar. O schema do
cliente só aceita `customer` com `billing.mode = contract` e o modo `self_hosted` da tabela, e o estado
`waiting_customer_install` só com `customer`; `hosting` nunca muda depois do cadastro. Com o ambiente no cliente:

- **Cadastro:** o pedido leva `hosting`, o plano e o volume em GB/dia (o modo da tabela sai do lugar: `managed` na
  Verax, `self_hosted` no cliente, `MODE_OF_HOSTING`); a cotação de referência é o **mesmo preço por GB/dia** dos dois
  lugares (no cliente, a DRE fica sem a nuvem da Verax e com as horas a mais do modelo de custos), só do Dedicado e do
  vCISO (a Plataforma é a célula da Verax: no cliente, 422 `configuration_contact_us` com `mode_unavailable` no campo
  `configuration.plan`), e do que o provisionamento exige valem só os limites que o próprio nó recusa (`node-fit.ts`;
  agentes não são vendidos). O cliente nasce direto em
  `waiting_customer_install` (a transição de `null`, `contract_created_customer_hosted`), e o `cp-admin` **não chama o
  `cp-worker`**: nenhum passo, nenhuma fila, nenhum Terraform, nada no projeto dos nós, no Cloudflare nem no Firebase.
- **Defesa em profundidade no `cp-worker`:** o `provision` e o `resume` recusam com 409 `customer_hosted`; o motor do
  provisionamento termina qualquer passo desse cliente sem agir; `mayHaveNode` e `mayHaveExternalResources` são falsos
  para ele (nunca `node.stop`/`node.start`, e a exclusão pula todo passo que fala com a nuvem, mesmo com uma VM forjada
  no documento); suspender é recusado (não há o que parar), e a exportação responde `no_backups` sem consultar nada.
- **O que mandar ao cliente** (`GET /v1/admin/tenants/:id/installation` → `POST /internal/tenants/:id/installation`,
  só leitura, `@WorkerCallers('owner', 'console')`): o `cp-worker` lê o manifesto da versão vigente (`NODE_RELEASE`) do
  bucket de releases, confere a assinatura e devolve a versão, o commit, os endereços do release no GitHub (o
  manifesto, a assinatura, o pacote com o SHA-256), as imagens pelo digest e a chave que assinou com a impressão
  digital (SHA-256 da pública em DER). O `cp-admin` confere a resposta de novo (só `https://github.com`, imagens só
  pelo digest) e acrescenta o guia (`docs/runbooks/instalacao-no-cliente.md`) e as linhas do plano no `node.conf`
  (`node-limits.ts`). Precisa só de `RELEASE_BUCKET` e `NODE_RELEASE`, não do provisionamento ligado.
- **Ciclo de vida:** cancelar (agora ou numa data) só registra o fim do contrato: sem janela de exportação (os dados
  nunca estiveram na Verax) e sem parar VM. Em D+30 (ou no "Apagar agora"), a exclusão só mexe no Firestore: o cliente
  perde o e-mail do administrador e o acesso, e o registro de exclusão por e-mail diz que o ambiente roda na
  infraestrutura da empresa dele, que a Verax não apagou nada lá e que a exclusão é da equipe dele (o guia,
  "Desinstalar"). Em D+97, o registro mínimo, como de todo cliente.

- **Cadastro (`POST /v1/admin/tenants`, só no `cp-admin`):** a razão social, o CNPJ, o e-mail do administrador e o
  subdomínio com os mesmos schemas e limites do checkout (`checkout.schema.ts`), o plano (os três: Plataforma, Dedicado
  e vCISO) e o volume em GB/dia e `confirmSlug` (o subdomínio digitado de novo). A API confere tudo de novo: o
  subdomínio (formato, lista reservada, livre), o nome e o e-mail como o nó os aceita, a tabela de preços vigente, a
  cotação ("fale conosco" é recusado, 422) e se o `envs/tenant` sabe criar a configuração
  (`provisioning/node-fit.ts`, a mesma regra do `preflight`: modo gerenciado, porte P, sem agentes, limites nas faixas;
  senão 422 `configuration_unsupported` com o motivo por campo).
  O cliente nasce em `pending` com `billing.mode = contract`, sem `stripe` nem `consent` (o aceite é o do contrato
  assinado), com a cotação de referência gravada em `quotes` e em `pricing` (nenhuma cobrança: a fatura e a NFS-e do
  contrato são fora do plano de controle). Logo em seguida, o console pede ao `cp-worker` o `provision`.
- **Idempotência:** o console gera um ULID ao abrir o formulário (`idempotencyKey`), que é o id do cliente: o mesmo
  envio repetido (clique duplo, resposta perdida) encontra o cliente e responde o mesmo (`replayed: true`), sem outro
  cadastro, outra cotação nem outra task; a mesma chave com outro cliente é 409 `idempotency_conflict`. Dois envios ao
  mesmo tempo terminam com um só (`TenantStore.create` com o id, numa transação).
- **Limites e auditoria:** 5 cadastros por hora e 20 operações por hora por responsável (em memória; o `cp-admin` tem
  uma instância). Toda recusa (`tenant.create_refused`, `tenant.console_request_refused`), o cadastro (`tenant.create`
  com `billingMode`) e cada pedido ao worker com o desfecho (`tenant.console_request`) vão à auditoria como
  `owner:<e-mail da sessão>`; a transição feita no worker, com o mesmo ator. Os logs levam só ids, o subdomínio, o
  plano, o porte, a versão da tabela e os códigos (nunca o e-mail, o CNPJ nem a razão social).
- **`POST /internal/tenants/:id/provision` `{confirmSlug, actor?}` (cp-worker, `@WorkerCallers('owner', 'console')`):**
  só um cliente `contract` em `pending` vai a `provisioning`, com um `runId` novo e o `preflight` na fila (o equivalente
  ao `invoice.paid` para quem não paga pela Stripe); repetido no `preflight`, só garante a task (id determinístico);
  um cliente da Stripe é 409 `stripe_managed` (o pagamento é a única porta dele). Com o worker fora do alcance, o
  cadastro fica em `pending` e o detalhe do cliente oferece "Iniciar provisionamento".
- **O acesso do cliente:** quem não passou pelo checkout não tem a página de status aberta (o `cs_` da sessão). Para um
  contrato direto, o motor do provisionamento enfileira o `access.reveal_email` assim que o cliente entra em
  `waiting_customer_connection` (o mesmo id do plano B, `access_reveal_email-<tenantId>`, então nunca saem dois), e o
  passo manda na hora o e-mail "ambiente pronto" com o link de uso único (24 h) para a página de status, onde a senha
  aparece uma vez. **Por que o e-mail, e não um link mostrado ao responsável no console:** o link é uma credencial da
  senha do administrador do cliente; no console ele passaria pelo navegador, pela área de transferência e pelo canal de
  conversa do responsável, e um clique de teste do responsável gastaria a revelação única. Pelo e-mail, a senha e o link
  só chegam ao cliente, e o console mostra só quando o e-mail saiu e quando a senha foi vista. Sem o SMTP do
  `cp-worker` ou a página de status (`SITE_SUCCESS_URL`), o `preflight` de um contrato direto para com
  `access_email_unconfigured` antes de criar qualquer coisa. Se o e-mail não sair, o plano B do `tick` (48 h) tenta de
  novo; se o link vencer sem uso, vale o caminho de uma senha nova (onboarding, item 7).
- **Detalhe (`GET /v1/admin/tenants/:id`):** o cadastro, o contratado e o preço de referência, a execução e a linha do
  tempo dos passos (de `provisioningRuns/{runId}/steps`, com o código de quem parou), o acesso (quando o e-mail saiu
  e quando a senha foi vista, nunca a senha), o ciclo de vida (prazos e a exclusão em andamento), o histórico de estados
  e as operações disponíveis agora. As operações (`POST /v1/admin/tenants/:id/<operação>`: `start`, `resume`, `cancel`,
  `suspend`, `reactivate`, `delete-now` e `export`) pedem o subdomínio digitado, conferido no `cp-admin` e de novo no
  `cp-worker`, e vão pelo `worker-owner-client.ts`; o link da exportação aparece uma vez na tela e não fica guardado.

**Exportação sob pedido (`export`):** de um cliente `canceled` dentro de `exportUntil` (30 dias); o responsável diz qual
backup (`postgres/verax-<AAAAMMDD>T<HHMMSS>Z.dump`, o nome do `backup.sh`), e o plano de controle **nunca lista o
bucket**: confere o objeto com um `HEAD` por um link assinado de 60 s e devolve um link V4 de 24 h (`GET`), assinado pelo
`signBlob` da conta `EXPORT_SIGNER_SA_EMAIL` (nenhuma chave no plano de controle). O bucket é sempre o deste cliente
(`<projeto-dos-nos>-vx-<slug>-backups`). O link é a credencial: nunca vai a log, à auditoria (que guarda o objeto e o
prazo) nem ao Firestore. Sem a conta configurada, 503: hoje o plano de controle não alcança backup de cliente nenhum
(decisão do responsável no GUIA, "O ciclo de vida (CP-11)").

### Ambiente na VM do cliente: registro e provisionamento reduzido (18/11/2026)

O contrato direto com `hosting = customer` deixou de ser "nada roda na Verax": o back end (API, worker, Postgres, Wazuh e
o `cloudflared`) roda numa VM Linux do cliente, com o pacote do nó em `NODE_PLATFORM=vm`, e o **painel e o túnel ficam
na Verax**, nos mesmos endereços do gerenciado (`tenantHosts`: `<slug>.control...` no Firebase e `api-<slug>...` pelo
túnel `vx-<slug>`). A VM não abre porta de entrada e a Verax não tem acesso a ela. Código em
`apps/control-plane/src/enrollment/`, o passo `enrollment.wait` em `provisioning-steps.ts` e a sequência em
`provisioning-engine.ts` (`CUSTOMER_PROVISIONING_STEPS`). O que vem abaixo substitui, para esse cliente, as linhas "nada
é criado na Verax" da seção anterior.

- **Código de instalação** (`POST /v1/admin/tenants/:id/enrollment-code` `{confirmSlug}` → `POST
/internal/tenants/:id/enrollment-code`, `@WorkerCallers('owner', 'console')`): 32 bytes aleatórios em base64url (43
  caracteres), mostrados uma vez, válidos por 7 dias. O cliente guarda só o SHA-256 (`tenant.enrollment.codeHash`, com
  `codeExpiresAt`, `codeCreatedAt` e `codeCreatedBy`). Gerar outro revoga o anterior e, depois de um `claim`, também a
  chave do nó (reinstalar: `reinstall: true`). Em `waiting_customer_install` (o primeiro código) ou
  `provisioning_failed` (recomeçar), o mesmo pedido leva o cliente a `provisioning` com um `runId` novo e o `preflight`
  na fila; o `resume` continua recusado para esse cliente (o código novo é o caminho). Auditado
  (`tenant.enrollment_code_issued` e `tenant.console_request`, sem o código).
- **Sequência reduzida:** `preflight → cloudflare.tunnel → firebase.site → enrollment.wait → node.health →
panel.domain_wait → access.ready`. Sem `terraform.*`, `secrets.smtp_password`, `secrets.tunnel_token` nem
  `node.wait_ready` (o registro os substitui); o `preflight` não aloca faixa de rede e confere só agentes e faixas de
  limites (`node-fit.ts` com o lugar). Um passo de fora da sequência do cliente responde `not_in_sequence`, nos dois
  sentidos. O `enrollment.wait` consulta a cada 60 s: `enrollment.readyAt` → segue; `enrollment.lastError` →
  `node_error:<código>`; aviso `enrollment_slow` em 3 dias e `enrollment_timeout` em 30.
- **Registro pela VM** (só máquina: sem cookie, sem CORS, só JSON, limite por IP, erro genérico; o `cp-public` confere o
  hash em tempo constante e repassa ao `cp-worker` em `/internal/node-enrollment/*`, `@WorkerCallers('public')`, como a
  revelação da página de status):
  - `POST /v1/node-enrollment/claim` `{code, release, host}` → 200, uma vez: o contrato (`size`, `nodeConf`, nome,
    e-mails), os endereços, o `mail` (a mesma senha do `secrets.smtp_password`; `null` sem `SMTP_HOST_NODES`), o
    `tunnelToken` lido do Cloudflare na hora e a `nodeKey` (32 bytes, guardada só como hash). Desconhecido, vencido ou
    usado: o mesmo 404; outra versão que a da execução: 409 `release_mismatch`, sem gastar o código; o token e a senha
    são lidos antes de o código ser marcado, então uma falha do Cloudflare (503) deixa o código valendo;
  - `POST /v1/node-enrollment/report` com `Authorization: Bearer <nodeKey>`: `ready` grava
    `{email, password, expiresAt}` (72 h, a janela da senha temporária) como versão nova de `vx-<slug>-admin-bootstrap`
    no projeto dos nós (o mesmo cofre que o `access.ready`, a revelação e o `secrets.destroy_bootstrap` usam; o
    `cp-worker` o cria se faltar) e marca `readyAt`; repetido, não grava outra versão. `error` grava o código. 204.
  - **Reinstalação de um ambiente pronto** (`waiting_customer_connection` ou `active`): o `ready` da VM nova abre um
    ciclo novo de revelação, porque o banco novo tem outra senha temporária. As marcas da revelação e do e-mail saem,
    `access.reissuedAt` abre de novo a janela de 72 h do e-mail, `active` volta a `waiting_customer_connection` (sem
    conta conectada no banco novo) e o `access.reveal_email` vai à fila com outra execução. A revelação continua de uso
    único; tudo auditado (`tenant.enrollment_ready` com `reissued: true`, `access.revealed`).
  - O código gerado com a execução ainda no `preflight` garante a task dessa execução (id determinístico), como o
    `provision`: uma falha da fila no primeiro pedido não deixa o cliente parado.
- **Permissões:** como não há `envs/tenant`, o `envs/nodes-platform` dá ao `cp-worker` o `cpBootstrapSecretCreator`
  (só `secrets.create`, no projeto: a criação não se condiciona pelo nome) e o `cpBootstrapSecretWriter` (gravar, ler e
  destruir versões e apagar o cofre) com condição pelo nome `vx-*-admin-bootstrap`.
- **Instalação no console:** a leitura da instalação traz, além da versão, o `installer` (`verax-install.sh` e o
  SHA-256, do campo opcional `installer` do manifesto assinado) e o porte do contrato (`size`), para o console montar
  o comando e o perfil da VM. A versão é a da execução quando o `preflight` já a escolheu.
- **Exclusão:** a Exclusão 1 apaga o túnel, o DNS, o site e o cofre `vx-<slug>-admin-bootstrap` com todas as versões,
  revelado ou não (os passos `deletion.cloudflare`, `deletion.firebase` e `deletion.bootstrap_secret`, este só para a
  VM do cliente; e só se algum código foi gerado); nada de Terraform, cofre de credenciais ou backups. O registro da VM
  sai com o acesso.

### Sincronização com o plano de controle (22/11/2026)

O nó dedicado (gerenciado na GCP ou na VM do cliente; nunca a célula) chama o plano de controle a cada 5 min (±30 s), conta
o que aplicou e recebe o estado desejado: as fontes de log que o responsável cadastrou no console e os usuários que a
Verax pediu para o cliente. O contrato está em `packages/shared/src/node-sync.ts` (protocolo 1, estrito dos dois
lados); os envelopes, em `packages/vault-envelope`. O lado do plano de controle fica em
`apps/control-plane/src/node-sync/`; o console que escreve o desejado, em `apps/control-plane/src/admin/admin-log-sources.*`
(as fontes) e `admin-node-users.*` (os usuários do cliente, com a região "Usuários do cliente" no detalhe do cliente do
console, `apps/console/src/features/tenants/node-users.tsx`).

- **Caminho:** `POST /v1/node-sync` no `cp-public` (pelo Hosting de `conta.veraxsistemas.com.br`) → no `cp-worker`
  (`@WorkerCallers('public')`, o token do cp-public), como o registro da VM, uma rota por credencial: `POST
/internal/node-sync/managed` `{token, request}` (o nó gerenciado) ou `POST /internal/node-sync/customer` `{nodeKey,
request}` (a VM do cliente). O cp-public escolhe a rota pelo formato do `Authorization` que já confere; no worker,
  nada lê do corpo qual credencial é, e cada rota tem a sua entrada no serviço (`syncManaged`, `syncCustomer`). O
  cp-public só faz o barato: o limite por IP (120/h), só JSON até 256 KB (o leitor próprio da rota; as outras seguem com
  16 KB; no worker, 256 KB mais a credencial), o formato da credencial, uma olhada sem assinatura no token (`aud`, `sub`,
  prazo) e o corpo estrito. Sem CORS (`NO_CORS_PATHS`), `Cache-Control: private, no-store`, erro genérico: 400
  `invalid_request` ou `clock_skew`, 401, 404 (cliente fora dos estados com nó), 409 `stale_sequence`, 429 com
  `Retry-After`, 503.
- **Credencial e cliente:** o cliente sai **só** da credencial, conferida de novo no cp-worker; o corpo nunca traz o id
  do cliente do plano de controle.
  - Nó gerenciado: `Authorization: Bearer <token de identidade>` da conta de serviço do nó, pedido ao servidor de
    metadados com `audience=<NODE_SYNC_AUDIENCE>&format=full` (padrão `https://conta.veraxsistemas.com.br/v1/node-sync`).
    O `NodeIdentityVerifier` aceita só token assinado (as chaves do Google, com a releitura numa rotação), o emissor, o
    `aud` exato, o prazo (vida de até 1 h) e o `sub` de 21 dígitos, que acha o cliente por
    `resources.serviceAccountUniqueId`; `google.compute_engine.project_id` e `instance_name` têm de ser
    `resources.nodesProject` e `instanceName`. Dois clientes com o mesmo `sub`: recusado e `node_sync_identity_ambiguous`
    no log. Vale em `provisioning`, `waiting_customer_connection`, `active` e `past_due`, com `hosting = verax` e sem
    `placement`.
  - VM do cliente: `Authorization: Bearer <nodeKey>` (a chave do registro, guardada só como SHA-256), com as regras do
    `report` do registro (`nodeKeyValid`).
  - A plataforma do corpo tem de ser a da credencial (`gcp` com o token, `vm` com a chave) e, no gerenciado,
    `node.serviceAccountId` o `sub` do token; senão 401.
- **Repetição e ritmo:** `sentAt` a até 10 min do relógio do plano de controle; `sequence` maior que a última aceita (o nó
  guarda no banco dele); no máximo uma chamada aceita por cliente a cada 20 s. Uma recusa não grava nada. Numa
  reinstalação (o banco novo: outro `nodeTenantId` ou outra impressão digital, com o guardado e o do pedido presentes)
  a sequência recomeça: o pedido é aceito com qualquer `sequence`, desde que o `sentAt` seja mais novo que o da última
  chamada aceita (`lastSentAt`), e a sequência guardada passa a ser a dele; um pedido capturado da instalação anterior
  não troca a identidade de volta (409).
- **Firestore** (sob `tenants/{id}`, `node-sync.schema.ts`, tudo estrito):
  - `nodeSync/state` (cp-worker, a cada chamada): `lastSeenAt`, `lastSentAt`, `sequence`, `authKind`, plataforma, commit, capacidades,
    `nodeTenantId` (o cliente no banco do nó, o do rótulo dos envelopes), `vaultKey` (versão, chave pública, impressão
    digital e `since`), conta de serviço, IPs de saída, audience e erro do nó. `nodeSync/desired` (console): `generation`;
  - `logSources/{UUID}` e `nodeUsers/{ULID}` (console): o cadastro desejado com revisão e lápide (`removed`), e o
    usuário pedido com `notAfter`;
  - `logSourceSecrets/{id}` e `nodeUserSecrets/{id}` (console cria, cp-worker apaga): só o envelope cifrado para a chave
    do cofre do nó, com a impressão digital e o `nodeTenantId` dela, e o TTL de `expiresAt` (7 dias; o do usuário, 1
    dia depois de `notAfter`) como rede de segurança (`firestore.tf`);
  - `logSourceReports/{id}` e `nodeUserReports/{id}` (cp-worker): o último relato, regravado só quando muda.
- **O que o cp-worker faz:** grava relatos só dos ids que existem sob o cliente da credencial (os outros são ignorados e
  contados no log); apaga o envelope da fonte quando o relato mostra aquela revisão da credencial aplicada ou recusada
  de vez (`credential_unreadable`, `credential_rejected_*`, `credential_kind_not_allowed`, `vault_disabled`), quando a
  fonte sai ou o pedido vence, e o do usuário com qualquer resultado; responde só as seções das capacidades anunciadas,
  a fonte com a credencial quando a revisão do envelope é maior que a última aplicada e o envelope é da chave atual do
  nó, o usuário sem `created`, no prazo, e a resposta conferida com `nodeSyncResponseSchema`. A resposta inteira cabe
  no que o nó lê (`NODE_SYNC_RESPONSE_MAX_BYTES`, 1 MB): os itens entram pela ordem do que pede ação (credencial
  pendente, usuário pedido, revisão ainda não processada, fonte que falhou, fonte já aplicada) e pelo id; o que não
  cabe vai na chamada seguinte, com `pollAfterSeconds` mínimo. Nunca 503 por tamanho, e a ausência nunca é remoção.
- **Console (cp-admin, `/v1/admin/tenants/:id/...`, atrás da `OwnerGuard`; escritas no limite de 20 operações por hora
  do responsável, na auditoria como `tenant.console_request` com `operation: log_source.*`, e as recusas como
  `tenant.console_request_refused`):
  - `GET node-sync`: o nó como ele se descreveu (`lastSeenAt`, `stale` depois de 15 min, plataforma, commit,
    `vaultReady`, versão e impressão digital da chave, erro) e cada fonte com o desejado, os metadados da credencial
    (nunca o envelope), o último relato, `pending` (revisão desejada acima da relatada, ou credencial acima da
    aplicada) e a situação (`pending`, `applied`, `failed` com o código, `removing`, `removed`). Na AWS do gerenciado, o
    bloco `awsStack` com os valores **do plano de controle** (`resources.serviceAccountUniqueId`, `resources.natIp/32`,
    `AWS_READER_AUDIENCE`, o ARN do papel, o `aws cloudformation deploy` e o link do CloudFormation) e `mismatch` quando
    o nó informa outros; na VM do cliente, `readKeys` (o usuário IAM e as políticas, ou a assinatura e a conta de serviço
    da GCP, de `read-keys.ts`); no Cloudflare, o link do token e os IPs para o filtro. O template do papel sai do
    próprio cp-admin, do commit da imagem: `GET /v1/admin/aws-reader/verax-control-reader.yaml` (`text/yaml`; o
    Dockerfile copia `infra/cloudformation/verax-control-reader.yaml` para `/app/cloudformation/`);
  - `POST log-sources` (`{spec, credential?}`: `cloudAccountCreateSchema` e as regras de credencial do painel), `PATCH
log-sources/:id` (os campos do provedor; provedor, ID da conta e `status` recusados), `PUT log-sources/:id/credential`
    e `POST log-sources/:id/remove` (`{confirmSlug}`, a lápide; o envelope pendente sai junto). Cada escrita é uma
    transação: a fonte (a revisão sobe; a credencial tem revisão própria), o envelope, `nodeSync/desired.generation` + 1
    e a auditoria. O id da fonte é um `randomUUID()` (o id da conta no banco do nó). Recusados: GCP no gerenciado
    (`gcp_unsupported_managed`, até o Terraform receber projetos de cliente), cliente da célula, cancelado ou excluído,
    a mesma conta ativa duas vezes (`source_exists`);
  - **Lacre:** a credencial só é cifrada para um nó que já sincronizou com o cofre (`node_not_synced`, `vault_disabled`
    senão), na plataforma do lugar do cliente (`gcp` no gerenciado, `vm` no cliente, cruzada com a informada), com o
    tipo que vale nela (`credentialKindAllowed`: no gerenciado, só o Cloudflare), com a chave pública informada e a
    impressão digital conferida de novo (`vault_key_invalid`), amarrada a `{nodeTenantId, id da fonte, tipo, conta}`. O
    texto claro entra na máscara do logger antes de qualquer `await` e sai no fim do pedido; só o envelope e os
    metadados vão ao Firestore (`expiresAt` em 7 dias).
- **Usuários do cliente pelo console** (`admin-node-users.*`; decisões D7 a D10 do plano da sincronização):
  - `POST users` `{name, email, role}` (`userCreateSchema`; os três papéis do cliente, nunca `admin_verax`). Recusados,
    com a auditoria `tenant.console_request_refused`: cliente cancelado ou excluído (`not_allowed`), da célula
    (`placement_unsupported`), nó que nunca sincronizou (`node_not_synced`), nó sem a capacidade `users` na última
    chamada (`node_outdated`: "o servidor do cliente precisa da versão nova para receber usuários"), outra plataforma,
    sem cofre ou com a chave que não confere (`platform_mismatch`, `vault_disabled`, `vault_key_invalid`), um pedido
    ainda pendente para o mesmo e-mail (`user_pending`, sem diferença de maiúsculas), 200 pendentes (`user_limit`) e o
    limite de operações (429). A conferência roda antes do limite, que só gasta com um pedido que pode dar certo;
  - a senha temporária sai da mesma geradora do painel (`generateTemporaryPassword`, `@verax/vault-envelope`), entra na
    máscara do logger no mesmo instante e é cifrada com a chave pública do cofre do nó (a impressão digital conferida de
    novo, como nas fontes), amarrada a `{nodeTenantId, requestId (ULID), e-mail em minúsculas}` (`sealUserPassword`).
    Uma transação: `nodeUsers/{requestId}` (nome, e-mail, papel, `notAfter` = agora + 72 h, quem e quando),
    `nodeUserSecrets/{requestId}` (só o envelope, `expiresAt` = `notAfter` + 1 dia), `nodeSync/desired.generation` + 1 e
    a auditoria `tenant.console_request` com `operation: node_user.create` (o pedido, o e-mail, o papel, o prazo e a
    chave do cofre; nunca a senha nem o envelope). O log leva só ids, o papel e a geração;
  - a resposta (201, uma vez, `Cache-Control: private, no-store`): `{requestId, panelUrl, email, role,
temporaryPassword, notAfter}`; o controlador tira a senha da máscara quando a resposta termina. Nenhum e-mail sai
    para o cliente (D8): o responsável copia o acesso (ou a mensagem pronta) e manda;
  - `GET node-sync` traz também `users` (do mais novo ao mais antigo; nunca a senha nem o envelope), com a situação:
    `created` (com a conta: situação, MFA e se ainda está na senha temporária), `failed` com o código do nó
    (`NODE_SYNC_USER_CODES`), `expired` (o prazo passou sem relato, o nó contou `expired`, ou o envelope foi descartado
    numa reinstalação) e `pending`; `usersSupported` (a capacidade anunciada) e `usersBlockedBy` (o mesmo motivo da
    recusa, para o console desligar o botão com o texto);
  - o cp-worker entrega o pedido ao nó que anuncia `users` e apaga o envelope com qualquer resultado; o pedido falhado
    ou vencido libera o e-mail para um novo. Na v1 o console não altera nem remove usuários: a pessoa do cliente cuida
    da conta no painel dele, e o cliente vê a criação na auditoria do painel como "Verax (administrativo)" (D10).
- **Reinstalação:** outro `nodeTenantId` ou outra impressão digital da chave do cofre → `node_sync.identity_changed` na
  auditoria do plano de controle e os envelopes pendentes descartados (não abririam mais).
- **Segurança:** o cp-public vê a credencial do nó em trânsito (como no registro), mas o worker confere de novo e nunca
  há texto claro de segredo no caminho; um nó comprometido só alcança os próprios envelopes e só pode mentir sobre o
  próprio estado (o console mostra como "o nó disse"); o token e a chave do nó entram na máscara do logger e nunca vão a
  log, auditoria nem Firestore. **Exclusão:** o passo `deletion.node_sync` apaga todas essas subcoleções na Exclusão 1.

### Exclusão em dois tempos

Só existe a partir de `canceled`, por dois caminhos: o `tick` com `deleteAfter` vencido e o `delete-now` do responsável
(que adianta `deleteAfter` e fecha a exportação, mas não mexe em `cryptoDestroyAfter`: os backups saem pela retenção do
bucket, contada do último backup). A tabela de transições só tem `canceled` → `deleted`, o motor dos passos ignora
cliente fora de `deleted` (`not_deleting`), e o executor amarra a ação ao tipo da execução. O cliente entra em `deleted`
no começo da Exclusão 1 (a página de status passa a responder 404) e `lifecycle.run` guarda o passo; uma falha
definitiva para a execução com o código (`lifecycle.run.lastError`, linha `event=deletion_failed`), e o `delete-now`
recomeça do primeiro passo da mesma fase (todos reconhecem o que já foi apagado). Quem nunca provisionou (sem
`provisioning.runId`; o subdomínio dele pode ser de outro cliente agora) é excluído só no Firestore. Com recursos fora,
o subdomínio tem de ser do cliente (`slugs/{slug}`), senão a exclusão para com `slug_not_owned` sem tocar em nada.

| Momento              | Passos (fila `lifecycle`)                                                                                                            | O que acontece                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D+30 do cancelamento | `deletion.terraform`, `deletion.terraform_wait`, `deletion.cloudflare`, `deletion.firebase`, `deletion.node_sync`, `deletion.record` | **Exclusão 1:** o executor com `EXECUTOR_ACTION=destroy`, `RUN_KIND=delete` (abaixo): VM, conta de serviço do nó, rede, NAT, tópicos e assinaturas, os cofres `admin-bootstrap`, `support-bootstrap`, `cloudflare-tunnel-token` e `smtp-password` e as permissões; o disco, os snapshots dele e o IP do NAT pela API. O túnel `vx-<slug>` e os registros de DNS só dos nomes do cliente (`api-<slug>.<zona>`, `<slug>.control...` e abaixo dele). O domínio e o site `vxc-<slug>-<hex>` do Firebase. Ficam o bucket de backups e o cofre `credentials-key`. O que a sincronização do nó guardou no Firestore (o estado do nó, as fontes e os usuários pedidos pelo console, os envelopes e os relatos). O registro de exclusão por e-mail ao admin (sem SMTP, segue sem ele: `event=deletion_record_unsent`); o cliente perde `adminEmail`, `access` e os recursos que a Exclusão 2 não usa (`lifecycle.deletedAt`) |
| D+97 do cancelamento | `crypto.destroy_key`, `crypto.purge`, `crypto.purge_wait`, `crypto.finish`                                                           | **Exclusão 2 (cripto-destruição):** o cp-worker destrói todas as versões de `vx-<slug>-credentials-key` (`cpSecretVersionDestroyer`: lista e destrói, sem ler) e confere que nenhuma ficou viva (`lifecycle.cryptoDestroyedAt`); o executor com `EXECUTOR_ACTION=purge`, `RUN_KIND=crypto_destroy` apaga o cofre, o bucket de backups (só vazio) e `tenants/<slug>/default.tfstate`. O tenant vira registro mínimo (`lifecycle.purgedAt`; o prazo `cryptoDestroyAfter` sai, para o `tick` só consultar quem ainda tem trabalho): ficam `slug`, `company`, `stripe.customerId`, `billing.mode` (se houver), `lifecycle`, o que foi vendido (`configuration`, `limits`, `pricing`), o aceite dos textos (`consent`) e as faturas por 5 anos                                                                                                                                                                           |

**O executor na Exclusão 1 (`entrypoint.sh`, `destroy` só com `RUN_KIND=delete`):** `init`; `state list`; com a VM no
estado, tira a proteção dela pela API (`instances.setDeletionProtection`; nada de `apply`, que num estado pela metade
criaria de novo o que já saiu) e espera valer; `terraform state rm` destes endereços, só dos que estão no estado:

- `module.node.google_compute_disk.node` e `module.node.google_compute_address.nat[0]` (`prevent_destroy`);
- `module.node.google_storage_bucket.backups` (`force_destroy = false`), que fica até a Exclusão 2;
- `module.node.google_secret_manager_secret.node_written["credentials-key"]` e
  `google_secret_manager_secret_iam_member.worker_credentials_key`: o cofre e a permissão do `cp-worker` de destruir as
  versões ficam até a Exclusão 2 (sem tirar a permissão do estado, o `destroy` a apagaria).

Então `plan -destroy`, conferido: só `delete` (e `no-op`/`read`) e nenhum dos endereços acima, senão
`destroy_plan_unexpected` sem `apply`; `apply`; e, pela API, o disco `vx-<slug>` (espera sumir), os snapshots de
`sourceDisk` igual ao dele (todas as páginas de `snapshots.list` do projeto, conferidos um a um: o snapshot de outro
cliente, mesmo com o nome começando igual, e o de um disco de mesmo nome em outra zona ficam) e o IP `vx-<slug>-nat-ip`.
Um 404 em qualquer um conta como feito: repetir a Exclusão 1 inteira não dá erro. A conta de serviço do nó só pode ser
apagada aqui; num `apply` (só `provision` e `resume`) a recusa `node_sa_replacement` do CP-07 continua. Era a proteção que
substitui o `prevent_destroy`, que não muda por variável e impediria a própria exclusão.

**O executor na Exclusão 2 (`purge`, só com `RUN_KIND=crypto_destroy`):** recebe só o endereço (slug e execução; nenhuma
`TF_VAR_*`, nenhum dado do cliente); `init` e `state list`, que tem de estar vazio (senão `state_not_empty`: a Exclusão 1
não terminou); apaga pela API `vx-<slug>-credentials-key`, o bucket `<projeto>-vx-<slug>-backups` (com objetos, 409 →
`backups_bucket_not_empty`: o cp-worker tenta de novo uma vez por dia, por até 14 dias, e então para e avisa) e
`tenants/<slug>/default.tfstate` do bucket do estado (as versões antigas, com o e-mail do admin nos metadados da VM, saem
30 dias depois pela retenção daquele bucket). Os papéis são os do `cp-terraform` que já existiam (`cpSecretsProvisioner`,
`cpBucketsProvisioner`, os `compute.*Admin`, `objectAdmin` no bucket do estado): nenhum objeto de backup é lido nem
apagado pelo plano de controle.

**O bucket de backups e o D+97 (a contradição que o PR-20 anotou, resolvida pelas regras do `backups.tf`):** cada backup
é um objeto novo (`postgres/verax-<data>.dump`), nunca sobrescrito. A regra `age = 90` não tem `with_state` (o provider
manda a condição sem `isLive`), então vale para a versão viva e para a não corrente, e a idade conta da criação ("the age
of an object is unaffected by the object becoming a noncurrent version", documentação do ciclo de vida do Cloud
Storage). Aos 90 dias a versão viva vira não corrente e, na passada seguinte, a mesma regra a apaga; ela fica então 7
dias na exclusão reversível. A regra `days_since_noncurrent_time = 30` nunca é a que vale aqui (só valeria para um
objeto sobrescrito, e encurtaria). **O prazo real é 90 + 7 dias mais o atraso do ciclo de vida, que é assíncrono e sem
prazo garantido pelo Google (na prática até cerca de um dia por passada, e são duas): cerca de 99 dias depois do backup,
não 120.** Num cancelamento, a VM para no cancelamento (`node.stop`), então o último backup é do dia do cancelamento e
tudo sai até cerca de D+99; em D+97 o bucket já não deve ter versão viva nem não corrente (a exclusão dele passa), só
cópias na exclusão reversível, que somem até cerca de D+99. Se a VM não parar (o `node.stop` falhando), a Exclusão 1 a
destrói em D+30, e o limite passa a D+30+99. Nada aqui mudou a retenção do bucket; `docs/retencao-de-dados.md` diz o
mesmo e recomenda o texto do site.

Retenção do resto: `auditLog` 24 meses, `stripeEvents` 90 dias, `provisioningRuns` 180 dias, tokens e reservas pelo
próprio prazo, tudo por TTL do Firestore. Nunca gravado: dado de cartão, senha temporária (lida do Secret Manager e
devolvida uma vez), token do túnel, chaves da Stripe e do Cloudflare, corpo bruto do webhook, IP completo do cliente.

### Preço configurável

O preço é por **volume de logs em GB por dia (GB/dia)**, em três planos (decisão do responsável, 10/11/2026): a
**Plataforma** (célula compartilhada, vendida no checkout do site: uma base mensal com alguns GB/dia incluídos e um
preço mensal por GB/dia contratado acima disso, até o máximo do site; acima, "fale conosco"), o **Dedicado** (servidor
próprio, contrato anual: um preço por GB/dia, com um mínimo e um máximo cotáveis) e o **vCISO** (o Dedicado mais um
serviço mensal e uma implantação cobrada uma vez). O Dedicado e o vCISO são só por contrato direto. O porte do nó sai do
volume pela regra de porte da tabela (nunca escolhido); contas de nuvem não mudam o preço (o plano tem só o teto que o
nó grava) e agentes nas instâncias não são vendidos. Nenhum valor comercial está no código nem neste repositório; o
código (`apps/control-plane/src/pricing`) só define a forma dos documentos e as regras.

- **Tabela de preços** (`pricingTables/{versão}`): o imposto (`taxMode`: `inclusive`, embutido, ou `exclusive`, o "+
  impostos" que vai por cima na fatura), a regra de porte (o maior GB/dia de cada porte), e por plano, cada valor em
  centavos com o `lookup_key` do preço na Stripe: na Plataforma, a base, os GB/dia incluídos, o **GB/dia adicional**,
  o **GB/dia excedente** (o uso acima da franquia, cobrado depois pela medição; a checagem recusa um excedente mais
  barato que o adicional), o máximo do site e o teto de contas; no Dedicado, o GB/dia, o mínimo, o máximo, a duração do
  contrato e o teto de contas; no vCISO, o serviço e a implantação (o GB/dia e a faixa são os do Dedicado). Mais o
  histórico incluído e o máximo de usuários. Estados: `draft` (editável), `published` (imutável, vigente a partir de
  `effectiveFrom`, que pode ser agendado) e `retired` (substituída; `retiredAt` diz quando deixa de valer). A vigente é
  a de maior `effectiveFrom` até agora. Uma versão nova nunca muda assinatura existente (os preços da Stripe são
  imutáveis).
- **Modelo de custos** (`costModels/{versão}`, confidencial, só no console): câmbio e folga; a **célula compartilhada**
  (a máquina, a capacidade dela em GB/dia e o custo fixo de cada cliente nela); o nó dedicado de cada porte; disco,
  snapshot, NAT, IP e outros; a ingestão por GB/dia; tarifas por meio de pagamento, alíquotas e reserva; o custo da
  hora e as horas por cliente (por plano, o serviço do vCISO em horas equivalentes, as a mais na infraestrutura do
  cliente e as da implantação); custos fixos com o rateio e as metas de margem (mínima e de alerta). Publicado, vale na
  hora (custo não muda o preço de ninguém).
- **Documentos do modelo anterior (legado).** As versões gravadas antes da troca (portes, componentes e contas de
  nuvem, até `2026-11-v1`) não passam nos schemas novos. O repositório (`pricing-store.ts`) lê o envelope delas
  (estado, datas, quem publicou) e nunca o conteúdo: a lista do console as mostra com `legacy: true` ("Modelo
  anterior"), abrir uma é 409 `version_legacy`, e elas **nunca são a vigente** (se a de maior `effectiveFrom` for uma
  delas, não há vigente: o site responde 503 até a primeira versão nova valer, em vez de cotar com uma forma que o código
  não entende mais). Publicar a primeira versão nova aposenta a antiga pelo envelope, sem mexer no conteúdo. Uma cotação
  gravada no formato antigo (ainda nas 24 h) não vale (`quote_outdated` no checkout), e um cliente contratado no modelo
  anterior continua legível (`legacyConfigurationSchema`, só leitura: a lista, o detalhe e o `tick` o leem; nunca é
  cotado de novo).
- **Cotação** (`POST /v1/public/quote` `{ "plan", "gbDay" }`, estrito, sem nenhum campo de preço nem o lugar): o
  volume sobe até o mínimo do plano (na Plataforma, o incluído); acima do máximo do site, "fale conosco"
  (`above_online_max`). **O site vende só a Plataforma, na infraestrutura da Verax** (decisões de 06/11/2026 e
  10/11/2026; hoje a GCP, e pode mudar, por isso nada voltado ao cliente cita o provedor): o Dedicado e o vCISO são
  recusados com 422 `plan_not_sold_online` (a mensagem leva à proposta e ao contrato direto), qualquer que seja a
  tabela publicada, sem gravar nada. Itens da Plataforma: a base (quantidade 1) e, acima do incluído, o GB/dia
  adicional com **a franquia acima do incluído como quantidade** (no incluído, o item não entra: o Checkout não aceita
  quantidade 0); do Dedicado, GB/dia × o preço; do vCISO, o do Dedicado, o serviço e a implantação (avulsa, por
  último). Os limites do nó: a franquia mensal pelo GB/dia (`monthlyGibFor`: GB/dia × 31 dias, em GiB, para cima), o
  teto de contas do plano, o histórico e os usuários da tabela e 0 agentes. A cotação é gravada em `quotes/{id}` por
  24 h, com limite por IP e teto diário, e é o que o checkout aceita. `GET /v1/public/pricing` devolve só a parte
  pública da tabela vigente: os três planos (a Plataforma `online`, o Dedicado e o vCISO `contract`, como referência),
  os incluídos, os preços unitários, os mínimos, o máximo do site, o `taxMode`, os portes e o "a partir de" de cada
  plano; sem custo, margem nem `lookup_key`, com 5 min de cache no CDN.
- **Checkout** (`POST /v1/public/checkout` com `quoteId`): uma cotação de um plano ou lugar que o site não vende (a de
  referência de um contrato direto, que o console grava na mesma coleção) é recusada com o mesmo 422, antes de reservar
  ou falar com a Stripe. Fora isso, relê a cotação, recalcula pela tabela da versão dela (honrada até vencer, mesmo
  com outra tabela publicada), confere cada preço na Stripe (ativo, em BRL, mensal ou avulso, com o valor da tabela, e
  a soma igual ao total) e abre a sessão com um item por componente: a base e o GB/dia adicional com a quantidade
  contratada acima do incluído. **Ampliar a franquia depois é mudar a quantidade desse item na assinatura** (ou
  acrescentá-lo, quando o cliente estava no incluído); o excedente medido e a ampliação pelo painel são de outra frente
  (`fase3/plano-checkout-gb.md`, frente 4), que usa o preço do excedente e o `lookup_key` dele da mesma tabela. A
  reserva guarda a configuração (o plano, o lugar, **a franquia contratada em GB/dia**, o porte e o histórico), os
  limites do nó e o preço cotado (versão, cotação, mensal e implantação), que o webhook copia para o cliente
  (`tenants/{id}.configuration`, `.limits`, `.pricing`); a medição do excedente e o contador do painel partem de
  `configuration.gbDay`. Os metadados da sessão e da assinatura levam o plano e o GB/dia. O nome da empresa vai de 2 a
  120 caracteres (`companyNameSchema`), o limite do `Tenant.name` do nó, e a mesma regra vale no `customer.updated` da
  Stripe, no executor Terraform e no `envs/tenant`: o nome chega inteiro ao nó, sem corte. Um cliente gravado antes
  desse limite, com um nome maior, para no `preflight` com `tenant_name_invalid`. O aceite do pedido precisa trazer as
  versões vigentes dos três textos legais (abaixo): outra versão, 409 `terms_outdated`; sem uma publicada de algum
  deles, 503 `checkout_unavailable`. As versões aceitas vão para a reserva, os metadados da Stripe e o cliente.
- **Imposto por cima.** Com `taxMode = exclusive`, os valores da tabela são sem imposto, e a DRE trata a receita bruta
  como o valor ÷ (1 − alíquota) (o imposto é a diferença, e o valor da tabela fica inteiro). A cobrança é de verdade: o
  checkout de uma tabela `exclusive` põe a alíquota de imposto da Stripe de `STRIPE_TAX_RATE_ID` (`txr_...`, só o id
  no ambiente; o percentual fica na Stripe e no modelo de custos) em cada item (`line_items[].tax_rates`) e como padrão
  da assinatura (`subscription_data.default_tax_rates`, para o que entrar depois, como a ampliação da franquia), e a
  Stripe soma o imposto na fatura. A alíquota é relida a cada sessão e conferida: ativa, exclusiva (`inclusive:
false`), no modo da chave e com o percentual da alíquota padrão do modelo de custos vigente (a mesma da checagem e
  da DRE). Sem a variável, sem modelo de custos, inexistente ou divergente, o checkout dessa tabela responde 503
  `checkout_unavailable` antes de reservar, com a linha `checkout_tax_rate_invalid` e o motivo (`unconfigured`,
  `cost_model_missing`, `missing`, `inactive`, `inclusive`, `livemode`, `percentage`). A soma conferida dos preços
  continua a da tabela. O `stripe-setup` cria ou acha a alíquota (`--tax-rate-percent=<n>`, marcada com
  `metadata.verax = imposto`) e imprime o id; a mesma variável vai ao `cp-public` e ao `cp-admin` (`service_env`, que
  o Terraform repassa ao console só nesta chave). Com o imposto embutido (`inclusive`), nada disso é usado.
- **Checagem de publicação** (no console e no `publicar-precos`): antes de publicar uma tabela, o motor percorre cada
  GB/dia vendável (a Plataforma do incluído ao máximo do site, só na Verax; o Dedicado e o vCISO do mínimo ao máximo,
  na Verax e no cliente) com o modelo de custos vigente (cartão e a alíquota padrão) e recusa a publicação se alguma
  configuração ficar com margem de contribuição abaixo da mínima, se um GB/dia a mais baixar o preço, se o "a partir
  de" de um plano não for o menor preço dele, se o site oferecer um volume que não cota ou que o provisionamento ainda
  não cria (`node-fit.ts`: hoje um nó P por cliente, também na Plataforma, até a célula multi-cliente existir) ou se o
  excedente for mais barato que o adicional. A célula da Plataforma entra rateada por GB/dia (custo da máquina ÷
  capacidade × GB/dia contratado), mais o custo fixo de cada cliente nela e a ingestão. O relatório (as piores, as
  abaixo do alerta, a pior de cada plano e lugar, o pior caso com as outras alíquotas e no boleto) volta ao console; a
  recusa e a publicação ficam na auditoria. Uma tabela `exclusive` também é recusada se o serviço que publica não tiver
  `STRIPE_TAX_RATE_ID` (o checkout cobraria só o valor da tabela): o relatório diz por quê; no `publicar-precos`, o
  id vem por `--aliquota-stripe` (o mesmo do serviço).
- **DRE** (`POST /v1/admin/dre/simulate` com `{ plan, gbDay, mode }`): por cliente e por mês, o valor da tabela, a
  receita bruta (com o imposto por cima, se a tabela for `exclusive`), imposto, reserva, receita líquida,
  infraestrutura (na Verax: o rateio da célula na Plataforma, o nó do porte no Dedicado e no vCISO; no cliente, 0), meio
  de pagamento, suporte (as horas do plano, do serviço do vCISO e as a mais no cliente), margem de contribuição, custos
  fixos rateados e resultado; a implantação à parte e os 12 meses; no cliente, a estimativa da nuvem dele (o nó do
  porte com a ingestão, a preço de lista), só informativa.
- **Console do responsável** (`apps/console`, servido pelo `cp-admin`): um app React compilado pelo Vite, com os
  tokens e os padrões do painel (pt-BR, claro e escuro, WCAG 2.2 AA conferido pelo axe), que a imagem do plano de
  controle leva em `/app/console`. O próprio `cp-admin` serve as telas e a API na mesma origem
  (`admin.veraxsistemas.com.br`): sem CORS e sem outro serviço. As telas abrem sem sessão (a de login, `/entrar`; não
  há tela de cadastro; são o código do repositório público, sem número nenhum), com a CSP própria
  delas (só scripts, estilos e chamadas da própria origem, nada inline, nada em frame);
  `/assets/` (nomes com hash) fica em cache privado, o resto sem cache. As telas não têm nenhum número: o modelo de
  custos (com o custo da célula, o custo por GB/dia dela e o do nó por porte recalculados na hora), a tabela de preços
  (com a checagem e a publicação, e o relatório da recusa) e o simulador de DRE leem e gravam só pela API, e os
  problemas de validação voltam por campo. Os tipos que as telas leem são conferidos contra os da API no
  `pnpm typecheck` (teste de contrato do plano de controle).
- **Limites no nó** (gancho do PR-18): a configuração vira os ajustes `PLAN_*` que o nó já lê (`PLAN=enterprise` e os
  quatro limites: a franquia mensal em GiB sai do GB/dia contratado) e `WAZUH_AGENTS=false` (agentes não são
  vendidos); fica gravada no cliente (`tenants/{id}.limits`) para o provisionamento.

### Textos legais

Os Termos de uso, a Política de privacidade e o DPA que o cliente aceita no checkout vivem no Firestore
(`legalTexts/{terms|privacy|dpa}/versions/{versão}`, `apps/control-plane/src/legal`), em Markdown de até 100 KB, no
mesmo molde da tabela de preços: **rascunho** (editável) e **publicada** (imutável, com `publishedAt`, `publishedBy` e
o SHA-256 do texto). A vigente de cada texto é a publicada mais recente (consulta de um campo só, sem índice composto);
não há agendamento nem aposentadoria, e uma versão antiga continua legível para quem a aceitou. Nenhuma variável de
ambiente guarda versão (as antigas `TERMS_VERSION`, `PRIVACY_VERSION` e `DPA_VERSION` saíram do schema).

- **Console** (`/v1/admin/legal`, só no `cp-admin`, atrás da sessão): a lista dos três com as versões, o rascunho em
  branco ou copiado de outra versão, a edição com a guarda de revisão (`expectedUpdatedAt`; mudou, 409
  `draft_changed`), a publicação com a versão digitada de novo (`confirmVersion`; texto em branco não publica) e a
  trilha de cada texto (`legal.<tipo>.draft.created`, `.draft.updated` e `.published` na auditoria, com o tamanho e o
  hash, nunca o texto). A tela tem o Markdown ao lado de uma prévia que não usa pacote nem HTML cru.
- **Site** (`cp-public`, com o CORS das origens do site): `GET /v1/public/legal` (a versão e a data da vigente de cada
  texto, ou `null`), `GET /v1/public/legal/{tipo}` (o texto vigente) e `GET /v1/public/legal/{tipo}/{versão}` (uma
  publicada pelo nome; rascunho nunca sai), com o limite por IP e 5 min de cache no CDN (1 h numa versão já
  substituída). Quem publicou não aparece. O site desenha o Markdown em `/termos`, `/privacidade` e `/dpa`.
- **Checkout:** a cada pedido, as três vigentes são lidas e comparadas com o aceite (acima, em "Checkout").

## Versões do nó: imagens públicas e manifesto assinado _(fase 3, SH-02)_

Preparação do modo próprio (o nó na infraestrutura do cliente, que desde 06/11/2026 é só por contrato direto: veja
"Cliente de contrato direto pelo console"). Um nó fora da infraestrutura da Verax precisa baixar as imagens sem login
e saber, sem o `gh` e sem falar com a Verax, que a versão foi publicada por ela. O roteiro e os passos únicos do
responsável estão em `docs/runbooks/versao-no.md`; o que o cliente segue para instalar, em
`docs/runbooks/instalacao-no-cliente.md`.

| Imagem                                      | Nó gerenciado (GCP da Verax)                                                                             | Nó na nuvem do cliente                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| API e migrations (do Verax)                 | Artifact Registry privado, pelo `deploy.sh` ou pelo digest do manifesto (instalação sem operador, PR-N7) | GHCR público (`ghcr.io/williandotdev/verax-control/...`) |
| Wazuh, PostgreSQL e cloudflared (terceiros) | Registro de origem, pelo digest dos compose (como hoje)                                                  | Registro de origem, pelo digest dos compose              |

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
  espelho privado só para os nós gerenciados não mudaria o manifesto. O PR-N7 manteve a origem e deixou o espelho
  como decisão em aberto ("Instalação sem operador", acima).
- **Quem usa o manifesto hoje:** a instalação sem operador do nó de cliente (PR-N7), com as chaves que o Terraform
  põe no script de boot.

## Atualização da frota _(decisão de 16/11/2026)_

Até aqui, um nó no ar nunca se atualizava sozinho (só os nós novos nasciam na versão promovida; os outros esperavam o
`deploy.sh`), e o painel ia para todos os sites a cada merge, podendo ficar à frente da API do nó. O responsável aprovou
o desenho abaixo: a versão é **pedida por nó** e **aplicada pelo próprio host**, a frota anda **em ondas** com
conferência e volta automática, e o **painel de cada destino anda junto com o nó dele**. O roteiro do host está em
`docs/runbooks/versao-no.md` ("Atualização da frota").

### O atualizador do host (`infra/node/bin/update.sh`)

- **O pedido** é uma chave dos metadados da VM (`verax-node-release`, com o SHA-256 do pacote, o id do pedido, a
  intenção `upgrade` ou `rollback` e a janela opcional), gravada pelo plano de controle. Não é a `verax-node-version` da
  instalação, que o Terraform do tenant possui: o módulo `node` ignora as chaves do pedido (`ignore_changes`), e um
  `apply` do tenant não as apaga.
- **Quem aplica** é o host, pelo `verax-update.timer` (a cada 5 min, root, fora dos contêineres, como as outras unidades
  do host): nenhuma porta de entrada, nenhum SSH, nenhuma credencial nova na VM. O mesmo código serve a célula e o nó
  dedicado.
- **Confiança:** o manifesto vem do release do GitHub e só vale com a assinatura conferida pelo verificador e pelas
  chaves **já instaladas** no host (`/opt/verax`, que o `install.sh` agora instala), nunca pelas do pacote novo; o
  SHA-256 do pedido tem de ser o do manifesto assinado. Um plano de controle comprometido só consegue pedir uma versão
  assinada pela Verax, e uma mais antiga só com `rollback` explícito.
- **Segurança da manutenção:** um pedido por vez (`flock`), nunca durante a instalação sem operador (a trava e o
  marcador dela), a janela de manutenção, as imagens baixadas e o backup do banco **antes** de tocar no nó, e a cópia do
  que está instalado (`/opt/verax`, o `images.env` e as unidades do systemd) para a volta. Se o `install.sh` ou a
  conferência (o `verax-node`, o Wazuh no standard e a API em `/health/ready`) falham, o host põe a cópia de volta e
  reinicia o nó: `rolled_back`. O banco não volta: as migrations são aditivas, a regra de sempre da volta de versão.
- **Andamento** nos guest attributes `verax/update-*` (estado, versão, id do pedido, versão de antes e código de erro),
  que o plano de controle lê como os do CP-10.

### A rodada no plano de controle (`apps/control-plane/src/fleet`)

- **Quem entra** sai do registro, não de uma lista à parte: as células de `cells/{id}` com a VM (`node: {zone,
instance}`) e os clientes dedicados com nó no ar (`active`, `waiting_customer_connection`, `past_due`, com
  `resources.instanceName`; o suspenso e o de VM parada aparecem na revisão como "fora", com o motivo). O painel de
  cada nó: no dedicado, o site do cliente; na célula, o site de cada cliente dela e o da equipe (`staffPanel`).
- **Ondas:** 0, a célula com o painel da equipe da Verax (a canária); 1, as outras células, uma de cada vez; 2, os nós
  dedicados, em lotes de `concurrency` (1 a 5, padrão 1). Uma onda só começa com a anterior inteira feita ou pulada.
- **O passo de cada nó:** o pedido nos metadados da VM (`setMetadata` com a impressão digital, sem tocar nas outras
  chaves) → o `ok` do host nos guest attributes, para **este** pedido e esta versão (60 min; com janela, um dia a mais)
  → `GET /health` e `/health/ready` na API pública (10 conferências) → o painel de cada destino do nó, publicado com o
  bundle da mesma versão (`provisioning/panel-publish.ts`, o mesmo código do `firebase.site`) → feito. O painel nunca sai
  antes da API do nó estar de pé na versão nova.
- **Parar na primeira falha:** o host que volta sozinho (`node_rolled_back:<motivo>`), que não responde
  (`update_timeout`), a API que não sobe (`health_failed`) ou o painel que não publica param a rodada
  (`paused_on_failure`); nenhum nó novo começa, os que já mudavam terminam. O responsável retoma (o nó que falhou tenta
  de novo, com outro id de pedido), pula o nó ou aborta; e pode voltar um nó feito para a versão que ele tinha antes
  (o pedido com `rollback` e o painel dessa versão), quando ela é uma versão publicada.
- **O motor:** uma task `fleet.tick` (fila `lifecycle`) a cada 30 s enquanto há nó mudando ou na fila, com o número da
  volta no id (`fleet_tick-<rodada>-p<n>`): uma entrega repetida é ignorada, a que perdeu a fila põe a seguinte, e uma
  concessão de 5 min impede duas entregas da mesma volta ao mesmo tempo. Cada nó é gravado só se ninguém mexeu nele no
  meio (`rev`). Uma rodada por vez.
- **Firestore:** `rollouts/{id}` (a versão conferida, as ondas, o estado, a falha e os totais) e
  `rollouts/{id}/nodes/{cell-<id>|tenant-<id>}` (a VM, os sites, a operação, a tentativa, o id do pedido, o estado do
  host e o código), sem segredo nem dado pessoal de cliente. Auditoria `rollout.created`, `.paused`, `.resumed`,
  `.aborted`, `.node_skipped`, `.node_rollback`, `.paused_on_failure` e `.completed`; o alerta `rollout_failed`
  (`envs/control-plane/monitoring.tf`).
- **A versão** vem do bucket de releases, com a assinatura conferida pelas chaves do repositório, e precisa do bundle
  do painel no manifesto (`panel`): sem ele, a rodada é recusada (`panel_bundle_missing`), porque o painel não teria
  como andar junto.

### O painel junto com o nó

- **O bundle é da versão:** o workflow `Versão do nó` monta o build único do `apps/web` uma vez (num job sem identidade
  nem segredo) em `panel-<commit>.tar.gz` (`scripts/node-release.sh panel`: ustar, data, dono e permissões fixos), cita
  o SHA-256 no manifesto assinado (`panel`), atesta a origem e o põe no release. A configuração de cada site sai da
  configuração-modelo do bundle (o marcador `{tenant}` trocado pelo subdomínio do site, CP-08), e a API, do endereço do
  painel, em tempo de execução: o mesmo bundle serve todo destino.
- **Quem publica:** o passo de cada nó, depois do `ok` do host e da API pública, em cada site daquele destino. A
  demonstração (sem API) continua no merge.
- **A lista dos sites** é o registro: o `siteId` e o `firebaseProject` de cada cliente e o `staffPanel` da célula, e
  não o secret `PAINEL_SITES`, que deixa de ser lido.

### As permissões novas do cp-worker

| Onde                                    | O quê                                                                                                   | Por quê                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Projeto dos nós (`envs/nodes-platform`) | `cpNodeUpdater`: `instances.get`, `getGuestAttributes` e `setMetadata`, só nas VMs `vx-*`               | O pedido de versão e o andamento                                     |
| Cada nó dedicado (`envs/tenant`)        | `iam.serviceAccountUser` na conta da VM daquele nó                                                      | O Compute exige para gravar metadados de uma VM com conta de serviço |
| Projeto da célula (`envs/celula`)       | `cpCellNodeUpdater` (as mesmas três), só na VM da célula, pelo nome; `serviceAccountUser` na conta dela | A canária                                                            |

**O risco aceito:** a GCP não restringe o `setMetadata` por chave. Com ele, o cp-worker poderia trocar o
`startup-script` de uma VM `vx-*` e, com o `start`/`stop` do `cpNodeLifecycle`, rodar código nela no boot seguinte;
antes, o plano de controle não entrava em nenhuma VM. É o preço do desenho aprovado em 16/11/2026 (o pedido nos
metadados, sem nada exposto). Contenções: só as VMs `vx-*` e a VM da célula, pelo nome; o atualizador do host só
instala versão assinada pela chave de release, que não está no plano de controle; o `apply` seguinte do tenant
reescreve as chaves do Terraform; e toda chamada fica nos logs de auditoria de atividade do Compute (sempre ligados).
A alternativa estudada, o pedido num objeto do Cloud Storage lido pela VM, não daria esse poder ao cp-worker, mas
pediria uma concessão por nó num bucket do projeto do plano de controle, que o `cp-terraform` não alcança hoje.

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
   PR-V3'); entrega ao Wazuh pelo token do Google, com recarga sem parar o painel (PR-V4'); checagem da conexão e das
   fontes (PR-V5'); medidor da ingestão (PR-V6); regras críticas da AWS com títulos em português (PR-V7). **Feito no
   código.** Depois, na revisão de 22/11/2026, o onboarding self-service (o template no modelo 2, a descoberta, a
   autorização das fontes e os coletores novos: seção "Onboarding AWS self-service"), na branch de integração. O
   template e a coleta esperam o teste prático na conta AWS de teste
   (`docs/runbooks/homologacao-onboarding-aws.md`).
4. **Cloudflare:** token no cofre, auditoria e eventos de segurança.
5. **Ativos e Postura da AWS** pelo papel de leitura do cliente. **Feito no código**: o inventário nativo (PR-14') e
   a postura nativa com 18 checagens (PR-15'), numa coleta só, uma vez por dia; falta o teste prático.
6. **Compromissos do plano:** avisos por e-mail (feito no código no PR-16, com os avisos de 80% e 100% do volume),
   limites do plano, expurgo do histórico e 365 dias nas telas.
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
