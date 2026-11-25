import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { awsAlertMitre } from '../../src/alerts/aws-mitre.js';
import { AWS_RULE_TITLES } from '../../src/alerts/aws-rule-titles.js';
import type { FindingSource } from '@verax/shared';
import { DEFAULT_SYNC_SETTINGS } from '../../src/alerts/sync-query.js';
import { AWS_FINDING_RULES } from '../../src/aws/findings/finding-rules.js';
import { GUARDDUTY_PORT_PROBE, guardDutyWazuhRule } from '../../src/aws/findings/finding-keys.js';
import { HOST_LOGIN_RULES } from '../../src/cases/case-key.js';
import { CLOUDFLARE_RULES } from '../../src/cloudflare/cloudflare-rules.js';
import { CLOUDFLARE_SECURITY_RULES } from '../../src/cloudflare/cloudflare-security-rules.js';
import {
  builtinRuleFingerprint,
  managerImageOf,
  moduleClosure,
  relayRuleFingerprint,
  workerRuleFingerprint,
  xmlRuleFingerprints,
  xmlRules,
  type WorkerRuleMetadata,
} from './rule-fingerprints.js';
import { GCP_RULES } from '../../src/gcp/gcp-rules.js';
import { WEB_RULES } from '../../src/weblogs/rules.js';

/**
 * O inventário das regras de detecção do repositório (Cobertura de detecção, UC-1): o que o catálogo
 * (`detections/catalog/`) tem de cobrir, com o MITRE que o código mapeia e a fingerprint atual de cada regra.
 */

export const REPO_ROOT = new URL('../../../../', import.meta.url);
const RULES_DIR = 'infra/wazuh/config/manager/rules/';

/** Lê um arquivo do repositório pelo caminho relativo à raiz (com `/`); `undefined` se não existe. */
export function readRepoFile(path: string): string | undefined {
  const url = new URL(path, REPO_ROOT);
  return existsSync(url) ? readFileSync(url, 'utf8') : undefined;
}

export type RuleOrigin = 'wazuh-verax' | 'wazuh-builtin' | 'worker' | 'provider';

export interface RepositoryRule {
  id: string;
  origin: RuleOrigin;
  /** A fonte do achado (`logSource`). */
  source: FindingSource;
  /** O nível, quando o código o fixa (as regras do ALB e dos provedores têm o nível dado na hora). */
  level?: number;
  /** Pode virar achado: nível igual ou acima do mínimo do sync (as regras XML) ou regra que o código grava. */
  findable: boolean;
  /** O MITRE que o código mapeia para a regra (o XML só traz técnicas; o Wazuh completa a tática na hora). */
  tactics: readonly string[];
  techniques: readonly string[];
  fingerprint: string;
}

/**
 * Regras de fábrica do Wazuh nos agentes que o código diz virarem achado (nível 7 ou mais), além das de login de
 * `HOST_LOGIN_RULES`: o arquivo alterado ou apagado (550 e 553), o pacote instalado (2902) e a checagem do SCA com falha
 * (19007), conforme `AGENT_MIN_LEVEL` em `apps/api/src/alerts/sync-query.ts`.
 */
export const AGENT_RULES_NAMED_IN_CODE = ['550', '553', '2902', '19007'] as const;

/**
 * O maior nível de cada regra do ALB. A tabela `WEB_RULES` não tem nível: ele é dado na contagem, em
 * `apps/api/src/weblogs/rules.ts` (o resumo do dia, 990400, em `digest.ts`). Copiado daqui só para conferir a
 * severidade dos cenários; não entra na fingerprint (o texto daqueles módulos já entra).
 */
const WEB_RULE_MAX_LEVEL: Readonly<Record<string, number>> = {
  '990400': 4,
  '990401': 7,
  '990402': 7,
  '990403': 10,
  '990404': 10,
  '990405': 10,
  '990406': 12,
  '990407': 10,
};

/** Os módulos de cada família de regras do worker (a entrada do fecho da fingerprint). */
const WORKER_MODULES = {
  gcp: 'apps/api/src/gcp/gcp-rules.ts',
  cloudflareAudit: 'apps/api/src/cloudflare/cloudflare-rules.ts',
  cloudflareSecurity: 'apps/api/src/cloudflare/cloudflare-security-rules.ts',
  web: 'apps/api/src/weblogs/rules.ts',
  awsApi: 'apps/api/src/aws/findings/finding-rules.ts',
} as const;

/** Os módulos que montam o achado do GuardDuty pela API: a regra do Wazuh, a severidade e o MITRE pelo tipo. */
const GUARDDUTY_MODULES = ['apps/api/src/aws/findings/finding-keys.ts', 'apps/api/src/alerts/aws-mitre.ts'];

export function managerImage(): string {
  return managerImageOf(readRepoFile('infra/wazuh/docker-compose.yml') ?? '');
}

export function xmlRuleFiles(): { name: string; text: string }[] {
  return readdirSync(new URL(RULES_DIR, REPO_ROOT))
    .filter((name) => name.endsWith('.xml') || name.endsWith('.xml.tmpl'))
    .sort()
    .map((name) => ({ name, text: readRepoFile(`${RULES_DIR}${name}`) ?? '' }));
}

export function repositoryRules(): Map<string, RepositoryRule> {
  const image = managerImage();
  const rules = new Map<string, RepositoryRule>();
  const add = (rule: RepositoryRule) => {
    if (rules.has(rule.id)) throw new Error(`regra em duas origens: ${rule.id}`);
    rules.set(rule.id, rule);
  };

  // Regras XML da Verax (inclusive as correlações de fábrica sobrescritas e o modelo do papel de leitura).
  const files = xmlRuleFiles();
  const xmlFingerprints = xmlRuleFingerprints(files, image);
  const xmlSource = (file: string, id: string): FindingSource => {
    if (file === 'verax_aws_flow_rules.xml') return 'vpc_flow';
    return id === '80443' ? 'waf' : 'cloudtrail';
  };
  for (const { file, rule } of files.flatMap((item) =>
    xmlRules(item.text).map((rule) => ({ file: item.name, rule })),
  )) {
    // O mesmo caminho do alerta: o `<mitre>` da regra e, sem ele, o que `aws-mitre.ts` completa (a 80443).
    const mitre = awsAlertMitre({
      source: 'cloudtrail',
      eventName: undefined,
      rule: {
        id: rule.id,
        level: rule.level,
        description: '',
        groups: [],
        mitre: { ids: rule.techniques, tactics: [], techniques: [] },
      },
    });
    add({
      id: rule.id,
      origin: 'wazuh-verax',
      source: xmlSource(file, rule.id),
      level: rule.level,
      findable: rule.level >= DEFAULT_SYNC_SETTINGS.minLevel,
      tactics: mitre.tactics,
      techniques: mitre.techniques,
      fingerprint: xmlFingerprints.get(rule.id) ?? '',
    });
  }

  // Regras de fábrica do Wazuh que o código cita: o login com falha da AWS (título fixo), o login nas instâncias e as
  // dos agentes.
  const builtin: [string, FindingSource][] = [
    ...[...AWS_RULE_TITLES.keys()]
      .filter((id) => !rules.has(id))
      .map((id): [string, FindingSource] => [id, 'cloudtrail']),
    ...[...HOST_LOGIN_RULES, ...AGENT_RULES_NAMED_IN_CODE].map((id): [string, FindingSource] => [
      id,
      'wazuh_agent',
    ]),
  ];
  for (const [id, source] of builtin) {
    add({
      id,
      origin: 'wazuh-builtin',
      source,
      findable: true,
      tactics: [],
      techniques: [],
      fingerprint: builtinRuleFingerprint(id, image),
    });
  }

  // GuardDuty: a regra de fábrica que o achado leva pelo bucket e pela API. O MITRE sai do tipo de cada achado.
  const guardDutyModules = moduleClosure(GUARDDUTY_MODULES, readRepoFile);
  const guardDuty = new Set(
    [0, 5, 8].flatMap((severity) =>
      [undefined, GUARDDUTY_PORT_PROBE].map((action) => guardDutyWazuhRule(severity, action)),
    ),
  );
  for (const rule of [...guardDuty].sort((a, b) => a.id.localeCompare(b.id))) {
    if (rules.has(rule.id)) continue;
    add({
      id: rule.id,
      origin: 'provider',
      source: 'guardduty',
      level: rule.level,
      // Pela API, todo achado do GuardDuty é gravado, qualquer que seja o nível da regra.
      findable: true,
      tactics: [],
      techniques: [],
      fingerprint: relayRuleFingerprint(rule.id, image, guardDutyModules),
    });
  }

  // Regras do worker.
  const worker = (
    entry: string,
    origin: RuleOrigin,
    sourceOf: (id: string) => FindingSource,
    metas: readonly (WorkerRuleMetadata & { tactics?: readonly string[]; techniques?: readonly string[] })[],
  ) => {
    const modules = moduleClosure([entry], readRepoFile);
    for (const meta of metas) {
      add({
        id: meta.id,
        origin,
        source: sourceOf(meta.id),
        level: meta.level ?? WEB_RULE_MAX_LEVEL[meta.id],
        findable: true,
        tactics: meta.tactics ?? [],
        techniques: meta.techniques ?? [],
        fingerprint: workerRuleFingerprint(meta, modules),
      });
    }
  };
  worker(WORKER_MODULES.gcp, 'worker', () => 'gcp_audit', GCP_RULES);
  worker(WORKER_MODULES.cloudflareAudit, 'worker', () => 'cloudflare_audit', CLOUDFLARE_RULES);
  worker(WORKER_MODULES.cloudflareSecurity, 'worker', () => 'cloudflare_waf', CLOUDFLARE_SECURITY_RULES);
  worker(
    WORKER_MODULES.web,
    'worker',
    () => 'alb',
    Object.entries(WEB_RULES).map(([id, rule]) => ({ id, ...rule })),
  );
  const awsApiSource = (id: string): FindingSource =>
    id.startsWith('99050') ? 'security_hub' : id.startsWith('99051') ? 'inspector' : 'access_analyzer';
  worker(WORKER_MODULES.awsApi, 'provider', awsApiSource, Object.values(AWS_FINDING_RULES));
  return rules;
}
