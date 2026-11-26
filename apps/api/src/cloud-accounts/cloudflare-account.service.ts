import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  CloudflareConnection,
  CloudflareGrantStatus,
  CloudflareZone,
  CloudflareZones,
  CloudflareZoneState,
} from '@verax/shared';
import { CLOUDFLARE_AUDIT_STREAM } from '../cloudflare/cloudflare-streams.js';
import { SECURITY_MAX_ZONES } from '../cloudflare/security-events.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const ZONE_SELECT = {
  zoneId: true,
  name: true,
  plan: true,
  state: true,
  lastReadAt: true,
  lastErrorCode: true,
  firstSeenAt: true,
  missingSince: true,
} as const satisfies Prisma.CloudflareZoneSelect;
type ZoneRow = Prisma.CloudflareZoneGetPayload<{ select: typeof ZONE_SELECT }>;

/** A conta do Cloudflare do cliente: a conexão e a saúde das zonas. Só leitura, sempre pelo escopo do cliente. */
@Injectable()
export class CloudflareAccountService {
  constructor(private readonly prisma: PrismaService) {}

  async connection(id: string): Promise<CloudflareConnection> {
    const row = await this.prisma.scoped().cloudAccount.findUnique({
      where: { id },
      select: {
        provider: true,
        credential: { select: { kind: true } },
        cloudflareGrant: {
          select: {
            status: true,
            consentedAt: true,
            lastRefreshAt: true,
            scopes: true,
            _count: { select: { cloudAccounts: true } },
          },
        },
      },
    });
    const account = this.cloudflare(row);
    const grant = account.cloudflareGrant;
    if (grant === null) {
      return { method: account.credential?.kind === 'cloudflare_api_token' ? 'token' : null, grant: null };
    }
    return {
      method: 'oauth',
      grant: {
        status: grant.status as CloudflareGrantStatus,
        consentedAt: grant.consentedAt.toISOString(),
        lastRefreshAt: grant.lastRefreshAt?.toISOString() ?? null,
        scopes: grant.scopes,
        accounts: grant._count.cloudAccounts,
      },
    };
  }

  async zones(id: string): Promise<CloudflareZones> {
    const row = await this.prisma.scoped().cloudAccount.findUnique({
      where: { id },
      select: {
        provider: true,
        status: true,
        zones: true,
        cloudflareZones: { select: ZONE_SELECT, orderBy: [{ name: 'asc' }, { zoneId: 'asc' }] },
        cursors: {
          where: { stream: CLOUDFLARE_AUDIT_STREAM, region: '' },
          select: { lastSuccessAt: true, lastErrorKind: true },
        },
      },
    });
    const account = this.cloudflare(row);
    const active = account.status === 'active';
    const listed = new Set(account.zones.map((zone) => zone.toLowerCase()));
    const [audit] = account.cursors;
    return {
      monitored: listed.size === 0 ? 'all' : 'listed',
      limit: SECURITY_MAX_ZONES,
      audit: {
        lastReadAt: audit?.lastSuccessAt?.toISOString() ?? null,
        lastErrorCode: active ? (audit?.lastErrorKind ?? null) : null,
      },
      zones: account.cloudflareZones.map((zone) =>
        toZone(zone, active && (listed.size === 0 || listed.has(zone.name))),
      ),
    };
  }

  private cloudflare<T extends { provider: string }>(row: T | null): T {
    if (row === null) throw new ApiError(HttpStatus.NOT_FOUND, 'Conta não encontrada');
    if (row.provider !== 'cloudflare') {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'Só uma conta do Cloudflare tem zonas.');
    }
    return row;
  }
}

/**
 * A zona como a tela a vê. O que o worker gravou é da última leitura: a lista cadastrada e a conta desativada valem já, e a
 * zona que voltou para a lista espera a próxima leitura.
 */
function toZone(zone: ZoneRow, monitored: boolean): CloudflareZone {
  const stored = zone.state as CloudflareZoneState;
  const state: CloudflareZoneState =
    stored === 'missing'
      ? stored
      : !monitored
        ? 'not_monitored'
        : stored === 'not_monitored'
          ? 'pending'
          : stored;
  return {
    zoneId: zone.zoneId,
    name: zone.name,
    plan: zone.plan,
    state,
    lastReadAt: zone.lastReadAt?.toISOString() ?? null,
    lastErrorCode: state === 'not_monitored' ? null : zone.lastErrorCode,
    firstSeenAt: zone.firstSeenAt.toISOString(),
    missingSince: zone.missingSince?.toISOString() ?? null,
  };
}
