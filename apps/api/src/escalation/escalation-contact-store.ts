import { HttpStatus } from '@nestjs/common';
import {
  ESCALATION_CONFIRMATION_INTERVAL_MINUTES,
  type EscalationConfirmationEmailStatus,
  type EscalationContact,
  type EscalationContactInput,
} from '@verax/shared';
import { ApiError } from '../common/http/api-error.js';
import type { NotificationStatus, Prisma } from '../generated/prisma/client.js';

/**
 * O contato de escalonamento no cadastro do cliente (D8): as regras comuns ao cadastro de clientes da Verax
 * (`TenantsService`) e à tela do administrador do cliente (`EscalationContactService`). Todas as funções recebem o
 * cliente do banco já no escopo do cliente (o da sessão, ou `forTenant` do cliente pedido pela Verax).
 *
 * - Endereço novo (ou o primeiro): o contato volta a "aguardando confirmação", a geração sobe (os links dos e-mails
 *   anteriores deixam de valer, e os registros deles saem) e o e-mail de confirmação entra na fila de saída
 *   (`escalation_confirmation`), que o worker entrega. Mudar só o nome ou o telefone não mexe na confirmação.
 * - Pedir a confirmação de novo (aguardando ou descadastrado) faz o mesmo, com o mesmo endereço.
 * - Entre dois e-mails de confirmação do mesmo cliente, no mínimo `ESCALATION_CONFIRMATION_INTERVAL_MINUTES`, contados
 *   do último que saiu de fato: a fila segura o novo até lá, o worker confere de novo no envio (e adia, sem descartar),
 *   e só manda o da geração atual. Várias trocas seguidas viram um e-mail só.
 * - Toda troca e todo pedido travam antes a linha do cliente (`lockTenantRow`) e só então leem o contato: duas
 *   requisições ao mesmo tempo não decidem sobre um endereço que a outra já trocou.
 */
export const ESCALATION_SELECT = {
  id: true,
  escalationName: true,
  escalationEmail: true,
  escalationPhone: true,
  escalationState: true,
  escalationGeneration: true,
  escalationConfirmedAt: true,
  escalationUnsubscribedAt: true,
} as const satisfies Prisma.TenantSelect;
export type EscalationRow = Prisma.TenantGetPayload<{ select: typeof ESCALATION_SELECT }>;

/** O último pedido de confirmação do endereço atual, na fila de saída. */
export interface ConfirmationNotice {
  status: NotificationStatus;
  createdAt: Date;
  sentAt: Date | null;
  updatedAt: Date;
}

const CONFIRMATION_SELECT = {
  status: true,
  createdAt: true,
  sentAt: true,
  updatedAt: true,
} as const satisfies Prisma.NotificationSelect;

const EMAIL_STATUS: Readonly<Record<NotificationStatus, EscalationConfirmationEmailStatus>> = {
  pending: 'queued',
  sent: 'sent',
  failed: 'failed',
  skipped: 'skipped',
};

/** Código e mensagem das recusas de "pedir a confirmação de novo". */
export const ESCALATION_CONTACT_MISSING = 'ESCALATION_CONTACT_MISSING';
export const ESCALATION_CONTACT_CONFIRMED = 'ESCALATION_CONTACT_CONFIRMED';

/**
 * Trava a linha do cliente até o fim da transação da requisição, antes de ler o contato e decidir a transição. Sem isso,
 * uma troca só de nome que leu o endereço A gravaria A de volta depois de outra requisição trocar para B e subir a
 * geração, sem recomeçar a confirmação nem invalidar os links de B, e o link de confirmação mandado a B confirmaria A.
 * `FOR NO KEY UPDATE` é a mesma trava do `UPDATE` da linha: serializa as trocas e as confirmações, sem segurar quem só
 * grava dados com chave estrangeira para o cliente (achados, avisos, trilha). Recebe o cliente do banco sem escopo (o
 * da transação da requisição), porque o escopo não aceita SQL.
 */
export async function lockTenantRow(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Tenant" WHERE id = ${tenantId}::uuid FOR NO KEY UPDATE`;
}

const CONFIRMATION_INTERVAL_MS = ESCALATION_CONFIRMATION_INTERVAL_MINUTES * 60_000;

/**
 * Quando o último e-mail de confirmação do cliente saiu de fato (o `sentAt`, gravado pelo worker), de qualquer geração.
 * O pedido que ainda está na fila não conta: o intervalo é entre e-mails entregues, não entre pedidos.
 */
export async function lastConfirmationSentAt(
  db: Prisma.TransactionClient,
  exceptId?: string,
): Promise<Date | null> {
  const last = await db.notification.findFirst({
    where: {
      kind: 'escalation_confirmation',
      status: 'sent',
      sentAt: { not: null },
      ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
    },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    select: { sentAt: true },
  });
  return last?.sentAt ?? null;
}

/** O primeiro instante em que outro e-mail de confirmação do cliente pode sair: agora, ou o intervalo depois do último. */
export function nextConfirmationAt(lastSentAt: Date | null, now: Date): Date {
  if (lastSentAt === null) return now;
  const allowed = new Date(lastSentAt.getTime() + CONFIRMATION_INTERVAL_MS);
  return allowed > now ? allowed : now;
}

/** O mesmo endereço, sem diferença de maiúsculas nem de espaço nas pontas. */
export function sameAddress(a: string | null, b: string): boolean {
  return a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** O contato com o estado, como a API devolve. Sem endereço, nenhum. */
export function toEscalationContact(
  row: Omit<EscalationRow, 'id' | 'escalationGeneration'>,
  confirmation: ConfirmationNotice | null,
): EscalationContact | null {
  if (row.escalationName === null || row.escalationEmail === null || row.escalationState === null)
    return null;
  return {
    name: row.escalationName,
    email: row.escalationEmail,
    phone: row.escalationPhone,
    status: row.escalationState,
    confirmedAt: row.escalationConfirmedAt?.toISOString() ?? null,
    unsubscribedAt: row.escalationUnsubscribedAt?.toISOString() ?? null,
    confirmationEmail:
      confirmation === null
        ? null
        : {
            status: EMAIL_STATUS[confirmation.status],
            at: (confirmation.status === 'sent'
              ? (confirmation.sentAt ?? confirmation.updatedAt)
              : confirmation.status === 'pending'
                ? confirmation.createdAt
                : confirmation.updatedAt
            ).toISOString(),
          },
  };
}

/** O último pedido de confirmação da geração atual do endereço (nenhum: o contato é anterior a este controle). */
export function latestConfirmation(
  db: Prisma.TransactionClient,
  generation: number,
): Promise<ConfirmationNotice | null> {
  return db.notification.findFirst({
    where: { kind: 'escalation_confirmation', escalationGeneration: generation },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: CONFIRMATION_SELECT,
  });
}

/** O contato do cliente com o estado do último e-mail de confirmação. */
export async function readEscalationContact(
  db: Prisma.TransactionClient,
  row: Omit<EscalationRow, 'id'>,
): Promise<EscalationContact | null> {
  if (row.escalationState === null) return null;
  return toEscalationContact(row, await latestConfirmation(db, row.escalationGeneration));
}

/** O que muda no cadastro quando a confirmação recomeça: aguardando, geração nova e sem as datas de antes. */
const RESTART = {
  escalationState: 'pending',
  escalationGeneration: { increment: 1 },
  escalationConfirmedAt: null,
  escalationUnsubscribedAt: null,
} as const satisfies Prisma.TenantUpdateInput;

/**
 * Os dados da troca do contato: nome e telefone sempre (o contato é substituído inteiro); a confirmação recomeça só
 * com endereço novo. `restart` diz se o e-mail de confirmação precisa entrar na fila depois de gravar.
 */
export function escalationContactUpdate(
  before: Pick<EscalationRow, 'escalationEmail' | 'escalationState'> | null,
  input: EscalationContactInput,
): { data: Prisma.TenantUpdateInput; restart: boolean } {
  const fields = {
    escalationName: input.name,
    escalationEmail: input.email,
    escalationPhone: input.phone ?? null,
  };
  const restart =
    before === null || before.escalationState === null || !sameAddress(before.escalationEmail, input.email);
  return { data: restart ? { ...fields, ...RESTART } : fields, restart };
}

/** Os dados do contato num cliente novo: já aguardando a confirmação da primeira geração. */
export function escalationContactCreate(
  input: EscalationContactInput,
): Pick<
  Prisma.TenantCreateInput,
  'escalationName' | 'escalationEmail' | 'escalationPhone' | 'escalationState'
> & { escalationGeneration: number } {
  return {
    escalationName: input.name,
    escalationEmail: input.email,
    escalationPhone: input.phone ?? null,
    escalationState: 'pending',
    escalationGeneration: 1,
  };
}

/**
 * Depois de gravar a geração nova: apaga os links das gerações anteriores, encerra os pedidos de confirmação delas que
 * ainda estavam na fila e põe o novo, no mínimo `ESCALATION_CONFIRMATION_INTERVAL_MINUTES` depois do último e-mail de
 * confirmação que saiu de fato (um pedido entregue com atraso, depois de o worker ficar parado, não abre espaço para
 * outro logo em seguida). O worker confere o intervalo de novo no envio. Nenhum endereço entra na fila: o worker lê o do
 * cadastro na hora do envio.
 */
export async function queueEscalationConfirmation(
  db: Prisma.TransactionClient,
  generation: number,
  now: Date,
): Promise<void> {
  await db.escalationContactToken.deleteMany({ where: { generation: { lt: generation } } });
  await db.notification.updateMany({
    where: { kind: 'escalation_confirmation', status: 'pending', escalationGeneration: { lt: generation } },
    data: { status: 'skipped', lastError: 'superseded' },
  });
  await db.notification.create({
    data: {
      kind: 'escalation_confirmation',
      dedupeKey: `escalation-confirmation:${generation}`,
      escalationGeneration: generation,
      createdAt: now,
      nextAttemptAt: nextConfirmationAt(await lastConfirmationSentAt(db), now),
    } as Prisma.NotificationUncheckedCreateInput,
    select: { id: true },
  });
}

/**
 * Pede a confirmação de novo, com o mesmo endereço: só para quem está aguardando (o e-mail não chegou, o link venceu) ou
 * se descadastrou e pediu para voltar. Quem já confirmou não recebe outro pedido. Quem chama trava antes a linha do
 * cliente (`lockTenantRow`).
 */
export async function restartEscalationConfirmation(
  db: Prisma.TransactionClient,
  tenantId: string,
  now: Date,
): Promise<{ before: EscalationRow; after: EscalationRow }> {
  const before = await db.tenant.findUnique({ where: { id: tenantId }, select: ESCALATION_SELECT });
  if (before === null || before.escalationState === null) {
    throw new ApiError(
      HttpStatus.CONFLICT,
      'O cliente não tem contato de escalonamento',
      ESCALATION_CONTACT_MISSING,
    );
  }
  if (before.escalationState === 'confirmed') {
    throw new ApiError(
      HttpStatus.CONFLICT,
      'O contato de escalonamento já confirmou o endereço',
      ESCALATION_CONTACT_CONFIRMED,
    );
  }
  const after = await db.tenant.update({ where: { id: tenantId }, data: RESTART, select: ESCALATION_SELECT });
  await queueEscalationConfirmation(db, after.escalationGeneration, now);
  return { before, after };
}
