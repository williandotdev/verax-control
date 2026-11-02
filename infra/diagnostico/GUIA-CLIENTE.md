# Diagnóstico de logs da sua conta AWS — Verax Control

Antes de começar o monitoramento, a Verax precisa saber de onde vêm os logs de segurança da sua conta AWS. Este
diagnóstico levanta isso em cerca de 5 minutos, **somente lendo configurações**.

## O que ele faz e o que ele não faz

- **Faz:** lista trilhas do CloudTrail, GuardDuty, Security Hub, Inspector, Access Analyzer, WAF, VPC Flow Logs e
  grupos do CloudWatch Logs (nomes, tamanhos e retenção), e os limites de leitura da conta.
- **Não faz:** não altera nenhuma configuração, não lê o conteúdo dos logs, não lê segredos e não envia nada para
  fora da conta. O resultado fica só com você até você enviá-lo à Verax.
- O script recusa qualquer chamada que não seja de leitura e faz no máximo 4 chamadas por segundo, para não
  disputar os limites da conta com outras ferramentas.

## Passo a passo (no navegador, sem instalar nada)

1. Entre no console da AWS com um usuário que tenha a política **ReadOnlyAccess** ou **SecurityAudit**. Não precisa
   ser administrador.
2. No canto superior direito, escolha a região onde ficam os seus logs (ex.: `us-east-1`).
3. Abra o **CloudShell**, pelo ícone `>_` no topo do console.
4. Cole os comandos abaixo e tecle Enter. Troque `us-east-1` pelas suas regiões, separadas por vírgula.

   ```sh
   base=https://github.com/williandotdev/verax-control/releases/download/diagnostico-v{{VERSAO}}
   curl -fsSLO "$base/diagnostico_aws.py" && curl -fsSLO "$base/SHA256SUMS"
   sha256sum -c --ignore-missing SHA256SUMS
   python3 diagnostico_aws.py --regioes us-east-1
   ```

   A linha do `sha256sum` precisa mostrar `diagnostico_aws.py: OK`. Isso confirma que o arquivo é o publicado pela
   Verax.

5. O resumo aparece na tela. Baixe os dois arquivos gerados pelo menu **Actions → Download file** do CloudShell:
   - `diagnostico-verax-<sua conta>.md`: relatório para leitura;
   - `diagnostico-verax-<sua conta>.json`: dados para a Verax.
6. Envie os dois arquivos à Verax pelo canal combinado. Eles trazem o número da conta e nomes de recursos, então não
   publique nem envie por canais abertos.

Versão do diagnóstico: {{VERSAO}}. Dúvidas: fale com o seu contato na Verax.
