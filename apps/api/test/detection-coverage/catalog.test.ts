import { readdirSync, readFileSync, statSync } from 'node:fs';
import {
  type DetectionScenario,
  detectionScenarioSchema,
  effectiveScenarioState,
  FINDING_SEVERITIES,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { severityOfLevel } from '../../src/alerts/finding-draft.js';
import {
  builtinRuleFingerprint,
  moduleClosure,
  workerRuleFingerprint,
  xmlRuleFingerprints,
  xmlRules,
} from './rule-fingerprints.js';
import {
  managerImage,
  REPO_ROOT,
  readRepoFile,
  repositoryRules,
  type RepositoryRule,
  xmlRuleFiles,
} from './repository-rules.js';

type Inventory = ReadonlyMap<string, RepositoryRule>;

/**
 * O catálogo da Cobertura de detecção (`detections/catalog/`, UC-1) confere com as regras do repositório: toda regra
 * que pode virar achado está num cenário, todo cenário cita só regras que existem, o MITRE é só o que o código mapeia
 * e nada nos arquivos aponta para dado real.
 */

const CATALOG_DIR = new URL('detections/catalog/', REPO_ROOT);
const DETECTIONS_DIR = new URL('detections/', REPO_ROOT);
/** As contas fictícias permitidas em todo o repositório (CLAUDE.md, confidencialidade). */
const FICTITIOUS_ACCOUNTS = new Set(['111111111111', '222222222222']);

interface CatalogFile {
  name: string;
  text: string;
}

function catalogFiles(): CatalogFile[] {
  return readdirSync(CATALOG_DIR)
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(name, CATALOG_DIR), 'utf8') }));
}

function allDetectionFiles(dir: URL = DETECTIONS_DIR): CatalogFile[] {
  return readdirSync(dir).flatMap((name) => {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) return allDetectionFiles(new URL(`${name}/`, dir));
    return [{ name: url.pathname, text: readFileSync(url, 'utf8') }];
  });
}

function parseCatalog(files: readonly CatalogFile[]): DetectionScenario[] {
  return files.map((file) => detectionScenarioSchema.parse(JSON.parse(file.text)));
}

/** Os achados do catálogo que violam a cobertura, por motivo (vazio quando está tudo certo). */
function coverageProblems(scenarios: readonly DetectionScenario[], inventory: Inventory) {
  const placements = new Map<string, string[]>();
  for (const scenario of scenarios) {
    for (const rule of scenario.rules) placements.set(rule, [...(placements.get(rule) ?? []), scenario.id]);
  }
  const findable = [...inventory.values()].filter((rule) => rule.findable);
  return {
    unknownRules: [...placements.keys()].filter((rule) => !inventory.has(rule)),
    notFindable: [...placements.keys()].filter((rule) => inventory.get(rule)?.findable === false),
    uncovered: findable.filter((rule) => !placements.has(rule.id)).map((rule) => rule.id),
    inTwoScenarios: [...placements.entries()].filter(([, ids]) => ids.length > 1).map(([rule]) => rule),
  };
}

/** Táticas e técnicas do cenário que nenhuma das regras dele mapeia no código. */
function inventedMitre(scenario: DetectionScenario, inventory: Inventory): string[] {
  const rules = scenario.rules.flatMap((id) => {
    const rule = inventory.get(id);
    return rule === undefined ? [] : [rule];
  });
  const tactics = new Set(rules.flatMap((rule) => rule.tactics));
  const techniques = new Set(rules.flatMap((rule) => rule.techniques));
  return [
    ...scenario.mitre.tactics.filter((tactic) => !tactics.has(tactic)),
    ...scenario.mitre.techniques.filter((technique) => !techniques.has(technique)),
  ];
}

/** Números de 12 algarismos (formato de conta da AWS) fora das contas fictícias. */
function realLookingAccounts(text: string): string[] {
  return [...text.matchAll(/\d+/g)]
    .map(([digits]) => digits)
    .filter((digits) => digits.length === 12 && !FICTITIOUS_ACCOUNTS.has(digits));
}

describe('catálogo da Cobertura de detecção (UC-1)', () => {
  const files = catalogFiles();
  const scenarios = parseCatalog(files);
  const inventory = repositoryRules();

  it('todo arquivo passa no schema estrito e se chama pelo ID do cenário, sem repetir ID', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((file) => file.name)).toEqual(scenarios.map((scenario) => `${scenario.id}.json`));
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
  });

  it('toda regra que pode virar achado está em exatamente um cenário, e todo cenário cita só regras que existem', () => {
    expect(coverageProblems(scenarios, inventory)).toEqual({
      unknownRules: [],
      notFindable: [],
      uncovered: [],
      inTwoScenarios: [],
    });
  });

  it('acusa regra sem cenário, regra inexistente, regra que não vira achado e regra em dois cenários', () => {
    const [first, second, ...rest] = scenarios;
    if (first === undefined || second === undefined) throw new Error('catálogo curto demais');
    const [dropped, ...kept] = first.rules;
    const mutated = [
      { ...first, rules: [...kept, '999999', '100200'] },
      { ...second, rules: [...second.rules, kept[0] ?? ''] },
      ...rest,
    ];
    expect(coverageProblems(mutated, inventory)).toEqual({
      unknownRules: ['999999'],
      notFindable: ['100200'],
      uncovered: [dropped],
      inTwoScenarios: [kept[0]],
    });
  });

  it('o MITRE de cada cenário é só o que o código mapeia para as regras dele', () => {
    for (const scenario of scenarios) expect(inventedMitre(scenario, inventory), scenario.id).toEqual([]);
    const [first] = scenarios;
    if (first === undefined) throw new Error('catálogo vazio');
    const invented = { ...first, mitre: { tactics: ['Lateral Movement' as const], techniques: ['T1021'] } };
    expect(inventedMitre(invented, inventory)).toEqual(['Lateral Movement', 'T1021']);
  });

  it('fontes, severidade e detecção do provedor batem com as regras', () => {
    for (const scenario of scenarios) {
      const rules = scenario.rules.map((id) => inventory.get(id)).filter((rule) => rule !== undefined);
      expect(new Set(scenario.logSources), scenario.id).toEqual(new Set(rules.map((rule) => rule.source)));
      expect(scenario.providerDetection, scenario.id).toBe(rules.every((rule) => rule.origin === 'provider'));
      if (scenario.providerDetection) {
        expect(scenario.severity, scenario.id).toBe('from_source');
        continue;
      }
      const levels = rules.flatMap((rule) => (rule.level === undefined ? [] : [rule.level]));
      // Os agentes não têm nível no código: só o mínimo do sync, 7 (média).
      const expected = levels.length > 0 ? severityOfLevel(Math.max(...levels)) : 'medium';
      expect(FINDING_SEVERITIES).toContain(scenario.severity);
      expect(scenario.severity, scenario.id).toBe(expected);
    }
  });

  it('nenhum arquivo de detections/ tem e-mail ou número de conta fora das contas fictícias', () => {
    const texts = allDetectionFiles();
    expect(texts.length).toBeGreaterThanOrEqual(files.length);
    for (const file of texts) {
      expect(file.text.includes('@'), file.name).toBe(false);
      expect(realLookingAccounts(file.text), file.name).toEqual([]);
    }
    // A conferência acusa o que deve acusar.
    expect(realLookingAccounts('conta 123456789012 e 111111111111')).toEqual(['123456789012']);
    expect(realLookingAccounts('ID 1234567890123 não é conta')).toEqual([]);
  });

  it('o estado efetivo de cada cenário sai das fingerprints atuais de todas as regras dele', () => {
    const fingerprints = new Map([...inventory.values()].map((rule) => [rule.id, rule.fingerprint]));
    for (const scenario of scenarios) {
      for (const rule of scenario.rules)
        expect(fingerprints.get(rule), rule).toMatch(/^sha256:[0-9a-f]{64}$/);
      const effective = effectiveScenarioState(scenario, fingerprints);
      expect(effective.state === scenario.state || effective.state === 'em_teste', scenario.id).toBe(true);
    }
  });
});

describe('fingerprint das regras (UC-1)', () => {
  const image = managerImage();
  const files = xmlRuleFiles();
  const critical = files.find((file) => file.name === 'verax_aws_critical_rules.xml');
  if (critical === undefined) throw new Error('verax_aws_critical_rules.xml ausente');
  const of = (text: string, id: string) =>
    xmlRuleFingerprints(
      [...files.filter((file) => file !== critical), { name: critical.name, text }],
      image,
    ).get(id);
  const original = of(critical.text, '100310');

  it('o mesmo commit dá a mesma fingerprint, com quebra de linha do Windows ou do Unix', () => {
    expect(original).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(of(critical.text, '100310')).toBe(original);
    expect(of(critical.text.split('\n').join('\r\n'), '100310')).toBe(original);
    const again = repositoryRules();
    expect([...again.values()].map((rule) => rule.fingerprint)).toEqual(
      [...repositoryRules().values()].map((rule) => rule.fingerprint),
    );
  });

  it('espaço, comentário e ordem de atributos no XML não mudam a fingerprint', () => {
    const spaced = critical.text
      .split('<rule id="100310" level="12">')
      .join('<!-- nota -->\n  <rule   level="12"\n id="100310"  >  <!-- antes: <level>9</level> -->');
    expect(spaced).not.toBe(critical.text);
    expect(of(spaced, '100310')).toBe(original);
    const indented = critical.text
      .split('\n')
      .map((line) => `\t${line}  `)
      .join('\n');
    expect(of(indented, '100310')).toBe(original);
  });

  it('mudar o nível muda a fingerprint da regra, e só dela', () => {
    const raised = critical.text.split('<rule id="100310" level="12">').join('<rule id="100310" level="11">');
    expect(raised).not.toBe(critical.text);
    expect(of(raised, '100310')).not.toBe(original);
    expect(of(raised, '100311')).toBe(of(critical.text, '100311'));
  });

  it('mudar o texto de um campo da regra muda a fingerprint', () => {
    const rule = xmlRules(critical.text).find((item) => item.id === '100310');
    expect(rule?.canonical).toContain('<rule id="100310" level="12">');
    const changed = critical.text.split('StopLogging').join('StopLoggingX');
    expect(changed).not.toBe(critical.text);
    expect(of(changed, '100310')).not.toBe(original);
  });

  it('a regra filha muda quando a mãe local muda, e a de fábrica muda com a imagem do Wazuh', () => {
    const child = xmlRules(critical.text).find((rule) =>
      rule.parents.some((parent) => parent.startsWith('1003')),
    );
    if (child === undefined) throw new Error('nenhuma regra crítica com mãe local');
    const parent = child.parents.find((id) => id.startsWith('1003')) ?? '';
    const parentRule = xmlRules(critical.text).find((rule) => rule.id === parent);
    const marker = `<rule id="${parent}" level="${parentRule?.level ?? ''}"`;
    expect(critical.text).toContain(marker);
    const mutated = critical.text.split(marker).join(`<rule id="${parent}" level="1"`);
    expect(of(mutated, child.id)).not.toBe(of(critical.text, child.id));
    expect(builtinRuleFingerprint('80254', image)).not.toBe(builtinRuleFingerprint('80254', `${image}0`));
    const otherImage = xmlRuleFingerprints(files, `${image}0`);
    expect(otherImage.get('80255')).not.toBe(xmlRuleFingerprints(files, image).get('80255'));
  });

  it('regra do worker: muda com os metadados e com qualquer módulo do fecho de imports', () => {
    const entry = 'apps/api/src/weblogs/rules.ts';
    const modules = moduleClosure([entry], readRepoFile);
    expect(modules.map((module) => module.path)).toContain(entry);
    expect(modules.length).toBeGreaterThan(1);
    const meta = { id: '990405', title: 'Força bruta numa rota de login por um mesmo endereço' };
    const base = workerRuleFingerprint(meta, modules);
    expect(workerRuleFingerprint({ ...meta, title: `${meta.title}!` }, modules)).not.toBe(base);
    const imported = modules.find((module) => module.path !== entry);
    if (imported === undefined) throw new Error('fecho sem import');
    const edited = moduleClosure([entry], (path) =>
      path === imported.path ? `${imported.text}\n// mudança` : readRepoFile(path),
    );
    expect(workerRuleFingerprint(meta, edited)).not.toBe(base);
    const crlf = moduleClosure([entry], (path) => readRepoFile(path)?.split('\n').join('\r\n'));
    expect(workerRuleFingerprint(meta, crlf)).toBe(base);
  });
});
