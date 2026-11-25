import {
  AWS_CONNECTION_ERROR_CODES,
  AWS_SOURCE_PERMISSION_CODES,
  WEB_LOGS_ERROR_CODES,
  WEB_MULTIPLIER_BOUNDS,
  WEB_ROUTE_KINDS,
  WEB_ROUTE_METHODS,
  WEB_ROUTES_LIMIT,
  WEB_SOURCE_MODES,
  WEB_TRUSTED_KINDS,
  WEB_TRUSTED_LIMIT,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@/lib/api-client';
import {
  clientClassText,
  EVIDENCE_COUNTERS,
  evidenceNoteText,
  probeFamilyText,
  routeText,
  statusText,
  uaFamilyText,
} from './evidence-labels';
import {
  DETECTION_LIMITS,
  engineNoteText,
  estimateErrorText,
  NEVER_SILENCED_RULES,
  severityOfLevel,
  SILENCED_RULES,
  WEB_LOGS_ERROR_TEXTS,
  WEB_MODE_LABELS,
  WEB_ROUTE_KIND_TEXTS,
  WEB_ROUTE_METHOD_LABELS,
  WEB_RULE_TEXTS,
  WEB_TRUSTED_KIND_TEXTS,
  webLogsErrorText,
  webRuleText,
  webRuleTitle,
} from './web-logs-labels';

/** O catálogo do motor (`apps/api/src/weblogs/`), copiado: o teste lembra de escrever o texto quando ele crescer. */
const RULES = ['990400', '990401', '990402', '990403', '990404', '990405', '990406', '990407'];
const ENGINE_NOTES = [
  'behind_proxy',
  'proxy_ranges_stale',
  'proxy_ranges_unavailable',
  'trusted_rejected',
  'truncated',
];
const EVIDENCE_NOTES = [
  'counts_are_floor',
  'counts_are_estimated',
  'late_object',
  'held_by_waf',
  'nat_like',
  'volume_only',
  'valid_account_possible',
  'client_not_direct',
  'bytes_include_headers',
];
const ESTIMATE_ERRORS = [
  'account_not_connected',
  'source_not_available',
  'invalid_details',
  'web_prefix_unsupported',
  'throttled',
  'NetworkError',
  'TimeoutError',
  's3:GetObject',
  'bucket_denied',
  'bucket_missing',
  'kms_denied',
];
/** Nomes que um objeto tem de nascença: nenhum deles é um código com texto. */
const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

const hasText = (text: string | null) => expect(text ?? '').toMatch(/\S/);

describe('textos dos ataques web', () => {
  it('toda regra tem o título e a explicação; a desconhecida aparece pelo número', () => {
    expect(Object.keys(WEB_RULE_TEXTS).sort()).toEqual(RULES);
    for (const rule of RULES) {
      hasText(webRuleTitle(rule));
      hasText(webRuleText(rule));
    }
    for (const rule of ['990499', ...INHERITED]) {
      expect(webRuleTitle(rule)).toBe(`Regra ${rule}`);
      expect(webRuleText(rule)).toBeNull();
    }
  });

  it('a severidade de cada nível, na escala das outras regras', () => {
    expect([15, 12, 11, 10, 9, 7, 6, 4, 0].map(severityOfLevel)).toEqual([
      'critical',
      'critical',
      'high',
      'high',
      'medium',
      'medium',
      'low',
      'low',
      'low',
    ]);
  });

  it('o que a fonte confiável cala e o que nunca cala: cada regra de um lado só, e o resumo do dia em nenhum', () => {
    expect([...SILENCED_RULES]).toEqual(['990401', '990402', '990404', '990405']);
    expect([...NEVER_SILENCED_RULES]).toEqual(['990403', '990406', '990407']);
    expect([...SILENCED_RULES, ...NEVER_SILENCED_RULES, '990400'].sort()).toEqual(RULES);
  });

  it('todo valor da configuração tem o rótulo', () => {
    for (const mode of WEB_SOURCE_MODES) hasText(WEB_MODE_LABELS[mode]);
    for (const kind of WEB_ROUTE_KINDS) {
      hasText(WEB_ROUTE_KIND_TEXTS[kind].label);
      hasText(WEB_ROUTE_KIND_TEXTS[kind].hint);
    }
    for (const method of WEB_ROUTE_METHODS) hasText(WEB_ROUTE_METHOD_LABELS[method]);
    for (const kind of WEB_TRUSTED_KINDS) {
      hasText(WEB_TRUSTED_KIND_TEXTS[kind].label);
      hasText(WEB_TRUSTED_KIND_TEXTS[kind].hint);
    }
    expect(WEB_MULTIPLIER_BOUNDS).toEqual({ min: 0.5, max: 10 });
  });

  it('toda recusa da API tem o texto dela, e os tetos do texto são os do contrato', () => {
    for (const code of WEB_LOGS_ERROR_CODES) {
      hasText(WEB_LOGS_ERROR_TEXTS[code]);
      expect(webLogsErrorText(new ApiRequestError(409, 'mensagem da API', code))).toBe(
        WEB_LOGS_ERROR_TEXTS[code],
      );
    }
    expect(WEB_LOGS_ERROR_TEXTS.WEB_TRUSTED_LIMIT_REACHED).toContain(String(WEB_TRUSTED_LIMIT));
    expect(WEB_LOGS_ERROR_TEXTS.WEB_ROUTE_LIMIT_REACHED).toContain(String(WEB_ROUTES_LIMIT));
    // O 429 sem código é o de sempre; o 404 é o que saiu; o 400 diz o que foi recusado.
    expect(webLogsErrorText(new ApiRequestError(429, 'x'))).toBe(
      'Muitas tentativas. Aguarde alguns minutos.',
    );
    expect(webLogsErrorText(new ApiRequestError(404, 'x', 'WEB_LOGS_DISABLED'))).toMatch(/não existe mais/);
    expect(webLogsErrorText(new ApiRequestError(400, 'Dados inválidos'))).toBe('Dados inválidos');
    expect(
      webLogsErrorText(
        new ApiRequestError(400, 'Dados inválidos', undefined, undefined, [
          { path: 'cidr', message: 'faixa inválida' },
        ]),
      ),
    ).toBe('Dado recusado: faixa inválida.');
    expect(webLogsErrorText(new Error('rede'))).toMatch(/Não foi possível falar com o servidor/);
  });

  it('todo motivo da estimativa que falhou diz o que fazer, e o desconhecido aparece pelo nome do erro', () => {
    for (const code of [...ESTIMATE_ERRORS, ...AWS_SOURCE_PERMISSION_CODES, ...AWS_CONNECTION_ERROR_CODES]) {
      const text = estimateErrorText(code);
      expect(text, code).not.toContain('a AWS respondeu');
      // Entra numa frase que já tem o ponto final.
      expect(text.endsWith('.'), code).toBe(false);
    }
    expect(estimateErrorText('SlowDown')).toBe(
      'a AWS respondeu SlowDown. Peça de novo daqui a alguns minutos',
    );
    hasText(estimateErrorText(null));
    for (const code of INHERITED) expect(estimateErrorText(code)).toContain(code);
  });

  it('as notas do motor e da evidência: todas com texto, e a desconhecida pelo código', () => {
    for (const note of ENGINE_NOTES) {
      hasText(engineNoteText(note).title);
      hasText(engineNoteText(note).text);
    }
    expect(engineNoteText('uma_nota_nova')).toEqual({
      title: 'Aviso da leitura: uma_nota_nova.',
      text: null,
    });
    for (const note of EVIDENCE_NOTES) expect(evidenceNoteText(note)).not.toContain(note);
    expect(evidenceNoteText('uma_nota_nova')).toBe('Observação do servidor: uma_nota_nova.');
    for (const code of INHERITED) {
      expect(engineNoteText(code).text).toBeNull();
      expect(evidenceNoteText(code)).toBe(`Observação do servidor: ${code}.`);
    }
  });

  it('os códigos da evidência: o que a tela conhece em português, e o resto como veio', () => {
    expect(clientClassText('cloudfront')).toBe('CloudFront');
    expect(probeFamilyText('dump')).toBe('Cópias de banco e backups');
    expect(uaFamilyText('empty')).toBe('Sem User-Agent');
    // A ferramenta de ataque aparece pelo próprio nome.
    expect(uaFamilyText('sqlmap')).toBe('sqlmap');
    for (const code of ['codigo_novo', ...INHERITED]) {
      expect(clientClassText(code)).toBe(code);
      expect(probeFamilyText(code)).toBe(code);
      expect(uaFamilyText(code)).toBe(code);
    }
    expect(routeText('login', 'declared')).toBe('login, declarada por você');
    expect(routeText('login', null)).toBe('login');
    expect(routeText('tipo_novo', 'novo')).toBeNull();
    expect(routeText(null, null)).toBeNull();
    expect(statusText('-')).toBe('Sem resposta');
    expect(statusText('4xx')).toBe('Outros 4xx');
    expect(statusText('401')).toBe('401');
    expect(new Set(EVIDENCE_COUNTERS.map(({ key }) => key)).size).toBe(11);
  });

  it('os limites da detecção falam da CDN, do melhor esforço da AWS e do que o log não tem', () => {
    const text = DETECTION_LIMITS.map((limit) => `${limit.title} ${limit.text}`).join(' ');
    expect(text).toMatch(/CloudFront/);
    expect(text).toMatch(/melhor esforço/);
    expect(text).toMatch(/não traz senha, usuário/);
    expect(text).toMatch(/NLB/);
  });
});
