# Conectar com Cloudflare: registro do app e homologação

Roteiro para registrar o app OAuth da Verax no Cloudflare e conferir, num **nó de homologação** e numa **conta Cloudflare
de teste**, o que os testes do repositório não provam: eles usam um Cloudflare falso (`apps/api/test/support/`) e, no
painel, uma demonstração (`apps/web/src/mocks/cloudflare-oauth.ts`). O desenho e o que já está no código estão em
`docs/ARQUITETURA.md`, seção "Conectar com Cloudflare (OAuth, CF-1 a CF-9)". Cada conferência tem um número (HC-01 a
HC-22); anote o resultado na tabela do fim e copie o resumo em `docs/STATUS.md`.

> **Nunca rode este roteiro com a conta de um cliente.** Ele autoriza, revoga, nega e apaga de propósito. Use uma conta
> Cloudflare de teste da Verax, sem dado de cliente, e o nó de homologação, sem nenhum cliente de verdade. Os valores
> abaixo são fictícios (`appdeexemplo0001`, `cliente-demo`, `conta.exemplo.com.br`): troque pelos reais só no
> terminal e no console, e **não os escreva em nenhum arquivo do repositório**, nem o `client_id`.

## 1. Antes de começar

1. **Acesso de administrador (Super Administrator)** à conta Cloudflare da Verax, onde o app é registrado, e a uma
   segunda conta Cloudflare de teste (a "do cliente"), com uma ou duas zonas de teste. Para HC-08, uma terceira conta
   (ou um segundo membro na conta de teste) ajuda.
2. **O plano de controle no ar com a versão do CF-5** e o nó de homologação na versão do CF-4 e do CF-8, os dois
   juntos (o nó anuncia a capacidade e o painel tem a rota `/conexao-cloudflare`: nunca promover um sem o outro).
3. **A exclusão de log do caminho do retorno** (pendência de `infra/`, CF-6): o log de requisição do Cloud Run do
   `cp-public` grava a URL inteira, com o `code`, por 185 dias. Antes do primeiro clique, confirme que existe uma
   exclusão para `/v1/public/cloudflare/callback` no Cloud Logging do projeto do plano de controle, ou que o app foi
   registrado com `response_mode=form_post` (HC-06). Sem uma das duas, pare aqui.

## 2. Registrar o app

No painel do Cloudflare da Verax, em **Manage Account › OAuth Applications** (o nome do menu pode mudar; a
documentação "Create an OAuth application" do Cloudflare é a referência):

| Campo               | Valor                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| Nome                | Verax Control                                                                          |
| Tipo de cliente     | público, sem segredo (`token_endpoint_auth_method = none`), PKCE S256 obrigatório      |
| Redirect URIs       | só `https://conta.<domínio da Verax>/v1/public/cloudflare/callback`, exato             |
| Grant types         | `authorization_code` e `refresh_token`                                                 |
| Escopos             | só leitura: os que cobrem a auditoria da conta, a lista de zonas e o analytics (HC-01) |
| Visibilidade        | **privado** durante a homologação (só membros da conta da Verax autorizam)             |
| Logo, URL e domínio | os da Verax, com o domínio verificado (exigidos para virar público)                    |

- **Nunca** marque escopo de escrita (`.write`, `.edit`, `.admin`): o plano de controle e o nó recusam na partida.
- **Não crie segredo.** Se o Cloudflare exigir um para entregar a renovação (HC-04), pare: o modo B do desenho
  (segredo no plano de controle) é outra entrega, com revisão de `infra/`.
- Tornar o app público é **irreversível**: só depois da tabela do fim inteira em "ok" e com o OK do responsável.

## 3. Ligar no plano de controle (só para o nó de homologação)

No `terraform.tfvars` do ambiente do plano de controle (fora do repositório), com valores reais:

```hcl
cloudflare_oauth = {
  client_id    = "appdeexemplo0001"
  scopes       = ["account-settings.read", "zone.read", "analytics.read", "offline_access"]
  tenant_slugs = ["cliente-demo"] # só o subdomínio do nó de homologação; nunca "*" antes da homologação
}
```

`terraform plan` deve mudar só as variáveis `CLOUDFLARE_OAUTH_*` do `cp-public`, do `cp-worker` e do `cp-admin`. Depois do
`apply`, na sincronização seguinte (até alguns minutos), o painel de homologação mostra "Conectar com Cloudflare" em
Contas cloud. Desligar: volte a variável para `null` (as conexões feitas continuam; só novas param).

## 4. Conferências

Para cada uma: o que fazer, o que esperar e onde olhar. "Auditoria" é a trilha do painel; "log" é o do nó
(`docker compose logs api worker`).

| Nº    | Conferência                                                                                                                                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HC-01 | `GET https://api.cloudflare.com/client/v4/oauth/scopes` (ou a tela do app): anote os nomes exatos dos escopos e se existe um só de `Audit Logs Read` (preferido a `account-settings.read`). Os nomes do passo 3 batem?                                            |
| HC-02 | Conectar uma conta nova (uma conta autorizada): o painel volta em `/conexao-cloudflare`, a barra de endereço fica sem `code` e sem `state` (só `?tentativa=`), e a conta aparece "Autorizada", com todas as zonas.                                                |
| HC-03 | Na primeira hora, a auditoria (REST) e os eventos de segurança (GraphQL) chegam com o token OAuth: alertas da faixa 9903xx, saúde das zonas em "Lendo". Anote o formato e o tamanho do access token (cabe no envelope? `CloudflareGrant`).                        |
| HC-04 | Renovação com método `none`: depois de 1 h, "Última renovação" muda e a coleta continua. Anote o `expires_in`, se o refresh é rotativo e o prazo dele.                                                                                                            |
| HC-05 | Reuso do refresh antigo (copie o envelope antes de uma renovação, num banco de teste): o Cloudflare recusa? Derruba a cadeia inteira? A conta vai a "Precisa conectar de novo"?                                                                                   |
| HC-06 | O retorno: o `iss` vem sempre, com código e com erro? `response_mode=form_post` é aceito pelo app? Quanto vale o código (a troca no worker leva até ~5 s)? Quais `error` o Cloudflare manda?                                                                      |
| HC-07 | Mais de uma conta autorizada: o painel lista só as escolhidas no consentimento? `/accounts` e `/zones` respeitam a escolha? A conta sem leitura da auditoria aparece sem poder ser marcada?                                                                       |
| HC-08 | Consentimento enganado: com outra sessão (outro navegador, outro usuário), cole o link de retorno da primeira: recusa única ("já foi usado ou não é desta sessão"), e o motivo só na auditoria (`cloudflare_oauth.refused`).                                      |
| HC-09 | Negar no Cloudflare: o painel mostra "A autorização não foi dada" e "Começar de novo".                                                                                                                                                                            |
| HC-10 | Esperar mais de 10 min na tela do Cloudflare antes de autorizar: recusa única no retorno.                                                                                                                                                                         |
| HC-11 | Voltar com o botão do navegador e recarregar `/conexao-cloudflare`: nada é enviado de novo, a tentativa continua no estado dela.                                                                                                                                  |
| HC-12 | Migração: numa conta com token colado coletando, "Migrar para Conectar com Cloudflare". A coleta não para (cursores seguem, nenhum alerta duplicado), o token sai do cofre (auditoria `cloud_credential.wipe`) e o painel lembra de apagar o token no Cloudflare. |
| HC-13 | Reconsentir na mesma conta: o Cloudflare cria outra concessão, troca a anterior ou a invalida? Revogar a antiga derruba a nova do mesmo usuário?                                                                                                                  |
| HC-14 | Desativar o monitoramento: a concessão vai a revogação, e em Connected Applications do perfil o app some. Excluir a conta: o mesmo.                                                                                                                               |
| HC-15 | Revogar o app no Cloudflare (Connected Applications) com a conta ativa: na renovação seguinte, "Precisa conectar de novo" e a coleta para; "Conectar de novo" volta a ler, e a auditoria recupera o que ficou para trás.                                          |
| HC-16 | Limites: o 429 é por token ou por usuário? Duas concessões do mesmo usuário disputam o mesmo limite (GraphQL, 300 por 5 min)?                                                                                                                                     |
| HC-17 | O filtro de IP do token colado não existe no OAuth: anote a perda dessa camada no registro de riscos.                                                                                                                                                             |
| HC-18 | O que a autorização gera na auditoria da conta do cliente (pode disparar a regra 990311?) e o que acontece quando quem autorizou sai da conta.                                                                                                                    |
| HC-19 | "Public OAuth App access" desligado pelo administrador da conta de teste: qual erro chega ao painel (esperado: a explicação de `oauth_denied` ou `oauth_client_rejected`).                                                                                        |
| HC-20 | Logs: procure o `code`, o `state` e os tokens no log do nó, no do `cp-public` (Cloud Logging, inclusive o de requisição) e na auditoria. Não podem aparecer.                                                                                                      |
| HC-21 | Nó anterior: num segundo nó sem a versão do CF-4, Contas cloud fica exatamente como antes (sem o botão, sem a saúde das zonas).                                                                                                                                   |
| HC-22 | Acessibilidade no navegador real (celular e computador, tema claro e escuro): retorno, escolha e detalhe da conta pelo teclado.                                                                                                                                   |

## 5. Depois

- Desautorize o app nas contas de teste (Connected Applications) e apague as contas cadastradas no nó de homologação.
- Volte `cloudflare_oauth` para `null` se a homologação não terminar no mesmo dia.
- Só com a tabela inteira em "ok": tornar o app público (passo irreversível), liberar o primeiro cliente em
  `tenant_slugs` e registrar a data em `docs/STATUS.md`.

## 6. Resultado

| Nº    | Resultado (ok, falhou, não aplicável) | Data | Observação |
| ----- | ------------------------------------- | ---- | ---------- |
| HC-01 |                                       |      |            |
| HC-02 |                                       |      |            |
| HC-03 |                                       |      |            |
| HC-04 |                                       |      |            |
| HC-05 |                                       |      |            |
| HC-06 |                                       |      |            |
| HC-07 |                                       |      |            |
| HC-08 |                                       |      |            |
| HC-09 |                                       |      |            |
| HC-10 |                                       |      |            |
| HC-11 |                                       |      |            |
| HC-12 |                                       |      |            |
| HC-13 |                                       |      |            |
| HC-14 |                                       |      |            |
| HC-15 |                                       |      |            |
| HC-16 |                                       |      |            |
| HC-17 |                                       |      |            |
| HC-18 |                                       |      |            |
| HC-19 |                                       |      |            |
| HC-20 |                                       |      |            |
| HC-21 |                                       |      |            |
| HC-22 |                                       |      |            |
