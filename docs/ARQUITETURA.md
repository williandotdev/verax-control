# Arquitetura de implantação (decisões de 02/11/2026 e 04/11/2026)

Substitui a plataforma central na AWS do E8 (ECS, RDS, CloudFront, ALB, NAT e endpoints privados), cara para o
estágio atual. O código da aplicação (API, painel, autenticação, isolamento entre clientes) não muda.

A revisão de 04/11/2026 (fase 2) põe todo nó de cliente na GCP da Verax, com o Wazuh, e troca o papel com ExternalId
por um usuário IAM de leitura com chave, guardada cifrada no cofre do nó. A pilha do nó na AWS e o conector com papel
saem do caminho atual.

O que vem dessa revisão é o **desenho-alvo da fase 2, ainda a construir**: o nó de cliente com o Wazuh, os perfis de
nó, o template do usuário de leitura, o cofre, a chave e o token colados no painel e o coletor nativo do Cloudflare.
As seções dessas partes levam a marca _(fase 2, a construir)_, e o que já existe está marcado como feito em "Ordem de
execução". Até lá, o painel segue com o fluxo anterior, do papel com ExternalId.

## Princípios

1. **Simples e replicável.** Cada implantação é um **nó**: uma VM com tudo dentro, criada pelo Terraform de
   `infra/gcp/` num projeto da Verax na GCP, no perfil `lean` ou `standard` (seção "Perfis de nó"). Um nó atende um
   só cliente. Subir um cliente novo é aplicar o Terraform e criar dois registros de DNS; na fase 3, isso fica
   automático.
2. **Leitura de fora, só leitura.** O nó lê os dados do cliente **pela API, como uma ferramenta externa**, e a Verax
   não ganha nenhum acesso de escrita:
   - AWS: um **usuário IAM de leitura com chave restrita ao IP do nó** (`verax-control-reader`), criado por um
     template na conta monitorada. A chave só funciona a partir do IP reservado do Cloud NAT do nó;
   - GCP: um sink do próprio cliente publica no Pub/Sub do nó, sem nenhum papel para a Verax no projeto do cliente;
   - Cloudflare: um token só de leitura.
3. **Nada no ambiente do cliente é alterado.** O template da AWS só cria o usuário de leitura (sem chave e sem
   senha), um grupo e duas políticas. A trilha do CloudTrail e o export do GuardDuty só são criados se o cliente pedir
   na pilha (o padrão é não). Nenhuma trilha, destino de log, assinatura, bucket ou política existente é modificado.
4. **Nenhum log é apagado ou sobrescrito.** Em três camadas:
   - o usuário de leitura não tem nenhuma ação de escrita ou exclusão, e o teste do template falha se alguma
     aparecer. Além disso, uma política de negação barra as ações que apagariam, desligariam ou desviariam logs e as
     que ampliariam o próprio acesso, o que vale mesmo que alguém anexe outra política ao usuário;
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
        ├─► AWS do cliente: usuário IAM verax-control-reader (chave no cofre)
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

- **Configuração da AWS (Ativos e Postura):** o worker lê com a mesma chave, só pelas ações de leitura da política,
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
  a chave privada do cofre e a chave da AWS, a memória do worker e a do manager) chega ao disco, e ao snapshot dele,
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

## Contas monitoradas por provedor

_(credencial no cofre: fase 2, a construir)_

O cadastro de contas (Contas cloud) aceita três provedores. A GCP não usa credencial. **AWS e Cloudflare: credencial
de leitura cifrada no cofre do nó** (seção "Cofre de credenciais"). Um admin cola a credencial no painel; ela nunca
volta pela API e nunca fica no cadastro da conta.

| Provedor   | Identificador                            | Origem dos logs                                                                                                                   | Como o nó lê                                                                 |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| AWS        | ID da conta (12 dígitos)                 | Buckets S3 (CloudTrail, GuardDuty e WAF)                                                                                          | Usuário IAM `verax-control-reader`, com chave restrita ao IP do nó, no cofre |
| GCP        | ID do projeto                            | Assinatura do Pub/Sub, no projeto do nó, ligada ao sink que o cliente cria (a identidade do sink fica no cadastro; não é segredo) | Identidade da VM do nó, sem chave                                            |
| Cloudflare | ID da conta (32 caracteres hexadecimais) | Zonas (domínios) monitoradas                                                                                                      | Token só de leitura, no cofre                                                |

Cada origem de log (bucket, assinatura, identidade do sink ou zona) pertence a um só cliente, como já valia para os
buckets: é o que permite atribuir cada alerta ao cliente certo. A identidade do sink, além disso, é de um projeto só,
mesmo dentro do cliente: em outro projeto, daria a ele a publicação no tópico do primeiro.

## Cofre de credenciais

_(fase 2, a construir)_

- **O que guarda:** a chave de acesso do usuário IAM da AWS e o token do Cloudflare, uma linha por conta cloud
  (`CloudCredential`), com o mesmo isolamento por cliente de todo dado de cliente.
- **Cifra assimétrica:** RSA-3072 com OAEP-SHA256. A API, exposta pelo túnel, tem só a chave pública: cifra o que o
  admin cola e não consegue decifrar o que já está guardado. Só o worker tem a chave privada.
- **Vínculo:** o rótulo do OAEP amarra o texto cifrado ao cliente, à conta e ao tipo. Uma linha copiada para outra
  conta ou outro cliente não abre.
- **Chave do nó:** nasce na VM, na instalação, se o segredo `<prefixo>-credentials-key` do Secret Manager estiver
  vazio, e vai direto para ele, sem passar pelo disco. A permissão de acrescentar versões vale só nesse segredo. A
  chave privada nunca sai da GCP e não é gravada no disco do nó: fica no tmpfs e na memória do worker, e o swap é
  cifrado com uma chave que some a cada boot (seção "Perfis de nó"). Por isso, os backups do banco e os snapshots do
  disco não levam a chave privada nem credencial em claro.
- **Versões:** a versão do segredo é a versão da chave. Uma tarefa diária do worker recifra as linhas antigas. Na
  saída de um cliente, destruir a versão depois do prazo dos backups inutiliza o texto cifrado que sobrou neles.
- **Validação antes de gravar:** só os admins (`admin_cliente` e `admin_verax`) colam, com permissão própria e limite
  de tentativas por conta e por cliente.
  - AWS: a conta e o ARN exatos do usuário de leitura (`GetCallerIdentity`). Chave de root ou de outro usuário é
    recusada.
  - AWS, permissão demais: o `SimulatePrincipalPolicy`, com o IP do NAT do nó no contexto (`aws:SourceIp`; sem ele,
    o Deny de IP pode negar tudo e esconder a permissão a mais), testa uma amostra de ações que o usuário não pode ter:
    escrita, IAM, KMS e leitura fora da política, como um bucket não cadastrado e o Secrets Manager. Se alguma for
    permitida, a chave é recusada. É uma amostra: uma permissão a mais fora dela não é detectada.
  - Cloudflare: `tokens/verify`. A Global API Key é recusada.
- **O segredo não sai:** não volta pela API e não vai para a auditoria (só os 4 últimos caracteres do ID da chave,
  `keyIdSuffix`) nem para o log (o logger mascara os segredos decifrados no processo). Erros da AWS vão para o log só
  pelo código.
- **Entrega ao Wazuh:** um processo curto decifra e passa a lista por pipe ao gerador da configuração, o único que
  escreve: o `ossec.conf`, com um profile por conta, e os arquivos `credentials` e `config` num tmpfs do host (0600),
  montado só leitura no manager. O `ossec.conf` nunca leva a chave (`<access_key>`/`<secret_key>`).
  - Trocar só a chave não reinicia nada: o módulo relê o arquivo na rodada seguinte.
  - Mudar contas ou buckets reinicia só o manager, com volta automática à configuração anterior se ele não subir.
    Indexer, API e painel seguem no ar.
- **Desativar a conta** apaga a credencial na mesma transação.

## Por que usuário IAM com chave

_(fase 2, a construir)_

**Decisão de 04/11/2026, com o risco aceito pelo responsável pelo produto.**

- O nó roda na GCP, fora da AWS. Para assumir um papel com ExternalId, ele precisaria de uma identidade da AWS do lado
  da Verax: uma conta AWS da Verax ou federação da GCP para a AWS. As duas ficaram fora do plano.
- O módulo `aws-s3` do Wazuh lê com um profile em `/root/.aws/credentials`, sem código novo de coleta.
- O modo papel com ExternalId fica guardado para um futuro modo Enterprise.

**O template** (`infra/cloudformation/verax-control-reader.yaml`, feito; o passo a passo do cliente está no README da
pasta) cria o usuário `/verax/verax-control-reader` sem chave e sem senha, o grupo e duas políticas gerenciadas.
Nenhuma saída da pilha é segredo.

- `VeraxControlReader` (Allow, que também é o permissions boundary do usuário): lê só os buckets e as chaves KMS
  informados (`kms:Decrypt` só pelo S3), confere as fontes e lê a configuração para Ativos e Postura.
- `VeraxControlGuardrails` (Deny): tudo o que vier de fora do IP do NAT do nó, qualquer alteração de logs, qualquer
  ampliação do próprio acesso e, num incidente, as sessões emitidas antes de uma data.

**Ciclo da chave:**

1. O cliente aplica o template, cria a chave no console e cola no painel. O nó passa a ler os buckets em poucos
   minutos.
2. O worker confere a cada 15 min a conexão, o KMS, a idade e se há outra chave ativa. Uma vez por dia, repete a
   simulação de permissão demais (só avisa) e confere se a trilha e o export do GuardDuty apontam para os buckets
   cadastrados.
3. Troca: faixa no painel aos 75 dias, aviso e e-mail aos 90 e escalonamento aos 120. O cliente cria a segunda chave,
   cola e exclui a antiga. **A coleta nunca para por idade.**
4. Remoção: a credencial é apagada, e o painel mostra os passos no console: excluir a chave e depois a pilha.

**Riscos residuais e mitigação:**

| Risco                                                                                                             | Mitigação                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chave de longa duração fora da AWS do cliente                                                                     | Só vale do IP do NAT do nó; leitura mínima com boundary; Deny de alteração de logs e de IAM; regra de nível 12 para uso fora do nó; troca aos 90 dias                              |
| Root no nó lê a chave em claro (tmpfs e memória do worker e do manager)                                           | Nó dedicado a um cliente; sem porta aberta; acesso só pelo IAP com OS Login auditado; metadata só para o worker; o alcance é leitura de logs e configuração                        |
| Página da memória com segredo em claro (chave privada, chave da AWS, token) vai para o swap, no disco do snapshot | Swap cifrado com chave aleatória a cada boot, nos dois perfis; no `standard`, `vm.swappiness=1` e o heap do indexer travado na memória                                             |
| Execução remota de código na API, exposta pelo túnel                                                              | Cofre assimétrico: a API não decifra o que está guardado, só vê as chaves coladas durante o comprometimento                                                                        |
| O manager processa log não confiável e lê a chave                                                                 | Sem acesso ao Postgres nem ao metadata; `cap_drop`; rede de saída só dele; imagem fixada pelo digest; nó dedicado                                                                  |
| Sessões do `GetSessionToken` sobrevivem à exclusão da chave e não podem ser negadas                               | O Deny de IP vale para elas; `RevokeSessionsIssuedBefore` no incidente                                                                                                             |
| O `GetCallerIdentity` não pode ser negado e revela a conta e o ARN                                                | Impacto baixo; documentado                                                                                                                                                         |
| O IP do NAT muda e a coleta para                                                                                  | IP reservado com `prevent_destroy`; erro `source_ip_denied` com instrução no painel                                                                                                |
| O cliente amplia o usuário (anexa política, tira o boundary)                                                      | `SimulatePrincipalPolicy` ao colar e todo dia, com uma amostra de escrita, IAM, KMS e leitura fora da política, e aviso na Torre. Permissão a mais fora da amostra não é detectada |
| A chave antiga continua ativa depois da troca                                                                     | Aviso até ela sumir; escalonamento aos 120 dias                                                                                                                                    |
| Na saída do cliente, a chave segue válida na AWS, e os backups guardam o texto cifrado                            | Roteiro de exclusão; destruição da versão da chave do nó depois do prazo dos backups                                                                                               |
| Pessoa interna da Verax com acesso à VM ou ao Secret Manager consegue decifrar                                    | IAM mínimo no projeto dos nós; IAP auditado; o CloudTrail do cliente registra todo uso pelo ARN e pelo IP                                                                          |
| Objeção de conformidade: Security Hub e Prowler acusam a chave; uma SCP pode proibir usuário IAM                  | Texto "Por que usuário IAM" no onboarding; modo papel guardado para Enterprise                                                                                                     |
| Quarentena automática da AWS se a chave vazar em público                                                          | A checagem mostra o AccessDenied com instrução de troca                                                                                                                            |
| Bucket de organização legível inteiro                                                                             | Prefixo opcional na pilha (`LogObjectPrefix`); nó dedicado ao mesmo cliente                                                                                                        |
| Chave em argumento de processo ou em log de debug                                                                 | Nunca `<access_key>` no `ossec.conf`; debug do módulo desligado; máscara de segredos no logger                                                                                     |

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

## Ordem de execução

**Decisão de 02/11/2026** (os números dos passos são citados em outros arquivos):

1. Diagnóstico somente leitura da conta monitorada (`infra/diagnostico/`), publicado por release e com roteiro de
   onboarding (`docs/runbooks/onboarding-cliente.md`). **Feito.**
2. Conector só com o papel de leitura (`infra/cloudformation/verax-control-connector.yaml`). **Feito; substituído**
   pelo usuário IAM de leitura na revisão de 04/11/2026.
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
3. **Cofre e AWS:** cofre de credenciais; template do usuário IAM; chave no painel; entrega da chave ao Wazuh, com
   recarga sem parar o painel; checagem da conexão, das fontes e da idade da chave; medidor da ingestão; regras
   críticas da AWS com títulos em português. O template do usuário IAM já está feito, à espera do teste na conta AWS
   de teste.
4. **Cloudflare:** token no cofre, auditoria e eventos de segurança.
5. **Ativos e Postura da AWS** com a chave do cliente.
6. **Compromissos do plano:** avisos por e-mail, limites do plano, expurgo do histórico e 365 dias nas telas.
7. **Versão do nó reproduzível e ensaio geral.** É o portão da fase 3: um nó nasce do zero só com `terraform apply` e
   a versão publicada, sem SSH e sem operador.

**Fase 3:** provisionamento automático do cliente (checkout, estados do cliente, Terraform por cliente, túnel e DNS
por API e primeiro acesso). **A primeira venda só acontece depois dela**; não há venda assistida.
