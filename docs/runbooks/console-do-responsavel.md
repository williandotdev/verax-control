# Console do responsável (`cp-admin`)

O console é onde o responsável mantém o preço configurável do Verax Control: o **modelo de custos** (câmbio, nuvem por
porte, tarifas, impostos, suporte, custos fixos e as metas de margem), a **tabela de preços** (regra de porte, preço e
`lookup_key` da Stripe de cada componente, pacotes de partida), o **simulador de DRE** e os **clientes** (a lista, a
linha do tempo do provisionamento, o cadastro de um contrato direto e as operações do responsável). Os números vivem
só no Firestore do plano de controle; o repositório (público) não tem nenhum, e o console também não: ele só mostra o
que a API devolve.

O console é o serviço `cp-admin` do Cloud Run: a mesma imagem do plano de controle, com `ROLE=admin`, que serve as
telas (`apps/console`) e a API `/v1/admin/...` na mesma origem, atrás do IAP ligado direto no serviço. Só quem está em
`owner_principals` passa pelo IAP, e o app confere de novo, em toda requisição (inclusive nas telas), o JWT que o IAP
assina.

## 1. Ligar o console (uma vez)

1. **Cliente OAuth do IAP (só se o projeto não tiver organização).** Com uma conta de fora de uma organização do
   Google Workspace (um Gmail, por exemplo), o IAP precisa de um cliente OAuth próprio, e ele não se cria por API.
   No console da GCP do projeto do plano de controle: APIs e serviços → Tela de consentimento OAuth (tipo "Externo",
   com você como usuário de teste) → Credenciais → Criar ID do cliente OAuth, tipo "Aplicativo da Web", com o URI de
   redirecionamento `https://iap.googleapis.com/v1/oauth/clientIds/<ID_DO_CLIENTE>:handleRedirect`. Depois, aponte o
   IAP para ele, sem o segredo passar pelo Terraform nem pelo histórico do shell:

   ```bash
   arquivo="${TMPDIR:-/tmp}/iap_settings.yaml"
   read -rs SEGREDO && printf 'access_settings:\n  oauth_settings:\n    client_id: %s\n    client_secret: %s\n' \
     "<ID_DO_CLIENTE>" "$SEGREDO" > "$arquivo" && unset SEGREDO
   gcloud iap settings set "$arquivo" --project=SEU_PROJETO
   rm "$arquivo"
   ```

   Num projeto de uma organização, com uma conta dela, o IAP usa o cliente gerenciado pelo Google e este passo não
   existe.

2. **Terraform** (`infra/gcp/envs/control-plane`, GUIA, passo 8): `owner_principals` com o seu `user:` e
   `admin_enabled = true` no `terraform.tfvars`, depois `terraform plan` e `terraform apply`. O plano cria 11 recursos,
   mais 1 por pessoa em `owner_principals`.
3. **GitHub:** acrescente `CP_ADMIN_SERVICE = cp-admin` às variáveis do environment `control-plane`
   (`terraform output github_environment`) e rode o workflow "Plano de controle" (Actions → Run workflow). Sem essa
   variável, o workflow implanta só o `cp-public` e o `cp-worker`.

## 2. Abrir o console

```bash
terraform output admin   # url (o endereço run.app do cp-admin) e iap_audience
```

Abra a `url` no navegador. O Google pede o login; o cabeçalho do console mostra o e-mail que o IAP confirmou. Se não
abrir:

| O que aparece                                        | Causa provável                                                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Página do Google "You don't have access"             | A conta não está em `owner_principals` (o IAP recusou antes do app).                                                              |
| Erro de OAuth no login                               | Projeto sem organização e sem o cliente OAuth do passo 1.                                                                         |
| `{"code":"unauthenticated"}` em JSON                 | O IAP está desligado no serviço ou o `IAP_AUDIENCE` não bate com o serviço (`terraform output admin`). O alerta de recusas avisa. |
| "Esta conta não é de um responsável pelo console"    | O e-mail passou pelo IAP mas não está em `OWNER_PRINCIPALS` (as duas listas saem de `owner_principals`: rode o `apply`).          |
| "Sua sessão no Google terminou. Recarregue a página" | A sessão do IAP venceu: recarregue e entre de novo.                                                                               |

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
diferença para o que está no banco. O modelo de custos é publicado antes da tabela; nada é gravado se a checagem
reprovar ou se a versão já estiver publicada com outro conteúdo; rodar de novo com o mesmo conteúdo não grava nada.

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
- **Alerta "acessos recusados repetidos no console"** (`admin_auth_failed`, 3 ou mais em 10 minutos): atrás do IAP,
  isso não acontece no uso normal. Confira se o IAP continua ligado no `cp-admin`, se o `IAP_AUDIENCE` bate com
  `terraform output admin` e quem tem acesso ao IAP do serviço.

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
