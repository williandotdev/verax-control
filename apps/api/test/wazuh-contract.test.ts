import { existsSync, readFileSync } from 'node:fs';
import {
  AWS_COLLECTION_ERROR_CODES,
  AWS_CONNECTION_ERROR_CODES,
  AWS_READER_AUDIENCE,
  AWS_READER_ROLE_NAME,
  AWS_READER_ROLE_PATH,
  awsReaderRoleArn,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { AWS_TOKEN_STALE_AFTER_MS, WAZUH_SIGNAL_FILES } from '../src/aws/wazuh-config.js';
import { toWazuhSources, wazuhDate } from '../src/aws/wazuh-sources.js';

const repoPath = (path: string) => new URL(`../../../${path}`, import.meta.url);
const repoFile = (path: string) => readFileSync(repoPath(path), 'utf8');
/** O valor de `NOME = "valor"` (Python) ou `NOME=valor` (shell), na linha inteira. */
const constant = (text: string, pattern: RegExp) => pattern.exec(text)?.[1];

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

  it('a lista: os campos que o worker e o CLI imprimem são os que o gerador aceita, e as datas no formato dele', () => {
    const fields = Object.keys(
      toWazuhSources([
        {
          id: '00000000-0000-7000-8000-000000000001',
          tenantId: '00000000-0000-7000-8000-0000000000aa',
          accountId: '111122223333',
          regions: ['sa-east-1'],
          ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
          cloudtrailBucket: 'trilha',
          guarddutyBucket: 'guardduty',
          wafBucket: 'aws-waf-logs-exemplo',
          collectionError: null,
        },
      ])[0] ?? {},
    );
    expect(constant(renderer, /^REQUIRED = \{(.+)\}$/m)).toBe('"accountId", "region", "onlyLogsAfter"');
    expect(constant(renderer, /^BUCKET_FIELDS = \((.+)\)$/m)).toBe(
      '("cloudtrailBucket", "cloudtrail"), ("guarddutyBucket", "guardduty"), ("wafBucket", "waf")',
    );
    expect(fields).toEqual([
      'accountId',
      'region',
      'onlyLogsAfter',
      'cloudtrailBucket',
      'guarddutyBucket',
      'wafBucket',
    ]);
    const months = Array.from(
      { length: 12 },
      (_, month) => `"${wazuhDate(new Date(Date.UTC(2026, month, 1))).slice(5, 8)}"`,
    );
    expect(constant(renderer, /^MONTHS = \((.+)\)$/m)).toBe(months.join(', '));
  });

  it('o host e o gerador falam pelas mesmas variáveis, e o CLI do Compose existe', () => {
    for (const name of ['VERAX_NODE_EGRESS_IPS', 'VERAX_MANAGER_CONFIG_ROLLBACK']) {
      expect(renderer).toContain(`"${name}"`);
      expect(apply).toContain(`${name}=`);
    }
    expect(composeWazuh).toContain("command: ['node', 'dist/cli/wazuh-sources.js']");
    expect(existsSync(repoPath('apps/api/src/cli/wazuh-sources.ts'))).toBe(true);
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
});
