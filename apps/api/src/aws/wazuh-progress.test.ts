import { describe, expect, it } from 'vitest';
import {
  findWazuhMarker,
  objectEventTime,
  parseWazuhProgress,
  WAZUH_PROGRESS_MAX_ENTRIES,
  type WazuhS3Progress,
} from './wazuh-progress.js';
import type { WazuhMarkerRef } from './wazuh-sources.js';

/** Conta fictícia da documentação da AWS. */
const ACCOUNT = '111122223333';
const OTHER = '444455556666';

const trailKey = (region: string, stamp: string, account = ACCOUNT): string =>
  `AWSLogs/${account}/CloudTrail/${region}/${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/${stamp.slice(6, 8)}/` +
  `${account}_CloudTrail_${region}_${stamp}_a.json.gz`;

function s3(overrides: Partial<WazuhS3Progress> = {}): WazuhS3Progress {
  return {
    table: 'cloudtrail',
    bucketPath: 'trilha/',
    accountId: ACCOUNT,
    region: 'sa-east-1',
    flowLogId: null,
    lastKey: trailKey('sa-east-1', '20261123T1155Z'),
    processedAt: '2026-11-23T11:58:02Z',
    createdDate: 20261123,
    keys: 2,
    ...overrides,
  };
}

/** O documento como o exportador o escreve. */
function document(parts: { s3?: object; cloudwatch?: object } = {}): Record<string, unknown> {
  return {
    version: 1,
    at: '2026-11-23T12:00:00Z',
    s3: { status: 'ok', truncated: false, entries: [], ...parts.s3 },
    cloudwatch: { status: 'ok', truncated: false, entries: [], ...parts.cloudwatch },
  };
}

const parsed = (parts: { s3?: object; cloudwatch?: object } = {}) => {
  const progress = parseWazuhProgress(document(parts));
  if (progress === null) throw new Error('o documento de exemplo não passou no schema');
  return progress;
};

const trailRef: WazuhMarkerRef = {
  method: 's3',
  table: 'cloudtrail',
  bucketPath: 'trilha/',
  accountId: ACCOUNT,
  regions: ['sa-east-1', 'us-east-1'],
  flowLogId: null,
};

describe('sinal progress: os marcadores do módulo do Wazuh (onboarding self-service da AWS)', () => {
  it('o documento do exportador passa, com a hora dele', () => {
    const progress = parsed({
      s3: { entries: [s3()] },
      cloudwatch: {
        entries: [
          { region: 'sa-east-1', logGroup: '/aws/lambda/cobranca', endTime: 1793527200000, streams: 2 },
        ],
      },
    });
    expect(progress.at.toISOString()).toBe('2026-11-23T12:00:00.000Z');
    expect(progress.s3.entries).toEqual([s3()]);
    expect(progress.cloudwatch.entries).toHaveLength(1);
    expect(progress.invalidEntries).toBe(0);
  });

  it('o envelope fora do formato recusa o sinal inteiro', () => {
    const cases: unknown[] = [
      null,
      [],
      'texto',
      { ...document(), version: 2 },
      { ...document(), at: 'ontem' },
      { ...document(), s3: undefined },
      { ...document(), s3: { status: 'pronto', truncated: false, entries: [] } },
      { ...document(), cloudwatch: { status: 'ok', truncated: 'não', entries: [] } },
      { ...document(), s3: { status: 'ok', truncated: false, entries: {} } },
      document({ s3: { entries: Array.from({ length: WAZUH_PROGRESS_MAX_ENTRIES + 1 }, () => s3()) } }),
    ];
    for (const value of cases) expect(parseWazuhProgress(value)).toBeNull();
  });

  it('a linha fora do formato fica de fora, contada, sem derrubar as outras', () => {
    const progress = parsed({
      s3: {
        entries: [
          s3(),
          s3({ accountId: 'conta' }),
          s3({ table: 'custom' as never }),
          s3({ lastKey: '' }),
          s3({ lastKey: 'k'.repeat(1025) }),
          s3({ processedAt: '2026-11-23 11:58:02' }),
          s3({ createdDate: 1 }),
          s3({ keys: -1 }),
          { ...s3(), conteudo: 'um campo a mais (o exportador nunca manda conteúdo de log)' },
          'texto',
        ],
      },
      cloudwatch: {
        entries: [
          { region: 'sa-east-1', logGroup: '/aws/lambda/cobranca', endTime: null, streams: 1 },
          { region: 'sa-east-1', logGroup: 'g'.repeat(513), endTime: 1, streams: 1 },
          { region: 'sa-east-1', logGroup: '/aws/a', endTime: -1, streams: 1 },
          { region: 'sa-east-1', logGroup: '/aws/b', endTime: 1.5, streams: 1 },
        ],
      },
    });
    expect(progress.s3.entries).toEqual([s3()]);
    expect(progress.cloudwatch.entries.map((entry) => entry.logGroup)).toEqual(['/aws/lambda/cobranca']);
    expect(progress.invalidEntries).toBe(12);
  });

  it('o horário do evento: o do nome do objeto, ou o dia dele até o fim, nunca depois da leitura', () => {
    const time = (lastKey: string, processedAt = '2026-11-23T11:58:02Z', createdDate: number | null = null) =>
      objectEventTime({ lastKey, processedAt, createdDate }).toISOString();
    // CloudTrail, flow logs e o log nativo do WAF: ao minuto.
    expect(time(trailKey('sa-east-1', '20261123T1155Z'))).toBe('2026-11-23T11:55:00.000Z');
    expect(
      time(
        `AWSLogs/${ACCOUNT}/vpcflowlogs/sa-east-1/2026/11/23/${ACCOUNT}_vpcflowlogs_sa-east-1_fl-0123456789abcdef0_20261123T1150Z_c.log.gz`,
      ),
    ).toBe('2026-11-23T11:50:00.000Z');
    // Entregue pelo Firehose: ao segundo.
    expect(time('2026/11/23/11/aws-waf-logs-painel-1-2026-11-23-11-40-33-abcdef')).toBe(
      '2026-11-23T11:40:33.000Z',
    );
    // Só a pasta do dia (o export do GuardDuty): até o fim do dia, ou até a leitura, o que vier antes.
    const finding = `AWSLogs/${ACCOUNT}/GuardDuty/sa-east-1/2026/11/22/achado.jsonl.gz`;
    expect(time(finding)).toBe('2026-11-22T23:59:59.999Z');
    expect(time(finding, '2026-11-22T15:00:00Z')).toBe('2026-11-22T15:00:00.000Z');
    // Sem data na chave: o dia que o módulo guardou; sem ele, a leitura.
    expect(time('objeto-sem-data', '2026-11-23T11:58:02Z', 20261121)).toBe('2026-11-21T23:59:59.999Z');
    expect(time('objeto-sem-data')).toBe('2026-11-23T11:58:02.000Z');
    // Um horário no nome depois da leitura (o relógio de quem gravou) não passa dela; uma data que não existe não vale.
    expect(time(trailKey('sa-east-1', '20261123T1300Z'))).toBe('2026-11-23T11:58:02.000Z');
    expect(time('AWSLogs/x/2026/13/45/x_20261345T9999Z_a.json.gz')).toBe('2026-11-23T11:58:02.000Z');
  });

  it('o marcador de uma fonte: a linha da tabela, do caminho, da conta e das regiões dela, a lida por último', () => {
    const progress = parsed({
      s3: {
        entries: [
          s3({
            region: 'us-east-1',
            processedAt: '2026-11-23T11:40:00Z',
            lastKey: trailKey('us-east-1', '20261123T1135Z'),
          }),
          s3(),
          // De outra conta, de outro bucket, de outra tabela e de uma região fora da leitura: não são desta fonte.
          s3({ accountId: OTHER, processedAt: '2026-11-23T11:59:00Z' }),
          s3({ bucketPath: 'outra-trilha/', processedAt: '2026-11-23T11:59:00Z' }),
          s3({ table: 'guardduty', region: null, processedAt: '2026-11-23T11:59:00Z' }),
          s3({ region: 'eu-west-1', processedAt: '2026-11-23T11:59:30Z' }),
        ],
      },
    });
    expect(findWazuhMarker(progress, trailRef)).toEqual({
      known: true,
      marker: {
        ingestedAt: new Date('2026-11-23T11:58:02Z'),
        eventAt: new Date('2026-11-23T11:55:00Z'),
        lastKey: trailKey('sa-east-1', '20261123T1155Z'),
        region: 'sa-east-1',
      },
    });
    // O cadastro anterior não fixa regiões: vale a de qualquer uma.
    expect(findWazuhMarker(progress, { ...trailRef, regions: null })).toMatchObject({
      marker: { region: 'eu-west-1' },
    });
    // O bucket lido inteiro (o GuardDuty do cadastro anterior): a linha de qualquer conta.
    const anyAccount: WazuhMarkerRef = {
      method: 's3',
      table: 'guardduty',
      bucketPath: 'trilha/',
      accountId: null,
      regions: null,
      flowLogId: null,
    };
    expect(findWazuhMarker(progress, anyAccount)).toMatchObject({ known: true, marker: { region: null } });
  });

  it('os flow logs: só a linha do flow log da fonte', () => {
    const flow = (flowLogId: string, processedAt: string) =>
      s3({ table: 'vpcflow', bucketPath: 'fluxo/', flowLogId, processedAt, lastKey: `chave-${flowLogId}` });
    const progress = parsed({
      s3: {
        entries: [
          flow('fl-0aaaaaaaaaaaaaaaa', '2026-11-23T11:00:00Z'),
          flow('fl-0bbbbbbbbbbbbbbbb', '2026-11-23T11:50:00Z'),
        ],
      },
    });
    const ref: WazuhMarkerRef = {
      method: 's3',
      table: 'vpcflow',
      bucketPath: 'fluxo/',
      accountId: ACCOUNT,
      regions: ['sa-east-1'],
      flowLogId: 'fl-0aaaaaaaaaaaaaaaa',
    };
    expect(findWazuhMarker(progress, ref)).toMatchObject({
      marker: { lastKey: 'chave-fl-0aaaaaaaaaaaaaaaa' },
    });
    expect(findWazuhMarker(progress, { ...ref, flowLogId: 'fl-0cccccccccccccccc' })).toEqual({
      known: true,
      marker: null,
    });
  });

  it('o grupo de logs: o último evento lido, ou só a passagem do módulo por ele', () => {
    const progress = parsed({
      cloudwatch: {
        entries: [
          { region: 'sa-east-1', logGroup: '/aws/lambda/cobranca', endTime: 1793527200000, streams: 2 },
          { region: 'sa-east-1', logGroup: '/aws/lambda/quieto', endTime: null, streams: 1 },
        ],
      },
    });
    const ref = (logGroup: string, region = 'sa-east-1'): WazuhMarkerRef => ({
      method: 'cloudwatch',
      region,
      logGroup,
    });
    expect(findWazuhMarker(progress, ref('/aws/lambda/cobranca'))).toEqual({
      known: true,
      marker: { ingestedAt: null, eventAt: new Date(1793527200000), lastKey: null, region: 'sa-east-1' },
    });
    expect(findWazuhMarker(progress, ref('/aws/lambda/quieto'))).toMatchObject({ marker: { eventAt: null } });
    expect(findWazuhMarker(progress, ref('/aws/lambda/outro'))).toEqual({ known: true, marker: null });
    // O mesmo nome noutra região é outro grupo.
    expect(findWazuhMarker(progress, ref('/aws/lambda/cobranca', 'us-east-1'))).toEqual({
      known: true,
      marker: null,
    });
  });

  it('o que não dá para saber não vira "nada lido": o banco travado, com erro, ou a parte cortada', () => {
    const group: WazuhMarkerRef = {
      method: 'cloudwatch',
      region: 'sa-east-1',
      logGroup: '/aws/lambda/cobranca',
    };
    for (const status of ['locked', 'error']) {
      const progress = parsed({ s3: { status }, cloudwatch: { status } });
      expect(findWazuhMarker(progress, trailRef)).toEqual({ known: false });
      expect(findWazuhMarker(progress, group)).toEqual({ known: false });
    }
    // O banco que ainda não existe: o módulo nunca leu nada.
    const missing = parsed({ s3: { status: 'missing' }, cloudwatch: { status: 'missing' } });
    expect(findWazuhMarker(missing, trailRef)).toEqual({ known: true, marker: null });
    expect(findWazuhMarker(missing, group)).toEqual({ known: true, marker: null });
    // Cortada: a fonte que está na parte é conhecida; a que não está pode ter ficado de fora.
    const truncated = parsed({ s3: { truncated: true, entries: [s3()] }, cloudwatch: { truncated: true } });
    expect(findWazuhMarker(truncated, trailRef)).toMatchObject({ known: true });
    expect(findWazuhMarker(truncated, { ...trailRef, bucketPath: 'outra/' })).toEqual({ known: false });
    expect(findWazuhMarker(truncated, group)).toEqual({ known: false });
  });
});
