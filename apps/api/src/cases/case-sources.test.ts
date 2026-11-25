import { FINDING_SOURCES, type FindingSource } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { AWS_RULE_TITLES } from '../alerts/aws-rule-titles.js';
import { AWS_FINDING_RULES } from '../aws/findings/finding-rules.js';
import { CLOUDFLARE_RULES } from '../cloudflare/cloudflare-rules.js';
import { CLOUDFLARE_SECURITY_RULES } from '../cloudflare/cloudflare-security-rules.js';
import { GCP_RULES } from '../gcp/gcp-rules.js';
import { WEB_RULES } from '../weblogs/rules.js';
import { CASE_FAMILIES, type CaseKeyInput, caseKeyOf, foldedCaseKey, ROLLUP_FAMILY } from './case-key.js';
import { caseSourceFilter, sourcesOfCase } from './case-sources.js';

const finding = (overrides: Partial<CaseKeyInput>): CaseKeyInput => ({
  accountId: '111122223333',
  logSource: 'cloudtrail',
  severity: 'high',
  ruleId: '100305',
  title: 'x',
  eventName: null,
  resource: 'arn:aws:s3:::exemplo',
  actorUser: 'pessoa',
  sourceIp: '203.0.113.7',
  caseGroup: null,
  ...overrides,
});

const idsOf = (rules: readonly { id: string }[]): string[] => rules.map((rule) => rule.id);

/** As regras de cada fonte que o projeto grava (as do Wazuh, por amostra de cada faixa). */
const RULES: Readonly<Record<FindingSource, readonly string[]>> = {
  cloudtrail: ['80202', '80250', '80254', '80255', '100305', ...AWS_RULE_TITLES.keys()],
  guardduty: ['80300', '80301', '80302', '80303', '80304', '80305'],
  waf: ['80440', '80441', '80442', '80443'],
  security_hub: ['990501', '990502'],
  inspector: ['990511', '990512', '990513'],
  access_analyzer: ['990521', '990522', '990523', '990524'],
  vpc_flow: ['100400', '100401'],
  cloudwatch_logs: ['5763', '31151', '100500'],
  gcp_audit: idsOf(GCP_RULES),
  cloudflare_audit: idsOf(CLOUDFLARE_RULES),
  cloudflare_waf: idsOf(CLOUDFLARE_SECURITY_RULES),
  wazuh_agent: ['5763', '2502', '23501', '23504', '23508', '19007', '550', '510'],
  alb: Object.keys(WEB_RULES),
};

const TITLES = [
  'qualquer título',
  'Vulnerabilidade em pacote: CVE-2026-0001 - openssl',
  'Achado do Security Hub (GuardDuty): x',
  'Achado do Security Hub (Inspector): CVE-2026-0001 - openssl',
  'Achado do Security Hub (Macie): x',
  'CVE-2026-0001 affects openssl',
];
const EVENTS = [
  null,
  'S3.1',
  'Recon:EC2/Portscan',
  'TTPs/Discovery/Recon:EC2-Portscan',
  'Software and Configuration Checks/Vulnerabilities/CVE',
  'Software and Configuration Checks/AWS Security Best Practices',
];

interface Row {
  family: string;
  ruleIds: readonly string[];
  keyParts: readonly { name: string; value: string }[];
}

/** O filtro do SQL, refeito em código. */
function matchesFilter(row: Row, source: FindingSource): boolean {
  const filter = caseSourceFilter(source);
  return (
    filter.families.includes(row.family) ||
    (filter.onlyFamilies.includes(row.family) && row.ruleIds.some((id) => filter.onlyRules.includes(id))) ||
    (filter.besidesFamilies.includes(row.family) &&
      row.ruleIds.some((id) => !filter.besidesRules.includes(id))) ||
    (row.family === filter.rollupFamily &&
      row.keyParts.some((part) => JSON.stringify([part]) === filter.rollupPart))
  );
}

/** As fontes para as quais o filtro acha o caso. */
const found = (row: Row): FindingSource[] => FINDING_SOURCES.filter((source) => matchesFilter(row, source));

describe('as fontes de um caso', () => {
  it.each(FINDING_SOURCES)(
    '%s: todo alerta cai num caso que diz a fonte dele, e o filtro concorda',
    (source) => {
      for (const ruleId of RULES[source]) {
        for (const title of TITLES) {
          for (const eventName of EVENTS) {
            for (const severity of ['critical', 'low']) {
              const input = finding({ logSource: source, ruleId, title, eventName, severity });
              const key = caseKeyOf(input);
              const row: Row = { family: key.family, ruleIds: [ruleId], keyParts: key.parts };
              const label = `${source} ${ruleId} ${key.family} ${title}`;
              expect(key.family, label).not.toBe('other');
              expect(sourcesOfCase(row), label).toEqual([source]);
              expect(found(row), label).toEqual([source]);
              // O caso que reúne médias e baixas guarda a fonte na chave.
              const fold = foldedCaseKey(input, 'rollup');
              const folded: Row = { family: fold.family, ruleIds: [ruleId], keyParts: fold.parts };
              expect(sourcesOfCase(folded), label).toEqual([source]);
              expect(found(folded), label).toEqual([source]);
            }
          }
        }
      }
    },
  );

  it('um caso de mais de uma fonte diz todas, na ordem das fontes, e o filtro acha cada uma', () => {
    const package_ = AWS_FINDING_RULES.inspectorPackage.id;
    const copy = AWS_FINDING_RULES.securityHubProduct.id;
    const row = (family: string, ...ruleIds: string[]): Row => ({ family, ruleIds, keyParts: [] });
    const cases: [Row, FindingSource[]][] = [
      [row('package', '23504', package_, copy), ['security_hub', 'inspector', 'wazuh_agent']],
      [row('package', package_), ['inspector']],
      [row('package', copy), ['security_hub']],
      [row('package', '23501'), ['wazuh_agent']],
      [row('guardduty', copy, '80303'), ['guardduty', 'security_hub']],
      [row('guardduty', copy), ['security_hub']],
      [row('guardduty', '80303'), ['guardduty']],
      [row('waf', '80443'), ['waf']],
      [row('waf', '990330'), ['cloudflare_waf']],
    ];
    for (const [candidate, sources] of cases) {
      expect(sourcesOfCase(candidate)).toEqual(sources);
      expect(found(candidate)).toEqual(sources);
    }
  });

  it('a amostra de regras das famílias de mais de uma fonte não enche', () => {
    // 990511, 990502 e 23501 a 23508: o que pode haver num caso de pacote.
    expect(2 + 8).toBeLessThan(20);
    expect(RULES.guardduty.length + 1).toBeLessThan(20);
  });

  it('a família que não se conhece não diz fonte nenhuma e aparece em todo filtro', () => {
    const unknown: Row = { family: 'other', ruleIds: ['1'], keyParts: [] };
    expect(sourcesOfCase(unknown)).toEqual([]);
    expect(found(unknown)).toEqual([...FINDING_SOURCES]);
    for (const family of ['toString', '__proto__', 'constructor', '', 'família-de-outra-versão']) {
      const other: Row = { family, ruleIds: ['1'], keyParts: [] };
      expect(sourcesOfCase(other)).toEqual([]);
      expect(found(other)).toEqual([]);
    }
  });

  it('o caso reunido de uma fonte que não se conhece não diz fonte nenhuma', () => {
    const part = (value: string): Row => ({
      family: ROLLUP_FAMILY,
      ruleIds: ['1'],
      keyParts: [
        { name: 'source', value },
        { name: 'fold', value: 'rollup' },
      ],
    });
    expect(sourcesOfCase(part('syslog'))).toEqual([]);
    expect(sourcesOfCase(part('waf'))).toEqual(['waf']);
    expect(sourcesOfCase({ family: ROLLUP_FAMILY, ruleIds: ['1'], keyParts: [] })).toEqual([]);
  });

  it('toda família está no quadro', () => {
    const named = new Set(
      FINDING_SOURCES.map(caseSourceFilter).flatMap((filter) => [
        ...filter.families,
        ...filter.onlyFamilies,
        ...filter.besidesFamilies,
      ]),
    );
    expect([...named].sort()).toEqual([...CASE_FAMILIES].sort());
  });
});
