import { existsSync, readFileSync } from 'node:fs';
import {
  AWS_COLLECTION_ERROR_CODES,
  AWS_CONNECTION_ERROR_CODES,
  AWS_MAX_AUTHORIZED_LOG_GROUPS,
  AWS_MAX_AUTHORIZED_S3_SOURCES,
  AWS_READER_AUDIENCE,
  AWS_READER_ROLE_NAME,
  AWS_READER_ROLE_PATH,
  awsReaderRoleArn,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { WAZUH_AWS_LOCATION } from '../src/alerts/cloudwatch-alert.js';
import { WAF_CLOUDFRONT_PATH_REGION } from '../src/aws/discovery/catalogue.js';
import { AWS_TOKEN_STALE_AFTER_MS, WAZUH_SIGNAL_FILES } from '../src/aws/wazuh-config.js';
import {
  WAZUH_PROGRESS_MAX_BYTES,
  WAZUH_PROGRESS_MAX_ENTRIES,
  WAZUH_PROGRESS_STALE_AFTER_MS,
} from '../src/aws/wazuh-progress.js';
import {
  planWazuhSources,
  serializeWazuhSources,
  WAZUH_AWS_REGIONS,
  WAZUH_FLOW_TRAFFIC,
  WAZUH_LOG_GROUP,
  WAZUH_MAX_PREFIX,
  WAZUH_MAX_PREFIX_SEGMENTS,
  WAZUH_ORGANIZATION_ID,
  WAZUH_PREFIX_SEGMENT,
  WAZUH_SOURCES_VERSION,
  WAZUH_WAF_CLOUDFRONT,
  WAZUH_WEB_ACL,
  type WazuhAccountRow,
  wazuhDate,
  type WazuhSourceRow,
} from '../src/aws/wazuh-sources.js';
import { ANALYSISD_STATS_PATH, WAZUH_STATS_ACCOUNT } from '../src/usage/wazuh-stats.js';

const repoPath = (path: string) => new URL(`../../../${path}`, import.meta.url);
const repoFile = (path: string) => readFileSync(repoPath(path), 'utf8');
/** O valor de `NOME = "valor"` (Python) ou `NOME=valor` (shell), na linha inteira. */
const constant = (text: string, pattern: RegExp) => pattern.exec(text)?.[1];
/** Os textos entre aspas de um trecho de Python (`("a", "b")` vira `['a', 'b']`). */
const quoted = (text: string | undefined) =>
  [...(text ?? '').matchAll(/"([^"]*)"/g)].map((match) => match[1]);
/** O padrão de `NOME = re.compile(r"...")` no gerador, de cada formato que a API confere antes. */
const PYTHON_PATTERNS = {
  WEB_ACL: /^WEB_ACL = re\.compile\(r"(.+)"\)$/m,
  LOG_GROUP: /^LOG_GROUP = re\.compile\(r"(.+)"\)$/m,
  ORGANIZATION_ID: /^ORGANIZATION_ID = re\.compile\(r"(.+)"\)$/m,
  PREFIX_SEGMENT: /^PREFIX_SEGMENT = re\.compile\(r"(.+)"\)$/m,
} as const;
const pythonPattern = (text: string, name: keyof typeof PYTHON_PATTERNS) =>
  constant(text, PYTHON_PATTERNS[name]);

/** Uma fonte autorizada como a busca da lista a devolve (contas fictícias da documentação da AWS). */
function sourceRow(overrides: Partial<WazuhSourceRow>): WazuhSourceRow {
  return {
    id: '00000000-0000-7000-8000-000000000010',
    tenantId: '00000000-0000-7000-8000-0000000000aa',
    cloudAccountId: '00000000-0000-7000-8000-000000000001',
    kind: 'cloudtrail',
    region: 'sa-east-1',
    resourceId: 'recurso',
    name: 'fonte',
    details: {},
    method: 's3',
    origin: 'discovered',
    authorizedAt: new Date('2026-11-20T15:00:00.000Z'),
    collectFrom: new Date('2026-11-20T00:00:00.000Z'),
    state: 'authorized',
    stateCode: 'awaiting_collector',
    stateSince: new Date('2026-11-20T15:00:00.000Z'),
    lastSyncAt: null,
    lastEventAt: null,
    lastIngestedAt: null,
    lagSeconds: null,
    ...overrides,
  };
}

function accountRow(accountId: string, region: string, sources: WazuhSourceRow[]): WazuhAccountRow {
  return {
    id: `00000000-0000-7000-8000-${accountId}`,
    tenantId: '00000000-0000-7000-8000-0000000000aa',
    accountId,
    regions: [region],
    ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
    cloudtrailBucket: null,
    guarddutyBucket: null,
    wafBucket: null,
    collectionError: null,
    awsSources: sources,
    awsDiscoveryRuns: [],
  };
}

/**
 * Contrato da coleta da AWS sem chave pelo Wazuh do nó (fase 2, PR-V4'): o template do papel e o painel
 * (packages/shared), o gerador da configuração do manager (infra/wazuh), os scripts, o Compose e as unidades do nó
 * (infra/node) e o worker (a tarefa wazuh-config) vivem em lugares diferentes e só funcionam juntos.
 */
describe("AWS sem chave no Wazuh do nó: o template, o gerador, o host e o worker dizem o mesmo (PR-V4')", () => {
  const renderer = repoFile('infra/wazuh/scripts/render-manager-config.py');
  const template = repoFile('infra/cloudformation/verax-control-reader.yaml');
  const awsToken = repoFile('infra/node/bin/aws-token.sh');
  const apply = repoFile('infra/node/bin/wazuh-apply.sh');
  const startSh = repoFile('infra/node/bin/start.sh');
  const composeWazuh = repoFile('infra/node/compose.wazuh.yaml');
  const units = 'infra/node/systemd/wazuh';

  it('o papel do profile é o da pilha e o que o painel mostra', () => {
    const role = constant(renderer, /^READER_ROLE = "([^"]+)"$/m);
    expect(role).toBe(`role${AWS_READER_ROLE_PATH}${AWS_READER_ROLE_NAME}`);
    expect(`arn:aws:iam::111122223333:${role ?? ''}`).toBe(awsReaderRoleArn('111122223333'));
    expect(template).toContain(
      `      RoleName: ${AWS_READER_ROLE_NAME}\n      Path: ${AWS_READER_ROLE_PATH}\n`,
    );
  });

  it('o audience que o host pede ao Google é o padrão da pilha e do painel', () => {
    expect(constant(awsToken, /^DEFAULT_AUDIENCE=(\S+)$/m)).toBe(AWS_READER_AUDIENCE);
    expect(template).toContain(`    Default: ${AWS_READER_AUDIENCE}\n`);
  });

  it('o token: o host o grava na pasta que o manager monta onde o profile o procura', () => {
    expect(constant(renderer, /^TOKEN_FILE = "([^"]+)"$/m)).toBe('/root/.aws/google-id-token');
    expect(composeWazuh).toContain('      - /run/verax/wazuh-aws:/root/.aws:ro\n');
    expect(awsToken).toMatch(/^dir=\$run\/wazuh-aws$/m);
    expect(awsToken).toContain('mv -fT "$file" "$dir/google-id-token"');
    // Só o manager (só leitura) e o gerador montam a pasta do token.
    const mounts = composeWazuh.match(/\/run\/verax\/wazuh-aws:[^\s']+/g) ?? [];
    expect(mounts.sort()).toEqual(['/run/verax/wazuh-aws:/out/aws', '/run/verax/wazuh-aws:/root/.aws:ro']);
  });

  it('a pasta dos sinais: o host escreve onde o worker lê, e o .path olha o arquivo que o worker grava', () => {
    expect(startSh).toMatch(/^WAZUH_SIGNAL_MOUNT=\/run\/wazuh-signal$/m);
    expect(startSh).toContain('"WAZUH_SIGNAL_DIR=$WAZUH_SIGNAL_MOUNT"');
    expect(composeWazuh).toContain("'/run/verax/wazuh-signal:/run/wazuh-signal'");
    for (const script of [awsToken, apply]) expect(script).toMatch(/^signal=\$run\/wazuh-signal$/m);
    expect(awsToken).toContain(`"$signal/${WAZUH_SIGNAL_FILES.awsToken}"`);
    expect(apply).toContain(`"$signal/${WAZUH_SIGNAL_FILES.applied}"`);
    expect(repoFile(`${units}/verax-wazuh-apply.path`)).toContain(
      `PathChanged=/run/verax/wazuh-signal/${WAZUH_SIGNAL_FILES.generation}\n`,
    );
    // O mesmo usuário do worker em todo lugar que entrega a pasta ou os sinais a ele.
    for (const script of [startSh, awsToken, apply]) expect(script).toMatch(/^WORKER_UID=1000$/m);
  });

  it('a lista: a versão, os campos e os tetos que o worker e o CLI imprimem são os que o gerador aceita', () => {
    expect(constant(renderer, /^LIST_VERSION = (\d+)$/m)).toBe(String(WAZUH_SOURCES_VERSION));
    const plan = planWazuhSources([
      accountRow('111122223333', 'sa-east-1', [
        sourceRow({
          kind: 'cloudtrail',
          details: { bucket: 'trilha', organizationTrail: true, organizationId: 'o-exemplo1234' },
        }),
        sourceRow({ kind: 'vpc_flow_logs', details: { bucket: 'fluxo', flowLogId: 'fl-0123456789abcdef0' } }),
        sourceRow({ kind: 'guardduty_export', details: { bucket: 'achados' } }),
        sourceRow({
          kind: 'waf',
          details: { bucket: 'aws-waf-logs-painel', webAclName: 'painel', webAclScope: 'CLOUDFRONT' },
        }),
        sourceRow({
          kind: 'cloudwatch_log_group',
          method: 'cloudwatch',
          resourceId: '/aws/lambda/cobranca',
          details: { logGroup: '/aws/lambda/cobranca' },
        }),
      ]),
    ]);
    const [account] = plan.list.accounts;
    expect(Object.keys(plan.list)).toEqual(['version', 'accounts']);
    expect(quoted(constant(renderer, /^ACCOUNT_FIELDS = \((.+)\)$/m))).toEqual(Object.keys(account ?? {}));
    // Os tipos de bucket, na ordem em que o gerador os escreve.
    expect(quoted(constant(renderer, /^S3_TYPES = \((.+)\)$/m))).toEqual(
      account?.s3.map((entry) => entry.type),
    );
    expect(quoted(constant(renderer, /^S3_REQUIRED = \{(.+)\}$/m)).sort()).toEqual([
      'bucket',
      'onlyLogsAfter',
      'type',
    ]);
    for (const entry of account?.s3 ?? []) {
      expect(Object.keys(entry).slice(0, 3)).toEqual(['type', 'bucket', 'onlyLogsAfter']);
    }
    // Os campos de cada tipo: o gerador recusa qualquer outro.
    const fields = new Set((account?.s3 ?? []).flatMap((entry) => Object.keys(entry)));
    for (const field of fields) expect(renderer).toContain(`"${field}"`);
    expect(quoted(constant(renderer, /^LOG_GROUPS_FIELDS = \{(.+)\}$/m)).sort()).toEqual(
      Object.keys(account?.logGroups[0] ?? {}).sort(),
    );
    expect(quoted(constant(renderer, /^TRAFFIC = \((.+)\)$/m))).toEqual([...WAZUH_FLOW_TRAFFIC]);
    expect(constant(renderer, /^MAX_S3_ENTRIES = (\d+)$/m)).toBe(String(AWS_MAX_AUTHORIZED_S3_SOURCES));
    expect(constant(renderer, /^MAX_LOG_GROUPS = (\d+)$/m)).toBe(String(AWS_MAX_AUTHORIZED_LOG_GROUPS));
    const months = Array.from(
      { length: 12 },
      (_, month) => `"${wazuhDate(new Date(Date.UTC(2026, month, 1))).slice(5, 8)}"`,
    );
    expect(constant(renderer, /^MONTHS = \((.+)\)$/m)).toBe(months.join(', '));
  });

  it('a lista: os formatos e as regiões que a API confere antes são os mesmos do gerador', () => {
    expect(pythonPattern(renderer, 'WEB_ACL')).toBe(WAZUH_WEB_ACL.source);
    expect(pythonPattern(renderer, 'LOG_GROUP')).toBe(WAZUH_LOG_GROUP.source.replace('\\/', '/'));
    expect(pythonPattern(renderer, 'ORGANIZATION_ID')).toBe(WAZUH_ORGANIZATION_ID.source);
    expect(pythonPattern(renderer, 'PREFIX_SEGMENT')).toBe(WAZUH_PREFIX_SEGMENT.source);
    expect(constant(renderer, /^MAX_PREFIX_SEGMENTS = (\d+)$/m)).toBe(String(WAZUH_MAX_PREFIX_SEGMENTS));
    expect(constant(renderer, /^MAX_PREFIX = (\d+)$/m)).toBe(String(WAZUH_MAX_PREFIX));
    expect(constant(renderer, /^WAF_CLOUDFRONT = "([^"]+)"$/m)).toBe(WAZUH_WAF_CLOUDFRONT);
    // A "região" do caminho dos logs de uma Web ACL do CloudFront é a mesma na descoberta, na lista e no gerador.
    expect(WAZUH_WAF_CLOUDFRONT).toBe(WAF_CLOUDFRONT_PATH_REGION);
    const regions = /^WODLE_REGIONS = \(\n([\s\S]+?)\n\)$/m.exec(renderer)?.[1];
    expect(quoted(regions)).toEqual([...WAZUH_AWS_REGIONS]);
  });

  it('a lista do cadastro anterior: a API imprime exatamente a que o teste do gerador compara com a configuração de antes', () => {
    // As mesmas contas das listas do formato anterior (`aws-sources.example.json` e `aws-sources.shared.v1.json`), agora
    // como linhas `legacy` de `AwsSource`. O teste do gerador (`GoldenLegacyTest`) confere que estas listas dão, byte a
    // byte, a configuração do manager que o gerador anterior escrevia.
    const legacy = (kind: string, bucket: string, ingestFrom: string) =>
      sourceRow({
        kind,
        region: 'global',
        resourceId: 'legacy',
        name: bucket,
        details: { bucket },
        origin: 'legacy',
        collectFrom: new Date(ingestFrom),
        // O estado de agora não muda a lista: a linha do cadastro anterior entra sempre.
        state: 'collecting',
        stateCode: null,
      });
    const KIND = {
      cloudtrailBucket: 'cloudtrail',
      guarddutyBucket: 'guardduty_export',
      wafBucket: 'waf',
    } as const;
    const DAY = /^(\d{4})-([A-Z]{3})-(\d{2})$/;
    const MONTHS = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ');
    for (const [previous, current] of [
      ['aws-sources.example.json', 'aws-sources.example.v2.json'],
      ['aws-sources.shared.v1.json', 'aws-sources.shared.v2.json'],
    ] as const) {
      const before = JSON.parse(repoFile(`infra/wazuh/tests/fixtures/${previous}`)) as Record<
        string,
        string
      >[];
      const rows = before.map((item) => {
        const [, year = '', month = '', day = ''] = DAY.exec(item['onlyLogsAfter'] ?? '') ?? [];
        const ingestFrom = `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}-${day}T00:00:00.000Z`;
        // Na ordem em que a busca as devolve (por autorização e ID), que não é a dos tipos.
        const sources = (Object.keys(KIND) as (keyof typeof KIND)[]).reverse().flatMap((field) => {
          const bucket = item[field];
          return bucket === undefined ? [] : [legacy(KIND[field], bucket, ingestFrom)];
        });
        const row = accountRow(item['accountId'] ?? '', item['region'] ?? '', sources);
        return { ...row, ingestFrom: new Date(ingestFrom) };
      });
      const { list } = planWazuhSources(rows.sort((a, b) => (a.accountId < b.accountId ? -1 : 1)));
      const fixture: unknown = JSON.parse(repoFile(`infra/wazuh/tests/fixtures/${current}`));
      expect(serializeWazuhSources(list)).toBe(JSON.stringify(fixture));
    }
  });

  it('o host e o gerador falam pelas mesmas variáveis, e o CLI do Compose existe', () => {
    for (const name of ['VERAX_NODE_EGRESS_IPS', 'VERAX_MANAGER_CONFIG_ROLLBACK']) {
      expect(renderer).toContain(`"${name}"`);
      expect(apply).toContain(`${name}=`);
    }
    expect(composeWazuh).toContain("command: ['node', 'dist/cli/wazuh-sources.js']");
    expect(existsSync(repoPath('apps/api/src/cli/wazuh-sources.ts'))).toBe(true);
    // VM própria do cliente: o modo da chave de leitura no gerador e o job das sessões que o aws-token.sh roda.
    expect(renderer).toContain('"VERAX_AWS_STATIC_KEYS"');
    expect(apply).toContain('VERAX_AWS_STATIC_KEYS=');
    expect(repoFile('infra/node/compose.vault.yaml')).toContain(
      "command: ['node', 'dist/cli/aws-sessions.js']",
    );
    expect(composeWazuh).not.toContain('aws-sessions');
    expect(repoFile('infra/node/bin/aws-token.sh')).toContain('run --rm -T aws-sessions');
    expect(existsSync(repoPath('apps/api/src/cli/aws-sessions.ts'))).toBe(true);
  });

  it('os avisos da coleta: os mesmos no painel, na API e no CHECK do banco, e fora da lista da conexão', () => {
    const migration = repoFile(
      'apps/api/prisma/migrations/20261109130000_aws_collection_error/migration.sql',
    );
    const checked = /"collectionError" IN \(([^)]+)\)/.exec(migration)?.[1];
    expect(checked?.split(',').map((code) => code.trim().replace(/'/g, ''))).toEqual([
      ...AWS_COLLECTION_ERROR_CODES,
    ]);
    for (const code of AWS_COLLECTION_ERROR_CODES) {
      expect((AWS_CONNECTION_ERROR_CODES as readonly string[]).includes(code)).toBe(false);
    }
  });

  it('o token é renovado a cada 10 min e só conta como parado depois de 40 (quatro renovações perdidas)', () => {
    const timer = repoFile(`${units}/verax-aws-token.timer`);
    expect(timer).toContain('OnUnitActiveSec=10min\n');
    expect(timer).toContain('OnBootSec=30s\n');
    expect(AWS_TOKEN_STALE_AFTER_MS).toBe(40 * 60 * 1000);
  });

  it('nada é apagado na origem: o gerador escreve o `no` em toda entrada, e nenhum script pede outra coisa', () => {
    expect(renderer).toContain('"      <remove_from_bucket>no</remove_from_bucket>"');
    expect(renderer).toContain('"      <remove_log_streams>no</remove_log_streams>"');
    for (const text of [renderer, composeWazuh]) {
      expect(text).not.toMatch(/remove_from_bucket>\s*yes|remove_log_streams>\s*yes/);
    }
  });
});

/**
 * Contrato do sinal `progress` (onboarding self-service da AWS): o exportador que roda no manager (infra/wazuh), o
 * script e o timer do host (infra/node), o install.sh que os põe no nó e o worker que lê o sinal dizem o mesmo.
 */
describe('marcadores da leitura da AWS: o exportador, o host e o worker dizem o mesmo', () => {
  const exporter = repoFile('infra/wazuh/scripts/export-aws-progress.py');
  const progress = repoFile('infra/node/bin/wazuh-progress.sh');
  const installSh = repoFile('infra/node/bin/install.sh');
  const units = 'infra/node/systemd/wazuh';

  it('o host escreve o sinal onde o worker o lê, com o mesmo teto', () => {
    expect(progress).toMatch(/^signal=\$run\/wazuh-signal$/m);
    expect(progress).toContain(`"$signal/${WAZUH_SIGNAL_FILES.progress}"`);
    expect(progress).toMatch(/^WORKER_UID=1000$/m);
    expect(constant(progress, /^MAX_BYTES=(\d+)$/m)).toBe(String(WAZUH_PROGRESS_MAX_BYTES));
    // O exportador do pacote, pela entrada padrão do Python do manager, em modo isolado, sobre a pasta do módulo.
    expect(progress).toMatch(/^script=\/opt\/verax\/wazuh\/scripts\/export-aws-progress\.py$/m);
    expect(progress).toContain('docker exec -i "$container" "$PYTHON" -I - "$WODLES" <"$script"');
    expect(constant(progress, /^WODLES=(\S+)$/m)).toBe(constant(exporter, /^DEFAULT_DIR = "([^"]+)"$/m));
    expect(existsSync(repoPath('infra/wazuh/scripts/export-aws-progress.py'))).toBe(true);
  });

  it('o documento: a versão, o começo que o host confere e o teto de linhas', () => {
    expect(constant(exporter, /^VERSION = (\d+)$/m)).toBe('1');
    expect(progress).toContain(`'{"version":1,'`);
    expect(constant(exporter, /^MAX_ENTRIES = (\d+)$/m)).toBe(String(WAZUH_PROGRESS_MAX_ENTRIES));
    // Só leitura: o banco aberto com mode=ro, e nenhuma escrita em SQL no exportador.
    expect(exporter).toContain('?mode=ro');
    expect(exporter).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|VACUUM)\b/);
  });

  it('o timer roda a cada 5 min, e o sinal só deixa de valer depois de 20 (quatro execuções perdidas)', () => {
    const timer = repoFile(`${units}/verax-wazuh-progress.timer`);
    expect(timer).toContain('OnUnitActiveSec=5min\n');
    expect(repoFile(`${units}/verax-wazuh-progress.service`)).toContain(
      'ExecStart=/opt/verax/bin/wazuh-progress.sh\n',
    );
    expect(WAZUH_PROGRESS_STALE_AFTER_MS).toBe(20 * 60 * 1000);
  });

  it('o install.sh põe o script no nó e liga o timer (na instalação e na atualização)', () => {
    expect(installSh).toContain('"$here/bin/wazuh-progress.sh" /opt/verax/bin/');
    expect(installSh).toMatch(/systemctl enable --now [^>]*verax-wazuh-progress\.timer/);
    // As unidades do Wazuh vão todas pela mesma linha (o glob pega as duas novas).
    expect(installSh).toContain('"$here"/systemd/wazuh/*.service "$here"/systemd/wazuh/*.timer');
  });

  it('o alerta do CloudWatch Logs é reconhecido pelo cabeçalho com que o módulo manda tudo o que lê', () => {
    // `MESSAGE_HEADER = "1:Wazuh-AWS:"` no wazuh_integration.py do módulo (conferido na imagem pelo test-aws-sources.sh).
    expect(WAZUH_AWS_LOCATION).toBe('Wazuh-AWS');
    expect(repoFile('infra/wazuh/scripts/test-aws-sources.sh')).toContain(`1:${WAZUH_AWS_LOCATION}:`);
  });
});

/**
 * Contrato do medidor e da saúde da ingestão (fase 2, PR-V6): o usuário da API do manager que o init-api-users.sh cria,
 * o certificado que o manager-api-tls.sh põe na API, o worker.env que o start.sh escreve, o Compose que leva o worker à
 * rede do manager e o cliente da tarefa wazuh-usage têm de falar o mesmo.
 */
describe('medidor do Wazuh: o host, o manager e o worker dizem o mesmo (PR-V6)', () => {
  const initUsers = repoFile('infra/wazuh/scripts/init-api-users.sh');
  const apiTls = repoFile('infra/wazuh/scripts/manager-api-tls.sh');
  const startSh = repoFile('infra/node/bin/start.sh');
  const installSh = repoFile('infra/node/bin/install.sh');
  const composeWazuh = repoFile('infra/node/compose.wazuh.yaml');

  it('o usuário, o papel e a política: só manager:read, e o worker entra com o mesmo nome', () => {
    expect(initUsers).toContain(
      "ADMIN, USER, ROLE, POLICY = 'wazuh-wui', 'verax_stats', 'verax_stats', 'verax_stats_manager_read'",
    );
    expect(initUsers).toContain(
      "RULES = {'actions': ['manager:read'], 'resources': ['*:*:*'], 'effect': 'allow'}",
    );
    expect(WAZUH_STATS_ACCOUNT).toBe('verax_stats');
    // A conferência do script é a leitura da tarefa.
    expect(initUsers).toContain(`send('GET', '${ANALYSISD_STATS_PATH}', token=token)`);
  });

  it('a API do manager pelo nome do certificado e com a CA do volume público, nos dois lados', () => {
    expect(apiTls).toMatch(/^name=wazuh\.manager$/m);
    expect(initUsers).toContain("HOST, PORT, CA = 'wazuh.manager', 55000, '/etc/ssl/verax/root-ca.pem'");
    expect(startSh).toContain('WAZUH_API_URL=https://wazuh.manager:55000');
    expect(startSh).toContain('WAZUH_API_CA_FILE=/etc/verax/wazuh/root-ca.pem');
    expect(startSh).toContain('"WAZUH_STATS_PASSWORD=$WAZUH_STATS_PASSWORD"');
    expect(composeWazuh).toContain(
      "volumes: ['certs-public:/etc/verax/wazuh:ro', '/run/verax/wazuh-signal:/run/wazuh-signal']",
    );
    expect(composeWazuh).toContain(
      '      - ./wazuh/scripts/manager-api-tls.sh:/entrypoint-scripts/verax-api-tls.sh:ro\n',
    );
    // O worker entra na rede do manager; a API, não.
    const block = (service: string) => {
      const start = composeWazuh.indexOf(`\n  ${service}:\n`);
      return composeWazuh.slice(start, composeWazuh.indexOf('\n\n', start + 1));
    };
    expect(block('worker')).toContain('\n    networks: [wazuh-read, wazuh]\n');
    expect(block('api')).toContain('\n    networks: [wazuh-read]\n');
  });

  it('a senha do verax_stats: o install.sh a gera, o start.sh a confere e a entrega só ao worker e ao script', () => {
    expect(installSh).toContain('generate_wazuh wazuh-api-stats');
    expect(startSh).toContain('WAZUH_STATS_PASSWORD=$(internal_secret wazuh-api-stats)');
    expect(startSh).toContain(
      'write_env wazuh-manager.env "INDEXER_PASSWORD=$INDEXER_FILEBEAT_PASSWORD" "API_PASSWORD=$WAZUH_API_PASSWORD"',
    );
    expect(startSh).toContain('bash "$wazuh/scripts/init-api-users.sh"');
  });
});
