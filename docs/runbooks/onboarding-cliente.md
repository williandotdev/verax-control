# Onboarding de um cliente

Roteiro da equipe da Verax para colocar um cliente novo em monitoramento. Vale para qualquer cliente e não depende de
nenhuma ferramenta além deste repositório. As etapas marcadas como _em construção_ entram com as próximas entregas da
arquitetura (`docs/ARQUITETURA.md`).

## 1. Diagnóstico da conta (somente leitura)

1. Envie ao contato técnico do cliente o link do guia da versão mais recente do diagnóstico:
   `https://github.com/williandotdev/verax-control/releases`. Procure a release `diagnostico-vX.Y.Z` mais recente e
   envie o arquivo `GUIA-CLIENTE.md`. O guia já traz os comandos com a versão certa.
2. O cliente roda o diagnóstico no AWS CloudShell e devolve dois arquivos: `diagnostico-verax-<conta>.md` e `.json`.
3. Guarde os arquivos **fora do git**, na pasta privada do cliente. Eles trazem número de conta e nomes de recursos.

## 2. Leitura do relatório (`.md`)

- **Visão geral:** o que está ligado (CloudTrail, GuardDuty, Security Hub, Inspector) e o volume no CloudWatch Logs.
- **Fontes sugeridas:**
  - `sim`: fontes de segurança, que entram;
  - `avaliar`: decidir com o cliente (VPC Flow Logs, banco, DNS, logs de aplicação). Pese o volume por dia: alto
    volume pede filtro ou fica de fora no começo;
  - `não`: métricas de desempenho.
- **Pontos de atenção:** o que **não pode ser alterado** no ambiente do cliente. Exemplos: Web ACL que já envia log
  (o WAF aceita um só destino), GuardDuty que já exporta, log groups já no limite de subscription filters. A Verax lê
  de onde os logs já estão.
- **Limites de leitura:** são da conta e são divididos com qualquer outra ferramenta que já leia os mesmos logs. Uma
  coleta agressiva atrapalha as outras.

## 3. Reunião de definição com o cliente

- Confirme a lista final de fontes, a região do nó (a mesma dos logs) e quem hospeda o nó: a conta do cliente ou a
  da Verax.
- Colete o fluxo de escalonamento (quem recebe Critical, High, Medium e Low, e por qual canal) e a baseline de rede:
  portas publicadas e tráfego interno esperado. As duas coisas evitam o ruído que mais incomoda o cliente.
- Combine o subdomínio do painel: `<cliente>.control.veraxsistemas.com.br`.

## 4. Conector, nó e painel _(em construção)_

1. O cliente cria a pilha do conector na conta monitorada (`infra/cloudformation/README.md`). Ela cria só o papel
   somente leitura, que só o papel do nó pode assumir, com o ExternalId. Passe ao cliente:
   - a conta onde o nó vai rodar;
   - o ExternalId gerado pelo painel;
   - os ARNs das fontes aprovadas no passo 3: grupos do CloudWatch Logs, buckets e as chaves KMS deles.

   O papel só lê o conteúdo desses logs e tem negação explícita para apagar, alterar ou desviar logs.

2. Crie a pilha do nó na conta escolhida e na região dos logs (`infra/cloudformation/GUIA-NO.md`), grave o token do
   túnel no parâmetro indicado e passe ao conector as saídas `NodeAccountId` e `NodeRoleName`.
3. Crie os registros no Cloudflare (túnel da API) e o site do painel no Firebase Hosting.
4. Cadastre o cliente, a conta e os usuários no painel. O convite chega por e-mail.

## Publicar uma versão nova do diagnóstico

1. Altere o script, os testes e a constante `VERSION` em `infra/diagnostico/diagnostico_aws.py`, num PR.
2. Depois do merge, crie a tag `diagnostico-vX.Y.Z` (igual à `VERSION`) na `main`: `git tag diagnostico-vX.Y.Z` e
   `git push origin diagnostico-vX.Y.Z`.
3. O workflow `Publicar diagnóstico` roda os testes, confere a versão e publica a release com o script, o guia e o
   `SHA256SUMS`, além do atestado de procedência.
