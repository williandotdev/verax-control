import type { RequestAuth } from '../common/auth/request-auth.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { UserRole } from '../generated/prisma/enums.js';
import { SESSION_ABSOLUTE_MAX_MS, SESSION_IDLE_TIMEOUT_SECONDS } from './auth.constants.js';
import { belongsToHost, type HostTenant } from './host-tenant.js';
import { temporaryPasswordExpired } from './temporary-password.js';

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
    /** Célula (CE-01): o cliente do endereço onde a sessão nasceu. */
    hostTenantId?: string | null;
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

async function isTenantActive(prisma: PrismaService, id: string): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({ where: { id }, select: { status: true } });
  return tenant?.status === 'active';
}

/** O único cliente ativo do nó, ou `null` com nenhum ou mais de um (dois bastam para saber). */
async function onlyActiveTenant(prisma: PrismaService): Promise<string | null> {
  const tenants = await prisma.tenant.findMany({
    where: { status: 'active' },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 2,
  });
  return tenants.length === 1 && tenants[0] !== undefined ? tenants[0].id : null;
}

/** Como a sessão é conferida: na célula, o endereço; no nó dedicado da Verax, a visão de cliente da equipe. */
export interface SessionOptions {
  /** Na célula (CE-01), o cliente do endereço da requisição (`sessionHostOf`); `undefined` no nó dedicado. */
  cell?: { host: HostTenant | undefined } | undefined;
  /** `STAFF_CUSTOMER_VIEW` (só no nó dedicado da Verax): o `admin_verax` vê o painel como o cliente do nó. */
  staffCustomerView?: boolean | undefined;
}

/**
 * Regras de sessão da Verax, além das do Better Auth (assinatura do cookie, expiração). Valem em toda
 * requisição com sessão: nas rotas da API (`SessionGuard`) e nas rotas de sessão da própria biblioteca
 * (`AuthController`).
 * - no máximo 12 h desde o login, mesmo com uso contínuo;
 * - nunca mais de 30 min de validade à frente (a sessão "sem lembrar de mim" do Better Auth teria 24 h);
 * - usuário ativo, com papel conhecido, e cliente dele ativo: desativar um ou outro derruba a sessão;
 * - senha temporária dentro da validade (vencida, a sessão não vale);
 * - na célula (`cell`, CE-01), o mesmo endereço onde a sessão nasceu, e a pessoa do cliente desse endereço (ou o
 *   `admin_verax`, só no endereço da equipe). O cookie levado a outro endereço não vale lá; o navegador nunca o leva
 *   (o cookie não tem `Domain`), então isso só acontece com um cookie copiado.
 *
 * Com `staffCustomerView` (`STAFF_CUSTOMER_VIEW`, só no nó dedicado da Verax; decisão de 17/11/2026), o `admin_verax`
 * sem cliente vale como o `admin_cliente` do único cliente ativo do nó: o mesmo painel, as mesmas permissões e o mesmo
 * escopo que o cliente tem. Com nenhum ou mais de um cliente ativo, nada muda (a equipe nunca cai no cliente errado).
 *
 * Sessão que fere alguma regra é apagada, e o retorno é `undefined`.
 */
export async function resolveSession(
  prisma: PrismaService,
  { session, user }: SessionData,
  { cell, staffCustomerView = false }: SessionOptions = {},
): Promise<RequestAuth | undefined> {
  const now = Date.now();
  const tenantId = user.tenantId ?? null;
  const onItsHost =
    cell === undefined ||
    (cell.host !== undefined &&
      (session.hostTenantId ?? null) === cell.host.tenantId &&
      belongsToHost(user, cell.host));
  const valid =
    onItsHost &&
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
  const base = {
    sessionId: session.id,
    userId: user.id,
    email: user.email,
    mfaEnabled: user.twoFactorEnabled === true,
    mustChangePassword: user.mustChangePassword === true,
  };
  if (staffCustomerView && role === 'admin_verax' && tenantId === null) {
    const customer = await onlyActiveTenant(prisma);
    if (customer !== null) {
      // Escopo e papel do administrador do cliente; o cliente vem do banco, nunca da requisição (regra 4).
      return {
        ...base,
        role: 'admin_cliente',
        tenantId: customer,
        activeTenantId: null,
        scopeTenantId: customer,
        staffAsCustomer: true,
      };
    }
  }
  // admin_verax: um cliente selecionado que foi desativado deixa de valer (a troca também recusa inativo).
  const selected = role === 'admin_verax' ? (session.activeTenantId ?? null) : null;
  const activeTenantId = selected !== null && (await isTenantActive(prisma, selected)) ? selected : null;
  return {
    ...base,
    role,
    tenantId,
    activeTenantId,
    // Regra 4: o cliente do escopo vem sempre da sessão, nunca do corpo, da query ou da URL.
    scopeTenantId: role === 'admin_verax' ? activeTenantId : tenantId,
  };
}
