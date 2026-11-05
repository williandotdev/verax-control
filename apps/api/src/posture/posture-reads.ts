import { DescribeTrailsCommand, GetTrailStatusCommand } from '@aws-sdk/client-cloudtrail';
import { GetEbsEncryptionByDefaultCommand } from '@aws-sdk/client-ec2';
import { GetDetectorCommand, ListDetectorsCommand } from '@aws-sdk/client-guardduty';
import { GetAccountPasswordPolicyCommand } from '@aws-sdk/client-iam';
import { GetPublicAccessBlockCommand } from '@aws-sdk/client-s3-control';
import { INVENTORY_INVALID_ITEMS, isAwsRegion } from '@verax/shared';
import { z } from 'zod';
import { AwsConnectionError, awsErrorName, STS_FALLBACK_REGION } from '../aws/web-identity.js';
import { isPermanentFailure, type PublicAccessBlock } from '../inventory/collectors.js';
import {
  codeOf,
  type InventoryClients,
  InventoryUnavailable,
  inventoryRegions,
} from '../inventory/inventory.js';

/**
 * As leituras próprias da postura nativa (fase 2, PR-15'), feitas na mesma coleta do inventário e com os mesmos
 * clientes (a sessão do papel, o sinal da tarefa e a fila do IAM). O resto das checagens sai do que o inventário já
 * leu. Só leitura, e poucas chamadas (cada uma é uma linha no CloudTrail do cliente), todas na política `PosturaEAtivos`
 * ou `ValidarFontes` do papel `verax-control-reader`, sem mudança no template:
 * - `GetAccountPasswordPolicy` (IAM), uma vez;
 * - `GetPublicAccessBlock` do S3 Control (o bloqueio de acesso público da conta), uma vez, pela região de partida;
 * - por região monitorada: `GetEbsEncryptionByDefault`, `ListDetectors` e, com um detector, `GetDetector`;
 * - `DescribeTrails` com as trilhas de outras regiões e da organização, na região de partida, e `GetTrailStatus` das
 *   multirregião, na região de origem de cada uma, até achar uma gravando.
 *
 * A política de falha é a do inventário (`isPermanentFailure`): a leitura recusada (permissão, SCP, região desligada)
 * ou com outro erro que não passa sozinho vira `{ ok: false, code }`, e as checagens que dependem dela ficam "não
 * lidas" naquele escopo (nunca reprovadas nem aprovadas); a falha passageira, a sessão perdida e o cancelamento param a
 * coleta inteira, sem gravar nada. Uma resposta fora do formato também fica "não lida" (`invalid_items`).
 */

/** Uma leitura: o valor, ou o código do erro (o nome do erro da AWS, nunca a mensagem). */
export type Read<T> = { ok: true; value: T } | { ok: false; code: string };

export interface PasswordPolicy {
  minimumLength: number | null;
  reusePrevention: number | null;
}

/** O detector do GuardDuty de uma região: ligado, suspenso ou nenhum. */
export type DetectorState = 'enabled' | 'suspended' | 'missing';

export interface TrailCoverage {
  /** A trilha multirregião que está gravando (o ARN); null sem nenhuma. */
  loggingTrail: string | null;
  /** Quantas trilhas multirregião a conta tem. */
  multiRegionTrails: number;
}

export interface PostureReads {
  /** null: a conta não tem política de senha (vale a padrão da AWS). */
  passwordPolicy: Read<PasswordPolicy | null>;
  /** null: o bloqueio de acesso público da conta não está configurado. */
  accountPublicAccessBlock: Read<PublicAccessBlock | null>;
  /** Por região monitorada, na ordem do cadastro. */
  ebsDefaultEncryption: { region: string; read: Read<boolean> }[];
  cloudTrail: Read<TrailCoverage>;
  /** Por região monitorada, na ordem do cadastro. */
  guardDuty: { region: string; read: Read<DetectorState> }[];
}

/** Até quantas trilhas multirregião têm o estado conferido (uma gravando basta; normalmente há uma). */
export const MAX_TRAIL_STATUS_CALLS = 5;

const policySchema = z.object({
  MinimumPasswordLength: z.number().int().min(0).max(1024).optional(),
  PasswordReusePrevention: z.number().int().min(0).max(1024).optional(),
});
const blockSchema = z.object({
  BlockPublicAcls: z.boolean().optional(),
  IgnorePublicAcls: z.boolean().optional(),
  BlockPublicPolicy: z.boolean().optional(),
  RestrictPublicBuckets: z.boolean().optional(),
});
const trailsSchema = z
  .array(
    z.object({
      TrailARN: z.string().min(1).max(512).optional(),
      HomeRegion: z.string().max(64).optional(),
      IsMultiRegionTrail: z.boolean().optional(),
    }),
  )
  .max(1000);
const detectorIdsSchema = z.array(z.string().regex(/^[a-z0-9]{1,300}$/)).max(50);

/** A resposta fora do formato: a leitura fica "não lida", como uma recusa. */
class OutOfFormat extends Error {}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new OutOfFormat();
  return result.data;
}

/**
 * Uma leitura pela política de falha da coleta. `missing` diz quais erros querem dizer "não existe" (a conta sem
 * política de senha, sem bloqueio configurado) e o valor que eles valem.
 */
async function attempt<T>(
  call: () => Promise<T>,
  signal: AbortSignal | undefined,
  missing?: { codes: readonly string[]; value: T },
): Promise<Read<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (error instanceof OutOfFormat) return { ok: false, code: INVENTORY_INVALID_ITEMS };
    // A parada do worker, o orçamento ou a concessão perdida: a coleta para aqui, com o motivo do sinal.
    signal?.throwIfAborted();
    if (error instanceof AwsConnectionError) throw error;
    const name = awsErrorName(error);
    if (missing?.codes.includes(name)) return { ok: true, value: missing.value };
    if (!isPermanentFailure(error)) throw new InventoryUnavailable('aws_unavailable');
    return { ok: false, code: codeOf(name) };
  }
}

async function passwordPolicy(
  clients: InventoryClients,
  signal: AbortSignal | undefined,
): Promise<Read<PasswordPolicy | null>> {
  return attempt<PasswordPolicy | null>(
    async () => {
      const { PasswordPolicy: policy } = await clients.iam().send(new GetAccountPasswordPolicyCommand({}));
      const value = parsed(policySchema, policy ?? {});
      return {
        minimumLength: value.MinimumPasswordLength ?? null,
        reusePrevention: value.PasswordReusePrevention ?? null,
      };
    },
    signal,
    { codes: ['NoSuchEntityException', 'NoSuchEntity'], value: null },
  );
}

async function accountPublicAccessBlock(
  clients: InventoryClients,
  accountId: string,
  signal: AbortSignal | undefined,
): Promise<Read<PublicAccessBlock | null>> {
  return attempt<PublicAccessBlock | null>(
    async () => {
      const response = await clients
        .s3control()
        .send(new GetPublicAccessBlockCommand({ AccountId: accountId }));
      const config = parsed(blockSchema, response.PublicAccessBlockConfiguration ?? {});
      return {
        blockPublicAcls: config.BlockPublicAcls === true,
        ignorePublicAcls: config.IgnorePublicAcls === true,
        blockPublicPolicy: config.BlockPublicPolicy === true,
        restrictPublicBuckets: config.RestrictPublicBuckets === true,
      };
    },
    signal,
    { codes: ['NoSuchPublicAccessBlockConfiguration'], value: null },
  );
}

async function ebsDefaultEncryption(
  clients: InventoryClients,
  region: string,
  signal: AbortSignal | undefined,
): Promise<Read<boolean>> {
  return attempt(async () => {
    const response = await clients.ec2(region).send(new GetEbsEncryptionByDefaultCommand({}));
    return parsed(z.boolean().optional(), response.EbsEncryptionByDefault) === true;
  }, signal);
}

async function guardDuty(
  clients: InventoryClients,
  region: string,
  signal: AbortSignal | undefined,
): Promise<Read<DetectorState>> {
  const guardduty = clients.guardduty(region);
  const listed = await attempt(async () => {
    const response = await guardduty.send(new ListDetectorsCommand({}));
    return parsed(detectorIdsSchema, response.DetectorIds ?? []);
  }, signal);
  if (!listed.ok) return listed;
  const [detectorId] = listed.value;
  if (detectorId === undefined) return { ok: true, value: 'missing' };
  // Uma região tem no máximo um detector por conta.
  const detector = await attempt(async () => {
    const response = await guardduty.send(new GetDetectorCommand({ DetectorId: detectorId }));
    return parsed(z.string().max(32).optional(), response.Status);
  }, signal);
  if (!detector.ok) return detector;
  return { ok: true, value: detector.value === 'ENABLED' ? 'enabled' : 'suspended' };
}

/**
 * As trilhas que valem para a conta (as desta região, as multirregião de outras e as da organização) e o estado das
 * multirregião, até achar uma gravando. Uma trilha da organização vista da conta-membro pode ter o estado recusado: sem
 * outra gravando, a checagem fica "não lida" (nunca reprovada por isso).
 */
async function cloudTrail(
  clients: InventoryClients,
  home: string,
  signal: AbortSignal | undefined,
): Promise<Read<TrailCoverage>> {
  const described = await attempt(async () => {
    const response = await clients
      .cloudtrail(home)
      .send(new DescribeTrailsCommand({ includeShadowTrails: true }));
    return parsed(trailsSchema, response.trailList ?? []);
  }, signal);
  if (!described.ok) return described;
  const multiRegion = new Map<string, string>();
  for (const trail of described.value) {
    if (trail.IsMultiRegionTrail !== true || trail.TrailARN === undefined) continue;
    const region = trail.HomeRegion !== undefined && isAwsRegion(trail.HomeRegion) ? trail.HomeRegion : home;
    multiRegion.set(trail.TrailARN, region);
  }
  let refused: string | null = null;
  for (const [arn, region] of [...multiRegion].slice(0, MAX_TRAIL_STATUS_CALLS)) {
    const status = await attempt(async () => {
      const response = await clients.cloudtrail(region).send(new GetTrailStatusCommand({ Name: arn }));
      return parsed(z.boolean().optional(), response.IsLogging) === true;
    }, signal);
    if (status.ok && status.value) {
      return { ok: true, value: { loggingTrail: arn, multiRegionTrails: multiRegion.size } };
    }
    if (!status.ok) refused ??= status.code;
  }
  if (refused !== null) return { ok: false, code: refused };
  return { ok: true, value: { loggingTrail: null, multiRegionTrails: multiRegion.size } };
}

/**
 * Faz as leituras da postura de uma conta, depois do inventário: a política de senha, o bloqueio da conta, e, por
 * região monitorada, a criptografia padrão do EBS e o GuardDuty; por último, as trilhas. Uma de cada vez.
 */
export async function collectPostureReads(
  target: { accountId: string; regions: readonly string[] },
  clients: InventoryClients,
  { signal }: { signal?: AbortSignal } = {},
): Promise<PostureReads> {
  const regions = inventoryRegions(target.regions);
  const home = regions[0] ?? STS_FALLBACK_REGION;
  const reads: PostureReads = {
    passwordPolicy: await passwordPolicy(clients, signal),
    accountPublicAccessBlock: await accountPublicAccessBlock(clients, target.accountId, signal),
    ebsDefaultEncryption: [],
    cloudTrail: { ok: false, code: 'Unknown' },
    guardDuty: [],
  };
  for (const region of regions) {
    reads.ebsDefaultEncryption.push({ region, read: await ebsDefaultEncryption(clients, region, signal) });
    reads.guardDuty.push({ region, read: await guardDuty(clients, region, signal) });
  }
  reads.cloudTrail = await cloudTrail(clients, home, signal);
  return reads;
}
