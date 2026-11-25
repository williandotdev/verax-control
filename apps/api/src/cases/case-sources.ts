import { FINDING_SOURCES, type FindingSource } from '@verax/shared';
import { AWS_FINDING_RULES } from '../aws/findings/finding-rules.js';
import { CLOUDFLARE_SECURITY_RULES } from '../cloudflare/cloudflare-security-rules.js';
import { type CaseFamily, type CaseKeyPart, ROLLUP_FAMILY } from './case-key.js';

/**
 * As fontes de log de um caso, que ele não guarda: saem da família da chave e, nas famílias de mais de uma fonte, das
 * regras dos alertas. É exato porque a amostra de regras dessas famílias não enche: a `package` só tem as regras do
 * Inspector, da cópia do Security Hub e do detector do Wazuh (10 ao todo), a `guardduty` as do GuardDuty e a da cópia, e
 * a `waf` leva a regra na chave. O mesmo quadro serve ao filtro (no SQL) e ao que a tela mostra.
 *
 * A família `other` (fonte, regra ou tipo que não se conhece) não diz a fonte. Na dúvida, o caso aparece: ela entra no
 * filtro de qualquer fonte, em vez de sumir de todos.
 */

/** A regra das cópias que o Security Hub traz do GuardDuty e do Inspector. */
const SECURITY_HUB_COPY = AWS_FINDING_RULES.securityHubProduct.id;
const INSPECTOR_PACKAGE = AWS_FINDING_RULES.inspectorPackage.id;
const CLOUDFLARE_WAF_RULES: readonly string[] = CLOUDFLARE_SECURITY_RULES.map((rule) => rule.id);

/** Uma das fontes de uma família: pelas regras dela (`only`) ou por qualquer regra fora de uma lista (`besides`). */
interface MixedSource {
  source: FindingSource;
  only?: readonly string[];
  besides?: readonly string[];
}

/** As fontes de uma família: uma só, várias, ou nenhuma que se conheça (só o alerta diz). */
type FamilySources = FindingSource | readonly MixedSource[] | null;

const FAMILY_SOURCES: Readonly<Record<CaseFamily, FamilySources>> = {
  cloudtrail: 'cloudtrail',
  'console-login': 'cloudtrail',
  guardduty: [
    { source: 'guardduty', besides: [SECURITY_HUB_COPY] },
    { source: 'security_hub', only: [SECURITY_HUB_COPY] },
  ],
  waf: [
    { source: 'waf', besides: CLOUDFLARE_WAF_RULES },
    { source: 'cloudflare_waf', only: CLOUDFLARE_WAF_RULES },
  ],
  'vpc-flow': 'vpc_flow',
  'cloudwatch-logs': 'cloudwatch_logs',
  'gcp-audit': 'gcp_audit',
  'cloudflare-audit': 'cloudflare_audit',
  host: 'wazuh_agent',
  'host-login': 'wazuh_agent',
  'security-hub-finding': 'security_hub',
  package: [
    { source: 'inspector', only: [INSPECTOR_PACKAGE] },
    { source: 'security_hub', only: [SECURITY_HUB_COPY] },
    { source: 'wazuh_agent', besides: [INSPECTOR_PACKAGE, SECURITY_HUB_COPY] },
  ],
  code: 'inspector',
  control: 'security_hub',
  'network-exposure': 'inspector',
  'access-analyzer': 'access_analyzer',
  'security-hub-check': 'security_hub',
  'host-configuration': 'wazuh_agent',
  other: null,
};
const SOURCES_BY_FAMILY: ReadonlyMap<string, FamilySources> = new Map(Object.entries(FAMILY_SOURCES));

/** A parte da chave em que o caso que reúne médias e baixas de uma fonte a guarda (`foldedCaseKey`). */
const SOURCE_PART = 'source';

function isMixedSource({ only, besides }: MixedSource, ruleIds: readonly string[]): boolean {
  return ruleIds.some((rule) =>
    only !== undefined ? only.includes(rule) : besides?.includes(rule) === false,
  );
}

/** As fontes de um caso, na ordem de `FINDING_SOURCES`; nenhuma, se só o alerta diz. */
export function sourcesOfCase(row: {
  family: string;
  ruleIds: readonly string[];
  keyParts: readonly CaseKeyPart[];
}): FindingSource[] {
  if (row.family === ROLLUP_FAMILY) {
    const part = row.keyParts.find(({ name }) => name === SOURCE_PART);
    return FINDING_SOURCES.filter((source) => source === part?.value);
  }
  const sources = SOURCES_BY_FAMILY.get(row.family) ?? null;
  if (sources === null) return [];
  if (typeof sources === 'string') return [sources];
  const present = sources.filter((mixed) => isMixedSource(mixed, row.ruleIds));
  return FINDING_SOURCES.filter((source) => present.some((mixed) => mixed.source === source));
}

/** O filtro por fonte, pronto para os parâmetros do SQL. Uma lista vazia não casa com nada. */
export interface CaseSourceFilter {
  source: FindingSource;
  /** Famílias em que a fonte é sempre esta, e as que não dizem a fonte (aparecem em todo filtro). */
  families: string[];
  /** Famílias em que é esta se há alguma destas regras. */
  onlyFamilies: string[];
  onlyRules: string[];
  /** Famílias em que é esta se há alguma regra fora destas. */
  besidesFamilies: string[];
  besidesRules: string[];
  /** O caso que reúne médias e baixas desta fonte. */
  rollupFamily: string;
  rollupPart: string;
}

export function caseSourceFilter(source: FindingSource): CaseSourceFilter {
  const filter: CaseSourceFilter = {
    source,
    families: [],
    onlyFamilies: [],
    onlyRules: [],
    besidesFamilies: [],
    besidesRules: [],
    rollupFamily: ROLLUP_FAMILY,
    rollupPart: JSON.stringify([{ name: SOURCE_PART, value: source }]),
  };
  for (const [family, sources] of SOURCES_BY_FAMILY) {
    if (sources === null || sources === source) filter.families.push(family);
    else if (typeof sources !== 'string') {
      for (const mixed of sources.filter((candidate) => candidate.source === source)) {
        if (mixed.only !== undefined) {
          filter.onlyFamilies.push(family);
          filter.onlyRules.push(...mixed.only);
        } else {
          filter.besidesFamilies.push(family);
          filter.besidesRules.push(...(mixed.besides ?? []));
        }
      }
    }
  }
  return filter;
}
