import {
  type PostureCheckStatus,
  type PostureCheckSummary,
  postureCheckStatus,
  type PostureSection,
  type PostureSectionError,
} from '@verax/shared';
import { describeReadError } from '@/features/inventory/labels';

/** As leituras de que as checagens dependem, como a faixa de varredura parcial as nomeia. */
export const POSTURE_SECTION_LABELS: Readonly<Record<PostureSection, string>> = {
  root: 'Conta root',
  iam: 'Usuários IAM e chaves de acesso',
  password_policy: 'Política de senha',
  s3: 'Buckets S3',
  s3_account: 'Bloqueio de acesso público da conta',
  ec2: 'Instâncias EC2',
  sg: 'Security groups',
  ebs: 'Criptografia padrão do EBS',
  cloudtrail: 'Trilhas do CloudTrail',
  guardduty: 'GuardDuty',
};

/** "GuardDuty em us-east-1: a AWS recusou a leitura (AccessDeniedException)". */
export function describePostureError(error: PostureSectionError): string {
  return describeReadError(POSTURE_SECTION_LABELS[error.section], error.region, error.code);
}

export const CHECK_STATUS_LABELS: Readonly<Record<PostureCheckStatus, string>> = {
  fail: 'Reprovada',
  unknown: 'Não lida',
  pass: 'Aprovada',
  not_applicable: 'Não se aplica',
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "3 aprovados, 1 reprovado e 1 não lido"; "—" sem recurso conferido. */
export function describeCheckCounts(
  check: Pick<PostureCheckSummary, 'passed' | 'failed' | 'unknown'>,
): string {
  const parts = [
    check.passed > 0 ? plural(check.passed, 'aprovado', 'aprovados') : null,
    check.failed > 0 ? plural(check.failed, 'reprovado', 'reprovados') : null,
    check.unknown > 0 ? plural(check.unknown, 'não lido', 'não lidos') : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return '—';
  return parts.length === 1 ? (parts[0] as string) : `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}`;
}

/**
 * As checagens do catálogo de várias contas numa linha por checagem, na ordem em que aparecem: as contagens somadas e a
 * situação recalculada (uma conta reprovada reprova; uma não lida, sem reprovação, deixa não lida).
 */
export function mergeChecks(lists: readonly (readonly PostureCheckSummary[])[]): PostureCheckSummary[] {
  const merged = new Map<string, PostureCheckSummary>();
  for (const list of lists) {
    for (const check of list) {
      const known = merged.get(check.checkId);
      if (known === undefined) {
        merged.set(check.checkId, { ...check });
        continue;
      }
      known.passed += check.passed;
      known.failed += check.failed;
      known.unknown += check.unknown;
    }
  }
  return [...merged.values()].map((check) => ({ ...check, status: postureCheckStatus(check) }));
}
