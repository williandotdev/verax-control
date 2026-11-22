import { HttpStatus } from '@nestjs/common';
import { LOG_SOURCES } from '@verax/shared';
import { ApiError } from '../common/http/api-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { type AwsBuckets, BUCKET_COLUMN } from './cloud-account-data.js';

/** Origens de log que identificam o cliente de um alerta: nenhuma pode ser de dois clientes. */
export interface LogOrigins {
  buckets?: AwsBuckets;
  pubsubSubscription?: string | null;
  sinkWriterIdentity?: string | null;
  zones?: string[];
}

/**
 * Uma origem de log já cadastrada noutra conta: 409, com a frase de `assertLogOriginsFree` (o painel a mostra). A
 * sincronização com o plano de controle a conta de volta como `origin_conflict`.
 */
export class LogOriginTaken extends ApiError {
  constructor(message: string) {
    super(HttpStatus.CONFLICT, message);
  }
}

export interface LogOriginsCheck {
  /** O cliente dono da conta que está sendo criada ou alterada (o da sessão, ou o do nó, no worker). */
  tenantId: string;
  /** A conta que está sendo alterada (a identidade do sink não se repete nas outras contas do mesmo cliente). */
  exceptId?: string | undefined;
  /** Célula (CE-01): a recusa não diz se a origem está em outro cliente. */
  sharedCell: boolean;
}

/**
 * Uma origem de log não pode ser de dois clientes: o alerta lido dela seria atribuído a qualquer um.
 * - Bucket: o nome é único no S3, então vale para qualquer fonte (o mesmo bucket como CloudTrail de um cliente e
 *   GuardDuty de outro também é ambíguo).
 * - Assinatura do Pub/Sub: um coletor agregado pode servir vários projetos do mesmo cliente, nunca de dois.
 * - Identidade do sink: é o agente do Cloud Logging do projeto do cliente, e quem a tem publica no tópico dele.
 *   Vale para um projeto só: colada em outro cliente, daria a publicação a um projeto que não é dele; colada em
 *   outro projeto do mesmo cliente, daria a um projeto a publicação no tópico de outro (o Terraform do nó recusa
 *   a repetição em `customer_projects` pela mesma razão). Por isso é a única origem que também não se repete
 *   entre as contas do próprio cliente (`exceptId` é a conta que está sendo alterada).
 * - Zona do Cloudflare: o domínio identifica o cliente nos eventos do WAF.
 *
 * A checagem roda sob um lock transacional por origem, para dois cadastros simultâneos não passarem juntos: `db` é a
 * transação que vai gravar a conta (a da requisição, `PrismaService.db()`, ou a do worker), nunca o escopo de um
 * cliente (que não alcança as contas dos outros). Responde só "já cadastrado", sem dizer de quem (`LogOriginTaken`).
 * Na célula (CE-01), nem se é de outro cliente: a mesma frase para a origem de outro cliente e para a de outra conta do
 * próprio, e nada nela aponta para quem tem a origem.
 *
 * Usada pelo painel (`CloudAccountsService`) e pela sincronização com o plano de controle (a tarefa `control-plane-sync`
 * do worker), com a mesma régua.
 */
export async function assertLogOriginsFree(
  db: Prisma.TransactionClient,
  origins: LogOrigins,
  { tenantId, exceptId, sharedCell }: LogOriginsCheck,
): Promise<void> {
  const checks: {
    key: string;
    label: string;
    where: Prisma.CloudAccountWhereInput;
    /** A origem também não pode estar em outra conta do mesmo cliente. */
    onePerAccount?: boolean;
  }[] = [];
  const buckets = new Set(
    LOG_SOURCES.map((source) => origins.buckets?.[source]).filter((name) => typeof name === 'string'),
  );
  for (const name of buckets) {
    checks.push({
      key: `verax:bucket:${name}`,
      label: `O bucket ${name} já está cadastrado`,
      where: { OR: LOG_SOURCES.map((source) => ({ [BUCKET_COLUMN[source]]: name })) },
    });
  }
  if (origins.pubsubSubscription) {
    const name = origins.pubsubSubscription;
    checks.push({
      key: `verax:pubsub:${name}`,
      label: `A assinatura ${name} já está cadastrada`,
      where: { pubsubSubscription: name },
    });
  }
  if (origins.sinkWriterIdentity) {
    const identity = origins.sinkWriterIdentity;
    checks.push({
      key: `verax:sink:${identity}`,
      label: 'A identidade do sink já está cadastrada',
      where: { sinkWriterIdentity: identity },
      onePerAccount: true,
    });
  }
  for (const zone of origins.zones ?? []) {
    checks.push({
      key: `verax:zone:${zone}`,
      label: `A zona ${zone} já está cadastrada`,
      where: { zones: { has: zone } },
    });
  }
  // Ordem fixa dos locks: dois cadastros com as mesmas origens não se travam um ao outro.
  checks.sort((a, b) => a.key.localeCompare(b.key));
  for (const check of checks) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${check.key}))`;
    const taken = await db.cloudAccount.findFirst({
      where: { tenantId: { not: tenantId }, ...check.where },
      select: { id: true },
    });
    if (taken) {
      throw new LogOriginTaken(sharedCell ? check.label : `${check.label} em outro cliente`);
    }
    if (!check.onePerAccount) continue;
    const repeated = await db.cloudAccount.findFirst({
      where: { tenantId, ...check.where, ...(exceptId && { id: { not: exceptId } }) },
      select: { id: true },
    });
    if (repeated) {
      throw new LogOriginTaken(sharedCell ? check.label : `${check.label} em outra conta deste cliente`);
    }
  }
}
