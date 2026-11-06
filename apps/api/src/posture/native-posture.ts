import {
  DATABASE_PORTS,
  GLOBAL_REGION,
  INVENTORY_INVALID_ITEMS,
  isAwsRegion,
  MAX_POSTURE_ERRORS,
  NATIVE_POSTURE_CHECKS,
  type NativePostureCheck,
  POSTURE_CHECK_ID,
  POSTURE_SECTIONS,
  POSTURE_SEVERITIES,
  type PostureCheckResult,
  postureCheckResultSchema,
  postureErrorValue,
  type PostureSection,
  type PostureSectionError,
  POSTURE_TRUNCATED,
  REGIONAL_POSTURE_SECTIONS,
} from '@verax/shared';
import { z } from 'zod';
import type { BucketInfo, IamAccessKey, OpenRule, PublicAccessBlock } from '../inventory/collectors.js';
import type { AccountInventory } from '../inventory/inventory.js';
import { KEY_MAX_AGE_DAYS, KEY_UNUSED_DAYS } from '../inventory/risk-rules.js';
import type { PostureReads } from './posture-reads.js';
import {
  type CheckStatus,
  type PostureCheck,
  type PostureSummary,
  summarizePosture,
} from './prowler-report.js';

/**
 * A postura nativa da AWS (fase 2, PR-15'): as 18 checagens do catálogo (`NATIVE_POSTURE_CHECKS`, em
 * `packages/shared`) sobre o que a coleta leu, o inventário (`AccountInventory`) e as leituras próprias da postura
 * (`PostureReads`). Sem chamada à AWS aqui: só regras, explícitas e testadas.
 *
 * Cada checagem dá um resultado por recurso (usuário, chave, security group, instância, bucket), por região (EBS e
 * GuardDuty) ou da conta (root, política de senha, bloqueio da conta, trilha), como o Prowler: aprovado, reprovado ou
 * não lido (`manual`). A leitura recusada deixa a checagem não lida naquele escopo (uma região, a conta, um bucket):
 * fora da nota e nunca aprovada. Sem recurso a conferir, a checagem não se aplica (nenhum resultado). A nota é a de
 * sempre (`summarizePosture`: crítica 10, alta 5, média 2, baixa 1, só aprovadas e reprovadas).
 *
 * Uma parte do inventário que passou do teto de itens (1.000 por tipo) deixa a checagem dela com um resultado não lido
 * naquele escopo, além dos itens conferidos: sem reprovação entre eles, a checagem fica não lida, nunca aprovada, e a
 * varredura sai parcial (`parte[:região]:truncated`).
 *
 * Cada resultado passa pelo zod antes de entrar: um fora do formato (um nome que a AWS mudou, um texto grande demais)
 * fica de fora, é contado e marca a leitura dele com `invalid_items`.
 */

const DAY = 24 * 60 * 60 * 1000;

type Outcome = Extract<CheckStatus, 'pass' | 'fail' | 'manual'>;

/** O que um resultado confere: a região (ou `global`), o recurso mostrado na tela e a chave estável do resultado. */
interface Subject {
  region: string;
  resource: string | null;
  key: string;
}

/** Verdadeiro, falso ou não lido: a lógica de três valores do S3 (uma leitura recusada pode decidir ou não). */
type Tri = boolean | null;
const or = (a: Tri, b: Tri): Tri =>
  a === true || b === true ? true : a === null || b === null ? null : false;
const and = (a: Tri, b: Tri): Tri =>
  a === false || b === false ? false : a === null || b === null ? null : true;
const not = (a: Tri): Tri => (a === null ? null : !a);

interface Context {
  accountId: string;
  inventory: AccountInventory;
  reads: PostureReads;
  now: Date;
}

/**
 * O código da recusa de uma parte inteira do inventário, ou null se ela foi lida. No S3, as leituras recusadas de um
 * bucket também entram em `errors` com a parte `s3`; a listagem só foi recusada se nenhum bucket entrou (com algum
 * bucket, a listagem foi lida e a recusa é de um bucket, que a checagem do bucket trata).
 */
function partRefused(context: Context, section: PostureSection, region: string | null): string | null {
  const error = context.inventory.errors.find(
    (entry) => entry.section === section && entry.region === region,
  );
  if (error === undefined) return null;
  if (section === 's3' && context.inventory.buckets.length > 0) return null;
  return error.code;
}

type Evaluate = (context: Context) => [Outcome, Subject][];

const account = (key: string, resource: string | null = null): Subject => ({
  region: GLOBAL_REGION,
  resource,
  key,
});
const inRegion = (region: string, key: string, resource: string | null = null): Subject => ({
  region,
  resource,
  key,
});
const outcome = (passed: Tri): Outcome => (passed === null ? 'manual' : passed ? 'pass' : 'fail');

// --- IAM ---

function rootCheck(passes: (root: NonNullable<AccountInventory['root']>) => boolean): Evaluate {
  return (context) => {
    const root = context.inventory.root;
    const subject = account('root', `arn:aws:iam::${context.accountId}:root`);
    return [[root === null ? 'manual' : outcome(passes(root)), subject]];
  };
}

/** Os resultados de cada chave ativa; com o IAM recusado, um resultado não lido da conta. */
function activeKeyCheck(passes: (key: IamAccessKey, now: Date) => Tri): Evaluate {
  return (context) => {
    if (partRefused(context, 'iam', null) !== null) return [['manual', account('iam')]];
    return context.inventory.users.flatMap((user) =>
      user.accessKeys
        .filter((key) => key.status === 'Active')
        .map((key): [Outcome, Subject] => [
          outcome(passes(key, context.now)),
          account(`key:${key.id}`, `${user.userName} · ${key.id}`),
        ]),
    );
  };
}

const olderThan = (date: string | null, days: number, now: Date): Tri =>
  date === null ? null : now.getTime() - Date.parse(date) > days * DAY;

function passwordCheck(
  passes: (policy: { minimumLength: number | null; reusePrevention: number | null }) => boolean,
): Evaluate {
  return ({ reads }) => {
    const read = reads.passwordPolicy;
    const subject = account('password_policy');
    if (!read.ok) return [['manual', subject]];
    // Sem política, vale a padrão da AWS (8 caracteres, reúso livre): reprovada.
    return [[read.value === null ? 'fail' : outcome(passes(read.value)), subject]];
  };
}

// --- EC2 ---

const TCP = new Set(['tcp', '6']);
const TCP_OR_UDP = new Set(['tcp', '6', 'udp', '17']);

/** A regra libera a porta TCP: todo protocolo, ou TCP numa faixa que a inclui (sem faixa é toda porta). */
function opensTcpPort(rule: OpenRule, port: number): boolean {
  if (rule.protocol === '-1') return true;
  if (!TCP.has(rule.protocol)) return false;
  if (rule.fromPort === null || rule.toPort === null) return true;
  return rule.fromPort <= port && port <= rule.toPort;
}

/** Todo o tráfego, ou TCP ou UDP em todas as portas. */
function opensAllPorts(rule: OpenRule): boolean {
  if (rule.protocol === '-1') return true;
  if (!TCP_OR_UDP.has(rule.protocol)) return false;
  if (rule.fromPort === null || rule.toPort === null) return true;
  return rule.fromPort <= 0 && rule.toPort >= 65535;
}

/** Um resultado por security group de cada região monitorada; a região recusada fica não lida. */
function securityGroupCheck(fails: (rule: OpenRule) => boolean): Evaluate {
  return (context) =>
    context.inventory.regions.flatMap((region): [Outcome, Subject][] => {
      if (partRefused(context, 'sg', region) !== null) return [['manual', inRegion(region, 'sg')]];
      return context.inventory.securityGroups
        .filter((group) => group.region === region)
        .map((group) => [
          group.openToWorld.some(fails) ? 'fail' : 'pass',
          inRegion(
            region,
            `sg:${group.groupId}`,
            group.name === null ? group.groupId : `${group.groupId} (${group.name})`,
          ),
        ]);
    });
}

const imdsV2: Evaluate = (context) =>
  context.inventory.regions.flatMap((region): [Outcome, Subject][] => {
    if (partRefused(context, 'ec2', region) !== null) return [['manual', inRegion(region, 'ec2')]];
    return context.inventory.instances
      .filter((instance) => instance.region === region && instance.state !== 'terminated')
      .map((instance) => [
        instance.imdsV2Required ? 'pass' : 'fail',
        inRegion(region, `instance:${instance.instanceId}`, instance.instanceId),
      ]);
  });

const ebsDefaultEncryption: Evaluate = ({ reads }) =>
  reads.ebsDefaultEncryption.map(({ region, read }) => [
    read.ok ? outcome(read.value) : 'manual',
    inRegion(region, 'ebs'),
  ]);

// --- S3 ---

type BlockFlag = keyof PublicAccessBlock;

/** Uma trava do bloqueio do bucket: ligada, desligada (sem bloqueio configurado) ou não lida. */
function bucketFlag(bucket: BucketInfo, flag: BlockFlag): Tri {
  if (bucket.publicAccessBlock !== null) return bucket.publicAccessBlock[flag];
  return bucket.unreadable.some((entry) => entry.startsWith('GetPublicAccessBlock:')) ? null : false;
}

/** Uma trava do bloqueio da conta: ligada, desligada (sem bloqueio configurado) ou não lida. */
function accountFlag(reads: PostureReads, flag: BlockFlag): Tri {
  const read = reads.accountPublicAccessBlock;
  if (!read.ok) return null;
  return read.value === null ? false : read.value[flag];
}

/** Um resultado por bucket; com a listagem recusada, um resultado não lido da conta. */
function bucketCheck(passes: (bucket: BucketInfo, reads: PostureReads) => Tri): Evaluate {
  return (context) => {
    if (partRefused(context, 's3', null) !== null) return [['manual', account('s3')]];
    return context.inventory.buckets.map((bucket) => [
      outcome(passes(bucket, context.reads)),
      inRegion(
        bucket.region !== null && isAwsRegion(bucket.region) ? bucket.region : GLOBAL_REGION,
        `bucket:${bucket.name}`,
        bucket.name,
      ),
    ]);
  };
}

/**
 * A trava que vale para o bucket: a do bucket ou a da conta. O S3 aplica a combinação mais restritiva das duas, trava a
 * trava (https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html): ligada em
 * qualquer um dos níveis, vale; não lida num nível e desligada no outro, fica não lida.
 */
function effectiveFlag(bucket: BucketInfo, reads: PostureReads, flag: BlockFlag): Tri {
  return or(bucketFlag(bucket, flag), accountFlag(reads, flag));
}

/**
 * Público: a política pública que a trava efetiva de restringir buckets públicos não segura, ou a ACL pública que a de
 * ignorar ACLs públicas não ignora. Uma leitura recusada que poderia mudar a resposta deixa o bucket não lido.
 */
function bucketNotPublic(bucket: BucketInfo, reads: PostureReads): Tri {
  const restricted = effectiveFlag(bucket, reads, 'restrictPublicBuckets');
  const ignored = effectiveFlag(bucket, reads, 'ignorePublicAcls');
  return not(or(and(bucket.policyPublic, not(restricted)), and(bucket.aclPublic, not(ignored))));
}

/**
 * Protegido pelo bloqueio: as duas travas que neutralizam o acesso público (ignorar ACLs públicas e restringir buckets
 * públicos) valendo, cada uma combinada entre o bucket e a conta. A do bucket com uma trava e a da conta com a outra
 * também protegem.
 */
function bucketBlocked(bucket: BucketInfo, reads: PostureReads): Tri {
  return and(
    effectiveFlag(bucket, reads, 'ignorePublicAcls'),
    effectiveFlag(bucket, reads, 'restrictPublicBuckets'),
  );
}

const accountBlock: Evaluate = ({ reads }) => {
  const subject = account('s3_account');
  if (!reads.accountPublicAccessBlock.ok) return [['manual', subject]];
  return [
    [
      outcome(and(accountFlag(reads, 'ignorePublicAcls'), accountFlag(reads, 'restrictPublicBuckets'))),
      subject,
    ],
  ];
};

// --- CloudTrail e GuardDuty ---

const multiRegionTrail: Evaluate = ({ reads }) => {
  const read = reads.cloudTrail;
  if (!read.ok) return [['manual', account('trail')]];
  return [[read.value.loggingTrail === null ? 'fail' : 'pass', account('trail', read.value.loggingTrail)]];
};

const guardDutyEnabled: Evaluate = ({ reads }) =>
  reads.guardDuty.map(({ region, read }) => [
    read.ok ? outcome(read.value === 'enabled') : 'manual',
    inRegion(region, 'guardduty'),
  ]);

/** A regra de cada checagem do catálogo. */
const EVALUATORS: Readonly<Record<string, Evaluate>> = {
  iam_root_mfa_enabled: rootCheck((root) => root.mfaEnabled),
  iam_no_root_access_key: rootCheck((root) => !root.accessKeysPresent),
  iam_user_mfa_enabled_console_access: (context) => {
    if (partRefused(context, 'iam', null) !== null) return [['manual', account('iam')]];
    return context.inventory.users
      .filter((user) => user.consoleAccess)
      .map((user) => [user.mfaEnabled ? 'pass' : 'fail', account(`user:${user.userName}`, user.userName)]);
  },
  iam_rotate_access_key_90_days: activeKeyCheck((key, now) =>
    not(olderThan(key.createdAt, KEY_MAX_AGE_DAYS, now)),
  ),
  // Chave nova que ainda não foi usada não é "parada": conta a partir da criação (a mesma regra de Ativos).
  iam_user_accesskey_unused: activeKeyCheck((key, now) =>
    not(olderThan(key.lastUsedAt ?? key.createdAt, KEY_UNUSED_DAYS, now)),
  ),
  iam_password_policy_minimum_length_14: passwordCheck((policy) => (policy.minimumLength ?? 0) >= 14),
  iam_password_policy_reuse_24: passwordCheck((policy) => (policy.reusePrevention ?? 0) >= 24),
  ec2_securitygroup_allow_ingress_from_internet_to_all_ports: securityGroupCheck(opensAllPorts),
  ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22: securityGroupCheck((rule) =>
    opensTcpPort(rule, 22),
  ),
  ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_3389: securityGroupCheck((rule) =>
    opensTcpPort(rule, 3389),
  ),
  ec2_securitygroup_allow_ingress_from_internet_to_database_ports: securityGroupCheck((rule) =>
    DATABASE_PORTS.some((port) => opensTcpPort(rule, port)),
  ),
  ec2_instance_imdsv2_enabled: imdsV2,
  ec2_ebs_default_encryption: ebsDefaultEncryption,
  s3_bucket_public_access: bucketCheck(bucketNotPublic),
  s3_bucket_level_public_access_block: bucketCheck(bucketBlocked),
  s3_account_level_public_access_blocks: accountBlock,
  cloudtrail_multi_region_enabled: multiRegionTrail,
  guardduty_is_enabled: guardDutyEnabled,
};

/** O formato de um resultado antes de entrar na varredura (os limites são os das colunas de `PostureFailure`). */
const resultSchema = z.strictObject({
  checkId: z.string().regex(POSTURE_CHECK_ID),
  findingUid: z.string().min(1).max(512),
  status: z.enum(['pass', 'fail', 'manual']),
  severity: z.enum(POSTURE_SEVERITIES),
  title: z.string().min(1).max(500),
  region: z.string().regex(/^[a-z0-9-]{1,40}$/),
  resourceUid: z.string().min(1).max(4000).nullable(),
  resourceType: z.string().max(4000).nullable(),
  detail: z.null(),
  risk: z.string().max(4000).nullable(),
  remediation: z.string().max(4000).nullable(),
  references: z.array(z.url({ protocol: /^https$/ })).max(20),
});

function toResult(
  check: NativePostureCheck,
  accountId: string,
  [status, subject]: [Outcome, Subject],
): PostureCheck {
  return {
    checkId: check.id,
    findingUid: `${check.id}:${subject.region}:${subject.key}`,
    status,
    severity: check.severity,
    title: status === 'fail' ? check.failTitle : check.title,
    region: subject.region,
    resourceUid: subject.resource,
    resourceType: check.resourceType,
    detail: null,
    risk: check.risk,
    remediation: check.remediation({ accountId, region: subject.region, resource: subject.resource }),
    references: [...check.references],
  };
}

/** Uma reprovação no formato de `PostureFailure` (sem o cliente e a varredura, que a gravação põe). */
export interface PostureFailureData {
  findingUid: string;
  checkId: string;
  title: string;
  severity: PostureCheck['severity'];
  region: string;
  resource: string | null;
  resourceType: string | null;
  risk: string | null;
  remediation: string | null;
  references: string[];
}

export interface PostureScanData {
  accountId: string;
  /** O início da coleta (o mesmo `collectedAt` do retrato): com a conta e o cliente, a chave única da varredura. */
  scannedAt: Date;
  summary: PostureSummary;
  /** Cada checagem do catálogo, na ordem dele, com as contagens. */
  checks: PostureCheckResult[];
  failures: PostureFailureData[];
  /** As leituras recusadas, no formato gravado (`ec2:us-east-1:UnauthorizedOperation`). */
  errors: string[];
  /** Resultados recusados pelo zod (só para o relatório da tarefa; nenhum dado do resultado). */
  dropped: number;
}

/**
 * As partes do inventário que passaram do teto de itens (`AccountInventory.truncated`: `iam`, `s3`, `ec2:<região>`,
 * `sg:<região>`), com a região das regionais. Os itens além do teto não foram conferidos.
 */
function truncatedScopes(inventory: AccountInventory): { section: PostureSection; region: string | null }[] {
  return inventory.truncated.flatMap((entry) => {
    const [section = '', region = null] = entry.split(':');
    const known = POSTURE_SECTIONS.find((candidate) => candidate === section);
    if (known === undefined || (region !== null && !isAwsRegion(region))) return [];
    return [{ section: known, region }];
  });
}

/**
 * Um resultado não lido em cada escopo cortado pelo teto da parte de que a checagem depende: sem reprovação entre os
 * itens conferidos, a checagem não pode ser aprovada (os itens além do teto ficaram de fora); uma reprovação achada
 * continua reprovando.
 */
function truncatedResults(context: Context, section: PostureSection): [Outcome, Subject][] {
  return truncatedScopes(context.inventory)
    .filter((scope) => scope.section === section)
    .map((scope) => [
      'manual',
      scope.region === null
        ? account(`${section}:${POSTURE_TRUNCATED}`)
        : inRegion(scope.region, `${section}:${POSTURE_TRUNCATED}`),
    ]);
}

/** As leituras recusadas da coleta (as do inventário e as da postura) e as partes cortadas pelo teto de itens. */
function readErrors(inventory: AccountInventory, reads: PostureReads): PostureSectionError[] {
  const errors: PostureSectionError[] = inventory.errors.map((error) => ({ ...error }));
  for (const scope of truncatedScopes(inventory)) errors.push({ ...scope, code: POSTURE_TRUNCATED });
  if (!reads.passwordPolicy.ok)
    errors.push({ section: 'password_policy', region: null, code: reads.passwordPolicy.code });
  if (!reads.accountPublicAccessBlock.ok)
    errors.push({ section: 's3_account', region: null, code: reads.accountPublicAccessBlock.code });
  for (const { region, read } of reads.ebsDefaultEncryption)
    if (!read.ok) errors.push({ section: 'ebs', region, code: read.code });
  for (const { region, read } of reads.guardDuty)
    if (!read.ok) errors.push({ section: 'guardduty', region, code: read.code });
  if (!reads.cloudTrail.ok) errors.push({ section: 'cloudtrail', region: null, code: reads.cloudTrail.code });
  return errors;
}

/**
 * A varredura de uma conta: os resultados de cada checagem (conferidos pelo zod), a nota pelo `summarizePosture`, as
 * contagens por checagem, as reprovações e as leituras recusadas.
 */
export function toPostureScan(inventory: AccountInventory, reads: PostureReads): PostureScanData {
  const scannedAt = new Date(inventory.collectedAt);
  const context: Context = { accountId: inventory.accountId, inventory, reads, now: scannedAt };
  const errors = readErrors(inventory, reads);
  const results: PostureCheck[] = [];
  const checks: PostureCheckResult[] = [];
  let dropped = 0;
  for (const check of NATIVE_POSTURE_CHECKS) {
    const evaluate = EVALUATORS[check.id];
    if (evaluate === undefined) continue;
    const counts = { passed: 0, failed: 0, unknown: 0 };
    for (const raw of [...evaluate(context), ...truncatedResults(context, check.section)]) {
      const candidate = toResult(check, inventory.accountId, raw);
      const parsed = resultSchema.safeParse(candidate);
      if (!parsed.success) {
        dropped += 1;
        const region =
          REGIONAL_POSTURE_SECTIONS.has(check.section) && isAwsRegion(raw[1].region) ? raw[1].region : null;
        errors.push({ section: check.section, region, code: INVENTORY_INVALID_ITEMS });
        continue;
      }
      results.push(parsed.data);
      if (parsed.data.status === 'pass') counts.passed += 1;
      else if (parsed.data.status === 'fail') counts.failed += 1;
      else counts.unknown += 1;
    }
    checks.push(
      postureCheckResultSchema.parse({
        checkId: check.id,
        title: check.title,
        severity: check.severity,
        ...counts,
      }),
    );
  }
  return {
    accountId: inventory.accountId,
    scannedAt,
    summary: summarizePosture(results),
    checks,
    failures: results
      .filter((result) => result.status === 'fail')
      .map((result) => ({
        findingUid: result.findingUid,
        checkId: result.checkId,
        title: result.title,
        severity: result.severity,
        region: result.region,
        resource: result.resourceUid,
        resourceType: result.resourceType,
        risk: result.risk,
        remediation: result.remediation,
        references: result.references,
      })),
    errors: [...new Set(errors.map(postureErrorValue))].slice(0, MAX_POSTURE_ERRORS),
    dropped,
  };
}
