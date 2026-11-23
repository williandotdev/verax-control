import { describe, expect, it } from 'vitest';
import {
  awsFindingKey,
  guardDutyRuleDescription,
  guardDutyWazuhRule,
  wazuhNumberText,
} from './finding-keys.js';
import {
  ACCESS_ANALYZER_RULE,
  accessAnalyzerClass,
  accessAnalyzerSeverity,
  AWS_FINDING_RULES,
  inspectorSeverity,
  levelOfSeverity,
  securityHubSeverity,
} from './finding-rules.js';
import { severityOfLevel } from '../../alerts/finding-draft.js';

describe('chave dos achados da API da AWS', () => {
  it('o ID nativo que cabe entra como está, com a conta e o serviço', () => {
    expect(
      awsFindingKey(
        '111111111111',
        'inspector',
        'arn:aws:inspector2:sa-east-1:111111111111:finding/0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      ),
    ).toBe(
      'aws/111111111111/inspector:arn:aws:inspector2:sa-east-1:111111111111:finding/0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    );
    expect(awsFindingKey('111111111111', 'access-analyzer', 'sa-east-1/conta/1111-2222')).toBe(
      'aws/111111111111/access-analyzer:sa-east-1/conta/1111-2222',
    );
  });

  it('o ID que não cabe, ou com caractere fora do conjunto seguro, entra pelo resumo, sempre o mesmo', () => {
    const long = `arn:aws:securityhub:sa-east-1::product/aws/securityhub|${'x'.repeat(200)}`;
    const key = awsFindingKey('111111111111', 'securityhub', long);
    expect(key).toMatch(/^aws\/111111111111\/securityhub:sha256-[0-9a-f]{40}$/);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(awsFindingKey('111111111111', 'securityhub', long)).toBe(key);
    // O `|` (que separa o produto do ID) e o espaço não entram na chave como estão.
    expect(awsFindingKey('111111111111', 'securityhub', 'produto|id')).toMatch(/:sha256-[0-9a-f]{40}$/);
    expect(awsFindingKey('111111111111', 'access-analyzer', 'sa-east-1/nome com espaço/1')).toMatch(
      /:sha256-[0-9a-f]{40}$/,
    );
    // Outra conta, outra chave: o achado de um cliente nunca cai no de outro.
    expect(awsFindingKey('222222222222', 'securityhub', long)).not.toBe(key);
  });
});

describe('a regra do Wazuh de um achado do GuardDuty (a mesma chave do caminho do bucket)', () => {
  it('o número como o analysisd grava: inteiro como está, os outros com seis casas', () => {
    expect(wazuhNumberText(8)).toBe('8');
    expect(wazuhNumberText(8.0)).toBe('8');
    expect(wazuhNumberText(5.5)).toBe('5.500000');
    expect(wazuhNumberText(0)).toBe('0');
    expect(wazuhNumberText(10)).toBe('10');
  });

  it('a regra pela severidade, nas faixas de fábrica do Wazuh 4.14.9', () => {
    const cases: [number, string, number][] = [
      [1, '80301', 3],
      [2, '80301', 3],
      [3, '80301', 3],
      [4, '80302', 6],
      [5, '80302', 6],
      [6, '80302', 6],
      [7, '80303', 10],
      [8, '80303', 10],
      [9, '80303', 10],
    ];
    for (const [severity, id, level] of cases) {
      expect(guardDutyWazuhRule(severity, 'AWS_API_CALL'), String(severity)).toEqual({ id, level });
    }
  });

  it('o campo é comparado como texto, por trecho: os casos que fogem da faixa', () => {
    // 10 não tem 7, 8 nem 9, nem 4, 5 ou 6: cai na regra das baixas.
    expect(guardDutyWazuhRule(10, undefined)).toEqual({ id: '80301', level: 3 });
    // 5.5 é gravado "5.500000": casa a regra das médias pelo 5.
    expect(guardDutyWazuhRule(5.5, undefined)).toEqual({ id: '80302', level: 6 });
    // 3.7 é gravado "3.700000": o 7 casa a regra das altas, testada primeiro.
    expect(guardDutyWazuhRule(3.7, undefined)).toEqual({ id: '80303', level: 10 });
    expect(guardDutyWazuhRule(2.5, undefined)).toEqual({ id: '80302', level: 6 });
    expect(guardDutyWazuhRule(0, undefined)).toEqual({ id: '80301', level: 3 });
  });

  it('a sondagem de porta tem a regra filha de cada faixa', () => {
    expect(guardDutyWazuhRule(2, 'PORT_PROBE')).toEqual({ id: '80305', level: 3 });
    expect(guardDutyWazuhRule(5, 'PORT_PROBE')).toEqual({ id: '80306', level: 6 });
    expect(guardDutyWazuhRule(8, 'PORT_PROBE')).toEqual({ id: '80307', level: 10 });
    expect(guardDutyWazuhRule(8, 'NETWORK_CONNECTION')).toEqual({ id: '80303', level: 10 });
  });

  it('a descrição da regra, que vira o título do achado', () => {
    expect(
      guardDutyRuleDescription({ actionType: 'AWS_API_CALL', title: 'Credenciais usadas de fora' }),
    ).toBe('AWS GuardDuty: AWS_API_CALL - Credenciais usadas de fora.');
    expect(
      guardDutyRuleDescription({
        actionType: 'PORT_PROBE',
        title: 'Porta sondada',
        probe: { ip: '198.51.100.20', port: 22 },
      }),
    ).toBe('AWS GuardDuty: PORT_PROBE - Porta sondada [IP: 198.51.100.20] [Port: 22].');
    expect(guardDutyRuleDescription({ actionType: undefined, title: 'Malware no volume' })).toBe(
      'AWS GuardDuty: Malware no volume.',
    );
  });
});

describe('severidade dos achados da API da AWS', () => {
  it('Security Hub: o rótulo e, sem ele, a nota normalizada', () => {
    expect(securityHubSeverity('CRITICAL', undefined)).toBe('critical');
    expect(securityHubSeverity('HIGH', undefined)).toBe('high');
    expect(securityHubSeverity('MEDIUM', undefined)).toBe('medium');
    expect(securityHubSeverity('LOW', undefined)).toBe('low');
    expect(securityHubSeverity('INFORMATIONAL', undefined)).toBe('low');
    // O rótulo ganha da nota.
    expect(securityHubSeverity('LOW', 95)).toBe('low');
    expect(securityHubSeverity(undefined, 95)).toBe('critical');
    expect(securityHubSeverity(undefined, 90)).toBe('critical');
    expect(securityHubSeverity(undefined, 89)).toBe('high');
    expect(securityHubSeverity(undefined, 70)).toBe('high');
    expect(securityHubSeverity(undefined, 69)).toBe('medium');
    expect(securityHubSeverity(undefined, 40)).toBe('medium');
    expect(securityHubSeverity(undefined, 39)).toBe('low');
    expect(securityHubSeverity(undefined, 0)).toBe('low');
    expect(securityHubSeverity('QUALQUER', undefined)).toBe('low');
    expect(securityHubSeverity(undefined, Number.NaN)).toBe('low');
  });

  it('Inspector: o CRITICAL vira crítico (o Wazuh não o acusa), e o UNTRIAGED fica médio', () => {
    expect(inspectorSeverity('CRITICAL')).toBe('critical');
    expect(inspectorSeverity('HIGH')).toBe('high');
    expect(inspectorSeverity('MEDIUM')).toBe('medium');
    expect(inspectorSeverity('UNTRIAGED')).toBe('medium');
    expect(inspectorSeverity('LOW')).toBe('low');
    expect(inspectorSeverity('INFORMATIONAL')).toBe('low');
    expect(inspectorSeverity(undefined)).toBe('low');
  });

  it('Access Analyzer: acesso externo público é alto, a outra conta é médio, sem uso e interno são baixos', () => {
    const of = (type: string | undefined, isPublic: boolean) => {
      const kind = accessAnalyzerClass(type, isPublic);
      return [kind, accessAnalyzerSeverity(kind), ACCESS_ANALYZER_RULE[kind].id];
    };
    expect(of('ExternalAccess', true)).toEqual(['public', 'high', '990521']);
    expect(of('ExternalAccess', false)).toEqual(['external', 'medium', '990522']);
    expect(of(undefined, true)).toEqual(['public', 'high', '990521']);
    expect(of('UnusedIAMRole', false)).toEqual(['unused', 'low', '990523']);
    expect(of('UnusedIAMUserAccessKey', false)).toEqual(['unused', 'low', '990523']);
    expect(of('UnusedIAMUserPassword', false)).toEqual(['unused', 'low', '990523']);
    // O "público" só vale para o acesso externo.
    expect(of('UnusedPermission', true)).toEqual(['unused', 'low', '990523']);
    expect(of('InternalAccess', true)).toEqual(['internal', 'low', '990524']);
  });

  it('o nível da regra segue a escala comum, e a escala devolve a mesma severidade', () => {
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
      expect(severityOfLevel(levelOfSeverity(severity))).toBe(severity);
    }
  });

  it('as regras ficam na faixa 9905xx, sem ID repetido e com título', () => {
    const rules = Object.values(AWS_FINDING_RULES);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    for (const rule of rules) {
      expect(rule.id).toMatch(/^9905\d\d$/);
      expect(rule.title.length).toBeGreaterThan(5);
    }
  });
});
