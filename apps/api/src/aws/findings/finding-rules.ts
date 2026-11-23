import type { FindingSeverity } from '@verax/shared';

/**
 * As regras e as severidades dos achados lidos pela API da AWS (tarefa `aws-findings`): a faixa 990501 a 990599
 * (`docs/ARQUITETURA.md`, "Regras de detecção: faixas de ID e títulos"). O GuardDuty lido pela API não tem regra aqui:
 * leva a do Wazuh, a mesma do caminho do bucket (`finding-keys.ts`).
 *
 * A regra separa as classes de achado de cada serviço, porque é por ela (mais o recurso) que o cliente cria uma exceção:
 * a exceção de uma vulnerabilidade de pacote num recurso não cala a porta aberta do mesmo recurso.
 *
 * **Severidade.** O achado guarda a severidade do painel (`critical`, `high`, `medium`, `low`); o nível da regra é o da
 * escala comum (12 crítica, 10 alta, 7 média, 3 baixa), derivado dela.
 *
 * | Serviço         | Na origem                                             | No painel                        |
 * | --------------- | ----------------------------------------------------- | -------------------------------- |
 * | GuardDuty       | `severity` de 0 a 10                                   | 9+ crítica, 7+ alta, 4+ média, senão baixa (`findingSeverity`) |
 * | Security Hub    | `Severity.Label` (sem ele, `Severity.Normalized` 0–100) | CRITICAL (90+) crítica, HIGH (70+) alta, MEDIUM (40+) média, LOW e INFORMATIONAL baixa |
 * | Inspector       | `severity`                                             | CRITICAL crítica, HIGH alta, MEDIUM e UNTRIAGED média, LOW e INFORMATIONAL baixa |
 * | Access Analyzer | tipo do achado e `isPublic`                            | acesso externo público alta; acesso externo a outra conta ou identidade média; acesso sem uso e acesso interno baixa |
 *
 * O Inspector `UNTRIAGED` (o fornecedor ainda não deu severidade à vulnerabilidade) fica média: não some entre as
 * baixas antes de alguém olhar. O `INFORMATIONAL` não é descartado (nenhum log é descartado): entra como baixa.
 */

export interface AwsFindingRule {
  id: string;
  /** O que a regra acusa, em português: o começo do título do achado. */
  title: string;
}

export const AWS_FINDING_RULES = {
  /** Security Hub: um controle de segurança reprovado (o achado tem `Compliance`). */
  securityHubControl: { id: '990501', title: 'Controle de segurança reprovado' },
  /** Security Hub: o achado de um produto integrado (Macie, Firewall Manager, um parceiro...). */
  securityHubProduct: { id: '990502', title: 'Achado do Security Hub' },
  inspectorPackage: { id: '990511', title: 'Vulnerabilidade em pacote' },
  inspectorNetwork: { id: '990512', title: 'Porta alcançável de fora da rede' },
  inspectorCode: { id: '990513', title: 'Vulnerabilidade no código' },
  accessAnalyzerPublic: { id: '990521', title: 'Recurso aberto ao público' },
  accessAnalyzerExternal: { id: '990522', title: 'Recurso acessível por outra conta ou identidade' },
  accessAnalyzerUnused: { id: '990523', title: 'Acesso sem uso' },
  accessAnalyzerInternal: { id: '990524', title: 'Acesso interno a recurso crítico' },
} as const satisfies Record<string, AwsFindingRule>;

const LEVEL: Readonly<Record<FindingSeverity, number>> = { critical: 12, high: 10, medium: 7, low: 3 };

/** O nível da regra, na escala comum (`severityOfLevel` faz o caminho de volta), pela severidade do achado. */
export function levelOfSeverity(severity: FindingSeverity): number {
  return LEVEL[severity];
}

/** A severidade de um achado do Security Hub: o rótulo e, sem ele, a nota normalizada (ASFF). */
export function securityHubSeverity(
  label: string | undefined,
  normalized: number | undefined,
): FindingSeverity {
  switch (label) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
    case 'INFORMATIONAL':
      return 'low';
    default:
      break;
  }
  if (normalized === undefined || !Number.isFinite(normalized)) return 'low';
  if (normalized >= 90) return 'critical';
  if (normalized >= 70) return 'high';
  if (normalized >= 40) return 'medium';
  return 'low';
}

/** A severidade de um achado do Inspector. O CRITICAL é o motivo de a leitura ser pela API: o Wazuh não o acusa. */
export function inspectorSeverity(severity: string | undefined): FindingSeverity {
  switch (severity) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
    case 'UNTRIAGED':
      return 'medium';
    default:
      return 'low';
  }
}

/** Os tipos de achado do Access Analyzer de acesso sem uso. */
const UNUSED_ACCESS: ReadonlySet<string> = new Set([
  'UnusedIAMRole',
  'UnusedIAMUserAccessKey',
  'UnusedIAMUserPassword',
  'UnusedPermission',
]);

export type AccessAnalyzerClass = 'public' | 'external' | 'unused' | 'internal';

/** A classe de um achado do Access Analyzer, pelo tipo e por `isPublic` (só do acesso externo, lido no detalhe). */
export function accessAnalyzerClass(findingType: string | undefined, isPublic: boolean): AccessAnalyzerClass {
  if (findingType !== undefined && UNUSED_ACCESS.has(findingType)) return 'unused';
  if (findingType === 'InternalAccess') return 'internal';
  // Sem tipo (o analisador de acesso externo de uma versão anterior da API) é acesso externo.
  return isPublic ? 'public' : 'external';
}

const ACCESS_ANALYZER_SEVERITY: Readonly<Record<AccessAnalyzerClass, FindingSeverity>> = {
  public: 'high',
  external: 'medium',
  unused: 'low',
  internal: 'low',
};

export function accessAnalyzerSeverity(kind: AccessAnalyzerClass): FindingSeverity {
  return ACCESS_ANALYZER_SEVERITY[kind];
}

export const ACCESS_ANALYZER_RULE: Readonly<Record<AccessAnalyzerClass, AwsFindingRule>> = {
  public: AWS_FINDING_RULES.accessAnalyzerPublic,
  external: AWS_FINDING_RULES.accessAnalyzerExternal,
  unused: AWS_FINDING_RULES.accessAnalyzerUnused,
  internal: AWS_FINDING_RULES.accessAnalyzerInternal,
};
