# Diagnóstico da conta AWS (somente leitura)

O script `diagnostico_aws.py` mostra de onde vêm os logs de segurança de uma conta AWS e como estão configurados,
antes de qualquer coleta do Verax Control. **Ele não altera nada e não lê conteúdo de log.**

## O que ele consulta

- CloudTrail: trilhas, para onde gravam (bucket e/ou CloudWatch Logs), se estão ativas e a criptografia do bucket.
- GuardDuty, Security Hub, Inspector e IAM Access Analyzer: se estão ligados e para onde exportam.
- WAF: cada Web ACL e o destino atual do log (o WAF aceita **um** destino por Web ACL; o Verax lê de onde já está e
  nunca troca esse destino).
- VPC Flow Logs: de quais redes e para onde vão.
- CloudWatch Logs: grupos, retenção, volume armazenado, quantos subscription filters já existem (a AWS permite 2 por
  grupo) e os limites de leitura da conta (`GetLogEvents`, `DescribeLogStreams`), que são compartilhados com qualquer
  outra ferramenta que já leia esses logs.
- Se a conta faz parte de uma organização (logs centralizados podem estar em outra conta).

## Garantias

- Só chamadas de leitura (`get_`, `list_`, `describe_`, `batch_get_`). Qualquer outra é recusada pelo próprio script
  antes de sair, e os testes (`tests/`) conferem isso.
- No máximo 4 chamadas por segundo, para não disputar os limites da conta com outras ferramentas.
- Nenhum conteúdo de log, segredo ou chave é lido. O resultado tem o número da conta e nomes de recursos:
  **compartilhe só por canal privado**.

## Para enviar a um cliente

Use a release publicada, não este arquivo do repositório. O roteiro completo está em
`docs/runbooks/onboarding-cliente.md`.

- Cada versão sai como release `diagnostico-vX.Y.Z` (workflow `Publicar diagnóstico`), com o script, o
  `GUIA-CLIENTE.md` (passo a passo para o cliente, já com a versão nos comandos), o `SHA256SUMS` e o atestado de
  procedência do GitHub.
- O cliente roda no AWS CloudShell e devolve dois arquivos:
  - `diagnostico-verax-<conta>.md`: relatório para leitura, com visão geral, fontes sugeridas (`sim`, `avaliar` ou
    `não`, com o volume estimado por dia), pontos de atenção e limites de leitura;
  - `diagnostico-verax-<conta>.json`: os mesmos dados, mais a lista `fontes_sugeridas`, que a configuração do nó vai
    usar.

## Rodar a partir do repositório (desenvolvimento)

```sh
python3 infra/diagnostico/diagnostico_aws.py --regioes us-east-1   # precisa de boto3 e credenciais de leitura
python3 -m unittest discover -s infra/diagnostico/tests -v          # testes, sem boto3
```

Para contas com muitos log groups, `--sem-detalhes-de-logs` pula a contagem de subscription filters (uma chamada por
grupo).
