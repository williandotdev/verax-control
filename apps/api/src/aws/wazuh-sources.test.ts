import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  serializeWazuhSources,
  toWazuhSources,
  wazuhDate,
  type WazuhSourceRow,
  wazuhSourcesGeneration,
} from './wazuh-sources.js';

/** Uma linha do banco como a busca devolve; contas fictícias da documentação da AWS. */
function row(overrides: Partial<WazuhSourceRow> = {}): WazuhSourceRow {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    tenantId: '00000000-0000-7000-8000-0000000000aa',
    accountId: '111122223333',
    regions: ['sa-east-1', 'us-east-1'],
    ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
    cloudtrailBucket: 'verax-control-cloudtrail-111122223333-sa-east-1',
    guarddutyBucket: null,
    wafBucket: 'aws-waf-logs-verax-control-111122223333-sa-east-1',
    collectionError: null,
    ...overrides,
  };
}

describe("lista das contas AWS para o Wazuh do nó (PR-V4')", () => {
  it('a data do only_logs_after no formato do Wazuh, pelo dia em UTC', () => {
    expect(wazuhDate(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-NOV-01');
    expect(wazuhDate(new Date('2027-01-09T23:59:59.999Z'))).toBe('2027-JAN-09');
    const months = Array.from({ length: 12 }, (_, month) => wazuhDate(new Date(Date.UTC(2026, month, 15))));
    expect(months.map((date) => date.slice(5, 8))).toEqual([
      'JAN',
      'FEB',
      'MAR',
      'APR',
      'MAY',
      'JUN',
      'JUL',
      'AUG',
      'SEP',
      'OCT',
      'NOV',
      'DEC',
    ]);
  });

  it('cada conta com os campos que o gerador aceita, na ordem fixa, sem bucket nulo e sem nada do papel', () => {
    const [source] = toWazuhSources([row()]);
    expect(Object.keys(source ?? {})).toEqual([
      'accountId',
      'region',
      'onlyLogsAfter',
      'cloudtrailBucket',
      'wafBucket',
    ]);
    expect(source).toEqual({
      accountId: '111122223333',
      region: 'sa-east-1',
      onlyLogsAfter: '2026-NOV-01',
      cloudtrailBucket: 'verax-control-cloudtrail-111122223333-sa-east-1',
      wafBucket: 'aws-waf-logs-verax-control-111122223333-sa-east-1',
    });
    // Nada que identifique o cliente, a conexão de agora ou um papel: o gerador deriva o papel do ID.
    expect(serializeWazuhSources(toWazuhSources([row()]))).not.toMatch(/tenant|connection|role|arn:/i);
  });

  it('a conta sem região ou sem o início da coleta fica de fora', () => {
    expect(toWazuhSources([row({ regions: [] }), row({ ingestFrom: null })])).toEqual([]);
  });

  it('a geração é o SHA-256 da linha que o CLI imprime, e muda com qualquer campo da lista', () => {
    const line = serializeWazuhSources(toWazuhSources([row()]));
    expect(line).not.toContain('\n');
    expect(wazuhSourcesGeneration(line)).toBe(createHash('sha256').update(line).digest('hex'));
    expect(wazuhSourcesGeneration(serializeWazuhSources([]))).toBe(
      createHash('sha256').update('[]').digest('hex'),
    );
    const changed = [
      row({ guarddutyBucket: 'verax-control-guardduty-111122223333-sa-east-1' }),
      row({ regions: ['us-east-1'] }),
      row({ ingestFrom: new Date('2026-11-02T00:00:00.000Z') }),
    ].map((variant) => wazuhSourcesGeneration(serializeWazuhSources(toWazuhSources([variant]))));
    expect(new Set([wazuhSourcesGeneration(line), ...changed]).size).toBe(4);
    // O aviso da própria coleta não muda a geração: o manager não reinicia por causa dele.
    expect(
      wazuhSourcesGeneration(
        serializeWazuhSources(toWazuhSources([row({ collectionError: 'wazuh_apply_failed' })])),
      ),
    ).toBe(wazuhSourcesGeneration(line));
  });
});
