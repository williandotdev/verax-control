import {
  caseListQuerySchema,
  type CaseSummary,
  TRIAGE_ACTIONS,
  TRIAGE_STATES,
  TRIAGE_STOPS,
  TRIAGE_WARNINGS,
  type TriageOperationDetail,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { toSearch } from '@/features/detections/detections-api';
import { readCaseState, readDetectionState } from '@/features/detections/url-state';
import { caseListQuery } from './case-query';
import { caseName, groupingText, keyPartRows, mainSubjects, recurrenceLabel, sealLabel } from './labels';
import {
  isActive,
  OPERATION_STATE_LABELS,
  operationTitle,
  progressOf,
  progressText,
  resultText,
  stopText,
  targetText,
  warningText,
} from './operation-text';
import { viewsOf } from './views';

describe('os textos de um caso', () => {
  it('as partes da chave: com o nome em português, a rede sem o prefixo e a fonte pelo nome', () => {
    expect(
      keyPartRows([
        { name: 'network', value: 'ipv4:203.0.113.0/24' },
        { name: 'network', value: 'ipv6:2001:db8:0:1::/64' },
        { name: 'source', value: 'guardduty' },
        { name: 'source', value: 'fonte-que-nao-existe' },
        { name: 'package', value: 'ipv4:nao-e-rede' },
        { name: 'parte-nova', value: 'x' },
        { name: 'fold', value: 'distributed' },
      ]),
    ).toEqual([
      { label: 'Rede de origem', value: '203.0.113.0/24' },
      { label: 'Rede de origem', value: '2001:db8:0:1::/64' },
      { label: 'Fonte', value: 'GuardDuty' },
      { label: 'Fonte', value: 'fonte-que-nao-existe' },
      { label: 'Pacote', value: 'ipv4:nao-e-rede' },
      // A parte que o painel não conhece aparece pelo nome dela.
      { label: 'parte-nova', value: 'x' },
    ]);
  });

  const key = (overrides: Partial<CaseSummary>) =>
    groupingText({ queue: 'detection', keyParts: [], sealedAt: null, sealReason: null, ...overrides }).join(
      ' ',
    );

  it('como os alertas foram agrupados, em português', () => {
    expect(key({})).toMatch(/nunca dividem um caso com os médios e baixos\..*até 24 horas, e por até 7 dias/);
    expect(key({ queue: 'posture' })).toMatch(/postura fica aberto até ser tratado/);
    expect(key({ queue: 'vulnerability' })).toMatch(/um pacote num recurso/);
    expect(key({ queue: 'vulnerability' })).not.toMatch(/médios e baixos/);
    for (const [fold, text] of [
      ['distributed', /redes de origem demais/],
      ['overflow', /limite diário de casos críticos/],
      ['rollup', /médios e baixos desta fonte/],
    ] as const) {
      expect(key({ keyParts: [{ name: 'fold', value: fold }] })).toMatch(text);
    }
    // Uma reunião que o painel não conhece não vira texto do evento.
    expect(key({ keyParts: [{ name: 'fold', value: '<b>x</b>' }] })).not.toContain('<b>');
    expect(key({ sealedAt: '2026-11-24T10:00:00.000Z', sealReason: 'split' })).toMatch(/caso dividido/);
    expect(key({ sealedAt: '2026-11-24T10:00:00.000Z', sealReason: null })).toMatch(
      /Não recebe mais alertas/,
    );
    expect(sealLabel('treated')).toBe('tratado');
    expect(sealLabel(null)).toBe('fechado');
  });

  it('"voltou depois de tratado" só quando se sabe: na detecção, a chave também volta quando a janela passa', () => {
    expect(recurrenceLabel({ queue: 'detection', recurrence: 0 })).toBeNull();
    expect(recurrenceLabel({ queue: 'detection', recurrence: 2 })).toBe('Voltou (2×)');
    expect(recurrenceLabel({ queue: 'vulnerability', recurrence: 2 })).toBe('Voltou depois de tratado (2×)');
    expect(recurrenceLabel({ queue: 'posture', recurrence: 1 })).toBe('Voltou depois de tratado (1×)');
    // No detalhe, os casos anteriores dizem.
    expect(recurrenceLabel({ queue: 'detection', recurrence: 3 }, 1)).toBe('Voltou depois de tratado (1×)');
    expect(recurrenceLabel({ queue: 'detection', recurrence: 3 }, 0)).toBe('Voltou (3×)');
  });

  it('o que identifica o caso: até dois, e "e outros" quando há mais de um valor', () => {
    const preview = { accounts: [], actors: ['ana', 'joao'], ips: ['203.0.113.1'], resources: ['i-1'] };
    expect(mainSubjects({ queue: 'detection', keyParts: [], preview })).toEqual([
      { label: 'Usuário', value: 'ana', more: true },
      { label: 'Recurso', value: 'i-1', more: false },
    ]);
    const parts = [
      { name: 'package', value: 'openssl' },
      { name: 'resource', value: 'i-2' },
    ];
    expect(mainSubjects({ queue: 'vulnerability', keyParts: parts, preview })).toEqual([
      { label: 'Pacote', value: 'openssl', more: false },
      { label: 'Recurso', value: 'i-2', more: false },
    ]);
    expect(caseName({ title: 'Vulnerabilidade', queue: 'vulnerability', keyParts: parts, preview })).toBe(
      'Vulnerabilidade, openssl, i-2',
    );
  });
});

describe('a pergunta da lista de casos', () => {
  const ask = (search: string, view: 'cases' | 'vulnerabilities' = 'cases') => {
    const params = new URLSearchParams(search);
    const query = caseListQuery({
      view,
      filters: readDetectionState(params, 'on').filters,
      cases: readCaseState(params),
      page: readDetectionState(params, 'on').page,
      pageSize: 20,
    });
    // O que sai na URL é o que a API aceita.
    expect(
      caseListQuerySchema.safeParse(Object.fromEntries(new URLSearchParams(toSearch(query)))).success,
      search,
    ).toBe(true);
    return query;
  };

  it('a fila é da visão, e o status dos alertas nunca vai', () => {
    expect(ask('')).toMatchObject({ queue: 'detection', state: 'pending', sort: 'priority', page: 1 });
    expect(ask('fila=postura&status=new')).toMatchObject({ queue: 'posture' });
    expect(ask('status=new')).not.toHaveProperty('status');
    expect(ask('fila=postura', 'vulnerabilities')).toMatchObject({ queue: 'vulnerability' });
  });

  it('a severidade só vai com o que está pendente: a API recusa nos outros estados', () => {
    expect(ask('severidade=high')).toMatchObject({ severity: 'high' });
    expect(ask('severidade=high&estado=em-analise')).toMatchObject({ severity: 'high' });
    expect(ask('severidade=high&estado=tratados').severity).toBeUndefined();
    expect(ask('severidade=high&estado=todos').severity).toBeUndefined();
  });

  it('agrupada, a fila de vulnerabilidades só leva o que se vê ali; sem agrupar, leva tudo', () => {
    const url =
      'estado=tratados&fonte=guardduty&tatica=Impact&periodo=7d&severidade=high&busca=ssl&conta=111122223333';
    expect(ask(`${url}&ordem=volume`, 'vulnerabilities')).toEqual({
      queue: 'vulnerability',
      state: 'pending',
      sort: 'priority',
      severity: 'high',
      accountId: '111122223333',
      q: 'ssl',
      page: 1,
      pageSize: 20,
    });
    expect(ask('estado=em-analise', 'vulnerabilities').state).toBe('investigating');
    expect(ask(`${url}&agrupar=sem-grupo`, 'vulnerabilities')).toMatchObject({
      state: 'treated',
      source: 'guardduty',
      tactic: 'Impact',
      severity: undefined,
    });
  });

  it('a página não passa do que a API aceita', () => {
    expect(ask('pagina=99999').page).toBe(10_000);
  });

  it('os outros filtros em comum com as outras listas', () => {
    expect(
      ask(
        'fonte=guardduty&conta=111122223333&tatica=Credential+Access&tecnica=T1078&busca=ana&ordem=volume&estado=todos',
      ),
    ).toMatchObject({
      source: 'guardduty',
      accountId: '111122223333',
      tactic: 'Credential Access',
      technique: 'T1078',
      q: 'ana',
      sort: 'volume',
      state: 'all',
    });
  });
});

describe('as visões da lista', () => {
  it('sem os casos, as de sempre; com eles (ou na medição), as quatro', () => {
    expect(viewsOf('off', true)).toEqual(['alerts', 'incidents']);
    expect(viewsOf('off', false)).toEqual(['alerts']);
    expect(viewsOf('on', true)).toEqual(['cases', 'alerts', 'incidents', 'vulnerabilities']);
    expect(viewsOf('shadow', true)).toEqual(['cases', 'alerts', 'incidents', 'vulnerabilities']);
    expect(viewsOf('on', false)).toEqual(['cases', 'alerts', 'vulnerabilities']);
  });
});

describe('os textos de uma operação', () => {
  it('todo tipo, estado, parada e aviso do contrato tem texto', () => {
    for (const action of TRIAGE_ACTIONS) {
      expect(operationTitle({ action, status: null }).length).toBeGreaterThan(3);
    }
    expect(operationTitle({ action: 'status', status: 'legitimate' })).toBe('Marcar como legítimo');
    for (const state of TRIAGE_STATES) expect(OPERATION_STATE_LABELS[state]).toBeTruthy();
    for (const stop of TRIAGE_STOPS) expect(stopText(stop)).toMatch(/\.$/);
    for (const warning of TRIAGE_WARNINGS)
      expect(warningText(warning, { excludedCritical: 2 })).toMatch(/\.$/);
    expect(warningText('critical_excluded', { excludedCritical: 1 })).toBe('1 alerta crítico ficou de fora.');
    expect(warningText('critical_excluded', { excludedCritical: 2 })).toBe(
      '2 alertas críticos ficaram de fora.',
    );
  });

  it('só a fila e a em curso andam', () => {
    expect(TRIAGE_STATES.filter((state) => isActive({ state }))).toEqual(['queued', 'running']);
  });

  it('o andamento', () => {
    expect(progressOf({ matched: 200, remaining: 50 })).toBe(0.75);
    expect(progressOf({ matched: 0, remaining: 0 })).toBe(1);
    expect(progressOf({ matched: 10, remaining: 30 })).toBe(0);
    expect(progressText({ matched: 1_240, remaining: 240 })).toBe('1.000 de 1.240 alertas');
  });

  const result = (
    overrides: Partial<Pick<TriageOperationDetail, 'action' | 'changed' | 'skipped' | 'failed'>>,
  ) => resultText({ action: 'status', changed: 0, skipped: 0, failed: 0, ...overrides });

  it('o resultado: mudados, pulados e o que falhou (que está dentro dos pulados)', () => {
    expect(result({ changed: 1 })).toBe('1 alerta mudou.');
    expect(result({ changed: 40, skipped: 5, failed: 3 })).toBe(
      '40 alertas mudaram, 2 pulados (mudaram no meio do caminho), 3 não puderam ser gravados.',
    );
    expect(result({ action: 'undo', changed: 2 })).toBe('2 alertas voltaram ao que eram.');
    expect(result({ action: 'undo_all_of', changed: 2, skipped: 1 })).toBe(
      '2 operações vão ser desfeitas; 1 não podia mais ser desfeita.',
    );
  });

  it('o alvo, com o filtro em palavras', () => {
    expect(targetText({ kind: 'cases', caseIds: ['a', 'b'], group: null })).toBe('2 casos');
    expect(targetText({ kind: 'cases', caseIds: ['a'], group: 'openssl' })).toBe('grupo openssl de 1 caso');
    expect(targetText({ kind: 'findings', count: 3 })).toBe('3 alertas da lista');
    expect(
      targetText({
        kind: 'filter',
        filter: {
          queue: 'vulnerability',
          severity: 'high',
          source: 'inspector',
          groupBy: 'package',
          group: 'openssl',
          q: 'x',
        },
      }),
    ).toBe('casos do filtro: vulnerabilidades, severidade alta, Inspector, busca "x", pacote openssl');
    expect(targetText({ kind: 'filter', filter: { groupBy: 'resource' } })).toBe(
      'casos do filtro: recurso (sem valor)',
    );
    // Um valor de outra versão não vira rótulo inventado.
    expect(targetText({ kind: 'filter', filter: { queue: 'nova', severity: 'x' } })).toBe('casos do filtro');
  });
});
