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
cobrança e, no provisionamento, o passo e o código de quem parou. O detalhe de um cliente mostra o contratado e o preço,
a linha do tempo dos dez passos do provisionamento, o acesso do administrador (quando o e-mail saiu e quando a senha foi
vista; nunca a senha), o ciclo de vida e o histórico de estados. Enquanto o cliente provisiona, a página se atualiza
sozinha.

**Cadastrar um cliente de contrato direto** (um contrato negociado com você, sem o checkout do site e sem a Stripe):

1. **Clientes → Novo cliente (contrato direto).** Preencha a razão social, o CNPJ, o e-mail do administrador do cliente
   (o primeiro acesso ao painel; é ele que recebe o e-mail com o link para ver a senha) e o subdomínio.
2. As seis respostas, como na calculadora do site, e **Calcular a cotação**: o preço de referência da tabela vigente,
   o porte e, se houver, o que o provisionamento ainda não cria (hoje só o modo gerenciado, porte P, sem agentes). O
   preço é só referência: a cobrança e a nota fiscal do contrato são suas, fora da Stripe.
3. **Revisar e confirmar…**, digite o subdomínio e **Criar e provisionar**. A API confere tudo de novo; um problema
   aparece ao lado do campo. Criado, o cliente vai a `provisioning` e o detalhe abre. Enviar duas vezes (clique duplo,
   conexão que caiu) não cria dois: é o mesmo cadastro.
4. Acompanhe a linha do tempo. Pronto (`waiting_customer_connection`), o administrador do cliente recebe na hora o
   e-mail "ambiente pronto" com o link de uso único (24 h) para ver a senha temporária uma vez. Você não vê a senha nem o
   link; se o cliente não receber, confira o SMTP do `cp-worker` e, com o link vencido, o caminho de uma senha nova
   (`docs/runbooks/onboarding-cliente.md`, item 7).

Se o detalhe disser "Cliente criado, mas o provisionamento não começou", o console não alcançou o `cp-worker` (a
entrada dele, GUIA, "Operações do responsável no `cp-worker`"): corrija e use **Iniciar provisionamento…**.

**As operações do responsável** (cada uma pede o subdomínio do cliente digitado, e a API e o `cp-worker` conferem de
novo):

| Botão                   | Quando aparece                                                     | O que faz                                                                                                          |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Iniciar provisionamento | Contrato direto em `pending`                                       | O `provision` no `cp-worker`: `provisioning` e o primeiro passo na fila                                            |
| Retomar provisionamento | `provisioning_failed` ou parado em `provisioning`                  | Uma execução nova do `preflight` (`docs/runbooks/provisionamento.md`)                                              |
| Suspender / Reativar    | Contrato direto ativo (ou esperando o cliente) / suspenso por você | A VM para / volta ao estado de antes e a VM liga                                                                   |
| Cancelar contrato       | Contrato direto vivo                                               | Agora, ou numa data (o fim do contrato, até 2 anos); cancelado: exportação por 30 dias, exclusão em D+30 e D+97    |
| Exportar dados          | Cliente cancelado, dentro de 30 dias                               | O link de 24 h de um backup (o nome vem do `gcloud storage ls`, `docs/runbooks/ciclo-de-vida.md`); aparece uma vez |
| Apagar agora            | Cliente cancelado (ou uma exclusão que parou)                      | A Exclusão 1 agora, sem volta (`docs/runbooks/ciclo-de-vida.md`)                                                   |

Num cliente da Stripe, suspender, reativar e cancelar seguem a assinatura (Portal do cliente ou Dashboard da Stripe); o
console não os oferece. Os limites: 5 cadastros e 20 operações por hora por responsável.

Tudo o que se grava no console vai à auditoria (`auditLog`) como `owner:<e-mail>`: rascunho criado e editado (com a
diferença), publicação (com o resumo da checagem), aposentadoria e publicação recusada; o cadastro de um cliente, cada
pedido ao `cp-worker` com o desfecho (`tenant.console_request`) e cada recusa.
