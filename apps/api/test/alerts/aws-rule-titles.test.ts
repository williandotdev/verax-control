import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AWS_RULE_TITLES, awsAlertTitle } from '../../src/alerts/aws-rule-titles.js';

/** As regras locais do Wazuh, como estão no bundle (o modelo das regras do papel inclusive). */
const RULES_DIR = new URL('../../../../infra/wazuh/config/manager/rules/', import.meta.url);

interface LocalRule {
  id: string;
  level: number;
  description: string;
  file: string;
}

function localRules(): LocalRule[] {
  const files = readdirSync(RULES_DIR).filter((name) => /\.xml(?:\.tmpl)?$/.test(name));
  return files.flatMap((file) => {
    const text = readFileSync(new URL(file, RULES_DIR), 'utf8');
    return [...text.matchAll(/<rule id="(\d+)" level="(\d+)"[^>]*>([\s\S]*?)<\/rule>/g)].map(
      ([, id = '', level = '', body = '']) => ({
        id,
        level: Number(level),
        description: /<description>([^<]*)<\/description>/.exec(body)?.[1] ?? '',
        file,
      }),
    );
  });
}

/** Regras do próprio Wazuh, fora do bundle, que o catálogo da AWS usa e que têm título. */
const WAZUH_RULES_WITH_TITLE = ['80254'];

describe('títulos em português das regras da AWS (fase 2, PR-V7)', () => {
  const rules = localRules();
  const critical = rules.filter((rule) => /^1003\d{2}$/.test(rule.id));

  it('as regras críticas estão no bundle, na faixa 100300 a 100399', () => {
    expect(critical.map((rule) => rule.file)).toEqual(critical.map(() => 'verax_aws_critical_rules.xml'));
    expect(critical.length).toBeGreaterThanOrEqual(20);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
  });

  it('toda regra crítica tem título, e a descrição dela começa por ele', () => {
    for (const rule of critical) {
      const title = AWS_RULE_TITLES.get(rule.id);
      expect(title, rule.id).toBeDefined();
      expect(rule.description.startsWith(`Verax Control: ${title ?? ''}`), rule.id).toBe(true);
    }
  });

  it('toda regra local que pode virar achado (nível acima de 0) tem título; as de nível 0, não', () => {
    for (const rule of rules) {
      expect(AWS_RULE_TITLES.has(rule.id), `${rule.file} ${rule.id}`).toBe(rule.level > 0);
    }
  });

  it('o dicionário não tem título de regra que não existe', () => {
    const known = new Set([...rules.map((rule) => rule.id), ...WAZUH_RULES_WITH_TITLE]);
    expect([...AWS_RULE_TITLES.keys()].filter((id) => !known.has(id))).toEqual([]);
  });

  it('nenhum título leva campo do evento, quebra de linha ou ponto final', () => {
    for (const [id, title] of AWS_RULE_TITLES) {
      expect(title, id).not.toMatch(/\$\(|[{}%<>]|\p{Cc}/u);
      expect(title, id).toBe(title.trim());
      expect(title, id).toMatch(/^\p{Lu}/u);
      expect(title, id).not.toMatch(/\.$/);
      expect(title.length, id).toBeLessThanOrEqual(100);
    }
  });

  it('o título é o fixo da regra; sem ele, a descrição do alerta', () => {
    expect(
      awsAlertTitle({
        id: '100310',
        description: 'Verax Control: CloudTrail parado ou apagado (StopLogging).',
      }),
    ).toBe('CloudTrail parado ou apagado');
    expect(
      awsAlertTitle({
        id: '80255',
        description: 'AWS Cloudtrail: signin.amazonaws.com - ConsoleLogin - Possible break in attempt.',
      }),
    ).toBe('Possível força bruta no console');
    // O GuardDuty segue com a descrição (o título vem da própria AWS), e o CloudTrail genérico também.
    const guardDuty = 'AWS GuardDuty: AWS_API_CALL - Credenciais usadas de fora da AWS.';
    expect(awsAlertTitle({ id: '80303', description: guardDuty })).toBe(guardDuty);
    expect(
      awsAlertTitle({ id: '80202', description: 'AWS Cloudtrail: iam.amazonaws.com - CreateUser.' }),
    ).toBe('AWS Cloudtrail: iam.amazonaws.com - CreateUser.');
    // Só a chave exata: nada do protótipo.
    expect(awsAlertTitle({ id: 'constructor', description: 'descrição' })).toBe('descrição');
  });
});
