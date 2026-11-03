import type { RequestAuth } from '../common/auth/request-auth.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { UserRole } from '../generated/prisma/enums.js';
import { SESSION_ABSOLUTE_MAX_MS, SESSION_IDLE_TIMEOUT_SECONDS } from './auth.constants.js';

const ROLES = new Set<string>(Object.values(UserRole));
/** Folga para o tempo entre a renovação da sessão e esta checagem. */
const EXPIRY_SLACK_MS = 60_000;

/** O que o Better Auth devolve da sessão atual (só os campos usados aqui). */
export interface SessionData {
  session: {
    id: string;
    createdAt: Date | string;
    expiresAt: Date | string;
    activeTenantId?: string | null;
  };
  user: {
    id: string;
    email: string;
    role: string;
    tenantId?: string | null;
    status: string;
    twoFactorEnabled?: boolean | null;
    mustChangePassword?: boolean | null;
    temporaryPasswordExpiresAt?: Date | string | null;
  };
}

/** Senha temporária vencida: a sessão aberta com ela não vale (o administrador gera outra). */
function temporaryPasswordExpired(user: SessionData['user'], now: number): boolean {
  if (user.mustChangePassword !== true) return false;
  const expiresAt = user.temporaryPasswordExpiresAt
    ? new Date(user.temporaryPasswordExpiresAt).getTime()
    : NaN;
  return !(expiresAt > now);
}

async function isTenantActive(prisma: PrismaService, id: string): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({ where: { id }, select: { status: true } });
  return tenant?.status === 'active';
}

/**
 * Regras de sessão da Verax, além das do Better Auth (assinatura do cookie, expiração). Valem em toda
 * requisição com sessão: nas rotas da API (`SessionGuard`) e nas rotas de sessão da própria biblioteca
 * (`AuthController`).
 * - no máximo 12 h desde o login, mesmo com uso contínuo;
 * - nunca mais de 30 min de validade à frente (a sessão "sem lembrar de mim" do Better Auth teria 24 h);
 * - usuário ativo, com papel conhecido, e cliente dele ativo: desativar um ou outro derruba a sessão;
 * - senha temporária dentro da validade (vencida, a sessão não vale).
 *
 * Sessão que fere alguma regra é apagada, e o retorno é `undefined`.
 */
export async function resolveSession(
  prisma: PrismaService,
  { session, user }: SessionData,
): Promise<RequestAuth | undefined> {
  const now = Date.now();
  const tenantId = user.tenantId ?? null;
  const valid =
    now - new Date(session.createdAt).getTime() <= SESSION_ABSOLUTE_MAX_MS &&
    new Date(session.expiresAt).getTime() - now <= SESSION_IDLE_TIMEOUT_SECONDS * 1000 + EXPIRY_SLACK_MS &&
    user.status === 'active' &&
    ROLES.has(user.role) &&
    !temporaryPasswordExpired(user, now) &&
    (tenantId === null || (await isTenantActive(prisma, tenantId)));
  if (!valid) {
    await prisma.session.deleteMany({ where: { id: session.id } });
    return undefined;
  }

  const role = user.role as UserRole;
  // admin_verax: um cliente selecionado que foi desativado deixa de valer (a troca também recusa inativo).
  const selected = role === 'admin_verax' ? (session.activeTenantId ?? null) : null;
  const activeTenantId = selected !== null && (await isTenantActive(prisma, selected)) ? selected : null;
  return {
    sessionId: session.id,
    userId: user.id,
    email: user.email,
    role,
    tenantId,
    activeTenantId,
    // Regra 4: o cliente do escopo vem sempre da sessão, nunca do corpo, da query ou da URL.
    scopeTenantId: role === 'admin_verax' ? activeTenantId : tenantId,
    mfaEnabled: user.twoFactorEnabled === true,
    mustChangePassword: user.mustChangePassword === true,
  };
}
