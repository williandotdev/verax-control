import { createHash, randomBytes } from 'node:crypto';
import { ESCALATION_CONFIRMATION_TTL_HOURS, ESCALATION_UNSUBSCRIBE_TTL_DAYS } from '@verax/shared';
import type { EscalationTokenPurpose, Prisma } from '../generated/prisma/client.js';

/**
 * Links dos e-mails ao contato de escalonamento (D8), no mesmo desenho dos links de uso único que já existem (o da
 * redefinição de senha, guardado com hash pelo Better Auth, e o da revelação da senha no plano de controle): um valor
 * aleatório de 256 bits que só o e-mail leva e, no banco, só o SHA-256 dele. Quem lê o banco não consegue confirmar
 * nem descadastrar ninguém.
 *
 * O valor vai no fragmento do link (`#token=`): o navegador nunca o manda a servidor nenhum, nem no `Referer`, e ele
 * não aparece em log de CDN ou de proxy. A página do painel o lê e o envia no corpo do `POST`.
 */
const TOKEN_BYTES = 32;

/** Validade de cada link: 72 h a confirmação (uso único) e um ano o descadastro (idempotente). */
export const ESCALATION_TOKEN_TTL_MS: Readonly<Record<EscalationTokenPurpose, number>> = {
  confirm: ESCALATION_CONFIRMATION_TTL_HOURS * 3_600_000,
  unsubscribe: ESCALATION_UNSUBSCRIBE_TTL_DAYS * 86_400_000,
};

/** 32 bytes aleatórios em base64url: 43 caracteres de `[A-Za-z0-9_-]` (o `escalationLinkTokenSchema`). */
export function newEscalationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** A chave do link no banco: SHA-256 em hexadecimal do valor que só o e-mail tem. */
export function escalationTokenHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Gera os links de um e-mail e grava só o hash de cada um, pelo cliente do banco já no escopo do cliente (que confere o
 * `tenantId`). Na mesma ida, apaga os links vencidos do cliente, para a tabela não crescer sem fim.
 */
export async function mintEscalationTokens<P extends EscalationTokenPurpose>(
  db: Prisma.TransactionClient,
  tenantId: string,
  generation: number,
  purposes: readonly P[],
  now: Date,
): Promise<Record<P, string>> {
  await db.escalationContactToken.deleteMany({ where: { expiresAt: { lte: now } } });
  const values = {} as Record<P, string>;
  const rows = purposes.map((purpose) => {
    const value = newEscalationToken();
    values[purpose] = value;
    return {
      tokenHash: escalationTokenHash(value),
      tenantId,
      purpose,
      generation,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ESCALATION_TOKEN_TTL_MS[purpose]),
    };
  });
  await db.escalationContactToken.createMany({ data: rows });
  return values;
}

/** Apaga os links de um e-mail que não saiu: ninguém tem o valor, e eles não precisam ficar valendo. */
export async function discardEscalationTokens(
  db: Prisma.TransactionClient,
  values: readonly string[],
): Promise<void> {
  await db.escalationContactToken.deleteMany({
    where: { tokenHash: { in: values.map(escalationTokenHash) } },
  });
}

/** O link do e-mail: a página pública do painel, com o valor no fragmento. */
export function escalationLink(webOrigin: string, path: string, token: string): string {
  return `${new URL(path, webOrigin).href}#token=${encodeURIComponent(token)}`;
}
