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

## Como rodar (no AWS CloudShell, sem instalar nada)

1. Entre no console da AWS com um usuário que tenha a política `ReadOnlyAccess` ou `SecurityAudit` (não precisa de
   administrador).
2. Escolha a região onde ficam os logs (ex.: `us-east-1`) e abra o **CloudShell** (ícone `>_` no topo).
3. Baixe o script fixado num commit (troque `COMMIT` pelo hash informado pela Verax):

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/williandotdev/verax-control/COMMIT/infra/diagnostico/diagnostico_aws.py
   ```

   Ou envie o arquivo pelo menu **Actions → Upload file** do CloudShell.

4. Rode (uma ou mais regiões separadas por vírgula; sem `--regioes`, todas as habilitadas):

   ```sh
   python3 diagnostico_aws.py --regioes us-east-1
   ```

5. O resumo aparece na tela. Baixe o JSON completo em **Actions → Download file**
   (`/home/cloudshell-user/diagnostico-verax-<conta>.json`) e envie à Verax por canal privado.

Para contas com muitos log groups, `--sem-detalhes-de-logs` pula a contagem de subscription filters (uma chamada por
grupo).
