import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '../common/clock.js';
import { ULID_PATTERN } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import { DOCUMENT_STORE, type DocumentStore, parseDocument } from '../firestore/document-store.js';
import { MAX_STEP_POLL } from '../queue/step-queue.js';
import { RUN_KINDS, type RunKind } from './executor-env.js';

/** `provisioningRuns` e `steps` vivem 180 dias (plano §3; TTL em `expiresAt`, `collections.ts`). */
export const RUN_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** O que a execução sabe da versão: lido e conferido no `preflight` (`release-manifest.ts`). Nada de segredo. */
export const runReleaseSchema = z.strictObject({
  release: z.string().max(32),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  packageSha256: sha256,
  panel: z.strictObject({ object: z.string().max(200), sha256 }).optional(),
});

/**
 * A caixa de envio que esta execução dá ao nó (servidor, porta e usuário; nunca a senha), decidida no `preflight`: o
 * `terraform.apply` a põe nos metadados da VM e o `secrets.smtp_password` copia a senha só quando ela existe, os dois
 * pela mesma decisão, mesmo que a configuração mude no meio da execução.
 */
export const runNodeMailSchema = z.strictObject({
  host: z.string().max(253),
  port: z.number().int().min(1).max(65535),
  user: z.string().max(254),
});

/** Documento `provisioningRuns/{runId}` (plano §3). */
export const runDocumentSchema = z.strictObject({
  tenantId: z.string().regex(ULID_PATTERN),
  kind: z.enum(RUN_KINDS),
  startedAt: z.date(),
  finishedAt: z.date().optional(),
  outcome: z.enum(['succeeded', 'failed']).optional(),
  /** O código da falha definitiva (o mesmo de `tenant.provisioning.lastError.code`); nunca uma mensagem. */
  failureCode: z.string().max(64).optional(),
  release: runReleaseSchema.optional(),
  /** Sem o campo, o nó desta execução nasce sem e-mail (`MAIL_TRANSPORT=none`). */
  nodeMail: runNodeMailSchema.optional(),
  expiresAt: z.date(),
});
export type RunDocument = z.infer<typeof runDocumentSchema>;

const outputKey = z.string().regex(/^[a-z][A-Za-z0-9]{0,40}$/);
const outputValue = z.union([z.string().max(300), z.number(), z.boolean()]);

/**
 * Documento `provisioningRuns/{runId}/steps/{passo}` (plano §3): o andamento de um passo nesta execução. `outputs`
 * guarda o que o passo precisa lembrar entre entregas (a execução do Job, quantas consultas já fez), nunca segredo nem
 * dado pessoal.
 */
export const stepDocumentSchema = z.strictObject({
  status: z.enum(['running', 'waiting', 'done', 'failed']),
  /** Entregas que chegaram a rodar o passo (inclusive as repetições do Cloud Tasks). */
  attempts: z.number().int().min(0),
  /** A próxima consulta esperada, nos passos que se reagendam: uma entrega com número menor é repetida e é ignorada. */
  nextPoll: z.number().int().min(0).max(MAX_STEP_POLL),
  startedAt: z.date(),
  updatedAt: z.date(),
  /** Quando a espera começou (a primeira consulta), para o prazo de cada passo que espera. */
  waitingSince: z.date().optional(),
  finishedAt: z.date().optional(),
  errorCode: z.string().max(64).optional(),
  outputs: z.record(outputKey, outputValue).optional(),
  expiresAt: z.date(),
});
export type StepDocument = z.infer<typeof stepDocumentSchema>;

/** O contador das faixas de rede dos nós (`counters/subnets`): o próximo número livre. */
const subnetCounterSchema = z.strictObject({
  next: z.number().int().min(1).max(65_536),
  updatedAt: z.date(),
});
const SUBNET_COUNTER = 'subnets';
/** 10.0.1.0/24 a 10.255.255.0/24: o número vira os dois octetos do meio. */
export const MAX_SUBNET_NUMBER = 65_535;

/** O contador passou de 65535 faixas. */
export class SubnetPoolExhaustedError extends Error {
  constructor() {
    super('faixas de rede dos nós esgotadas');
    this.name = 'SubnetPoolExhaustedError';
  }
}

export function subnetCidrOf(number: number): string {
  return `10.${Math.floor(number / 256)}.${number % 256}.0/24`;
}

/** Repositório das execuções e dos passos do provisionamento (`provisioningRuns`, `steps`, `counters/subnets`). */
@Injectable()
export class ProvisioningStore {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async getRun(runId: string): Promise<RunDocument | undefined> {
    const data = await this.store.get(COLLECTIONS.provisioningRuns, runId);
    return data === undefined
      ? undefined
      : parseDocument(runDocumentSchema, COLLECTIONS.provisioningRuns, runId, data);
  }

  /** Cria o documento da execução se ainda não existe (a mesma task pode chegar duas vezes). */
  async ensureRun(runId: string, tenantId: string, kind: RunKind): Promise<RunDocument> {
    return this.store.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.provisioningRuns, runId);
      if (data !== undefined)
        return parseDocument(runDocumentSchema, COLLECTIONS.provisioningRuns, runId, data);
      const now = this.clock.now();
      const run = runDocumentSchema.parse({
        tenantId,
        kind,
        startedAt: now,
        expiresAt: new Date(now.getTime() + RUN_RETENTION_MS),
      });
      tx.create(COLLECTIONS.provisioningRuns, runId, run);
      return run;
    });
  }

  /** Muda o documento da execução relido na transação (a versão lida no `preflight`, o desfecho). */
  async updateRun(runId: string, mutate: (run: RunDocument) => RunDocument): Promise<RunDocument> {
    return this.store.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.provisioningRuns, runId);
      if (data === undefined) throw new Error('execução do provisionamento não encontrada');
      const current = parseDocument(runDocumentSchema, COLLECTIONS.provisioningRuns, runId, data);
      const next = runDocumentSchema.parse(mutate(structuredClone(current)));
      tx.set(COLLECTIONS.provisioningRuns, runId, next);
      return next;
    });
  }

  async getStep(runId: string, step: string): Promise<StepDocument | undefined> {
    const collection = COLLECTIONS.steps(runId);
    const data = await this.store.get(collection, step);
    return data === undefined ? undefined : parseDocument(stepDocumentSchema, collection, step, data);
  }

  /** Os passos já tocados de uma execução, por nome (a linha do tempo do console do responsável). */
  async listSteps(runId: string): Promise<Map<string, StepDocument>> {
    const collection = COLLECTIONS.steps(runId);
    const docs = await this.store.query(collection);
    return new Map(docs.map(({ id, data }) => [id, parseDocument(stepDocumentSchema, collection, id, data)]));
  }

  /**
   * Muda o documento do passo relido na transação; sem documento, `mutate` recebe `undefined` (a primeira entrega).
   * Devolve o documento gravado.
   */
  async updateStep(
    runId: string,
    step: string,
    mutate: (current: StepDocument | undefined, now: Date) => StepDocument,
  ): Promise<StepDocument> {
    const collection = COLLECTIONS.steps(runId);
    return this.store.runTransaction(async (tx) => {
      const data = await tx.get(collection, step);
      const current =
        data === undefined ? undefined : parseDocument(stepDocumentSchema, collection, step, data);
      const next = stepDocumentSchema.parse(
        mutate(current === undefined ? undefined : structuredClone(current), this.clock.now()),
      );
      tx.set(collection, step, next);
      return next;
    });
  }

  /** O documento novo de um passo, na primeira entrega. */
  newStep(now: Date): StepDocument {
    return {
      status: 'running',
      attempts: 0,
      nextPoll: 0,
      startedAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + RUN_RETENTION_MS),
    };
  }

  /**
   * O próximo número de faixa de rede (`10.<n/256>.<n%256>.0/24`). Cada nó tem a própria rede, sem ligação com as
   * outras, então a faixa não precisaria ser única; o contador mantém isso, para uma rede compartilhada no futuro. Um
   * número tirado e não usado (a gravação no cliente falhou) fica como lacuna, sem efeito.
   */
  async allocateSubnetNumber(): Promise<number> {
    return this.store.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.counters, SUBNET_COUNTER);
      const current =
        data === undefined
          ? undefined
          : parseDocument(subnetCounterSchema, COLLECTIONS.counters, SUBNET_COUNTER, data);
      const number = current?.next ?? 1;
      if (number > MAX_SUBNET_NUMBER) throw new SubnetPoolExhaustedError();
      tx.set(
        COLLECTIONS.counters,
        SUBNET_COUNTER,
        subnetCounterSchema.parse({ next: number + 1, updatedAt: this.clock.now() }),
      );
      return number;
    });
  }
}
