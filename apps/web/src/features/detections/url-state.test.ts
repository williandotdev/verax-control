import { describe, expect, it } from 'vitest';
import { legacyDetectionsUrl } from './legacy-url';
import {
  activeFilterCount,
  dayBoundary,
  readDetectionState,
  selectionSearch,
  withChanges,
} from './url-state';

const INCIDENT = '018f2c1e-0000-7000-8000-0000000a0001';
const FINDING = '018f2c1e-0000-7000-8000-000000001001';

const read = (search: string) => readDetectionState(new URLSearchParams(search));

describe('estado da tela Detecções na URL', () => {
  it('sem nada: a lista de alertas, todo o histórico, a mais recente primeiro, página 1, nada aberto', () => {
    expect(read('')).toEqual({
      view: 'alerts',
      analysis: 'list',
      periodChoice: undefined,
      customDates: { from: '', to: '' },
      filters: {
        severity: undefined,
        status: undefined,
        source: undefined,
        accountId: undefined,
        tactic: undefined,
        technique: undefined,
        q: undefined,
        unassigned: undefined,
      },
      sort: 'recent',
      page: 1,
      selection: null,
    });
  });

  it('lê cada filtro em português e normaliza a técnica', () => {
    const state = read(
      'visao=incidentes&periodo=7d&severidade=high&status=new&fonte=guardduty&conta=111122223333&tatica=Credential+Access&tecnica=t1078.004&busca=+ana+&responsavel=nenhum&ordem=severidade&pagina=3',
    );
    expect(state.view).toBe('incidents');
    expect(state.periodChoice).toBe('7d');
    expect(state.filters).toMatchObject({
      severity: 'high',
      status: 'new',
      source: 'guardduty',
      accountId: '111122223333',
      tactic: 'Credential Access',
      technique: 'T1078.004',
      q: 'ana',
      unassigned: 'true',
    });
    expect(state.sort).toBe('severity');
    expect(state.page).toBe(3);
  });

  it('valor desconhecido é ignorado, nunca enviado à API', () => {
    const state = read(
      'visao=x&analise=y&periodo=2d&severidade=info&status=closed&fonte=vpc&conta=123&tatica=Hacking&tecnica=T10&busca=&responsavel=sim&ordem=risco&pagina=-2&incidente=nao-uuid&achado=1',
    );
    expect(state.view).toBe('alerts');
    expect(state.analysis).toBe('list');
    expect(state.periodChoice).toBeUndefined();
    expect(Object.values(state.filters).every((value) => value === undefined)).toBe(true);
    expect(state.sort).toBe('recent');
    expect(state.page).toBe(1);
    expect(state.selection).toBeNull();
  });

  it('o intervalo personalizado vale com as duas datas, no começo e no fim do dia de quem escolheu', () => {
    const state = read('periodo=personalizado&de=2026-11-01&ate=2026-11-07');
    expect(state.periodChoice).toBe('custom');
    expect(state.customDates).toEqual({ from: '2026-11-01', to: '2026-11-07' });
    expect(state.filters.from).toBe(new Date(2026, 10, 1, 0, 0, 0, 0).toISOString());
    expect(state.filters.to).toBe(new Date(2026, 10, 7, 23, 59, 59, 999).toISOString());
    // Só uma ponta, invertido ou data impossível: sem intervalo (a tela pede as duas datas).
    expect(read('periodo=personalizado&de=2026-11-01').filters.from).toBeUndefined();
    expect(read('periodo=personalizado&de=2026-11-08&ate=2026-11-01').filters.from).toBeUndefined();
    expect(dayBoundary('2026-02-31', 'start')).toBeUndefined();
    // Sem "personalizado", as datas da URL não valem.
    expect(read('de=2026-11-01&ate=2026-11-07').filters.from).toBeUndefined();
  });

  it('a seleção: o incidente ou o alerta (o alerta ganha, se vierem os dois)', () => {
    expect(read(`incidente=${INCIDENT}`).selection).toEqual({ kind: 'incident', id: INCIDENT });
    expect(read(`incidente=${INCIDENT}&alerta=${FINDING}`).selection).toEqual({
      kind: 'finding',
      id: FINDING,
    });
  });

  it('os endereços de antes de 17/11/2026: `visao=achados` é a lista de alertas e `achado=<id>` abre o alerta', () => {
    expect(read(`visao=achados&achado=${FINDING}`)).toMatchObject({
      view: 'alerts',
      selection: { kind: 'finding', id: FINDING },
    });
    expect(read('visao=alertas').view).toBe('alerts');
    // Abrir outro item tira o nome de antes do parâmetro.
    expect(
      selectionSearch(new URLSearchParams(`achado=${FINDING}`), { kind: 'incident', id: INCIDENT }),
    ).toBe(`?incidente=${INCIDENT}`);
  });

  it('mudar um filtro volta para a página 1; abrir um item mantém a página e os filtros', () => {
    const params = new URLSearchParams('severidade=high&pagina=3');
    expect(withChanges(params, { status: 'new' }).toString()).toBe('severidade=high&status=new');
    expect(withChanges(params, { severity: null }, { keepPage: true }).toString()).toBe('pagina=3');
    expect(selectionSearch(params, { kind: 'finding', id: FINDING })).toBe(
      `?severidade=high&pagina=3&alerta=${FINDING}`,
    );
    expect(
      selectionSearch(new URLSearchParams(`alerta=${FINDING}`), { kind: 'incident', id: INCIDENT }),
    ).toBe(`?incidente=${INCIDENT}`);
    expect(selectionSearch(new URLSearchParams(`alerta=${FINDING}`), null)).toBe('');
  });

  it('conta os filtros em uso (o intervalo conta uma vez)', () => {
    expect(
      activeFilterCount(new URLSearchParams('periodo=personalizado&de=2026-11-01&ate=2026-11-02&busca=x')),
    ).toBe(2);
    expect(activeFilterCount(new URLSearchParams('visao=achados&pagina=2'))).toBe(0);
  });
});

describe('endereços de antes', () => {
  it.each([
    ['/incidentes', '', '/?visao=incidentes'],
    [
      '/incidentes',
      '?status=open&severidade=critical&responsavel=nenhum&pagina=2',
      '/?visao=incidentes&status=new&severidade=critical&responsavel=nenhum&pagina=2',
    ],
    ['/incidentes', '?status=investigating', '/?visao=incidentes&status=investigating'],
    [`/incidentes/${INCIDENT}`, '', `/?incidente=${INCIDENT}`],
    ['/incidentes/nao-e-id', '', '/'],
    ['/achados', '', '/'],
    [
      '/achados',
      `?severidade=high&status=new&conta=111122223333&periodo=24h&achado=${FINDING}`,
      `/?severidade=high&status=new&conta=111122223333&periodo=24h&alerta=${FINDING}`,
    ],
    ['/relatorios', '', '/?analise=resumo'],
    ['/relatorios', '?aba=mitre&periodo=90d', '/?analise=mitre&periodo=90d'],
    ['/relatorios', '?aba=cobertura', '/?analise=cobertura'],
    ['/relatorios', '?aba=incidentes&periodo=90d', '/?analise=resposta&periodo=90d'],
    ['/relatorios', '?aba=deteccoes', '/?analise=regras'],
    ['/relatorios', '?aba=entidades', '/?analise=entidades'],
    ['/relatorios', '?aba=excecoes', '/?analise=excecoes'],
    ['/incidentes/', '', '/?visao=incidentes'],
  ])('%s%s → %s', (path, search, target) => {
    expect(legacyDetectionsUrl(path, search)).toBe(target);
  });
});
