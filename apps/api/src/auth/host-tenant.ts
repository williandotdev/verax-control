import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type CellConfig, cellPanelOrigin, slugFromApiHost } from '../common/config/cell.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { requestContext } from '../common/context/request-context.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { ANY_HOST_KEY } from './decorators.js';

/**
 * O cliente do endereço da requisição na célula (CE-01). Sai do header `Host`, que o túnel do Cloudflare repassa como
 * o navegador mandou, e do mapa gravado pelo sistema (`TenantHost`); nunca de um valor que o cliente HTTP escolhe.
 */
export interface HostTenant {
  tenantId: string;
  slug: string;
  /** Endereço da equipe da Verax (`CELL_STAFF_SLUG`): o único onde o `admin_verax` entra e troca de cliente. */
  staff: boolean;
  /** Origem do painel deste cliente (`https://<slug>.control.<domínio>`): CORS, CSRF, links e o Turnstile. */
  panelOrigin: string;
  panelHostname: string;
}

declare module 'express' {
  interface Request {
    /** Na célula, o cliente do endereço, preenchido pelo `HostTenantGuard`. Ausente no nó dedicado. */
    hostTenant?: HostTenant;
  }
}

/**
 * Quem a sessão pode ser num endereço da célula: alguém do cliente do endereço, ou o `admin_verax` (que não tem
 * cliente), só no endereço da equipe. O usuário de um cliente nunca entra no endereço de outro.
 */
export function belongsToHost(user: { role: string; tenantId?: string | null }, host: HostTenant): boolean {
  if (user.role === 'admin_verax') return host.staff && (user.tenantId ?? null) === null;
  return user.tenantId === host.tenantId;
}

/** O cliente do endereço da requisição em curso, para quem roda dentro do handler (os hooks do Better Auth). */
export function currentHostTenant(): HostTenant | undefined {
  return requestContext.getStore()?.host;
}

/**
 * A origem do painel que pode chamar esta requisição: o `WEB_ORIGIN` no nó dedicado; na célula, a do cliente do
 * endereço (`undefined` sem ele, e quem chama recusa).
 */
export function panelOriginOf(
  config: Pick<AppConfig, 'WEB_ORIGIN' | 'cell'>,
  request: Request,
): string | undefined {
  return config.cell === null ? config.WEB_ORIGIN : request.hostTenant?.panelOrigin;
}

/**
 * A amarração da sessão ao endereço, para `resolveSession`: na célula, o cliente do endereço (ou nenhum, e a sessão não
 * vale); no nó dedicado, `undefined`, e nada muda.
 */
export function sessionHostOf(
  config: Pick<AppConfig, 'cell'>,
  request: Request,
): { host: HostTenant | undefined } | undefined {
  return config.cell === null ? undefined : { host: request.hostTenant };
}

/**
 * Resolve o cliente do endereço. Uma consulta por requisição: o resultado fica guardado para o CORS (que roda antes
 * de tudo) e para o guard usarem o mesmo. Sem cache entre requisições: apagar o endereço vale na hora.
 */
@Injectable()
export class HostTenantResolver {
  private readonly resolved = new WeakMap<Request, Promise<HostTenant | undefined>>();
  readonly cell: CellConfig | null;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    this.cell = config.cell;
  }

  resolve(request: Request): Promise<HostTenant | undefined> {
    let pending = this.resolved.get(request);
    if (pending === undefined) {
      pending = this.lookup(request.headers.host);
      this.resolved.set(request, pending);
    }
    return pending;
  }

  private async lookup(host: unknown): Promise<HostTenant | undefined> {
    const cell = this.cell;
    if (cell === null) return undefined;
    const slug = slugFromApiHost(cell, host);
    if (slug === undefined) return undefined;
    const row = await this.prisma.tenantHost.findUnique({ where: { slug }, select: { tenantId: true } });
    if (row === null) return undefined;
    const panelOrigin = cellPanelOrigin(cell, slug);
    return {
      tenantId: row.tenantId,
      slug,
      staff: slug === cell.staffSlug,
      panelOrigin,
      panelHostname: new URL(panelOrigin).hostname,
    };
  }
}

/**
 * Primeiro guard global (CE-01). Na célula, toda rota responde só num endereço conhecido: `Host` fora do formato ou sem
 * cliente recebe 404, antes de qualquer regra de sessão, de login ou de permissão (nada é consultado, contado nem
 * gravado em nome do endereço desconhecido). A exceção, fechada e conferida pelo meta-teste de rotas, é o health check
 * (`@AnyHost`). No nó dedicado, não faz nada.
 */
@Injectable()
export class HostTenantGuard implements CanActivate {
  constructor(
    private readonly hosts: HostTenantResolver,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.hosts.cell === null) return true;
    if (context.getType() !== 'http') return false;
    const anyHost = this.reflector.getAllAndOverride<boolean | undefined>(ANY_HOST_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (anyHost) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const host = await this.hosts.resolve(request);
    if (host === undefined) throw new NotFoundException();
    request.hostTenant = host;
    return true;
  }
}
