import { describe, expect, it } from 'vitest';
import { legacyDetectionsUrl } from './legacy-url';
import {
  activeFilterCount,
  CASE_FILTER_KEYS,
  caseQueueSlug,
  casesSearch,
  caseSortSlug,
  caseStateSlug,
  dayBoundary,
  DETECTION_PARAMS,
  groupingSlug,
  parentCaseOf,
  readCaseState,
  readDetectionState,
  selectionSearch,
  viewIsDecided,
  viewParam,
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

const CASE = '018f2c1e-0000-7000-8000-0000000ca5e1';

describe('os casos na URL', () => {
  const view = (search: string, mode: 'off' | 'shadow' | 'on') =>
    readDetectionState(new URLSearchParams(search), mode).view;

  it('desligados: a tela é a de sempre, seja qual for o endereço', () => {
    for (const search of [
      '',
      'visao=casos',
      'visao=vulnerabilidades',
      'visao=alertas',
      'visao=achados',
      'visao=x',
    ]) {
      expect(view(search, 'off'), search).toBe('alerts');
    }
    expect(view('visao=incidentes', 'off')).toBe('incidents');
    expect(readDetectionState(new URLSearchParams(`caso=${CASE}`), 'off').selection).toBeNull();
  });

  it('ligados: sem visão, os casos; as outras pelo nome; o que não se conhece são os alertas', () => {
    expect(view('', 'on')).toBe('cases');
    expect(view('visao=casos', 'on')).toBe('cases');
    expect(view('visao=vulnerabilidades', 'on')).toBe('vulnerabilities');
    expect(view('visao=alertas', 'on')).toBe('alerts');
    expect(view('visao=achados', 'on')).toBe('alerts');
    expect(view('visao=incidentes', 'on')).toBe('incidents');
    expect(view('visao=x', 'on')).toBe('alerts');
  });

  it('ligados: o endereço com status (um atalho de antes) é a lista de alertas, a única que tem status', () => {
    expect(view('status=new', 'on')).toBe('alerts');
    expect(view('severidade=high', 'on')).toBe('cases');
    expect(view('status=', 'on')).toBe('cases');
    expect(view('visao=casos&status=new', 'on')).toBe('cases');
  });

  it('na medição, o padrão continua a ser os alertas, e os casos abrem pelo nome', () => {
    expect(view('', 'shadow')).toBe('alerts');
    expect(view('visao=casos', 'shadow')).toBe('cases');
    expect(view('visao=vulnerabilidades', 'shadow')).toBe('vulnerabilities');
  });

  it('a visão que não depende de haver casos já está decidida', () => {
    for (const search of ['visao=alertas', 'visao=achados', 'visao=incidentes', 'visao=x']) {
      expect(viewIsDecided(new URLSearchParams(search)), search).toBe(true);
    }
    for (const search of ['', 'status=new', 'visao=casos', 'visao=vulnerabilidades']) {
      expect(viewIsDecided(new URLSearchParams(search)), search).toBe(false);
    }
  });

  it('o `visao` de cada lista, que volta a ser lido como ela', () => {
    for (const mode of ['off', 'shadow', 'on'] as const) {
      const views =
        mode === 'off'
          ? (['alerts', 'incidents'] as const)
          : (['cases', 'alerts', 'incidents', 'vulnerabilities'] as const);
      for (const value of views) {
        const param = viewParam(value, mode);
        expect(view(param === null ? '' : `visao=${param}`, mode), `${mode} ${value}`).toBe(value);
      }
    }
    // A lista padrão não leva parâmetro.
    expect(viewParam('alerts', 'off')).toBeNull();
    expect(viewParam('alerts', 'shadow')).toBeNull();
    expect(viewParam('cases', 'on')).toBeNull();
  });

  it('o alerta, o incidente e o caso abrem o painel sobre qualquer lista; um por vez, o caso por último', () => {
    const selection = (search: string) => readDetectionState(new URLSearchParams(search), 'on').selection;
    expect(selection(`visao=incidentes&caso=${CASE}`)).toEqual({ kind: 'case', id: CASE });
    expect(selection(`caso=${CASE}&alerta=${FINDING}`)).toEqual({ kind: 'finding', id: FINDING });
    expect(selection(`caso=${CASE}&achado=${FINDING}`)).toEqual({ kind: 'finding', id: FINDING });
    expect(selection(`caso=${CASE}&incidente=${INCIDENT}`)).toEqual({ kind: 'incident', id: INCIDENT });
    expect(selection('caso=nao-uuid')).toBeNull();
  });

  it('o que foi aberto de dentro de um caso volta para ele', () => {
    const parent = (search: string) => {
      const params = new URLSearchParams(search);
      return parentCaseOf(params, readDetectionState(params, 'on').selection);
    };
    expect(parent(`caso=${CASE}&alerta=${FINDING}`)).toBe(CASE);
    expect(parent(`caso=${CASE}&incidente=${INCIDENT}`)).toBe(CASE);
    expect(parent(`caso=${CASE}`)).toBeNull();
    expect(parent(`alerta=${FINDING}`)).toBeNull();
    expect(parent(`caso=x&alerta=${FINDING}`)).toBeNull();
    expect(parent('')).toBeNull();
    // O alerta aberto de dentro do caso guarda o caso no endereço; o caso aberto sozinho tira os outros.
    expect(selectionSearch(new URLSearchParams(`caso=${CASE}`), { kind: 'finding', id: FINDING })).toBe(
      `?caso=${CASE}&alerta=${FINDING}`,
    );
    expect(
      selectionSearch(new URLSearchParams(`caso=${CASE}&alerta=${FINDING}`), { kind: 'case', id: CASE }),
    ).toBe(`?caso=${CASE}`);
    expect(selectionSearch(new URLSearchParams(`caso=${CASE}&alerta=${FINDING}`), null)).toBe('');
  });

  it('a situação, a ordem, a fila e o agrupamento: em português, e o padrão sem parâmetro', () => {
    expect(readCaseState(new URLSearchParams(''))).toEqual({
      state: 'pending',
      sort: 'priority',
      queue: 'detection',
      grouping: 'package',
    });
    expect(
      readCaseState(new URLSearchParams('estado=tratados&ordem=volume&fila=postura&agrupar=sem-grupo')),
    ).toEqual({ state: 'treated', sort: 'volume', queue: 'posture', grouping: 'none' });
    // A ordem dos incidentes e os valores desconhecidos não valem aqui.
    expect(
      readCaseState(new URLSearchParams('estado=x&ordem=severidade&fila=vulnerability&agrupar=x')),
    ).toEqual({
      state: 'pending',
      sort: 'priority',
      queue: 'detection',
      grouping: 'package',
    });
    for (const state of ['pending', 'investigating', 'treated', 'all'] as const) {
      const slug = caseStateSlug(state);
      expect(readCaseState(new URLSearchParams(slug === null ? '' : { estado: slug })).state).toBe(state);
    }
    for (const sort of ['priority', 'recent', 'volume'] as const) {
      const slug = caseSortSlug(sort);
      expect(readCaseState(new URLSearchParams(slug === null ? '' : { ordem: slug })).sort).toBe(sort);
    }
    for (const queue of ['detection', 'posture'] as const) {
      const slug = caseQueueSlug(queue);
      expect(readCaseState(new URLSearchParams(slug === null ? '' : { fila: slug })).queue).toBe(queue);
    }
    for (const grouping of ['package', 'resource', 'account', 'none'] as const) {
      const slug = groupingSlug(grouping);
      expect(readCaseState(new URLSearchParams(slug === null ? '' : { agrupar: slug })).grouping).toBe(
        grouping,
      );
    }
  });

  it('"Limpar filtros" dos casos tira os filtros e a situação; a fila e o agrupamento ficam', () => {
    const params = new URLSearchParams(
      'visao=vulnerabilidades&agrupar=recurso&fila=postura&severidade=high&estado=em-analise&busca=x',
    );
    const cleared = withChanges(params, Object.fromEntries(CASE_FILTER_KEYS.map((key) => [key, null])));
    expect(cleared.toString()).toBe('visao=vulnerabilidades&agrupar=recurso&fila=postura');
    expect(CASE_FILTER_KEYS.map((key) => DETECTION_PARAMS[key])).not.toContain('fila');
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
    ['/achados', '', '/?visao=alertas'],
    [
      '/achados',
      `?severidade=high&status=new&conta=111122223333&periodo=24h&achado=${FINDING}`,
      `/?visao=alertas&severidade=high&status=new&conta=111122223333&periodo=24h&alerta=${FINDING}`,
    ],
    ['/relatorios', '', '/?analise=resumo'],
    ['/relatorios', '?aba=mitre&periodo=90d', '/?analise=mitre&periodo=90d'],
    // A cobertura e as exceções saíram de Detecções (26/11/2026): o endereço antigo leva às telas que ficaram.
    ['/relatorios', '?aba=cobertura', '/cadastros/contas'],
    ['/relatorios', '?aba=incidentes&periodo=90d', '/?analise=resposta&periodo=90d'],
    ['/relatorios', '?aba=deteccoes', '/?analise=regras'],
    ['/relatorios', '?aba=entidades', '/?analise=entidades'],
    ['/relatorios', '?aba=excecoes', '/cadastros/excecoes'],
    ['/incidentes/', '', '/?visao=incidentes'],
  ])('%s%s → %s', (path, search, target) => {
    expect(legacyDetectionsUrl(path, search)).toBe(target);
  });
});

describe('atalhos da situação para a lista de casos', () => {
  it('com eles ligados, o endereço curto; na medição, a visão pelo nome', () => {
    expect(casesSearch('on')).toBe('');
    expect(casesSearch('on', { queue: 'posture' })).toBe('?fila=postura');
    expect(casesSearch('on', { state: 'all', period: '24h' })).toBe('?estado=todos&periodo=24h');
    expect(casesSearch('shadow', { state: 'all', period: '24h' })).toBe(
      '?visao=casos&estado=todos&periodo=24h',
    );
  });

  it('a tela lê de volta o que o atalho diz', () => {
    for (const mode of ['on', 'shadow'] as const) {
      const params = new URLSearchParams(
        casesSearch(mode, { state: 'all', queue: 'posture', period: '24h' }),
      );
      expect(readDetectionState(params, mode)).toMatchObject({ view: 'cases', periodChoice: '24h' });
      expect(readCaseState(params)).toMatchObject({ state: 'all', queue: 'posture' });
    }
  });
});
