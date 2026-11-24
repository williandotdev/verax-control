import { FINDING_SOURCES } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { AWS_RULE_TITLES } from '../alerts/aws-rule-titles.js';
import { CASE_FAMILIES, type CaseFold, type CaseKeyInput, caseKeyOf } from './case-key.js';
import { CASE_TITLE_MAX, caseTitle, foldedCaseTitle } from './case-titles.js';

const byRule = [{ name: 'rule', value: '1' }];

describe('títulos dos casos', () => {
  it.each(CASE_FAMILIES)('a família %s tem um título próprio, em português, que cabe na coluna', (family) => {
    const title = caseTitle({ family, parts: [] }, '');
    expect(title.length).toBeGreaterThan(5);
    expect(title.length).toBeLessThanOrEqual(CASE_TITLE_MAX);
    for (const fold of ['distributed', 'overflow'] as const) {
      const folded = foldedCaseTitle(fold, family, 'cloudtrail');
      expect(folded.startsWith(`${title} (`)).toBe(true);
      expect(folded.length).toBeLessThanOrEqual(CASE_TITLE_MAX);
    }
  });

  it('nenhuma família repete o título de outra', () => {
    const titles = CASE_FAMILIES.map((family) => caseTitle({ family, parts: [] }, ''));
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('a regra com título fixo dá o título do caso, se ela é parte da chave e da família dela', () => {
    const title = (family: (typeof CASE_FAMILIES)[number], ruleId: string, parts = byRule) =>
      caseTitle({ family, parts }, ruleId);
    expect(title('cloudtrail', '100310')).toBe('CloudTrail parado ou apagado');
    expect(title('cloudtrail', '100310', [])).toBe('Atividade suspeita na conta da AWS');
    expect(title('cloudtrail', '80202')).toBe('Atividade suspeita na conta da AWS');
    expect(title('vpc-flow', '100400')).toBe(AWS_RULE_TITLES.get('100400'));
    expect(title('waf', '80443')).toBe(AWS_RULE_TITLES.get('80443'));
    expect(title('waf', '990333')).toMatch(/^Ataque DDoS/);
    expect(title('gcp-audit', '990101')).toMatch(/^Logs de auditoria desviados/);
    expect(title('cloudflare-audit', '990324')).toMatch(/^Ação feita pela equipe/);
    expect(title('access-analyzer', '990521')).toBe('Recurso aberto ao público');
    // O número de uma regra da AWS, na instância de um cliente, é outra regra.
    expect(title('host', '100310')).toBe('Atividade suspeita numa instância');
    expect(title('other', '100310')).toBe('Alerta de uma fonte não reconhecida');
  });

  it('o caso reunido por fonte diz a fonte, do dicionário', () => {
    const titles = FINDING_SOURCES.map((source) => foldedCaseTitle('rollup', 'cloudtrail', source));
    expect(new Set(titles).size).toBe(FINDING_SOURCES.length);
    for (const title of titles) expect(title).toMatch(/^Alertas médios e baixos reunidos: /);
    expect(foldedCaseTitle('rollup', 'other', '<script>')).toBe(
      'Alertas médios e baixos reunidos: outras fontes',
    );
  });

  it('nada do evento chega ao título, com qualquer fonte, regra e conteúdo', () => {
    const marker = 'texto-do-evento';
    const hostile: CaseKeyInput = {
      accountId: marker,
      logSource: '',
      severity: 'high',
      ruleId: '',
      title: marker,
      eventName: marker,
      resource: marker,
      actorUser: marker,
      sourceIp: marker,
      caseGroup: marker,
    };
    const rules = ['80254', '80303', '80443', '100310', '100400', '990101', '990330', '990501', '990502'];
    const others = ['990511', '990512', '990513', '990521', '5763', '19007', '23505', marker];
    const folds: CaseFold[] = ['distributed', 'overflow', 'rollup'];
    for (const logSource of [...FINDING_SOURCES, marker]) {
      for (const ruleId of [...rules, ...others]) {
        for (const severity of ['critical', 'low']) {
          const key = caseKeyOf({ ...hostile, logSource, ruleId, severity });
          const titles = [
            caseTitle(key, ruleId),
            ...folds.map((fold) => foldedCaseTitle(fold, key.family, logSource)),
          ];
          for (const title of titles) {
            expect(title).not.toContain(marker);
            expect(title.length).toBeGreaterThan(5);
          }
        }
      }
    }
  });
});
