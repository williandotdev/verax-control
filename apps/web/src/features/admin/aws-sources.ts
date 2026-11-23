import {
  AWS_SOURCE_KIND_INFO,
  AWS_SOURCE_KINDS,
  type AwsOnboarding,
  type AwsOnboardingCheck,
  type AwsSource,
  type AwsSourceKind,
} from '@verax/shared';

/**
 * As fontes de log de uma conta AWS como a tela as organiza. Só regras de leitura do que a API mandou (o contrato de
 * `packages/shared/src/aws-onboarding.ts`): a tela nunca decide sozinha que uma fonte está autorizada ou coletando.
 */

/**
 * O `id` da linha de uma fonte em "Fontes autorizadas": é para onde as conferências da conexão apontam a fonte que as
 * deixa pendentes ou com falha (`sourceIds`).
 */
export function awsAuthorizedSourceAnchor(sourceId: string): string {
  return `aws-autorizada-${sourceId}`;
}

/** A autorização da fonte está valendo (autorizada e não retirada)? */
export function isAuthorizedSource(source: Pick<AwsSource, 'authorization'>): boolean {
  return source.authorization.authorizedAt !== null && source.authorization.revokedAt === null;
}

/**
 * Onde uma fonte sem autorização aparece:
 * - `available`: existe, o Verax lê e pode ser autorizada;
 * - `covered`: existe, mas o mesmo bucket já é lido pelo cadastro manual (autorizar duplicaria a coleta);
 * - `needs_permission`: existe, e falta a permissão (ou ela ainda não foi conferida);
 * - `not_enabled`: o serviço está desligado na conta, ou ligado sem log configurado;
 * - `unsupported`: grava num destino ou num formato que o Verax não lê;
 * - `not_collected`: tipo que o Verax já encontra e ainda não coleta;
 * - `gone`: a autorização foi retirada e a fonte não existe mais na conta.
 */
export const AWS_SOURCE_GROUPS = [
  'available',
  'covered',
  'needs_permission',
  'not_enabled',
  'unsupported',
  'not_collected',
  'gone',
] as const;
export type AwsSourceGroup = (typeof AWS_SOURCE_GROUPS)[number];

/** O grupo de uma fonte sem autorização valendo, pelo que a descoberta e a sondagem disseram dela. */
export function awsSourceGroup(source: AwsSource): AwsSourceGroup {
  if (!source.collectable) return 'not_collected';
  if (source.missingSince !== null) return 'gone';
  if (source.availability === 'not_enabled' || source.availability === 'no_destination') return 'not_enabled';
  if (source.availability !== 'available') return 'unsupported';
  if (source.notes.includes('covered_by_legacy')) return 'covered';
  return source.permission === 'granted' ? 'available' : 'needs_permission';
}

/** A fonte pode entrar num pedido de autorização (a API recusa as outras, e a tela nem as oferece)? */
export function isAuthorizableSource(source: AwsSource): boolean {
  return (
    source.origin !== 'legacy' &&
    (!isAuthorizedSource(source) || source.state === 'source_missing') &&
    awsSourceGroup(source) === 'available'
  );
}

/**
 * A ordem dos tipos na tela: a do catálogo, com a API do GuardDuty antes do export dele (a forma recomendada primeiro).
 */
const DISPLAY_ORDER: readonly AwsSourceKind[] = [
  ...AWS_SOURCE_KINDS.filter((kind) => kind !== 'guardduty_export'),
].flatMap((kind) => (kind === 'guardduty' ? (['guardduty', 'guardduty_export'] as const) : [kind]));
const KIND_ORDER = new Map<AwsSourceKind, number>(DISPLAY_ORDER.map((kind, index) => [kind, index]));

/** Por tipo (na ordem da tela), depois pela região e pelo nome. */
export function compareAwsSources(a: AwsSource, b: AwsSource): number {
  return (
    (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
    a.region.localeCompare(b.region) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

export interface AwsSourceGroups {
  /** As fontes com a autorização valendo (as do cadastro manual também): a tabela do acompanhamento. */
  authorized: AwsSource[];
  /** As demais, menos os grupos do CloudWatch Logs, pelo grupo da tela. */
  groups: Readonly<Record<AwsSourceGroup, AwsSource[]>>;
  /** Os grupos do CloudWatch Logs sem autorização: podem ser centenas, e têm a própria lista com busca. */
  logGroups: AwsSource[];
}

/** As fontes da conta separadas como a tela mostra. */
export function groupAwsSources(sources: readonly AwsSource[]): AwsSourceGroups {
  const groups: Record<AwsSourceGroup, AwsSource[]> = {
    available: [],
    covered: [],
    needs_permission: [],
    not_enabled: [],
    unsupported: [],
    not_collected: [],
    gone: [],
  };
  const authorized: AwsSource[] = [];
  const logGroups: AwsSource[] = [];
  for (const source of [...sources].sort(compareAwsSources)) {
    if (isAuthorizedSource(source)) authorized.push(source);
    else if (source.kind === 'cloudwatch_log_group') logGroups.push(source);
    else groups[awsSourceGroup(source)].push(source);
  }
  return { authorized, groups, logGroups };
}

/**
 * O export do GuardDuty traz os mesmos achados da API dele: com os dois na conta, a API é a recomendada e o export fica
 * "coberto pela API". Vale a nota da descoberta e, sem ela, a presença de uma fonte `guardduty` que dá para ler.
 */
export function isCoveredByGuardDutyApi(source: AwsSource, sources: readonly AwsSource[]): boolean {
  if (source.kind !== 'guardduty_export') return false;
  if (source.notes.includes('covered_by_api')) return true;
  return sources.some((other) => other.kind === 'guardduty' && other.availability === 'available');
}

/** A API do GuardDuty é a forma recomendada de ler os achados quando a conta também tem o export. */
export function isRecommendedSource(source: AwsSource, sources: readonly AwsSource[]): boolean {
  if (source.notes.includes('recommended')) return true;
  return (
    source.kind === 'guardduty' &&
    source.availability === 'available' &&
    sources.some((other) => other.kind === 'guardduty_export')
  );
}

/**
 * Antes de autorizar, o aviso de volume vale para as fontes de volume alto: os VPC Flow Logs, os grupos do CloudWatch
 * Logs e o que a descoberta marcou com a nota `high_volume`.
 */
export function isHighVolumeSource(source: AwsSource): boolean {
  return (
    source.kind === 'vpc_flow_logs' ||
    source.kind === 'cloudwatch_log_group' ||
    source.notes.includes('high_volume')
  );
}

/** A fonte traz achados (lida pela API de um serviço de segurança), e não um fluxo contínuo de eventos? */
export function isFindingSource(source: Pick<AwsSource, 'kind'>): boolean {
  return AWS_SOURCE_KIND_INFO[source.kind].capability === 'findings';
}

/** O texto de busca de um grupo de logs: o nome e a região, em minúsculas. */
export function matchesLogGroupSearch(source: AwsSource, search: string): boolean {
  const term = search.trim().toLowerCase();
  if (term === '') return true;
  return source.name.toLowerCase().includes(term) || source.region.toLowerCase().includes(term);
}

/**
 * As conferências que impedem dizer "tudo certo": as que falharam; com a coleta andando, as que ainda esperam; e as que
 * passaram com ressalva (a entrada no papel com um aviso, a descoberta que não leu tudo).
 */
export function attentionChecks(onboarding: Pick<AwsOnboarding, 'state' | 'checks'>): AwsOnboardingCheck[] {
  const collecting = onboarding.state === 'collecting' || onboarding.state === 'partial';
  return onboarding.checks.filter(
    (check) =>
      check.status === 'failed' ||
      (collecting && check.status === 'pending') ||
      (check.status === 'ok' && check.code !== null),
  );
}

/** O horário da conferência mais recente da conexão (a entrada no papel, a identidade ou o modelo); null sem nenhuma. */
export function lastVerifiedAt(checks: readonly AwsOnboardingCheck[]): string | null {
  let latest: string | null = null;
  for (const check of checks) {
    if (check.id !== 'assume_role' && check.id !== 'identity' && check.id !== 'template') continue;
    if (check.checkedAt !== null && (latest === null || check.checkedAt > latest)) latest = check.checkedAt;
  }
  return latest;
}
