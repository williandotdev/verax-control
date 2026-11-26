import {
  EXCEPTION_OPEN_CHUNK,
  EXCEPTION_OPEN_PREVIEW_SCAN_MAX,
  EXCEPTION_OPEN_RESOLVE_MAX,
  EXCEPTION_OPEN_STATUSES,
  type ExceptionOpenPreview,
  type ExceptionOpenResolution,
  type FindingSource,
  SCOPED_EXCEPTION_SEVERITIES,
} from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { type ActiveException, matchingException } from './exception-match.js';
import { type ActiveScopedException, matchingScopedException } from './scoped-exception-match.js';

/**
 * Os alertas em aberto que uma exceção nova resolve (decisão do dono de 26/11/2026; o contrato está em
 * `packages/shared/src/exception-open-alerts.ts`).
 *
 * **A regra é a da chegada.** Quem decide se o alerta cai na exceção é o mesmo comparador do sync (`matchingException` e
 * `matchingScopedException`), com todas as travas das amplas (crítico nunca, a severidade máxima, as regras bloqueadas, o
 * evento). O filtro no banco só estreita a leitura (a regra, o valor igual, as severidades possíveis); nunca decide sozinho.
 *
 * **O que fica.** O alerta num incidente, ou num caso promovido a incidente, foi julgado ameaça por uma pessoa: casa, mas
 * fica, e é contado (`keptInIncident`). O já tratado (legítimo ou resolvido) nem é lido.
 *
 * **Lotes.** A leitura anda pelo id, de `EXCEPTION_OPEN_CHUNK` em `EXCEPTION_OPEN_CHUNK`, e cada lote é uma gravação só
 * (mais os comentários). Numa requisição, no máximo `EXCEPTION_OPEN_RESOLVE_MAX` alertas: o resto fica para o "resolver os
 * próximos", que é esta mesma função de novo. **Idempotente:** a gravação confere de novo o status, o incidente e o caso,
 * então rodar duas vezes não resolve nada a mais, nem conta duas vezes.
 *
 * Tudo pelo client no escopo do cliente (da sessão): outro cliente nunca é lido nem tocado.
 */

/** O client no escopo de um cliente (`PrismaService.scoped()`). */
type ScopedDb = Prisma.TransactionClient;

const OPEN: Prisma.FindingWhereInput['status'] = { in: [...EXCEPTION_OPEN_STATUSES] };

/** Fora de incidente, e fora de caso promovido: o que a exceção pode resolver. A gravação repete a conferência. */
const NOT_IN_INCIDENT = {
  incidentId: null,
  OR: [{ caseId: null }, { alertCase: { is: { incidentId: null } } }],
} satisfies Prisma.FindingWhereInput;

const openSelect = {
  id: true,
  ruleId: true,
  logSource: true,
  accountId: true,
  eventName: true,
  resource: true,
  actorUser: true,
  sourceIp: true,
  severity: true,
  incidentId: true,
  alertCase: { select: { incidentId: true } },
} as const satisfies Prisma.FindingSelect;

export type OpenAlertRow = Prisma.FindingGetPayload<{ select: typeof openSelect }>;

/** Uma exceção vista daqui: o filtro que estreita a leitura, o comparador da chegada e o que a gravação liga ao alerta. */
export interface OpenAlertTarget {
  narrow: Prisma.FindingWhereInput;
  matches(row: OpenAlertRow, now: Date): boolean;
  link: Pick<Prisma.FindingUncheckedUpdateManyInput, 'exceptionId' | 'scopedExceptionId'>;
}

/** A exceção de usuário, IP ou recurso. O IP (com faixa CIDR) só o comparador decide: o banco lê os que têm IP. */
export function alertExceptionTarget(exception: ActiveException): OpenAlertTarget {
  const narrow: Prisma.FindingWhereInput = {
    ruleId: exception.ruleId,
    ...(exception.field === 'user' && { actorUser: exception.value }),
    ...(exception.field === 'resource' && { resource: exception.value }),
    ...(exception.field === 'ip' && { sourceIp: { not: null } }),
  };
  return {
    narrow,
    matches: (row, now) => matchingException(row, [exception], now) !== null,
    // Nunca as duas, como na chegada.
    link: { exceptionId: exception.id, scopedExceptionId: null },
  };
}

/** A exceção ampla. O começo do recurso, só o comparador decide. */
export function scopedExceptionTarget(exception: ActiveScopedException): OpenAlertTarget {
  const severities = SCOPED_EXCEPTION_SEVERITIES.slice(
    0,
    SCOPED_EXCEPTION_SEVERITIES.indexOf(exception.maxSeverity) + 1,
  );
  const narrow: Prisma.FindingWhereInput = {
    ruleId: exception.ruleId,
    logSource: exception.logSource,
    accountId: exception.accountId,
    severity: { in: severities },
    ...(exception.eventName !== null && { eventName: exception.eventName }),
  };
  return {
    narrow,
    // A fonte gravada é uma das conhecidas (o sync só grava essas); o comparador só a compara com a da exceção.
    matches: (row, now) =>
      matchingScopedException({ ...row, logSource: row.logSource as FindingSource }, [exception], now) !==
      null,
    link: { scopedExceptionId: exception.id, exceptionId: null },
  };
}

const inIncident = (row: OpenAlertRow): boolean =>
  row.incidentId !== null || (row.alertCase !== null && row.alertCase.incidentId !== null);

/** Um trecho dos alertas em aberto que a exceção pode alcançar, pelo id. */
function readPage(db: ScopedDb, target: OpenAlertTarget, after: string | null, take: number) {
  return db.finding.findMany({
    where: { ...target.narrow, status: OPEN, ...(after !== null && { id: { gt: after } }) },
    select: openSelect,
    orderBy: { id: 'asc' },
    take,
  });
}

/** "Vai resolver N alertas em aberto (M em incidentes ficam)": só leitura, até o teto. */
export async function previewOpenAlerts(
  db: ScopedDb,
  target: OpenAlertTarget,
  now: Date,
  scanMax = EXCEPTION_OPEN_PREVIEW_SCAN_MAX,
): Promise<ExceptionOpenPreview> {
  let resolve = 0;
  let keptInIncident = 0;
  let scanned = 0;
  let after: string | null = null;
  for (;;) {
    const rows = await readPage(db, target, after, EXCEPTION_OPEN_CHUNK);
    scanned += rows.length;
    for (const row of rows) {
      if (!target.matches(row, now)) continue;
      if (inIncident(row)) keptInIncident += 1;
      else resolve += 1;
    }
    if (rows.length < EXCEPTION_OPEN_CHUNK) return { resolve, keptInIncident, complete: true };
    if (scanned >= scanMax) return { resolve, keptInIncident, complete: false };
    after = rows.at(-1)?.id ?? null;
  }
}

export interface ResolveOptions {
  now: Date;
  /** O comentário que fica em cada alerta resolvido: o autor (uma pessoa, do banco) e o texto. */
  comment: { authorId: string; body: string };
  /**
   * O lock dos alertas do cliente, tomado uma vez, antes da primeira gravação (e só se houver o que gravar): incidente e
   * triagem em massa tomam o mesmo, e não correm junto.
   */
  lock: () => Promise<void>;
  max?: number;
  chunk?: number;
}

/**
 * Resolve os alertas em aberto que a exceção cobre: legítimo, ligado a ela, com o comentário, e a contagem dela sobe com
 * o que mudou. Quem chama soma a contagem à exceção e grava a auditoria (um registro para o lote inteiro).
 */
export async function resolveOpenAlerts(
  db: ScopedDb,
  target: OpenAlertTarget,
  options: ResolveOptions,
): Promise<ExceptionOpenResolution> {
  const max = options.max ?? EXCEPTION_OPEN_RESOLVE_MAX;
  const chunk = options.chunk ?? EXCEPTION_OPEN_CHUNK;
  const { now } = options;
  let resolved = 0;
  let keptInIncident = 0;
  let locked = false;
  let after: string | null = null;
  for (;;) {
    const rows = await readPage(db, target, after, chunk);
    const free: string[] = [];
    for (const row of rows) {
      if (!target.matches(row, now)) continue;
      if (inIncident(row)) keptInIncident += 1;
      else free.push(row.id);
    }
    const room = max - resolved;
    const taking = free.slice(0, room);
    if (taking.length > 0) {
      if (!locked) {
        await options.lock();
        locked = true;
      }
      const ids = await apply(db, target, taking, now);
      if (ids.length > 0) {
        await db.findingComment.createMany({
          data: ids.map(
            (findingId) =>
              ({
                findingId,
                authorId: options.comment.authorId,
                body: options.comment.body,
              }) as Prisma.FindingCommentCreateManyInput,
          ),
        });
      }
      resolved += ids.length;
    }
    if (free.length > room) return { resolved, keptInIncident, more: true };
    if (rows.length < chunk) return { resolved, keptInIncident, more: false };
    after = rows.at(-1)?.id ?? null;
  }
}

/**
 * A gravação de um lote. A conferência vai junto (status em aberto, fora de incidente e de caso promovido): o que outra
 * pessoa tratou ou promoveu entre a leitura e aqui não muda. A primeira saída de "novo" marca a triagem, como na tela.
 * Devolve os alertas que mudaram.
 */
async function apply(
  db: ScopedDb,
  target: OpenAlertTarget,
  ids: readonly string[],
  now: Date,
): Promise<string[]> {
  const where = { id: { in: [...ids] }, ...NOT_IN_INCIDENT } satisfies Prisma.FindingWhereInput;
  // A decisão de agora vale no lugar da triagem em massa (o desfazer dela não mexe mais no alerta), como na tela.
  const data = { status: 'legitimate', triageOpId: null, ...target.link } as const;
  const first = await db.finding.updateManyAndReturn({
    where: { ...where, status: 'new', triagedAt: null },
    data: { ...data, triagedAt: now },
    select: { id: true },
  });
  const rest = await db.finding.updateManyAndReturn({
    where: { ...where, status: OPEN },
    data,
    select: { id: true },
  });
  return [...first, ...rest].map((row) => row.id);
}

const FIELD_LABELS = { user: 'usuário', ip: 'IP', resource: 'recurso' } as const;

/** O comentário de cada alerta resolvido pela exceção de usuário, IP ou recurso. Cabe na coluna (2.000). */
export function alertExceptionComment(
  exception: Pick<ActiveException, 'id' | 'ruleId' | 'field' | 'value'>,
  creator: string,
): string {
  return (
    `Resolvido automaticamente pela exceção de ${FIELD_LABELS[exception.field]} "${exception.value}" da regra ` +
    `${exception.ruleId} (${exception.id}), criada por ${creator.slice(0, 200)}.`
  );
}

/** O comentário de cada alerta resolvido pela exceção ampla. */
export function scopedExceptionComment(
  exception: Pick<ActiveScopedException, 'id' | 'ruleId' | 'logSource' | 'accountId'>,
  creator: string,
): string {
  return (
    `Resolvido automaticamente pela exceção ampla da regra ${exception.ruleId} (fonte ${exception.logSource}, conta ` +
    `${exception.accountId}; ${exception.id}), criada por ${creator.slice(0, 200)}.`
  );
}
