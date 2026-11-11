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

### Regras de detecção: faixas de ID e títulos

Cada regra tem um ID numa faixa própria, e o ID vai para o achado (`ruleId`), para as exceções e para os relatórios.
A escala de nível é a mesma em todas: 12 ou mais é crítica, 10 alta, 7 média e abaixo disso baixa.

| Faixa           | Onde roda                                                               | O quê                                                                                                                          |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 80200 a 80499   | Wazuh do nó (`0350-amazon_rules.xml`, do próprio Wazuh)                 | CloudTrail, GuardDuty e WAF; as correlações 80252, 80255 e 80443 sobrescritas para contar por conta (`verax_aws_rules.xml`)    |
| 100200 a 100299 | Wazuh do nó (`verax_reader_rules.xml`, gerado do modelo com o IP do nó) | O papel de leitura da Verax no CloudTrail do cliente (PR-V4', passo "Coletar")                                                 |
| 100300 a 100399 | Wazuh do nó (`verax_aws_critical_rules.xml`)                            | Regras críticas da AWS no CloudTrail do cliente (PR-V7): root, administrador, CloudTrail, GuardDuty, S3, grupo de segurança... |
| 990101 a 990199 | Worker, sem Wazuh (`apps/api/src/gcp/gcp-rules.ts`)                     | Auditoria da GCP                                                                                                               |
| 990201 a 990299 | Não usada                                                               | Era a do coletor próprio do CloudTrail, que saiu do plano; o subconjunto crítico do catálogo dela virou a faixa 100300         |
| 990301 a 990399 | Worker, sem Wazuh (`apps/api/src/cloudflare/cloudflare-rules.ts`)       | Auditoria do Cloudflare                                                                                                        |

**O título do achado é fixo e em português.** Nas regras do worker, é o da tabela de regras. Nas do Wazuh, a
descrição cita campos do evento (o nome da chamada, o IP, o bucket) e, nas regras do próprio Wazuh, é em inglês: o
título vem do dicionário `apps/api/src/alerts/aws-rule-titles.ts`, que cobre toda regra local com nível acima de 0
(1002xx, 1003xx e as correlações sobrescritas) e o login com falha do Wazuh (80254). Sem título no dicionário (o
GuardDuty, cujo título vem da própria AWS, e o CloudTrail genérico), fica a descrição, como nos alertas dos agentes
nas instâncias do cliente (regras do próprio Wazuh). Um teste confere que toda regra local que pode virar achado tem
título e que nenhum título leva campo do evento: é o título, e não a descrição, que o aviso por e-mail (PR-16) pode
usar.

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

_(fase 2: o template está feito, no PR-V2'; o "Conectar AWS" do painel, no PR-V3'; a coleta pelo Wazuh do nó, no
PR-V4'; a conferência real da conexão vem no PR-V5', depois do teste prático na conta AWS de teste)_

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
2. **Coletar (PR-V4', feito):** o manager do Wazuh do nó lê os buckets de cada conta conectada com o papel, sem chave.
   - **O token, no host:** o `infra/node/bin/aws-token.sh` (root, `verax-aws-token.timer`: 30 s depois do boot e a
     cada 10 min; o `start.sh wazuh-up` também o roda antes de subir o manager) pede ao servidor de metadados o token
     com o audience do nó e `format=standard` (sem o projeto nem a VM), confere o formato e o grava por troca atômica
     em `/run/verax/wazuh-aws/google-id-token` (tmpfs, 0600, root), a pasta montada só leitura no manager em
     `/root/.aws`. Quem pede é o host: a guarda do metadata só filtra os contêineres, e o worker não ganha escrita na
     pasta do manager. Uma falha mantém o token anterior, que vale 1 hora: renovar a cada 10 min deixa 50 min de
     folga. Sem a pasta (o Wazuh fora do ar), não faz nada, e o `start.sh down` apaga a pasta.
   - **A lista das contas:** o CLI `wazuh-sources` (imagem da API, ambiente do worker, rede do banco; job do
     `compose.wazuh.yaml`) imprime as contas AWS ativas que já passaram pela verificação (`ingestFrom`) e têm bucket:
     ID, primeira região, `only_logs_after` (o `ingestFrom`) e os buckets. A conexão de agora não conta: um erro, uma
     edição de bucket (que volta a conta a "aguardando") ou os erros que a própria coleta grava não tiram a conta do
     manager nem o reiniciam; desativar a conta, sim. Nenhum valor é segredo.
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
     da lista que o CLI imprime) só quando ela muda; o host grava `applied` (`{generation, status ok|error, at}`) e
     `aws-token` (`{tokenAt}`), e o bit t impede que o worker troque os dois. O worker grava em cada conta que o
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
   sessões já emitidas, de até 1 hora) e apagar a pilha. Não há chave para apagar.

**Riscos residuais e mitigação:**

| Risco                                                                                                                                    | Mitigação                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token do Google vazado: vale até 1 hora e não pode ser revogado                                                                          | Só entra do IP do NAT do nó (`aws:SourceIp` na confiança) e só no papel deste cliente; a sessão emitida também fica presa ao IP (Deny); regra de nível 12 para entrada de outro IP                                                                                                                                    |
| Root no nó lê o token e as sessões em claro (tmpfs e memória do worker e do manager)                                                     | Valem 1 hora; nó dedicado a um cliente; sem porta aberta; acesso só pelo IAP com OS Login auditado; metadata só para o worker; o alcance é leitura de logs e configuração. Na célula, o alcance são os tokens de todos os clientes dela (o raio de impacto da seção "Célula compartilhada (Plataforma)")              |
| Página da memória com segredo em claro (chave privada do cofre, token, sessões) vai para o swap, no disco do snapshot                    | Swap cifrado com chave aleatória a cada boot, nos dois perfis; no `standard`, `vm.swappiness=1` e o heap do indexer travado na memória                                                                                                                                                                                |
| O ambiente de um contêiner fica gravado em `/var/lib/docker`, no disco e no snapshot                                                     | Chaves privadas do cofre só por arquivo do tmpfs montado só leitura no worker, nunca por variável (teste e CI conferem); o token da AWS fica num tmpfs do host                                                                                                                                                        |
| Execução remota de código na API, exposta pelo túnel                                                                                     | A API não alcança o metadata e não emite token; cofre assimétrico para o Cloudflare                                                                                                                                                                                                                                   |
| O manager processa log não confiável e lê o token                                                                                        | Sem acesso ao Postgres nem ao metadata; `cap_drop`; rede de saída só dele; imagem fixada pelo digest; nó dedicado; o token vale 1 hora e só do IP do nó. Na célula, um log forjado por um cliente que explore o manager alcança os tokens dos outros: risco residual aceito e documentado (raio de impacto da célula) |
| Quem emite ID token da conta de serviço do nó entra no papel (operador com `serviceAccountUser`; no plano de controle, o `cp-terraform`) | Precisa também sair pelo IP do NAT do nó; alertas em `SetIamPolicy` na conta de serviço, em `GenerateIdToken` e em VM criada com a conta de um nó (CP-12); nunca `serviceAccountOpenIdTokenCreator` no Terraform                                                                                                      |
| A conta de serviço do nó é apagada ou recriada, e o ID único muda                                                                        | `account_id` e `project` só do `name_prefix` e do `project_id`, com teste de que as mudanças de rotina não a recriam; o executor do plano de controle (CP-07) recusa recriá-la ou apagá-la fora da exclusão; restauração em até 30 dias com o mesmo ID; depois disso, cada cliente atualiza a pilha                   |
| Google ou o metadata fora do ar (`IDPCommunicationError`, renovação do token falha)                                                      | O token tem 50 min de folga; o wodle retoma do marcador e não perde log; aviso de token sem renovar                                                                                                                                                                                                                   |
| A web identity pelo profile não funcionar no contêiner do manager                                                                        | O CI confere na imagem, sem rede, que o boto3 do manager usa o provedor de web identity e troca o token no STS da região com o papel certo; o teste prático na conta de teste confirma de ponta a ponta; plano B: o host troca o token por uma sessão e grava um `credentials` temporário de 1 hora                   |
| Um bucket cadastrado depois do início da coleta é lido desde o `ingestFrom` da conta (histórico de semanas ou meses)                     | Aceito por ora: a leitura vai para o medidor de uso; um início por bucket fica para depois                                                                                                                                                                                                                            |
| O worker grava na pasta dos sinais, no tmpfs do host                                                                                     | Só sinal sem segredo; o bit t impede que ele troque os arquivos do host, que nunca leem o que ele grava (a geração só dispara o `.path`, com limite de partidas)                                                                                                                                                      |
| O `GetCallerIdentity` não pode ser negado e revela a conta e o ARN da sessão                                                             | Impacto baixo; documentado                                                                                                                                                                                                                                                                                            |
| O IP do NAT muda e a coleta para                                                                                                         | IP reservado com `prevent_destroy`; erro `source_ip_denied` com instrução no painel                                                                                                                                                                                                                                   |
| O cliente amplia o papel (anexa política, tira o boundary)                                                                               | `SimulatePrincipalPolicy` todo dia, com o IP do nó e uma amostra de escrita, IAM, KMS e leitura fora da política: aviso na conta, sem parar a coleta. Permissão a mais fora da amostra não é detectada                                                                                                                |
| O cliente cria o papel pelo assistente do console e põe o audience no `aud`                                                              | Template e Terraform prontos; o README avisa; a mensagem de papel recusado explica                                                                                                                                                                                                                                    |
| RCP de perímetro de dados do cliente nega a federação do Google                                                                          | O cliente inclui `accounts.google.com` na RCP ou marca o papel como exceção (decisão dele); texto pronto no onboarding                                                                                                                                                                                                |
| STS de sa-east-1 desligado pelo cliente                                                                                                  | O worker cai para us-east-1; no Wazuh, o erro instrui a religar                                                                                                                                                                                                                                                       |
| Objeção de conformidade: o Access Analyzer mostra o papel com acesso externo federado                                                    | Esperado e explicado no onboarding: papel com credencial temporária é o que a AWS recomenda; o CloudTrail registra cada entrada com o `sub` do nó                                                                                                                                                                     |
| Ruído no CloudTrail e no medidor (cerca de 1.700 entradas por dia por conta, estimativa)                                                 | Medir no teste prático; se pesar, intervalo de 10 min ou descontar do medidor                                                                                                                                                                                                                                         |
| Bucket de organização legível inteiro                                                                                                    | Prefixo opcional na pilha (`LogObjectPrefix`); nó dedicado ao mesmo cliente. Na célula, o papel só aceita a identidade do próprio cliente, e o prefixo continua valendo                                                                                                                                               |
| Na célula, o cliente A cadastra a conta AWS de B _(a construir, CE-11 e CE-12)_                                                          | Uma conta de serviço por cliente (`vxt-<slug>`); a identidade vem de `TenantCloudIdentity`, gravada só pelo plano de controle; o `sub` de cada token é conferido; a confiança de B recusa o `sub` de A (`trust_denied`) e a conta nunca chega ao Wazuh                                                                |
| Na célula, o cliente A cadastra o ID da conta de B antes dele (409 para B, negação de serviço)                                           | Mensagem genérica no 409; depois (CE-23), a unicidade só entre contas verificadas: a verificada vence e as duplicadas não verificadas são desativadas                                                                                                                                                                 |
| Na saída do cliente, o papel segue na conta dele                                                                                         | Roteiro: "Revoke active sessions" e apagar a pilha; sem o papel, o nó não entra                                                                                                                                                                                                                                       |

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
  - lê os avisos `pending` vencidos, os mais antigos primeiro (até 20 por execução);
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
    reunido de novo.
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

- **Semáforo** (pendência 9, com a coleta parada aprovada em 05/11/2026):
  - **vermelho** com incidente crítico aberto;
  - **amarelo** com incidente alto aberto, nota de postura abaixo de 70 ou **coleta parada** (`collection_stalled`):
    uma fonte configurada sem dado novo há mais que o prazo de parada dela. Silêncio não é segurança: sem isso, o verde
    de um cliente cuja coleta parou mentiria. Fonte **não configurada** (o cliente sem Cloudflare, sem agentes) ou
    ainda **sem nenhum dado** (conta recém-cadastrada) nunca deixa a Torre amarela;
  - **verde** nos demais casos. No verde, a frase traz a prova: "Tudo calmo. (...) Coleta ativa em 4 de 4 fontes,
    último dado há 2 minutos" só quando todas as fontes configuradas coletam; com uma atrasada ou aguardando, a mesma
    prova, sem o "Tudo calmo". O cartão de decisões vazio faz o mesmo ("Tudo calmo: nada para decidir agora", ou o
    estado vazio que aponta a fonte parada).
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
  como em toda mudança do contrato.
- **Interface:** os gráficos são SVG próprio, sem biblioteca (`components/charts/`): o cartão de número (`StatTile`) e o
  minigráfico por hora (`MiniBars`, na rampa neutra validada, com setas, mouse e toque e a mesma tabela de "Ver
  tabela"); a linha de saúde da fonte (`SourceHealthRow`) usa ícone de forma própria e rótulo, com o tom de "ok" em
  coletando, o de médio em atrasada e o de alto em parada. Todos estão no `/catalogo`.

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
  diária no ciclo contra a franquia: seção "Célula compartilhada (Plataforma)", "Medição e franquia"). Até o contador
  da franquia (CE-10), "Plano e uso" mostra o volume do mês sem limite para ela.

- **Vagas** (`packages/shared/src/plan-usage.ts`): contas cloud ativas (AWS, GCP e Cloudflare) e usuários do cliente
  convidados ou ativos. A equipe da Verax (`admin_verax`) nunca conta. Criar e reativar pedem vaga; desativar libera.
  Descer de plano com o uso acima do novo limite não desativa nem apaga nada: só a próxima criação é recusada, e o
  painel mostra "acima do limite do plano".
- **Onde a vaga é conferida:** `assertWithinPlan` (`apps/api/src/plan/plan-limits.ts`), sempre na transação que grava,
  sob `pg_advisory_xact_lock(hashtext('verax:plan:<vaga>:<cliente>'))` (`lockPlanSeats`). Duas criações simultâneas no
  limite menos 1 terminam com uma aceita. Toda escrita que muda o status (ativar ou desativar, inclusive o `DELETE`)
  pega o mesmo lock **antes** de ler o recurso: a decisão tomada sobre o status lido vale até a gravação, e uma
  desativação que corre junto com uma reativação e uma criação não deixa as duas usarem a mesma vaga. O lock do plano
  vem antes dos das origens de log e da credencial (as contas cloud), sempre na mesma ordem. Os pontos:
  - cadastro, reativação e desativação de conta cloud (`POST`, `PATCH` e `DELETE /v1/cloud-accounts`);
  - cadastro, reativação e desativação de usuário (`POST`, `PATCH` e `DELETE /v1/users`), inclusive o primeiro
    administrador de um cliente novo (`POST /v1/tenants`, que sempre tem vaga);
  - o bootstrap do nó: as contas da GCP (no limite, a conta fica de fora com `plan-limit`, e o resto segue) e, no modo
    `customer`, o `admin_cliente` (no limite, um e-mail novo é recusado; o primeiro sempre tem vaga).
- **Recusa:** 409 com o código `PLAN_LIMIT_REACHED` e a mensagem que diz o limite do plano do cliente ("Seu plano
  permite até 3 contas cloud ativas. Desative uma conta ou fale com a Verax para ampliar."), na trilha do cliente como
  falha, com a ação de sempre (`cloud_account.create`, `cloud_account.update`, `user.create` ou `user.update`).
- **Volume do mês:** o medidor de uso (PR-03) soma os bytes lidos por cliente, mês do calendário de Brasília e fonte
  (`aws` pela tarefa `wazuh-usage`, PR-V6: os bytes que o analysisd do nó recebe, que incluem os dos agentes do Wazuh
  quando ligados).
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
  | Postura                                                                  | Varreduras e reprovações pelo prazo do plano; a varredura mais recente de cada conta fica sempre                                                                                                                                                                                            |
  | Inventário                                                               | 30 dias; o retrato mais recente de cada conta fica sempre                                                                                                                                                                                                                                   |
  | Fila sem dono                                                            | 90 dias                                                                                                                                                                                                                                                                                     |
  | Avisos por e-mail                                                        | Enviados, com falha ou pulados, sem mudança há 90 dias (a chave de deduplicação não deixa o aviso sair de novo nesse tempo); o pendente fica, e o de um incidente ou achado que sai vai junto. As horas de avisos (o resumo resolvido e a hora só de contagem, PR-17'), pelo mesmo prazo    |
  | Sessões, links, tentativas de login, códigos TOTP usados e limite por IP | Vencidos há mais de um dia (as janelas vão de 2 minutos a 12 horas). Os links do contato de escalonamento (D8) não passam por aqui: os vencidos saem a cada e-mail novo ao contato, e os de um endereço anterior na troca; o limite por IP dos links, na chamada seguinte, depois de um dia |
  | Auditoria                                                                | 13 meses, ou o prazo do histórico do cliente se for maior (com histórico sem limite, fica). Os registros sem cliente seguem o corte mais antigo entre os clientes                                                                                                                           |
  | Fica sempre                                                              | Clientes, usuários, contas, lista de proteção, exceções, credenciais, agentes, uso por mês e o estado dos coletores                                                                                                                                                                         |

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
serviço por projeto (cerca de 100) nem pede um orçamento à parte. Um projeto das células volta à mesa quando a cota ou
o orçamento pedirem. Esta seção é o registro da decisão (ADR); o detalhamento por PR está no estudo da fase 3, fora do
repositório, e o que já está no código tem a marca de feito.

```
<slug>.control.veraxsistemas.com.br   (um site do Firebase por cliente, como hoje)
api-<slug>.veraxsistemas.com.br ──CNAME──► túnel da célula (um por célula, ingress único → api:3000)
                                                │
GCP da Verax, projeto do nó da Verax (por ora)
  célula verax-celula: módulo node, perfil standard, IP do NAT reservado
    API (host → cliente) · worker · Postgres · Wazuh (manager e indexer) · cloudflared
  uma conta de serviço por cliente, vxt-<slug> (a VM da célula só emite o token dela; a permissão fica em cada conta)
  Pub/Sub: comandos do plano de controle (só o cp-worker publica) · relatórios da célula (só a VM publica)
  tópicos da GCP por cliente e projeto, com o UUID da conta no nome (nunca reaproveitado)
  buckets: backups da célula (85 dias) e exportações (<célula>/<cliente>/..., 31 dias)
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

- o medidor da AWS para com `multiple_tenants`, e a saúde da AWS vem do contador do nó inteiro (`usage/wazuh-usage.ts`);
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
  `envs/cell-tenant` no provisionamento:
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
  que só o sistema grava (`TenantPlan`, feito no CE-02; `TenantHost` e `TenantCloudIdentity`, a construir) tem
  meta-teste de que nenhuma rota o aceita, e o escopo de cliente recusa a gravação. O RLS do Postgres fica como defesa
  em profundidade, depois da primeira venda (CE-21).
- **Vizinho barulhento.** Um `analysisd` e uma execução do módulo da AWS para todos: na célula, o `only_logs_after` é
  o mais recente entre o `ingestFrom` e ontem, cada bucket tem a própria data de início, e a configuração do manager é
  aplicada no máximo a cada 15 minutos; o worker reveza os clientes, com um orçamento por cliente em cada tarefa; a API
  tem limite por cliente nas rotas caras. **Nenhum log é descartado** (princípio 4): os freios do volume são o
  excedente e um aviso ao responsável acima de 5 vezes a franquia por 24 horas.
- **Logs e métricas.** Os logs dos contêineres já só levam IDs e códigos, então um destino só do Cloud Logging serve;
  a célula informa ao plano de controle CPU, memória, fila do `analysisd`, atraso do módulo e os maiores clientes em
  GB/dia, para a página "Células" do console. O item "Medidor da AWS parado" da Torre deixa de valer na célula.

### Canal entre o plano de controle e a célula _(a construir, CE-05 e CE-06)_

**Pub/Sub nos dois sentidos**, sem nada novo exposto na internet. Os comandos (`tenant.upsert`, com o estado desejado
inteiro e uma `generation` crescente por cliente; `tenant.export`, `tenant.purge` e `tenant.collection_pause`) seguem
um contrato zod estrito e versionado (`packages/shared/src/cell-protocol.ts`), e o worker da célula aplica cada um numa
transação, ignorando uma geração já aplicada, com o relatório na mesma transação (outbox). Os relatórios
(`tenant.applied`, `tenant.status`, `usage.daily`, `export.ready`, `tenant.purged`, `franchise.requested`,
`gcp_source.request` e `cell.status`) chegam ao `cp-worker` por uma assinatura push com OIDC, aceita só numa rota
(`@WorkerCallers('cell-push')`), e o plano de controle confere que **todo cliente citado está nesta célula**: uma
célula comprometida só mente sobre os próprios clientes. O IAM dos tópicos prova quem publicou. A senha do primeiro
administrador nunca passa pelo worker: o host a escreve no cofre `vxt-<slug>-admin-bootstrap`.

### Medição e franquia _(a construir, CE-09, CE-10, CE-13, CE-19 e CE-20)_

- **Unidade:** bytes descomprimidos (a regra do `usage-meter.ts`), por dia do calendário de Brasília, numa tabela
  diária por cliente e fonte (`IngestUsageDay`). A AWS é medida **na origem**, por cliente: um auditor lê o tamanho
  descomprimido no fim de cada objeto gzip, com a identidade do próprio cliente, e conta o objeto no dia em que ele foi
  criado (o histórico anterior à primeira verificação nunca é cobrado). O contador do `analysisd` vira só a
  conferência da célula. A GCP conta pelo `publishTime`; o Cloudflare, pelo tamanho de cada entrada da auditoria.
- **Excedente:** a média diária do ciclo menos a franquia ponderada pelos dias em que valeu, arredondada para baixo (a
  dúvida a favor do cliente), em centésimos de GB/dia. Vai à Stripe como um evento de medidor por ciclo fechado, com
  identificador idempotente, e cai na fatura seguinte. Um ciclo estranho (dia sem fechamento, divergência na
  conferência, excedente muito acima da franquia) espera a aprovação do responsável.
- **Ampliar a franquia:** pelo painel (Administração → Plano e uso), só o `admin_cliente`, com um código TOTP novo; o
  plano de controle muda a quantidade na Stripe, com a cobrança proporcional na hora, e só aplica se o pagamento
  passar. Reduzir vale no ciclo seguinte. Toda mudança gera auditoria nos dois lados e um recibo por e-mail.

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

### Exclusão e a promessa dos 100 dias na célula _(a construir, CE-03 e CE-16)_

Na célula, a VM continua no ar depois do cancelamento. Com o calendário do nó dedicado (dados até D+30), os backups da
célula com o cliente viveriam até cerca de D+129, e a frase do site ("eliminados também dos backups em até 100 dias")
deixaria de valer. Por isso a célula tem calendário próprio e backups de 85 dias:

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

| Peça                                           | Onde                                                                                | Faz                                                                                                                                                                                                                                                           | Não faz                                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Site estático** (repo privado)               | `veraxsistemas.com.br`, Firebase Hosting                                            | Calculadora de preço (lê a tabela pública e pede a cotação), formulário de compra, página de status com a revelação única da senha, link do Portal do cliente                                                                                                 | Nunca toca chave da Stripe nem dado de cliente além do que o usuário digita; nunca manda preço (só a cotação)                             |
| **`cp-public`** (Cloud Run, 0 a 2 instâncias)  | Projeto da Verax, atrás de `conta.veraxsistemas.com.br` (Hosting com rewrite `/**`) | Tabela pública de preços e cotação, textos legais vigentes, checkout pela cotação, consulta de subdomínio, página de status (claim, status, reveal), webhook da Stripe, `/health`                                                                             | Nenhuma rota interna nem do console: aceita invocação anônima (exigência do rewrite do Hosting)                                           |
| **`cp-worker`** (mesma imagem, `ROLE=worker`)  | Projeto da Verax, só IAM                                                            | Um passo do provisionamento por task, `tick` horário, `reconcile` diário, operações do responsável (`resume`, `delete-now`, `export` e, no contrato direto, `cancel`, `suspend` e `reactivate`), chamadas pelo console (`cp-admin`)                           | Não é alcançável sem token de identidade do Google; o app ainda confere `aud` e `email` do token                                          |
| **`cp-admin`** (mesma imagem, `ROLE=admin`)    | Projeto da Verax, atrás de `admin.veraxsistemas.com.br` (Hosting com rewrite `/**`) | Console do responsável: as telas (`apps/console`) e a API das tabelas de preços e dos modelos de custo, simulador de DRE, os clientes (lista, linha do tempo, contrato direto) e os botões das operações, pedidas ao `cp-worker`; os textos legais            | Login próprio (e-mail de `OWNER_PRINCIPALS`, senha e TOTP, com bloqueio); invocação anônima; nada da Stripe                               |
| **`cp-terraform`** (Cloud Run Job)             | Projeto da Verax; identidade com papéis no projeto dos nós                          | `init`, `plan` e `apply`/`destroy` de `infra/gcp/envs/tenant` com Terraform fixado, estado por tenant no bucket                                                                                                                                               | Não lê Stripe, Cloudflare nem Firestore; só recebe variáveis já validadas por regex                                                       |
| **Firestore** (banco `(default)`, modo nativo) | Projeto da Verax                                                                    | Estado: `tenants` (com `transitions` e `invoices`), `slugs`, `stripeEvents`, `statusTokens`, `provisioningRuns`, `auditLog`, `rateLimits`; preço configurável: `pricingTables`, `costModels`, `quotes` (24 h); textos legais: `legalTexts`; console: `admin*` | Nunca guarda segredo em claro, cartão, token do túnel nem corpo bruto do webhook; a senha do console só como hash scrypt e o TOTP cifrado |
| **Cloud Tasks** e **Cloud Scheduler**          | Projeto da Verax                                                                    | Filas `provisioning` e `lifecycle` com nova tentativa e recuo, OIDC para o `cp-worker`; `tick` a cada hora e `reconcile` às 03:00                                                                                                                             | Nada de longa duração: o `apply` roda no Job, a task só dispara e espera                                                                  |
| **Secret Manager** e **bucket de releases**    | Projeto da Verax                                                                    | Chaves da Stripe (teste e produção separadas), token do Cloudflare, senha SMTP, chave do cookie, chave e token do console; manifesto e bundle                                                                                                                 | —                                                                                                                                         |
| **Projeto dos nós** e **Firebase dos painéis** | Pago, criado na 1.ª venda; 1 a N projetos do Firebase (36 sites por projeto)        | Recursos `vx-<slug>` do módulo `node` (perfil `standard`); um site por cliente em `<slug>.control.veraxsistemas.com.br`, API em `api-<slug>`                                                                                                                  | Sem o projeto dos nós, o provisionamento falha com `provisioning_disabled` (sem laço) e retoma quando configurado                         |

### Identidades

- **`cp-public`:** lê e escreve no Firestore, enfileira tasks e lê as chaves da Stripe e do cookie. Nada mais.
- **`cp-worker`:** Firestore, tasks, execução do Job, Firebase Hosting nos projetos do pool, leitura do bucket de
  releases e, no projeto dos nós (`envs/nodes-platform`), um papel personalizado que só para, liga e lê atributos de
  VMs cujo nome começa com `vx-` (`cpNodeLifecycle`) e a leitura de `runs/` no bucket do estado. Por tenant, o
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
  console: `adminAccounts`, `adminSessions`, `adminLoginThrottle`, `adminEnrollments` e `adminSetup`), lê pela API do
  Secret Manager só os dois segredos do console (`cp-admin-totp-key` e `cp-admin-setup-token`, nunca montados) e
  invoca o `cp-worker` (`run.invoker` só nele, com `admin_enabled` e `services_enabled`) com o token de identidade da
  própria conta, para as operações do responsável; nenhum `actAs` na cp-invoker (não enfileira nada). Nenhum segredo
  montado: a configuração recusa a chave da Stripe. A invocação é anônima (o rewrite do Hosting de
  `admin.veraxsistemas.com.br` exige); quem entra é o login do próprio app: e-mail de `OWNER_PRINCIPALS`, senha (hash
  scrypt) e código TOTP (segredo cifrado com AES-256-GCM, código de uso único, códigos de recuperação em HMAC), com
  bloqueio de 15 minutos depois de 5 erros por e-mail e limite por IP (`req.ip`, a regra de `client-ip.ts`). A sessão
  é um id aleatório de 32 bytes no cookie `__session` (`HttpOnly`, `Secure`, `SameSite=Strict`), guardado só como
  hash, com 30 minutos de inatividade e 12 horas no máximo. O primeiro cadastro exige o token de uso único de
  `cp-admin-setup-token` e se fecha sozinho. A sessão nunca sai do `cp-admin`.
- **Responsável:** invoca o `cp-worker` com token de identidade, entra no `cp-admin` com e-mail, senha e TOTP,
  administra os segredos; tudo auditado (`owner:<e-mail>`).

O que o plano de controle **não** pode fazer: ler o banco do nó, abrir o cofre de credenciais, entrar na VM (sem OS
Login), ver dados de cartão (Checkout hospedado) ou usar a chave completa da Stripe (chave restrita).

### Estados do cliente

Toda mudança de estado é uma transação no documento `tenants/{id}` que relê o estado, confere a tabela de transições,
grava a transição em `tenants/{id}/transitions` e a auditoria em `auditLog`. O evento da Stripe só dispara: o objeto
que decide é relido na API; `event.id` é único (`stripeEvents`). Os passos do provisionamento usam uma trava por
tenant (`lock{owner, expiresAt}`, 20 min renovados; vencida, é tomada), que os campos de cobrança nunca disputam.

| Estado                        | Entra quando                                                                                                                                                               | Ação                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pending`                     | `checkout.session.completed`: a reserva do subdomínio vira tenant; ou o cadastro de um contrato direto pelo console                                                        | Cartão pago segue direto; boleto espera a compensação; contrato direto, o `provision` do console        |
| `provisioning`                | `invoice.paid` do 1.º ciclo, `checkout.session.async_payment_succeeded` ou, no contrato direto, o `provision` do responsável                                               | Enfileira o `preflight`; 10 passos idempotentes, um por task                                            |
| `provisioning_failed`         | Um passo esgotou as tentativas ou falhou sem repetição (`provisioning_disabled`, `ready_timeout`, `node_error`)                                                            | Alerta à Verax; o site diz "estamos finalizando"; `resume` pelo responsável retoma do passo registrado  |
| `waiting_customer_install`    | O cadastro de um contrato direto com o ambiente na infraestrutura do cliente (`hosting = customer`), direto da criação                                                     | Nada roda na Verax; o console mostra a versão e o guia para o cliente instalar; só sai cancelado        |
| `waiting_customer_connection` | Passo `access.ready`                                                                                                                                                       | E-mail "ambiente pronto" com o link da página de status; a senha é revelada ali, uma vez                |
| `active`                      | O `tick` lê no nó `verax/accounts-connected >= 1`                                                                                                                          | Monitoramento normal                                                                                    |
| `past_due`                    | `invoice.payment_failed` numa renovação                                                                                                                                    | Carência de 7 dias (relógio próprio: o Smart Retries não cobre boleto); e-mail com o Portal; nó no ar   |
| `suspended`                   | Assinatura `unpaid`, carência vencida (`tick`), disputa ou alerta de fraude (decisão humana); no contrato direto, só o responsável                                         | VM parada (`node.stop`); disco e snapshots ficam; `invoice.paid` (ou o responsável) reativa e liga a VM |
| `canceled`                    | `customer.subscription.deleted`, reembolso integral na garantia, boleto do 1.º ciclo vencido, 30 dias suspenso sem pagar (`tick`, D+37) ou o responsável (contrato direto) | VM parada; exportação sob pedido por 30 dias; relógios de D+30 e D+97                                   |
| `deleted`                     | `tick` com `deleteAfter` vencido, ou `delete-now` pelo responsável                                                                                                         | Exclusão em dois tempos (abaixo)                                                                        |

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
  responsável, com quem agiu no corpo (seção "Ciclo de vida depois da venda"). A chamada do `cp-public` sai pela internet, então a revelação depende da decisão
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

**Atualização não é automática.** Instalado o nó, uma versão diferente nos metadados (um `apply` do tenant com outra
`node_version`) só aparece no log do boot; nada é baixado nem instalado. Instalar sozinho, num reboot qualquer, rodaria
migrations sem backup, sem janela e sem volta (o que o SH-06 desenha). A atualização continua com o `deploy.sh`, pelo
operador, com o `node.conf` que a instalação escreveu (`/etc/verax/node.conf` da VM). Um nó instalado só pelo
`deploy.sh` (sem o marcador) também não é tocado. Uma instalação que parou no meio (o marcador `installing`) é refeita
do começo no boot seguinte: o `install.sh` pode rodar de novo.

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

**Bundle do painel ausente (CP-09 ainda não feito):** o contrato que o `firebase.site` lê é `panel: {url, sha256}` no
manifesto, como `package` (o arquivo `panel-<commit>.tar.gz` do release, num tar ustar com `dist/` e o
`dist-hosting.json` do build único do CP-08), e o arquivo na pasta da versão do bucket de releases. Sem o campo, o
passo para com `panel_bundle_missing` antes de criar qualquer coisa no Firebase (o túnel, gratuito, já existe e é
reaproveitado). **Por que parar, e não esperar:** o manifesto é imutável por versão, então o bundle não aparece
sozinho; só uma versão nova (com o CP-09) resolve, e esperar esconderia do responsável um erro que só ele corrige,
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

- **Cadastro:** o pedido leva `hosting` e as outras cinco respostas (o modo da tabela sai do lugar: gerenciado na
  Verax, licença no cliente, `MODE_OF_HOSTING`); a cotação de referência é a da licença, e do que o provisionamento
  exige valem os limites que o próprio nó recusa e os agentes nas instâncias (`node-fit.ts`: o guia de instalação no
  cliente usa o `envs/tenant`, que não liga a entrada dos agentes; um contrato com agentes é 422
  `configuration_unsupported` com o motivo no campo). O cliente nasce direto em
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
  subdomínio com os mesmos schemas e limites do checkout (`checkout.schema.ts`), as seis respostas da calculadora e
  `confirmSlug` (o subdomínio digitado de novo). A API confere tudo de novo: o subdomínio (formato, lista reservada,
  livre), o nome e o e-mail como o nó os aceita, a tabela de preços vigente, a cotação ("fale conosco" é recusado, 422)
  e se o `envs/tenant` sabe criar a configuração (`provisioning/node-fit.ts`, a mesma regra do `preflight`: modo
  gerenciado, porte P, sem agentes, limites nas faixas; senão 422 `configuration_unsupported` com o motivo por campo).
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
  `owner:<e-mail da sessão>`; a transição feita no worker, com o mesmo ator. Os logs levam só ids, o subdomínio, o porte,
  a versão da tabela e os códigos (nunca o e-mail, o CNPJ nem a razão social).
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

| Momento              | Passos (fila `lifecycle`)                                                                                      | O que acontece                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D+30 do cancelamento | `deletion.terraform`, `deletion.terraform_wait`, `deletion.cloudflare`, `deletion.firebase`, `deletion.record` | **Exclusão 1:** o executor com `EXECUTOR_ACTION=destroy`, `RUN_KIND=delete` (abaixo): VM, conta de serviço do nó, rede, NAT, tópicos e assinaturas, os cofres `admin-bootstrap`, `support-bootstrap`, `cloudflare-tunnel-token` e `smtp-password` e as permissões; o disco, os snapshots dele e o IP do NAT pela API. O túnel `vx-<slug>` e os registros de DNS só dos nomes do cliente (`api-<slug>.<zona>`, `<slug>.control...` e abaixo dele). O domínio e o site `vxc-<slug>-<hex>` do Firebase. Ficam o bucket de backups e o cofre `credentials-key`. O registro de exclusão por e-mail ao admin (sem SMTP, segue sem ele: `event=deletion_record_unsent`); o cliente perde `adminEmail`, `access` e os recursos que a Exclusão 2 não usa (`lifecycle.deletedAt`) |
| D+97 do cancelamento | `crypto.destroy_key`, `crypto.purge`, `crypto.purge_wait`, `crypto.finish`                                     | **Exclusão 2 (cripto-destruição):** o cp-worker destrói todas as versões de `vx-<slug>-credentials-key` (`cpSecretVersionDestroyer`: lista e destrói, sem ler) e confere que nenhuma ficou viva (`lifecycle.cryptoDestroyedAt`); o executor com `EXECUTOR_ACTION=purge`, `RUN_KIND=crypto_destroy` apaga o cofre, o bucket de backups (só vazio) e `tenants/<slug>/default.tfstate`. O tenant vira registro mínimo (`lifecycle.purgedAt`; o prazo `cryptoDestroyAfter` sai, para o `tick` só consultar quem ainda tem trabalho): ficam `slug`, `company`, `stripe.customerId`, `billing.mode` (se houver), `lifecycle`, o que foi vendido (`configuration`, `limits`, `pricing`), o aceite dos textos (`consent`) e as faturas por 5 anos                               |

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
  para cima); acima do que a tabela vende ou do maior porte, a resposta é "fale conosco". **O site vende só o ambiente
  na infraestrutura da Verax** (decisão do responsável, 06/11/2026; hoje a GCP, e pode mudar, por isso nada voltado ao
  cliente cita o provedor): o modo da infraestrutura do cliente (`self_hosted`) é recusado com 422
  `mode_not_sold_online` (a mensagem leva ao contrato direto), qualquer que seja a tabela publicada, sem gravar nada. A
  cotação é gravada em `quotes/{id}` por 24 h, com limite por IP e teto diário, e é o que o checkout aceita.
  `GET /v1/public/pricing` devolve só a parte pública da tabela vigente (preços e regras, o "a partir de") do ambiente
  na Verax: o modo do cliente não aparece (nem os preços nem o pacote de partida dele), sem custo, margem nem
  `lookup_key`, com 5 min de cache no CDN. A tabela continua com os preços da licença no cliente: o simulador de DRE, a
  checagem de publicação e a cotação de referência do contrato direto usam.
- **Checkout** (`POST /v1/public/checkout` com `quoteId`): uma cotação do modo do cliente (a de referência de um
  contrato direto, que o console grava na mesma coleção) é recusada com o mesmo 422, antes de reservar ou falar com a
  Stripe. Fora isso, relê a cotação, recalcula pela tabela da versão dela
  (honrada até vencer, mesmo com outra tabela publicada), confere cada preço na Stripe (ativo, em BRL, mensal ou
  avulso, com o valor da tabela, e a soma igual ao total) e abre a sessão com um item por componente; a implantação, se
  o modo tiver, entra como item avulso, só na primeira fatura. A reserva guarda a configuração, os limites do nó e o
  preço cotado (versão, cotação, mensal e implantação), que o webhook copia para o cliente. O nome da empresa vai de 2
  a 120 caracteres (`companyNameSchema`), o limite do `Tenant.name` do nó, e a mesma regra vale no `customer.updated`
  da Stripe, no executor Terraform e no `envs/tenant`: o nome chega inteiro ao nó, sem corte. Um cliente gravado antes
  desse limite, com um nome maior, para no `preflight` com `tenant_name_invalid`. O aceite do pedido precisa trazer as
  versões vigentes dos três textos legais (abaixo): outra versão, 409 `terms_outdated`; sem uma publicada de algum
  deles, 503 `checkout_unavailable`. As versões aceitas vão para a reserva, os metadados da Stripe e o cliente.
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
  controle leva em `/app/console`. O próprio `cp-admin` serve as telas e a API na mesma origem
  (`admin.veraxsistemas.com.br`): sem CORS e sem outro serviço. As telas abrem sem sessão (a de login, `/entrar`, e a
  do primeiro cadastro, `/configurar`; são o código do repositório público, sem número nenhum), com a CSP própria
  delas (só scripts, estilos e chamadas da própria origem, nada inline, nada em frame);
  `/assets/` (nomes com hash) fica em cache privado, o resto sem cache. As telas não têm nenhum número: o modelo de
  custos (com o custo do nó por porte recalculado na hora), a tabela de preços (com a checagem e a publicação, e o
  relatório da recusa) e o simulador de DRE leem e gravam só pela API, e os problemas de validação voltam por campo.
  Os tipos que as telas leem são conferidos contra os da API no `pnpm typecheck` (teste de contrato do plano de
  controle).
- **Limites no nó** (gancho do PR-18): a configuração vira os ajustes `PLAN_*` que o nó já lê (`PLAN=enterprise` e os
  quatro limites) e, com agentes contratados, `WAZUH_AGENTS=true` e `WAZUH_AGENTS_MAX` (seção "Agentes nas instâncias
  do cliente"); fica gravada no cliente (`tenants/{id}.limits`) para o provisionamento.

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
