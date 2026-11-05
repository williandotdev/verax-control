import { randomUUID } from 'node:crypto';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AwsConnectionErrorCode } from '@verax/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit/audit.service.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import {
  findWazuhSourceRows,
  serializeWazuhSources,
  toWazuhSources,
  type WazuhSourceRow,
  wazuhSourcesGeneration,
} from './wazuh-sources.js';

/** A cada 30 s: uma conta nova ou um bucket novo chega ao manager em menos de um minuto. */
export const WAZUH_CONFIG_INTERVAL_MS = 30_000;
/**
 * Token do Google do host sem renovação há mais que isso: `aws_token_stale`. O timer do host o renova a cada 10 min e
 * ele vale 1 hora: passados 40 min, faltam menos de 20 para a coleta parar.
 */
export const AWS_TOKEN_STALE_AFTER_MS = 40 * 60 * 1000;

/** Os erros da coleta do nó inteiro (não de uma conta), os únicos que esta tarefa grava e apaga. */
export const NODE_COLLECTION_ERRORS = [
  'aws_token_stale',
  'wazuh_apply_failed',
] as const satisfies readonly AwsConnectionErrorCode[];
export type NodeCollectionError = (typeof NODE_COLLECTION_ERRORS)[number];

/**
 * Os arquivos da pasta de sinais (`/run/verax/wazuh-signal` no host, montada no worker em `WAZUH_SIGNAL_DIR`). O worker
 * só escreve a geração; os outros dois são do host (`infra/node/bin/wazuh-apply.sh` e `aws-token.sh`), e o bit t da
 * pasta impede que o worker os troque.
 */
export const WAZUH_SIGNAL_FILES = {
  generation: 'generation',
  applied: 'applied',
  awsToken: 'aws-token',
} as const;
/** Um sinal do host tem menos de 200 bytes; maior que isso nem é lido. */
const SIGNAL_MAX_BYTES = 4096;

const generationPattern = /^[0-9a-f]{64}$/;
/** O resultado da última aplicação no host: a geração aplicada (null se a lista nem chegou ao gerador). */
const appliedSchema = z.strictObject({
  generation: z.string().regex(generationPattern).nullable(),
  status: z.enum(['ok', 'error']),
  at: z.iso.datetime(),
});
/** A última renovação do token do Google no host. Só a hora: o token nunca sai da pasta dele. */
const tokenSchema = z.strictObject({ tokenAt: z.iso.datetime() });

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente). */
export interface WazuhConfigReport {
  /** Contas AWS que o manager lê. */
  accounts: number;
  /** A geração foi gravada agora (a lista mudou) ou já estava lá. */
  generation: 'written' | 'unchanged';
  /** A coleta no nó: ok, aguardando a aplicação da lista de agora, ou o erro do nó inteiro. */
  state: 'ok' | 'pending' | NodeCollectionError;
  /** Contas que passaram a mostrar o erro do nó. */
  marked: number;
  /** Contas que voltaram a "conectada". */
  cleared: number;
  /** Sinais do host fora do formato (ignorados). */
  invalidSignals: number;
}

export interface WazuhConfigOptions {
  audit?: AuditService;
  now?: () => Date;
  /** Quando o worker subiu: sem nenhum sinal do token, o token só conta como parado depois do prazo, a partir daqui. */
  startedAt?: Date;
  staleAfterMs?: number;
  /** Só os testes, que dividem o banco: restringe a tarefa às contas destes clientes. */
  tenantIds?: readonly string[];
}

type Connection = Pick<WazuhSourceRow, 'connection' | 'connectionError'>;

function isNodeCollectionError(code: string | null): code is NodeCollectionError {
  return code !== null && (NODE_COLLECTION_ERRORS as readonly string[]).includes(code);
}

/**
 * O que a conta deve mostrar, ou null para deixá-la como está. Só a conta conectada recebe o erro do nó, e só o erro do
 * nó volta a "conectada": a que aguarda a verificação ou tem um erro dela mesma (o papel, um bucket) fica como está, e
 * o erro dela vale mais.
 */
export function nextConnection(
  current: Connection,
  wanted: NodeCollectionError | null,
): { connection: 'connected' | 'error'; connectionError: NodeCollectionError | null } | null {
  const nodeError =
    current.connection === 'error' && isNodeCollectionError(current.connectionError)
      ? current.connectionError
      : null;
  if (current.connection === 'connected') {
    return wanted === null ? null : { connection: 'error', connectionError: wanted };
  }
  if (nodeError === null || nodeError === wanted) return null;
  return wanted === null
    ? { connection: 'connected', connectionError: null }
    : { connection: 'error', connectionError: wanted };
}

/**
 * O erro do nó que a conta deve mostrar, pelo estado da coleta: o do token ou o da aplicação. Aguardando a aplicação
 * da lista de agora, o erro de aplicação de antes fica até o resultado chegar.
 */
export function wantedError(
  state: WazuhConfigReport['state'],
  current: Connection,
): NodeCollectionError | null {
  if (state === 'aws_token_stale' || state === 'wazuh_apply_failed') return state;
  if (
    state === 'pending' &&
    current.connection === 'error' &&
    current.connectionError === 'wazuh_apply_failed'
  ) {
    return 'wazuh_apply_failed';
  }
  return null;
}

/** Um sinal do host fora do formato (grande demais, não é arquivo, não é JSON ou não segue o schema). */
const INVALID = Symbol('sinal inválido');

/** Um sinal do host: o texto, null sem o arquivo, ou INVALID. */
async function readSignal(path: string): Promise<string | null | typeof INVALID> {
  let handle;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta da configuração do nó, não do request
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > SIGNAL_MAX_BYTES) return INVALID;
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function parseSignal<T>(
  raw: string | null | typeof INVALID,
  schema: z.ZodType<T>,
): T | null | typeof INVALID {
  if (raw === null || raw === INVALID) return raw;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return INVALID;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : INVALID;
}

/**
 * Tarefa `wazuh-config` do worker (fase 2, PR-V4'; só no nó com o Wazuh, com `WAZUH_SIGNAL_DIR`): a ponte, sem segredo,
 * entre as contas AWS do banco e a configuração do manager, que só o host aplica.
 *
 * - Grava a geração (o SHA-256 da lista que o CLI `wazuh-sources` imprime: contas, região, buckets e início da coleta)
 *   no arquivo `generation` da pasta de sinais, só quando ela muda: o `verax-wazuh-apply.path` do host reage e refaz a
 *   configuração do manager em segundos. Troca atômica (rename), como no host.
 * - Lê os dois sinais do host e grava, nas contas que o manager lê, o erro do nó inteiro: `aws_token_stale` quando o
 *   token do Google não é renovado há mais de 40 min, e `wazuh_apply_failed` quando a aplicação da lista de agora deu
 *   erro. Resolvido o problema (token renovado; a lista de agora aplicada), elas voltam a "conectada". Enquanto a lista
 *   de agora não foi aplicada, o `wazuh_apply_failed` de antes fica.
 * - Cada mudança de conta numa transação própria, pelo escopo do cliente da conta, só se a conexão ainda for a lida,
 *   com auditoria (`cloud_account.aws_collection`, ator sistema) na trilha do cliente.
 *
 * O worker só escreve esse sinal sem segredo: quem escreve a configuração do manager e os profiles da AWS é só o gerador
 * (decisão R1 do plano), e o token do Google fica com o host.
 */
export class WazuhConfig {
  private readonly audit: AuditService;
  private readonly now: () => Date;
  private readonly startedAt: Date;
  private readonly staleAfterMs: number;
  private readonly tenantIds: readonly string[] | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly signalDir: string,
    {
      audit = new AuditService(),
      now = () => new Date(),
      startedAt,
      staleAfterMs = AWS_TOKEN_STALE_AFTER_MS,
      tenantIds,
    }: WazuhConfigOptions = {},
  ) {
    this.audit = audit;
    this.now = now;
    this.startedAt = startedAt ?? now();
    this.staleAfterMs = staleAfterMs;
    this.tenantIds = tenantIds;
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<WazuhConfigReport> {
    const rows = await findWazuhSourceRows(this.prisma, this.tenantIds);
    const generation = wazuhSourcesGeneration(serializeWazuhSources(toWazuhSources(rows)));
    const written = await this.writeGeneration(generation);

    const applied = parseSignal(await readSignal(this.path('applied')), appliedSchema);
    const token = parseSignal(await readSignal(this.path('awsToken')), tokenSchema);
    const invalidSignals = [applied, token].filter((value) => value === INVALID).length;

    // Sem o sinal do token (o host ainda não o renovou desde a partida), o prazo conta da partida do worker.
    const tokenAt = token !== null && token !== INVALID ? new Date(token.tokenAt) : this.startedAt;
    const stale = this.now().getTime() - tokenAt.getTime() > this.staleAfterMs;
    const result =
      applied !== null && applied !== INVALID && applied.generation === generation
        ? applied.status
        : 'pending';
    const state: WazuhConfigReport['state'] = stale
      ? 'aws_token_stale'
      : result === 'error'
        ? 'wazuh_apply_failed'
        : result;

    const report: WazuhConfigReport = {
      accounts: rows.length,
      generation: written ? 'written' : 'unchanged',
      state,
      marked: 0,
      cleared: 0,
      invalidSignals,
    };
    for (const row of rows) {
      signal.throwIfAborted();
      const next = nextConnection(row, wantedError(state, row));
      if (next === null || !(await this.record(row, next))) continue;
      if (next.connection === 'error') report.marked += 1;
      else report.cleared += 1;
    }
    return report;
  }

  private path(name: keyof typeof WAZUH_SIGNAL_FILES): string {
    return join(this.signalDir, WAZUH_SIGNAL_FILES[name]);
  }

  /** Grava a geração só quando ela muda: cada gravação faz o host refazer a configuração do manager. */
  private async writeGeneration(generation: string): Promise<boolean> {
    const target = this.path('generation');
    const content = `${generation}\n`;
    if ((await readSignal(target)) === content) return false;
    const temporary = join(this.signalDir, `.generation-${randomUUID()}`);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta da configuração do nó, não do request
      await writeFile(temporary, content, { mode: 0o644, flag: 'wx' });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- idem
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return true;
  }

  /** Grava a conexão nova, se ela ainda for a lida, com a auditoria na trilha do cliente. */
  private record(
    row: WazuhSourceRow,
    next: { connection: 'connected' | 'error'; connectionError: NodeCollectionError | null },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const db = scopeToTenant(tx, row.tenantId);
      const { count } = await db.cloudAccount.updateMany({
        where: {
          id: row.id,
          provider: 'aws',
          status: 'active',
          connection: row.connection,
          connectionError: row.connectionError,
        },
        data: next,
      });
      if (count === 0) return false;
      await this.audit.write(tx, {
        actor: { type: 'system', tenantId: row.tenantId },
        action: 'cloud_account.aws_collection',
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: row.id,
        before: { connection: row.connection, connectionError: row.connectionError },
        after: next,
      });
      return true;
    });
  }
}
