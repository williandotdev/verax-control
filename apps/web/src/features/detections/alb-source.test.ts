import { type Finding, FINDING_SOURCES, findingSchema, radarSectorOf } from '@verax/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINDING_SOURCE_LABELS } from '@/features/findings/labels';
import { actionLabel } from '@/features/audit/labels';
import { api } from '@/lib/api';
import { exportFindings } from './export';
import { DETECTION_PARAMS, readDetectionState } from './url-state';

/** A fonte dos logs do ALB na tela Detecções: o nome, o filtro pela URL, a planilha e o radar. */

const ALB: Finding = findingSchema.parse({
  id: '018f2c1e-0000-7000-8000-000000001001',
  accountId: '111111111111',
  occurredAt: '2026-11-24T12:00:00.000Z',
  severity: 'high',
  status: 'new',
  title: 'Força bruta numa rota de login por um mesmo endereço',
  source: 'alb',
  eventName: 'falhas de login',
  region: 'sa-east-1',
  resource: 'alb:app/loja/0123456789abcdef',
  actor: { user: null, type: null, accessKeyId: null, ip: '203.0.113.7' },
  mitreTactics: ['Credential Access'],
  incidentId: null,
  commentCount: 0,
});

afterEach(() => vi.restoreAllMocks());

describe('fonte dos logs do ALB', () => {
  it('toda fonte tem nome, e a do ALB é da AWS no radar', () => {
    for (const source of FINDING_SOURCES) expect(FINDING_SOURCE_LABELS[source]).toMatch(/\S/);
    expect(FINDING_SOURCE_LABELS.alb).toBe('ALB (logs de acesso)');
    expect(radarSectorOf('alb')).toBe('aws');
  });

  it('o filtro vem da URL; uma fonte que o painel não conhece é ignorada', () => {
    const read = (value: string) =>
      readDetectionState(new URLSearchParams({ [DETECTION_PARAMS.source]: value })).filters.source;
    expect(read('alb')).toBe('alb');
    expect(read('fonte_que_nao_existe')).toBeUndefined();
  });

  it('a planilha leva o nome da fonte, o IP e o balanceador', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ items: [ALB], total: 1, page: 1, pageSize: 100 });
    const { csv, rows } = await exportFindings({});
    expect(rows).toBe(1);
    expect(csv).toContain('ALB (logs de acesso)');
    expect(csv).toContain('203.0.113.7');
    expect(csv).toContain('alb:app/loja/0123456789abcdef');
  });

  it('cada ação da configuração tem texto na trilha', () => {
    for (const action of [
      'web_logs.settings_update',
      'web_logs.estimate_request',
      'web_logs.trusted_source_create',
      'web_logs.trusted_source_update',
      'web_logs.trusted_source_delete',
      'web_logs.route_create',
      'web_logs.route_update',
      'web_logs.route_delete',
    ]) {
      expect(actionLabel(action)).not.toBe(action);
    }
  });
});
