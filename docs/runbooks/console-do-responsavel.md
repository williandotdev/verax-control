# Console do responsável (`cp-admin`)

O console é onde o responsável mantém o preço do Verax Control (por volume de logs em GB/dia, em três planos:
Plataforma, Dedicado e vCISO): o **modelo de custos** (câmbio, a célula compartilhada e o nó por porte, ingestão,
tarifas, impostos, horas de suporte, custos fixos e as metas de margem), a **tabela de preços** (os planos, a regra de
porte por GB/dia, o imposto embutido ou por cima, e o preço e o `lookup_key` da Stripe de cada componente), o
**simulador de DRE**, os **clientes** (a lista, a linha do tempo do provisionamento, o cadastro de um contrato direto
e as operações do responsável) e os **textos legais** que o cliente aceita no checkout (Termos de uso, Política de
privacidade e DPA, seção 8). Os números vivem
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
- **Bloqueio:** 5 tentativas com a **senha certa e o código errado** em 15 minutos bloqueiam o login daquele e-mail por
  15 minutos (o alerta "login do console do responsável bloqueado" avisa). A senha errada não bloqueia a conta (o
  e-mail do responsável é público, e ninguém deve conseguir trancá-lo do lado de fora só com ele): ela conta nos
  limites de falhas por IP e no total (seção 1, item 5). Na troca de senha e do aplicativo, que já exigem uma sessão,
  toda tentativa errada conta no bloqueio.
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
5. **Limite por IP atrás do Hosting:** no console, `TRUSTED_PROXIES` fica **vazia, de propósito** (o Terraform não
   repassa a de `service_env`, que é do `cp-public`). Listar as saídas da CDN do Hosting (Fastly) deixaria qualquer um
   com um serviço na mesma CDN chamar o `run.app` direto com um `X-Forwarded-For` escolhido e escapar do limite; o
   cabeçalho `Fastly-Client-IP` também não é usado, pelo mesmo motivo. Sem a lista, quem chega pelo Hosting conta no
   balde da saída do Hosting, e quem chama o `run.app` direto, no do próprio IP. Os limites só contam **falhas** (um
   login certo devolve a tentativa, e um pedido malformado nem conta): 10 por IP e 100 no total a cada 15 minutos. O
   que segura a adivinhação do segundo fator é o bloqueio da conta, que só a senha certa aciona (seção 2.4).

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

O bloqueio cai sozinho 15 minutos depois da quinta tentativa errada com a senha certa (ou da quinta tentativa errada
na troca de senha ou de aplicativo). Quem o aciona sabe a senha: se não foi você, troque-a. Para liberar antes (depois de confirmar nos logs
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
   custos de nuvem em dólares. As seções do modelo por GB/dia:
   - **Célula compartilhada (Plataforma):** a máquina (VM, disco, snapshots), a **capacidade em GB/dia** (quanto volume
     a célula aguenta; confirme com um teste de carga) e o custo fixo de cada cliente nela. O console mostra o custo da
     célula e o **custo por GB/dia** (custo ÷ capacidade), que é o que a Plataforma paga por GB/dia contratado.
   - **Nó dedicado por porte** (Dedicado e vCISO na Verax) e os itens comuns (disco, snapshot, NAT, IP, outros) e a
     **ingestão por GB/dia** (por mês). A tabela "Custo do nó por porte" recalcula a cada tecla.
   - **Horas de suporte** por mês e por cliente: Plataforma, Dedicado, o **serviço do vCISO em horas equivalentes**
     (somadas às do Dedicado) e as a mais com o ambiente na infraestrutura do cliente; e as da implantação.
   - Tarifas, alíquotas, reserva, custos fixos com o rateio e as margens mínima e de alerta, como antes.
3. **Criar rascunho.** A API valida tudo: cada problema aparece ao lado do campo (e num resumo no alto, com um botão
   que leva o foco até ele). Corrija e crie de novo.
4. Na versão criada: **Salvar rascunho** a cada ajuste; **Exportar JSON** para guardar uma cópia fora do repositório.
5. **Publicar…** → **Confirmar a publicação.** O modelo vale na hora. Com uma tabela de preços vigente, o console
   mostra a checagem dela com o modelo novo; se alguma configuração ficar abaixo da margem mínima, o alerta
   `pricing_margin_alert` vai para o e-mail de alertas (a tabela não muda sozinha: veja a seção 6).

## 4. Primeira publicação: a tabela de preços

1. **Tabelas de preço → Novo rascunho** (em branco, ou a importação do seu arquivo). Preencha:
   - **Imposto:** embutido nos valores, ou **por cima** (o "+ impostos": os valores são sem imposto e a DRE soma o
     imposto à receita bruta).
   - **Regra de porte:** o maior GB/dia de cada porte, do menor para o maior (o porte do nó sai do volume contratado).
   - **Plataforma:** a base mensal e os GB/dia incluídos nela, o preço do **GB/dia adicional** (a franquia contratada
     acima do incluído vira a quantidade desse item na assinatura), o do **GB/dia excedente** (cobrado depois, pela
     medição; nunca mais barato que o adicional), o **máximo do site** (acima, "fale conosco") e o teto de contas de
     nuvem do nó (não muda o preço).
   - **Dedicado:** o preço por GB/dia, o mínimo e o máximo cotáveis, a duração do contrato e o teto de contas.
   - **vCISO:** o serviço mensal e a implantação (cobrada uma vez); o GB/dia, o mínimo e o máximo são os do Dedicado.
   - O histórico incluído e o máximo de usuários.
     Cada preço tem o `lookup_key` do preço na Stripe.
2. **Criar rascunho**, corrija o que a API apontar, **Salvar rascunho**.
3. **Conferir.** A checagem percorre cada GB/dia que a tabela vende (a Plataforma do incluído ao máximo do site; o
   Dedicado e o vCISO do mínimo ao máximo, na Verax e no cliente), no cartão e na alíquota padrão do modelo, e mostra:
   aprovada ou reprovada; quantas configurações foram conferidas e quantas ficam sob consulta; quantas ficam abaixo
   da margem mínima (bloqueiam) e do alerta (só avisam); o "a partir de" de cada plano contra o menor preço dele; as
   piores configurações; a pior de cada plano e de cada lugar; o pior caso com as outras alíquotas e no boleto (só
   informação); e as quebras de monotonia (um GB/dia a mais que baixa o preço). Também reprova se o site oferecer um
   volume que não cota ou que o provisionamento ainda não cria (hoje, só o porte P na Verax) e se o excedente for
   mais barato que o GB/dia contratado. Dá para conferir com um rascunho de modelo de custos, para ver o efeito antes
   de publicá-lo.
4. Ajuste até a checagem aprovar. **Publicar…**, com a vigência (vazio = agora; uma data futura agenda a troca, no
   horário do seu navegador). A publicação roda a mesma checagem com o modelo vigente: reprovada, é recusada e o
   relatório aparece; aprovada, a versão anterior vira "Aposentada" na vigência da nova.
5. **Stripe:** monte o catálogo (fora do repositório) com os mesmos `lookup_key` e valores da tabela publicada e rode
   `apps/control-plane/scripts/stripe-setup.ts --catalog=<arquivo>` (simulação, depois `--apply`). A publicação não
   confere a Stripe: um `lookup_key` que falte lá deixa o checkout em 503 para as configurações que o usam, com o
   alerta `checkout_price_invalid` (nunca cobra diferente). O checkout usa só a base e o GB/dia adicional da
   Plataforma; os do excedente, do Dedicado e do vCISO ficam no catálogo para a cobrança do excedente e para faturar
   contratos.
6. **Imposto por cima** (tabela "sem impostos", o "+ impostos"): o checkout só cobra o imposto com uma alíquota de
   imposto da Stripe. Antes de publicar uma tabela assim:
   1. rode `stripe-setup.ts --tax-rate-percent=<n>` (o percentual da alíquota padrão do modelo de custos; simulação,
      depois `--apply`): ele acha ou cria a alíquota exclusiva "Impostos" e imprime `STRIPE_TAX_RATE_ID=txr_...`;
   2. ponha esse id em `service_env` do `envs/control-plane` (`STRIPE_TAX_RATE_ID`, que vai ao `cp-public` e ao
      `cp-admin`) e aplique;
   3. sem ela, a checagem e a publicação de uma tabela sem impostos são recusadas ("a alíquota da Stripe que o cobra
      não está configurada no serviço"). No `publicar-precos`, informe o mesmo id com `--aliquota-stripe=txr_...`.

   A cada sessão, o checkout relê a alíquota e confere que está ativa, exclusiva e com o percentual da alíquota padrão
   do modelo de custos vigente; senão, o checkout fica em 503 (`checkout_tax_rate_invalid` no log, com o motivo).
   **Mudar a alíquota padrão do modelo de custos exige uma alíquota nova na Stripe** (a da Stripe não muda de
   percentual): rode o `stripe-setup` com o percentual novo, troque `STRIPE_TAX_RATE_ID` e só então publique o modelo,
   ou o checkout para até a troca.

**A troca do modelo de preço (10/11/2026).** As versões publicadas antes dela (portes, componentes e contas de nuvem,
até `2026-11-v1`) não passam no formato novo: aparecem na lista como **Modelo anterior**, não abrem, não servem de
base para um rascunho nem para a checagem ou o simulador e **nunca são a vigente**. Enquanto a vigente for uma delas,
o site responde 503 (sem preço) e o contrato direto pede uma tabela: publique o modelo de custos e a tabela no formato
novo (pelo console ou pelo `publicar-precos`), e a primeira versão nova aposenta a antiga. Um cliente contratado no
modelo anterior continua legível, com o contratado de antes marcado como "modelo anterior".

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

Antes de abrir o checkout, publique também os três **textos legais** (seção 8): sem uma versão publicada de cada um,
o checkout responde 503 `checkout_unavailable`, mesmo com a tabela e a Stripe prontas.

## 5. Como o "a partir de" chega ao site

- O "a partir de" de cada plano é o preço da **configuração mínima** dele na tabela vigente (a Plataforma com os
  GB/dia incluídos; o Dedicado e o vCISO no mínimo), pelo mesmo motor da cotação. A checagem recusa a tabela se ele não
  for o menor preço do plano.
- O site lê `GET https://conta.veraxsistemas.com.br/v1/public/pricing` no navegador: `startingAt.<plano>.monthly` (em
  centavos), `taxMode` (`exclusive` é o "+ impostos") e o resto da tabela pública (os três planos, os incluídos, os
  preços unitários, os mínimos e o máximo do site; sem custo, margem nem `lookup_key`). A resposta fica até 5 minutos
  no cache do CDN do Hosting, então a mudança chega ao site em até 5 minutos depois da vigência.
- A cotação do site (`POST /v1/public/quote`) aceita só `{ "plan": "plataforma", "gbDay": N }`; o Dedicado e o
  vCISO respondem 422 `plan_not_sold_online` (a mensagem leva à proposta e ao contrato direto).
- O texto de reserva do site (para quem navega sem JavaScript) e o JSON-LD ficam no repositório do site: quando o "a
  partir de" mudar, atualize-os lá.

## 6. Ajustes depois

- **Mudar um preço ou um custo:** versão publicada não muda. Na versão vigente, **Novo rascunho a partir desta
  versão**, ajuste, confira e publique. Uma tabela nova nunca muda assinatura existente (cada assinatura aponta para
  os preços da Stripe dela).
- **Voltar atrás:** não se republica uma versão aposentada; crie um rascunho a partir dela e publique.
- **Simulador de DRE:** a DRE por cliente e por mês de um plano, um volume em GB/dia e um lugar (na Verax ou no
  cliente), com a tabela e o modelo vigentes ou qualquer versão, inclusive rascunhos; meio de pagamento, alíquota,
  desconto e clientes do rateio. Com o imposto por cima, a DRE mostra o valor da tabela e a receita bruta (o valor ÷
  (1 − alíquota)). A infraestrutura é o rateio da célula na Plataforma e o nó do porte no Dedicado e no vCISO. A
  margem de contribuição sai marcada contra as metas do modelo (abaixo da mínima, abaixo do alerta ou dentro da meta),
  com a implantação à parte, os doze meses e, na infraestrutura do cliente, a estimativa da nuvem dele (fora da DRE).
- **Alerta "a tabela de preços vigente ficou abaixo da margem mínima"** (`pricing_margin_alert`): um modelo de custos
  publicado deixou alguma configuração abaixo da mínima. Confira a tabela vigente (Conferir) e publique uma ajustada,
  ou corrija o modelo.
- **Alerta "acessos recusados repetidos no console"** (`admin_auth_failed`, 5 ou mais em 10 minutos): tentativas de
  login ou de cadastro recusadas. Se não foi você, alguém está tentando entrar: o rótulo `reason` diz o quê
  (`unknown_account` e `not_owner` são e-mails que não são do console; `bad_password` com o seu e-mail é a senha sendo
  testada; `setup_token` é alguém tentando o cadastro). Os logs do `cp-admin` mostram o IP das requisições. Se a senha
  pode ter vazado, troque-a (Conta → Trocar a senha); o código do aplicativo continua exigido em todo login.
- **Alerta "login do console do responsável bloqueado"** (`admin_account_locked`): 5 tentativas com a senha certa e o
  código errado em 15 minutos. Se não foi você, **a senha vazou**: troque-a já (seção 2.4).

## 7. Clientes e contrato direto

A tela **Clientes** lista os clientes (os do site e os de contrato direto, os mais novos primeiro) com o estado, a
cobrança, onde o ambiente roda e, no provisionamento, o passo e o código de quem parou. O detalhe de um cliente mostra
o contratado e o preço, a linha do tempo dos passos do provisionamento (ou, no ambiente do cliente, o que mandar a ele
para instalar), o acesso do administrador (quando o e-mail saiu e quando a senha foi vista; nunca a senha), o ciclo de
vida e o histórico de estados. Enquanto o cliente provisiona, a página se atualiza sozinha.

**Pelo site, só a Plataforma, na infraestrutura da Verax** (decisões de 06/11/2026 e 10/11/2026). O Dedicado, o vCISO
e o ambiente na infraestrutura do cliente existem **só por contrato direto**, aqui. O preço por GB/dia é o mesmo nos
dois lugares (no cliente, a Verax não paga a nuvem, e a DRE mostra isso); a Plataforma é a célula da Verax e nunca
roda no cliente.

**Cadastrar um cliente de contrato direto** (um contrato negociado com você, sem o checkout do site e sem a Stripe):

1. **Clientes → Novo cliente (contrato direto).** Preencha a razão social, o CNPJ, o e-mail do administrador do cliente
   (o primeiro acesso ao painel) e o subdomínio.
2. **Onde o ambiente roda** (obrigatório, nada marcado de início):
   - **Infraestrutura da Verax:** o provisionamento de sempre (o nó e o painel na Verax, com custo de nuvem); o
     administrador recebe o e-mail com o link para ver a senha;
   - **Infraestrutura do cliente:** nada é criado na Verax; o cliente instala a versão publicada com o guia
     (`docs/runbooks/instalacao-no-cliente.md`) e apaga o próprio ambiente no fim do contrato.
3. O **plano** (Plataforma, Dedicado ou vCISO) e o **volume em GB/dia**, e **Calcular a cotação**: o preço de
   referência da tabela vigente (abaixo do mínimo do plano, o volume sobe até ele), o porte que o volume pede e, se
   houver, o que ainda não se cria (na Verax, hoje só o porte P; no cliente, qualquer porte, com os limites nas faixas
   do nó). A Plataforma no cliente é recusada (sob consulta, com o motivo no plano). O preço é só referência: a
   cobrança e a nota fiscal do contrato são suas, fora da Stripe.
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

## 8. Textos legais (Termos, Privacidade e DPA)

Os três textos que o cliente aceita no checkout vivem no Firestore (`legalTexts/{terms|privacy|dpa}/versions`), em
Markdown, versionados como as tabelas de preço: **rascunho** (editável) e **publicada** (imutável; a mais recente é a
vigente). O site mostra a vigente de cada um em `/termos`, `/privacidade` e `/dpa`, lendo
`GET https://conta.veraxsistemas.com.br/v1/public/legal/{terms|privacy|dpa}` (o índice das vigentes, sem o texto, em
`GET .../v1/public/legal`; uma versão antiga pelo nome em `.../legal/{tipo}/{versão}`). O checkout exige que o aceite do
site traga as três versões vigentes (outra versão: 409 `terms_outdated`, e o site recarrega) e grava na reserva e na
Stripe as versões aceitas. As versões não são mais variáveis de ambiente (`TERMS_VERSION`, `PRIVACY_VERSION` e
`DPA_VERSION` saíram): uma que tenha ficado no `service_env` é ignorada, e pode sair dele.

**Primeira publicação (antes de abrir o checkout):**

1. **Textos legais.** A tela mostra os três, cada um com as versões e o aviso "Nenhuma versão publicada" no que falta.
   Enquanto faltar algum, o checkout fica fechado (503 `checkout_unavailable`, com o log
   `checkout_legal_texts_missing` dizendo qual).
2. Em cada texto, **Novo rascunho**: a versão (sugerida pelo dia de hoje, `AAAA-MM-DD`; é o que o cliente vê no aceite
   do Checkout) e o ponto de partida (a cópia da vigente, outra versão ou em branco). **Criar rascunho.**
3. No rascunho, cole o texto ou use **Importar .md** (o arquivo da minuta ou o revisado pelo advogado, até 100 KB),
   confira a **Prévia** ao lado e **Salvar rascunho**. A prévia mostra o Markdown básico (títulos, parágrafos, listas,
   negrito, itálico e links); o site desenha o mesmo texto com o estilo dele. Se outra aba ou pessoa gravou o rascunho depois
   que você o abriu, a gravação é recusada (`draft_changed`): **Recarregar o rascunho salvo** e refaça.
4. **Publicar…**, digite a versão e **Confirmar a publicação.** Publicada, a versão não muda mais e vira a vigente na
   hora; o site a mostra em até 5 minutos (o cache do CDN).
5. Repita para os outros dois. Com os três publicados, o aviso some e o checkout abre (se o resto da configuração
   estiver pronto).

**Depois:**

- **Revisão do advogado ou qualquer mudança:** na vigente, **Novo rascunho a partir desta versão** (ou **Exportar
  .md**, mande o arquivo, e importe a revisão no rascunho), salve e publique. A nova vale para quem comprar dali em
  diante; quem já é cliente continua com a versão que aceitou (gravada no cadastro dele), e a anterior continua legível
  no site pela versão. Se a mudança exigir um aviso ou um novo aceite dos clientes atuais, isso é fora do console (e-mail).
- **Durante uma publicação, um checkout em andamento** que mandou a versão anterior recebe 409 `terms_outdated` e o site
  pede o aceite da nova. Por causa do cache de 5 minutos do site, publique fora do horário de movimento.
- **Histórico** (em cada texto): quem criou, editou e publicou cada versão e quando, o tamanho e o SHA-256 do texto
  publicado (a prova do que foi aceito). O texto não vai à auditoria; ele fica na própria versão, que não muda.
