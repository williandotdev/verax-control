import { z } from 'zod';

/**
 * Resultado do Prowler (T5.8), lido do bucket da Verax onde a tarefa da T4.7 grava
 * `<tenantId>/<conta>/<AAAA-MM-DD>/prowler-<AAAAMMDDTHHMMSSZ>.ocsf.json`.
 *
 * O arquivo é uma lista de Detection Findings do OCSF, no formato do Prowler 5.47.0 (conferido no código dele,
 * `prowler/lib/outputs/ocsf/ocsf.py`): `status_code` PASS, FAIL, MANUAL ou MUTED (silenciada pela lista de exceções,
 * que apaga o status original; `status` vem Suppressed); `severity` de Critical a Informational; a checagem em
 * `metadata.event_code`; a conta em `cloud.account.uid`; campos nulos omitidos. Só os campos usados são lidos; `resources[].data` (metadados do
 * recurso) nunca é guardado.
 */

export interface ReportKey {
  tenantId: string;
  accountId: string;
  date: string;
  scannedAt: string;
}

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_ID = /^\d{12}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FILE = /^prowler-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.ocsf\.json$/;

export function parseReportKey(key: string): ReportKey | null {
  const parts = key.split('/');
  if (parts.length !== 4) return null;
  const [tenantId = '', accountId = '', date = '', file = ''] = parts;
  const day = DATE.exec(date);
  const name = FILE.exec(file);
  if (!TENANT_ID.test(tenantId) || !ACCOUNT_ID.test(accountId) || day === null || name === null) return null;
  const [, year, month, dayOfMonth, hour, minute, second] = name;
  const scannedAt = `${year}-${month}-${dayOfMonth}T${hour}:${minute}:${second}.000Z`;
  const time = Date.parse(scannedAt);
  // A data da pasta é a do arquivo, e as duas precisam existir no calendário.
  if (Number.isNaN(time) || new Date(time).toISOString() !== scannedAt || scannedAt.slice(0, 10) !== date) {
    return null;
  }
  return { tenantId, accountId, date, scannedAt };
}

export const POSTURE_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type PostureSeverity = (typeof POSTURE_SEVERITIES)[number];
/** `muted`: silenciada pela lista de exceções do Prowler (o status original não vem no relatório). */
export type CheckStatus = 'pass' | 'fail' | 'manual' | 'muted';

export interface PostureCheck {
  checkId: string;
  /** ID do resultado no Prowler (checagem, conta, região e recurso). */
  findingUid: string;
  status: CheckStatus;
  severity: PostureSeverity;
  title: string;
  region: string;
  resourceUid: string | null;
  resourceType: string | null;
  detail: string | null;
  risk: string | null;
  remediation: string | null;
  references: string[];
}

const longText = z.string().max(8192).optional();

const findingSchema = z.object({
  status_code: z.enum(['PASS', 'FAIL', 'MANUAL', 'MUTED']),
  severity: z.enum(['Critical', 'High', 'Medium', 'Low', 'Informational']),
  status: z.string().max(32).optional(),
  status_detail: longText,
  risk_details: longText,
  metadata: z.object({ event_code: z.string().regex(/^[a-z0-9_]{1,160}$/) }),
  finding_info: z.object({
    uid: z.string().min(1).max(1024),
    title: z.string().min(1).max(1024),
  }),
  cloud: z.object({
    account: z.object({ uid: z.string() }),
    region: z.string().regex(/^[a-z0-9-]{1,32}$/),
  }),
  resources: z
    .array(z.object({ uid: z.string().max(2048).optional(), type: z.string().max(256).optional() }))
    .max(64)
    .default([]),
  remediation: z
    .object({ desc: longText, references: z.array(z.string().max(2048)).max(16).default([]) })
    .optional(),
});

export class ReportRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportRejected';
  }
}

export interface ReportLimits {
  maxFindings: number;
  /** Fração de itens fora do formato a partir da qual o relatório inteiro é recusado (formato mudou?). */
  maxRejectedRatio: number;
}

export const DEFAULT_REPORT_LIMITS: Readonly<ReportLimits> = { maxFindings: 100_000, maxRejectedRatio: 0.01 };

export interface ParsedReport {
  checks: PostureCheck[];
  rejected: number;
}

const STATUS = { PASS: 'pass', FAIL: 'fail', MANUAL: 'manual', MUTED: 'muted' } as const;

const present = (value: string | undefined): string | null =>
  value === undefined || value.length === 0 ? null : value;

/**
 * Lê o relatório de uma conta. Recusa o relatório inteiro se algum resultado for de outra conta: a pasta é da
 * conta, e um resultado alheio ali não pode virar postura de ninguém.
 */
export function parseProwlerReport(
  document: unknown,
  expected: { accountId: string },
  limits: ReportLimits = DEFAULT_REPORT_LIMITS,
): ParsedReport {
  if (!Array.isArray(document)) throw new ReportRejected('o relatório não é uma lista de resultados');
  if (document.length > limits.maxFindings) {
    throw new ReportRejected(`o relatório passa de ${limits.maxFindings} resultados`);
  }

  const byUid = new Map<string, PostureCheck>();
  let rejected = 0;
  for (const item of document) {
    const parsed = findingSchema.safeParse(item);
    if (!parsed.success) {
      rejected += 1;
      continue;
    }
    const finding = parsed.data;
    if (finding.cloud.account.uid !== expected.accountId) {
      throw new ReportRejected('o relatório traz resultado de outra conta');
    }
    const [resource] = finding.resources;
    byUid.set(finding.finding_info.uid, {
      checkId: finding.metadata.event_code,
      findingUid: finding.finding_info.uid,
      status: finding.status === 'Suppressed' ? 'muted' : STATUS[finding.status_code],
      severity: finding.severity.toLowerCase() as PostureSeverity,
      title: finding.finding_info.title,
      region: finding.cloud.region,
      resourceUid: present(resource?.uid),
      resourceType: present(resource?.type),
      detail: present(finding.status_detail),
      risk: present(finding.risk_details),
      remediation: present(finding.remediation?.desc),
      references: finding.remediation?.references ?? [],
    });
  }

  if (document.length > 0 && rejected / document.length > limits.maxRejectedRatio) {
    throw new ReportRejected(`${rejected} de ${document.length} resultados fora do formato`);
  }
  return { checks: [...byUid.values()], rejected };
}

const WEIGHTS: Readonly<Record<PostureSeverity, number>> = {
  critical: 10,
  high: 5,
  medium: 2,
  low: 1,
  informational: 0,
};

export interface PostureSummary {
  /** De 0 a 100, ou `null` sem checagem que conte. */
  score: number | null;
  /** Pesos aprovados e totais: a nota de várias contas soma estes, em vez de tirar média das notas. */
  weightPassed: number;
  weightTotal: number;
  passed: number;
  failed: number;
  manual: number;
  muted: number;
  failedBySeverity: Record<PostureSeverity, number>;
}

/**
 * Nota de postura (premissa aprovada): taxa de aprovação ponderada pela severidade (crítica 10, alta 5, média 2,
 * baixa 1; informativa não pesa). Só aprovadas e reprovadas contam: as manuais pedem verificação humana, e as
 * silenciadas foram aceitas pelo cliente.
 */
export function summarizePosture(checks: readonly PostureCheck[]): PostureSummary {
  const failedBySeverity: Record<PostureSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  let passedWeight = 0;
  let totalWeight = 0;
  let passed = 0;
  let failed = 0;
  let manual = 0;
  let muted = 0;
  for (const check of checks) {
    if (check.status === 'muted') {
      muted += 1;
      continue;
    }
    if (check.status === 'manual') {
      manual += 1;
      continue;
    }
    const weight = WEIGHTS[check.severity];
    totalWeight += weight;
    if (check.status === 'pass') {
      passed += 1;
      passedWeight += weight;
    } else {
      failed += 1;
      failedBySeverity[check.severity] += 1;
    }
  }
  return {
    score: totalWeight === 0 ? null : Math.round((passedWeight / totalWeight) * 100),
    weightPassed: passedWeight,
    weightTotal: totalWeight,
    passed,
    failed,
    manual,
    muted,
    failedBySeverity,
  };
}
