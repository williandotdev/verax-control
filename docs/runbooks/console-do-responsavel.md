# Console do responsável (`cp-admin`)

O console é onde o responsável mantém o preço configurável do Verax Control: o **modelo de custos** (câmbio, nuvem por
porte, tarifas, impostos, suporte, custos fixos e as metas de margem), a **tabela de preços** (regra de porte, preço e
`lookup_key` da Stripe de cada componente, pacotes de partida), o **simulador de DRE** e os **clientes** (a lista, a
linha do tempo do provisionamento, o cadastro de um contrato direto e as operações do responsável). Os números vivem
só no Firestore do plano de controle; o repositório (público) não tem nenhum, e o console também não: ele só mostra o
que a API devolve.

O console é o serviço `cp-admin` do Cloud Run: a mesma imagem do plano de controle, com `ROLE=admin`, que serve as
telas (`apps/console`) e a API `/v1/admin/...` na mesma origem, em **https://admin.veraxsistemas.com.br** (um site
próprio do Firebase Hosting com o rewrite de tudo para o `cp-admin`, como o `conta` faz com o `cp-public`). Quem entra
é decidido pelo próprio console: **e-mail + senha + código do aplicativo autenticador (TOTP)**, só para os e-mails de
`owner_principals`. As telas abrem para qualquer um (são o código do repositório público, sem nenhum número); os dados
só saem da API com uma sessão de responsável.

Como o acesso funciona:

- **Login** (`/entrar`): e-mail, senha e o código de 6 dígitos do aplicativo (ou um código de recuperação), num
  formulário só. Qualquer erro (e-mail desconhecido, senha errada, código errado ou já usado, bloqueio) dá a mesma
  mensagem genérica, de propósito.
- **Bloqueio:** 5 tentativas erradas para o mesmo e-mail em 15 minutos bloqueiam o login dele por 15 minutos (o
  alerta "login do console do responsável bloqueado" avisa). Há também um limite de tentativas por IP.
- **Sessão:** cookie `__session` (o único que o Hosting repassa ao Cloud Run), `HttpOnly`, `Secure`,
  `SameSite=Strict`, guardado no Firestore só como hash. Vence com **30 minutos sem uso** ou **12 horas** depois do
  login, o que vier antes; o console volta para `/entrar`. **Sair** encerra a sessão no servidor.
- **Senha e TOTP guardados:** a senha só como hash (scrypt); o segredo do TOTP cifrado (AES-256-GCM) com uma chave
  derivada do segredo `cp-admin-totp-key`; os códigos de recuperação só como HMAC. Um código TOTP vale uma vez.
- **Conta** (`/conta`): trocar a senha e trocar o aplicativo autenticador (o que gera códigos de recuperação novos);
  as duas pedem a senha atual e um código. Trocar a senha encerra as outras sessões.

## 1. Ligar o console (uma vez)

1. **Os dois segredos do console** (o Terraform cria os cofres vazios, mesmo com `admin_enabled = false`; rode o
   `apply` uma vez se eles ainda não existirem: `terraform output secrets`). Grave os valores pelo `gcloud`, sem
   passar pelo Terraform nem pelo histórico do shell:

   ```bash
   # A chave mestra do console: gerada aqui, nunca vista por ninguém.
   openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add cp-admin-totp-key --data-file=- --project=SEU_PROJETO
   # O token do primeiro cadastro: gere com `openssl rand -base64 32`, guarde-o no seu gerenciador de senhas e grave:
   read -rs VALOR && printf '%s' "$VALOR" | gcloud secrets versions add cp-admin-setup-token --data-file=- --project=SEU_PROJETO && unset VALOR
   ```

   - **`cp-admin-totp-key`** (32 bytes em base64): cifra o segredo do TOTP no Firestore e assina os códigos de
     recuperação. **Não troque depois do cadastro**: o segredo gravado deixaria de abrir, e o único caminho seria o
     cadastro de emergência (seção 2.5).
   - **`cp-admin-setup-token`** (32 caracteres ou mais): exigido só na tela `/configurar`. Depois do cadastro, a tela
     se fecha sozinha; desative a versão mesmo assim (seção 2.1).

   Nenhum dos dois é montado no serviço: o `cp-admin` os lê pela API do Secret Manager na hora do login e do cadastro.
   Sem eles, o serviço sobe e o `/health` responde; só o login e o cadastro respondem "indisponível".

2. **Terraform** (`infra/gcp/envs/control-plane`, GUIA, passo 8): `owner_principals` com o seu `user:` e
   `admin_enabled = true` no `terraform.tfvars` (o site e o domínio têm padrão: `admin_hosting_site_id = "verax-admin"`
   e `admin_hosting_domain = "admin.veraxsistemas.com.br"`), depois `terraform plan` e `terraform apply`. O plano cria
   a conta `cp-admin` e o `datastore.user` dela, a leitura dos dois segredos, o serviço `cp-admin` com a invocação
   anônima (o rewrite do Hosting exige), o `run.developer` e o `actAs` de quem implanta, o site do Hosting com a versão,
   a release e o domínio, e os alertas do console (com `services_enabled`, mais o `run.invoker` do console no
   `cp-worker`).
3. **DNS:** `terraform output cloudflare_dns_records` lista os registros que o Firebase pede (os do `conta` e os do
   `admin`). Crie no Cloudflare os que faltarem, com o proxy **desligado** ("DNS only"), como no `conta` (GUIA,
   passo 6). O certificado sai sozinho depois que o Firebase vê os registros (de minutos a algumas horas); até lá, o
   endereço direto do Cloud Run (`terraform output admin`, `run_url`) abre a mesma tela.
4. **GitHub:** acrescente `CP_ADMIN_SERVICE = cp-admin` às variáveis do environment `control-plane`
   (`terraform output github_environment`) e rode o workflow "Plano de controle" (Actions → Run workflow). Sem essa
   variável, o workflow implanta só o `cp-public` e o `cp-worker`.
5. **Limite por IP atrás do Hosting:** o console conta as tentativas por IP pelo mesmo critério do `cp-public`
   (`TRUST_PROXY_HOPS` e `TRUSTED_PROXIES`; o cabeçalho `Fastly-Client-IP` não é usado, porque quem chama o `run.app`
   direto o forjaria). Sem `TRUSTED_PROXIES` em `service_env` (as saídas do Hosting), quem chega pelo Hosting aparece
   com o IP da saída do Hosting e as tentativas de pessoas diferentes se juntam num balde só: nada fica mais fraco (o
   bloqueio por e-mail continua), mas um robô pode fazer o limite por IP recusar você por alguns minutos. As variáveis
   de `service_env` vão também para o `cp-admin` (só essas duas).

### Migração de um console que estava atrás do IAP

O app novo não lê mais `IAP_AUDIENCE` e exige `ADMIN_SECRETS_PROJECT_ID`, que só o Terraform põe. Nesta ordem, o
console nunca fica aberto (no máximo fica fechado, respondendo 401, por alguns minutos):

1. Faça o merge. O workflow implanta a imagem nova; a revisão candidata do `cp-admin` não sobe (falta
   `ADMIN_SECRETS_PROJECT_ID`) ou não passa no `/health` (o IAP ainda está ligado), e o workflow para sem promover
   nada: os três serviços continuam na revisão anterior.
2. Grave os dois segredos (item 1 acima; o `apply` do passo seguinte cria os cofres, então grave-os logo depois dele)
   e rode o `terraform apply`: o IAP sai do `cp-admin`, a invocação passa a anônima, o site `verax-admin` e o domínio
   nascem, e o serviço ganha uma revisão nova com a imagem nova e as variáveis novas. O tráfego continua na revisão
   antiga, que ainda exige o JWT do IAP: sem o IAP, ela recusa tudo (401).
3. Crie os registros de DNS (item 3) e rode o workflow de novo (Actions → Run workflow): agora o `/health` do
   `cp-admin` responde, e os três serviços são promovidos.
4. Faça o cadastro (seção 2.1).

Se o `apply` do passo 2 falhar no `cp-admin` porque a revisão nova não subiu (a imagem do serviço ainda era a antiga),
rode o workflow (ele implanta a imagem nova, já com as variáveis novas) e o `apply` de novo.

Depois que o console novo estiver no ar, o que era só do IAP pode ser apagado à mão no console da GCP do projeto:

- o **cliente OAuth do IAP** (APIs e serviços → Credenciais) e, se ela só servia a ele, a **tela de consentimento
  OAuth**;
- a **API do IAP** (`iap.googleapis.com`): o Terraform a ligou com `disable_on_destroy = false`, então ela continua
  ligada depois do `apply`; desligue-a em APIs e serviços se nada mais a usa. Não confunda com o SSH dos nós pelo túnel
  do IAP (`gcloud compute ssh --tunnel-through-iap`), que é outro uso e continua.

## 2. Entrar no console

```bash
terraform output admin   # url (https://admin.veraxsistemas.com.br), run_url, site_id
```

### 2.1. O primeiro cadastro (uma vez)

1. Abra **https://admin.veraxsistemas.com.br/configurar**.
2. Informe o **token** que você gravou em `cp-admin-setup-token`, o seu **e-mail** (um de `owner_principals`) e uma
   **senha** com 12 caracteres ou mais (`autocomplete` de senha nova: o gerenciador de senhas sugere uma).
3. Escaneie o **QR code** com o aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password,
   Bitwarden...). O QR é gerado no próprio navegador, sem serviço externo; a chave em texto aparece ao lado para quem
   preferir digitar.
4. Digite o **código de 6 dígitos** que o aplicativo mostra para confirmar.
5. Guarde os **10 códigos de recuperação** (cada um vale uma vez, para entrar sem o celular). Eles aparecem **só
   agora**: copie para o gerenciador de senhas ou imprima. Você já entra no console.
6. A tela `/configurar` se fecha sozinha (o cadastro grava um marcador no Firestore, `adminSetup/owner`). Desative a
   versão do token mesmo assim (ele não é montado, então nada depende dela):

   ```bash
   gcloud secrets versions list cp-admin-setup-token --project=SEU_PROJETO
   gcloud secrets versions disable <NÚMERO> --secret=cp-admin-setup-token --project=SEU_PROJETO
   # ou, sem volta: gcloud secrets versions destroy <NÚMERO> --secret=cp-admin-setup-token --project=SEU_PROJETO
   ```

Só existe um cadastro: só o primeiro e-mail de `owner_principals` que se cadastrar tem conta no console.

### 2.2. No dia a dia

Abra **https://admin.veraxsistemas.com.br** (sem sessão, vai para `/entrar`): e-mail, senha e o código do aplicativo.
O cabeçalho mostra o e-mail da sessão e o botão **Sair**. Depois de 30 minutos sem uso (ou 12 horas do login), o
console pede o login de novo.

| O que aparece                                                 | Causa provável                                                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "E-mail, senha ou código incorretos..." (a mensagem genérica) | E-mail, senha ou código errados; o código já usado (espere o próximo); o relógio do celular adiantado ou atrasado; ou o e-mail bloqueado por 15 minutos (seção 2.4). |
| "Muitas tentativas. Tente novamente mais tarde."              | O limite por IP (seção 1, item 5). Espere alguns minutos.                                                                                                            |
| Login e cadastro "indisponíveis"                              | Os segredos `cp-admin-totp-key` ou `cp-admin-setup-token` sem versão ativa, ou a conta `cp-admin` sem a leitura deles (rode o `apply`).                              |
| O e-mail certo não entra nunca                                | O e-mail saiu de `owner_principals` (o console confere a lista a cada login e a cada requisição).                                                                    |
| Volta sempre para `/entrar`                                   | A sessão venceu (30 minutos sem uso, 12 h do login), você saiu em outra aba, ou a senha foi trocada em outra sessão.                                                 |
| Certificado inválido em admin.veraxsistemas.com.br            | O DNS (seção 1, item 3) ainda não foi visto pelo Firebase. Use o `run_url` enquanto isso.                                                                            |

### 2.3. Perdi o celular (tenho os códigos de recuperação)

1. Em `/entrar`, escolha **Usar um código de recuperação** e entre com o e-mail, a senha e um dos códigos (ele deixa
   de valer).
2. Em **Conta → Trocar o aplicativo autenticador**: confirme com a senha e outro código de recuperação, escaneie o QR
   novo no celular novo e confirme com o código dele. Saem 10 códigos de recuperação **novos** (os antigos deixam de
   valer): guarde-os.

Restando poucos códigos, faça a troca do aplicativo mesmo sem perder o celular: ela gera 10 novos.

### 2.4. Bloqueio

O bloqueio cai sozinho 15 minutos depois da quinta tentativa errada. Para liberar antes (depois de confirmar nos logs
do `cp-admin` que era você): no console da GCP, Firestore → coleção `adminLoginThrottle`, apague o documento (o id é o
SHA-256, em hexadecimal, de `login:<e-mail em minúsculas>`; com uma conta só, pode apagar a coleção inteira). Se não
foi você, troque a senha assim que entrar (Conta → Trocar a senha), o que encerra as outras sessões.

### 2.5. Cadastro de emergência (sem o celular e sem os códigos, ou com a chave trocada)

Só quem tem acesso ao projeto da GCP faz isto; o console não tem como se reabrir sozinho.

1. No console da GCP, Firestore: apague o documento da coleção `adminAccounts`, o documento `adminSetup/owner` e os
   documentos da coleção `adminSessions` (as sessões abertas).
2. Grave uma versão nova de `cp-admin-setup-token` (seção 1, item 1).
3. Faça o cadastro de novo em `/configurar` (seção 2.1) e desative a versão do token.

Para encerrar todas as sessões sem refazer o cadastro (um computador perdido com o console aberto), basta apagar os
documentos de `adminSessions`.

## 3. Primeira publicação: o modelo de custos

A tabela de preços não publica sem um modelo de custos vigente (a checagem precisa dele). Então, nesta ordem:

1. **Modelos de custo → Novo rascunho.** Na primeira vez, o ponto de partida é "Em branco (só a forma)". Se você já
   tem os números num arquivo JSON seu (fora do repositório), use "Importar um arquivo JSON": serve o exportado de
   uma versão (`{ "version", "content" }`) ou só o conteúdo.
2. Preencha cada seção. Dinheiro em reais (a API guarda em centavos), percentuais em % (a API guarda entre 0 e 1),
   custos de nuvem em dólares. A tabela "Custo do nó por porte" recalcula a cada tecla.
3. **Criar rascunho.** A API valida tudo: cada problema aparece ao lado do campo (e num resumo no alto, com um botão
   que leva o foco até ele). Corrija e crie de novo.
4. Na versão criada: **Salvar rascunho** a cada ajuste; **Exportar JSON** para guardar uma cópia fora do repositório.
5. **Publicar…** → **Confirmar a publicação.** O modelo vale na hora. Com uma tabela de preços vigente, o console
   mostra a checagem dela com o modelo novo; se alguma configuração ficar abaixo da margem mínima, o alerta
   `pricing_margin_alert` vai para o e-mail de alertas (a tabela não muda sozinha: veja a seção 6).

## 4. Primeira publicação: a tabela de preços

1. **Tabelas de preço → Novo rascunho** (em branco, ou a importação do seu arquivo). Preencha a regra de porte (do
   menor para o maior), o preço de cada porte em cada modo, os componentes e os pacotes de partida. Cada preço tem o
   `lookup_key` do preço na Stripe.
2. **Criar rascunho**, corrija o que a API apontar, **Salvar rascunho**.
3. **Conferir.** A checagem percorre todas as configurações que a tabela vende, no cartão e na alíquota padrão do
   modelo, e mostra: aprovada ou reprovada; quantas configurações foram conferidas e quantas ficam sob consulta;
   quantas ficam abaixo da margem mínima (bloqueiam) e do alerta (só avisam); o "a partir de" de cada modo contra o
   menor preço da grade; as piores configurações; a pior de cada modo e de cada porte; o pior caso com as outras
   alíquotas e no boleto (só informação); e as quebras de monotonia (uma unidade a mais que baixa o preço). Dá para
   conferir com um rascunho de modelo de custos, para ver o efeito antes de publicá-lo.
4. Ajuste até a checagem aprovar. **Publicar…**, com a vigência (vazio = agora; uma data futura agenda a troca, no
   horário do seu navegador). A publicação roda a mesma checagem com o modelo vigente: reprovada, é recusada e o
   relatório aparece; aprovada, a versão anterior vira "Aposentada" na vigência da nova.
5. **Stripe:** monte o catálogo (fora do repositório) com os mesmos `lookup_key` e valores da tabela publicada e rode
   `apps/control-plane/scripts/stripe-setup.ts --catalog=<arquivo>` (simulação, depois `--apply`). A publicação não
   confere a Stripe: um `lookup_key` que falte lá deixa o checkout em 503 para as configurações que o usam, com o
   alerta `checkout_price_invalid` (nunca cobra diferente).

### Sem o console: `publicar-precos`

Para semear a primeira versão (ou com o console fora do ar), o `publicar-precos` faz o mesmo que as seções 3 e 4 pelo
mesmo código do console (validação, checagem da grade, vigência, aposentadoria da versão anterior e auditoria
`owner:<e-mail>`), lendo os arquivos `{ "version", "content" }` (o formato do "Exportar JSON"), que ficam **fora do
repositório**. Quem publica é o e-mail das credenciais padrão do Google (`gcloud auth application-default login`), que
precisa poder escrever no Firestore do projeto. Sem `--publicar` é só simulação: a checagem e, com `--projeto`, a
diferença para o que está no banco. O modelo de custos é publicado antes da tabela, e a checagem da tabela usa o
modelo que estará vigente na publicação dela (o do arquivo, se ele for publicado ou já for o vigente; senão, o vigente
no banco). Nada é gravado se a checagem reprovar, se a versão já estiver publicada com outro conteúdo ou se ela estiver
aposentada (não se republica uma aposentada); rodar de novo com o mesmo conteúdo não grava nada. Um rascunho que já
existe igual ao arquivo só é publicado na revisão conferida: editado no meio do caminho, a publicação é recusada
(`draft_changed`).

```bash
pnpm --filter @verax/control-plane build
node apps/control-plane/dist/cli/publicar-precos.js --custos=<custos.json> --tabela=<tabela.json> --projeto=<id>
node apps/control-plane/dist/cli/publicar-precos.js --custos=<custos.json> --tabela=<tabela.json> --projeto=<id> --publicar
```

`--vigencia=<ISO 8601 com fuso>` agenda a tabela; sem `--projeto`, só a validação e a checagem, sem ler o banco. O
alerta `pricing_margin_alert` não sai daqui (só do console): a saída avisa no lugar dele.

## 5. Como o "a partir de" chega ao site

- O "a partir de" de cada modo é o preço da **configuração mínima** da tabela vigente (o menor porte, só o incluído,
  suporte padrão), pelo mesmo motor da cotação. A checagem recusa a tabela se ele não for o menor preço da grade.
- O site lê `GET https://conta.veraxsistemas.com.br/v1/public/pricing` no navegador: o campo
  `startingAt.managed.monthly` (em centavos) e o resto da tabela pública (sem custo, margem nem `lookup_key`). A
  resposta fica até 5 minutos no cache do CDN do Hosting, então a mudança chega ao site em até 5 minutos depois da
  vigência.
- O texto de reserva do site (para quem navega sem JavaScript) e o JSON-LD ficam no repositório do site: quando o "a
  partir de" mudar, atualize-os lá.

## 6. Ajustes depois

- **Mudar um preço ou um custo:** versão publicada não muda. Na versão vigente, **Novo rascunho a partir desta
  versão**, ajuste, confira e publique. Uma tabela nova nunca muda assinatura existente (cada assinatura aponta para
  os preços da Stripe dela).
- **Voltar atrás:** não se republica uma versão aposentada; crie um rascunho a partir dela e publique.
- **Simulador de DRE:** a DRE por cliente e por mês de qualquer configuração (ou pacote de partida), com a tabela e o
  modelo vigentes ou qualquer versão, inclusive rascunhos; meio de pagamento, alíquota, desconto e clientes do
  rateio. A margem de contribuição sai marcada contra as metas do modelo (abaixo da mínima, abaixo do alerta ou dentro
  da meta), com a implantação à parte, os doze meses e, na nuvem do cliente, a estimativa da nuvem dele (fora da DRE).
- **Alerta "a tabela de preços vigente ficou abaixo da margem mínima"** (`pricing_margin_alert`): um modelo de custos
  publicado deixou alguma configuração abaixo da mínima. Confira a tabela vigente (Conferir) e publique uma ajustada,
  ou corrija o modelo.
- **Alerta "acessos recusados repetidos no console"** (`admin_auth_failed`, 5 ou mais em 10 minutos): tentativas de
  login ou de cadastro recusadas. Se não foi você, alguém está tentando entrar: o rótulo `reason` diz o quê
  (`unknown_account` e `not_owner` são e-mails que não são do console; `bad_password` com o seu e-mail é a senha sendo
  testada; `setup_token` é alguém tentando o cadastro). Os logs do `cp-admin` mostram o IP das requisições. Se a senha
  pode ter vazado, troque-a (Conta → Trocar a senha); o código do aplicativo continua exigido em todo login.
- **Alerta "login do console do responsável bloqueado"** (`admin_account_locked`): 5 tentativas erradas para um e-mail
  em 15 minutos. Veja a seção 2.4.

## 7. Clientes e contrato direto

A tela **Clientes** lista os clientes (os do site e os de contrato direto, os mais novos primeiro) com o estado, a
cobrança, onde o ambiente roda e, no provisionamento, o passo e o código de quem parou. O detalhe de um cliente mostra
o contratado e o preço, a linha do tempo dos passos do provisionamento (ou, no ambiente do cliente, o que mandar a ele
para instalar), o acesso do administrador (quando o e-mail saiu e quando a senha foi vista; nunca a senha), o ciclo de
vida e o histórico de estados. Enquanto o cliente provisiona, a página se atualiza sozinha.

**Pelo site, todo cliente roda na infraestrutura da Verax** (decisão de 06/11/2026: a calculadora e o checkout não
oferecem mais o ambiente na nuvem do cliente). O ambiente na infraestrutura do cliente existe **só por contrato
direto**, aqui. A tabela de preços continua com os preços dos dois modos: o simulador de DRE e a cotação de referência
do contrato direto usam os dois.

**Cadastrar um cliente de contrato direto** (um contrato negociado com você, sem o checkout do site e sem a Stripe):

1. **Clientes → Novo cliente (contrato direto).** Preencha a razão social, o CNPJ, o e-mail do administrador do cliente
   (o primeiro acesso ao painel) e o subdomínio.
2. **Onde o ambiente roda** (obrigatório, nada marcado de início):
   - **Infraestrutura da Verax:** o provisionamento de sempre (o nó e o painel na Verax, com custo de nuvem); o
     administrador recebe o e-mail com o link para ver a senha;
   - **Infraestrutura do cliente:** nada é criado na Verax; o cliente instala a versão publicada com o guia
     (`docs/runbooks/instalacao-no-cliente.md`) e apaga o próprio ambiente no fim do contrato.
3. As outras cinco respostas, como na calculadora do site, e **Calcular a cotação**: o preço de referência da tabela
   vigente no modo do lugar escolhido (o ambiente gerenciado na Verax; a licença, com a implantação dela, no cliente),
   o porte e, se houver, o que ainda não se cria (na Verax, hoje só porte P e sem agentes; no cliente, qualquer
   porte, mas sem agentes nas instâncias, que o guia de instalação ainda não cobre, e com os limites nas faixas do
   nó). O preço é só referência: a cobrança e a nota fiscal do contrato são suas, fora da Stripe.
4. **Revisar e confirmar…**, digite o subdomínio e **Criar e provisionar** (na Verax) ou **Criar o cliente** (no
   cliente). A API confere tudo de novo; um problema aparece ao lado do campo. Criado, o detalhe abre. Enviar duas
   vezes (clique duplo, conexão que caiu) não cria dois: é o mesmo cadastro.
5. **Na Verax**, o cliente vai a `provisioning`: acompanhe a linha do tempo. Pronto (`waiting_customer_connection`), o
   administrador do cliente recebe na hora o e-mail "ambiente pronto" com o link de uso único (24 h) para ver a senha
   temporária uma vez. Você não vê a senha nem o link; se o cliente não receber, confira o SMTP do `cp-worker` e, com
   o link vencido, o caminho de uma senha nova (`docs/runbooks/onboarding-cliente.md`, item 7).
6. **No cliente**, o cliente nasce "Aguardando instalação pelo cliente" (`waiting_customer_install`), sem linha do
   tempo. O detalhe mostra, em "Instalação na infraestrutura do cliente", o que mandar a ele: a versão do nó (a
   vigente, lida e conferida pelo `cp-worker` no bucket de releases), os endereços do manifesto assinado, da
   assinatura e do pacote, as imagens pelo digest, o guia de instalação, as linhas do plano no `node.conf` e a
   **impressão digital da chave que assinou**: mande a impressão digital por um canal do contrato (fora do GitHub),
   porque é ela que o cliente compara antes de confiar na primeira instalação. Se o painel disser que a versão não está
   configurada, confira `release_bucket` e `NODE_RELEASE` (`worker_env`) no GUIA, "O provisionamento (CP-07)". A Verax
   não vê a instalação do cliente: o estado fica "Aguardando instalação pelo cliente" até o fim do contrato.

Se o detalhe disser "Cliente criado, mas o provisionamento não começou", o console não alcançou o `cp-worker` (a
entrada dele, GUIA, "Operações do responsável no `cp-worker`"): corrija e use **Iniciar provisionamento…**.

**As operações do responsável** (cada uma pede o subdomínio do cliente digitado, e a API e o `cp-worker` conferem de
novo):

| Botão                   | Quando aparece                                                     | O que faz                                                                                                          |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Iniciar provisionamento | Contrato direto na Verax em `pending`                              | O `provision` no `cp-worker`: `provisioning` e o primeiro passo na fila                                            |
| Retomar provisionamento | `provisioning_failed` ou parado em `provisioning`                  | Uma execução nova do `preflight` (`docs/runbooks/provisionamento.md`)                                              |
| Suspender / Reativar    | Contrato direto ativo (ou esperando o cliente) / suspenso por você | A VM para / volta ao estado de antes e a VM liga                                                                   |
| Cancelar contrato       | Contrato direto vivo                                               | Agora, ou numa data (o fim do contrato, até 2 anos); cancelado: exportação por 30 dias, exclusão em D+30 e D+97    |
| Exportar dados          | Cliente cancelado, dentro de 30 dias                               | O link de 24 h de um backup (o nome vem do `gcloud storage ls`, `docs/runbooks/ciclo-de-vida.md`); aparece uma vez |
| Apagar agora            | Cliente cancelado (ou uma exclusão que parou)                      | A Exclusão 1 agora, sem volta (`docs/runbooks/ciclo-de-vida.md`)                                                   |

Num cliente da Stripe, suspender, reativar e cancelar seguem a assinatura (Portal do cliente ou Dashboard da Stripe); o
console não os oferece. **Com o ambiente no cliente**, só **Cancelar contrato** e, depois, **Apagar agora**: cancelar
registra o fim do contrato (sem exportação, sem parar VM nenhuma) e apagar remove só o cadastro na Verax (o e-mail do
administrador e o acesso), com o registro de exclusão ao administrador dizendo que o ambiente é dele e que quem apaga é
ele. Iniciar, retomar, suspender, reativar e exportar não existem para ele, e o `cp-worker` recusa de novo
(`customer_hosted`) se pedirem. Os limites: 5 cadastros e 20 operações por hora por responsável.

Tudo o que se grava no console vai à auditoria (`auditLog`) como `owner:<e-mail>`: rascunho criado e editado (com a
diferença), publicação (com o resumo da checagem), aposentadoria e publicação recusada; o cadastro de um cliente, cada
pedido ao `cp-worker` com o desfecho (`tenant.console_request`) e cada recusa.
