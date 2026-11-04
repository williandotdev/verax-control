import { readFileSync } from 'node:fs';
import { GCP_SINK_LOG_FILTER, gcpSinkCommand, SINK_WRITER_IDENTITY_PATTERN } from '@verax/shared';
import { describe, expect, it } from 'vitest';

const repoFile = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

/** O texto entre `<nome> = <<-EOT` e o `EOT` que fecha, num arquivo do Terraform, linha a linha e sem a indentação. */
function heredoc(source: string, name: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${name} = <<-EOT`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'EOT');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end).map((line) => line.trim());
}

/**
 * Contrato entre Contas cloud (o comando do sink e a identidade colada), o Terraform do nó e o start.sh. Os três vivem
 * em lugares diferentes e só funcionam juntos: o filtro do comando é o dos sinks que o Terraform cria, a identidade
 * que a API aceita é a que o módulo aceita em `customer_projects`, e o tópico que o painel mostra é o que o módulo
 * cria para o projeto.
 */
describe('sink de projeto GCP de cliente: o painel, o Terraform do nó e o start.sh dizem o mesmo', () => {
  const logsTf = repoFile('infra/gcp/modules/node/logs.tf');
  const variablesTf = repoFile('infra/gcp/modules/node/variables.tf');

  it('o filtro do comando é o do security_log_filter do módulo, sem a exclusão das leituras do nó', () => {
    const filter = heredoc(logsTf, 'security_log_filter');
    // No módulo: ( <eventos de segurança> ) AND NOT ( <leituras do próprio nó no Pub/Sub> ).
    const close = filter.indexOf(')');
    expect(filter[0]).toBe('(');
    expect(filter[close + 1]).toBe('AND NOT (');
    expect(filter.slice(1, close)).toEqual(GCP_SINK_LOG_FILTER.split('\n'));
    expect(gcpSinkCommand('cliente-demo-a', 'projects/projeto-exemplo/topics/t')).toContain(
      GCP_SINK_LOG_FILTER,
    );
  });

  it('a identidade que a API aceita é a que o módulo aceita em customer_projects', () => {
    // A regex do HCL, entre aspas, com `\\` no lugar de `\`.
    const pattern = /can\(regex\("([^"]+)", project\.writer_identity\)\)/.exec(variablesTf)?.[1] ?? '';
    expect(pattern.replaceAll('\\\\', '\\')).toBe(SINK_WRITER_IDENTITY_PATTERN.source);
  });

  it('o tópico que o start.sh informa à API é o nome que o módulo dá ao tópico do projeto', () => {
    // O módulo nomeia o tópico (e a assinatura) de cada projeto `<prefixo>-security-<projeto>`, e os cofres
    // `<prefixo>-<nome>`: o prefixo dos cofres do node.conf (VERAX_SECRET_PREFIX) é o `name_prefix` do módulo.
    expect(logsTf).toContain('name = "${var.name_prefix}-security-${each.key}"');
    expect(repoFile('infra/gcp/modules/node/secrets.tf')).toContain(
      'secret_id = "${var.name_prefix}-${each.key}"',
    );
    expect(repoFile('infra/node/bin/start.sh')).toContain(
      'GCP_SINK_TOPIC_PREFIX=projects/$VERAX_GCP_PROJECT/topics/$VERAX_SECRET_PREFIX-security-',
    );
  });

  it('o projeto e o prefixo que o install.sh e o start.sh aceitam são os do módulo, e a API exige o mesmo formato', () => {
    // As regras de `project_id` e `name_prefix` do módulo. O install.sh recusa um node.conf fora delas, o start.sh
    // só escreve a variável quando as duas valem, e a API recusa a variável fora do formato: se uma das quatro
    // mudasse sozinha, a API deixaria de subir, ou o painel mostraria um tópico que o módulo não cria.
    const projectId = '^[a-z][a-z0-9-]{4,28}[a-z0-9]$';
    const namePrefix = '^[a-z][a-z0-9-]{3,18}$';
    expect(variablesTf).toContain(`can(regex("${projectId}", var.project_id))`);
    expect(variablesTf).toContain(`can(regex("${namePrefix}", var.name_prefix))`);
    for (const script of ['infra/node/bin/install.sh', 'infra/node/bin/start.sh']) {
      expect(repoFile(script)).toContain(`$VERAX_GCP_PROJECT =~ ${projectId}`);
      expect(repoFile(script)).toContain(`$VERAX_SECRET_PREFIX =~ ${namePrefix}`);
    }
    expect(repoFile('infra/node/bin/deploy.sh')).toContain(`$project =~ ${projectId}`);
    const envSchema = repoFile('apps/api/src/common/config/env.schema.ts');
    const apiPattern = /GCP_SINK_TOPIC_PREFIX: z\s*\.string\(\)\s*\.regex\(\/(.+?)\/, \{/.exec(
      envSchema,
    )?.[1];
    const unanchored = (pattern: string) => pattern.slice(1, -1);
    expect(apiPattern).toBe(
      `^projects\\/${unanchored(projectId)}\\/topics\\/${unanchored(namePrefix)}-security-$`,
    );
  });
});
