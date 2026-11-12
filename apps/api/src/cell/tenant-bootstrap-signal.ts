import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isTenantSlug } from '../common/config/cell.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';

/** A resposta do host a um pedido: `ok` (atendido), `error` (fica para a próxima tentativa) ou nenhuma ainda. */
export type TenantBootstrapStatus = 'ok' | 'error' | null;

/**
 * O pedido do primeiro administrador de um cliente da célula ao host (CE-04: o worker escreve, o host executa e
 * responde). A senha nunca passa pelo worker: o host roda o bootstrap e a grava no cofre do cliente.
 */
export interface TenantBootstrapSignal {
  /** O pedido ainda está na pasta (o host não o atendeu). */
  pending(tenantId: string): Promise<boolean>;
  /** Escreve o pedido (substitui um anterior do mesmo cliente). */
  request(tenantId: string, slug: string, email: string): Promise<void>;
  /** A última resposta do host para o cliente. */
  status(tenantId: string): Promise<TenantBootstrapStatus>;
}

/** O id do cliente no banco da célula, como o host o aceita no nome do arquivo (`re_tenant_id` do `start.sh`). */
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** O teto do pedido que o host lê (`read_tenant_request`). */
const REQUEST_MAX_BYTES = 512;
const emailSchema = z.email().max(254);

/** O nome do arquivo é o id do cliente: nada de fora vira caminho. */
function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId))
    throw new Error('id de cliente inválido para o pedido do primeiro acesso');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * O contrato de arquivos do CE-04 (`infra/node/bin/start.sh`, `tenant-bootstrap`): o pedido em
 * `<pasta dos pedidos>/<id do cliente>`, com duas linhas (`slug=` e `email=`, sem segredo), escrito de uma vez (arquivo
 * temporário com outro nome e `rename`, que o host ignora até o fim); a resposta em `<pasta de estado>/<id>`, `ok` ou
 * `error`, escrita só pelo host (montada só leitura no worker).
 */
export class FileTenantBootstrapSignal implements TenantBootstrapSignal {
  constructor(
    private readonly requestsDir: string,
    private readonly statusDir: string,
  ) {}

  async pending(tenantId: string): Promise<boolean> {
    assertTenantId(tenantId);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta da configuração do nó e o id conferido, não do request
      await stat(join(this.requestsDir, tenantId));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async request(tenantId: string, slug: string, email: string): Promise<void> {
    assertTenantId(tenantId);
    if (!isTenantSlug(slug)) throw new Error('subdomínio inválido para o pedido do primeiro acesso');
    if (!emailSchema.safeParse(email).success)
      throw new Error('e-mail inválido para o pedido do primeiro acesso');
    const body = `slug=${slug}\nemail=${email}\n`;
    if (Buffer.byteLength(body, 'utf8') > REQUEST_MAX_BYTES)
      throw new Error('pedido do primeiro acesso acima do teto');
    // O nome temporário não tem o formato de id: o host o ignora até o `rename`.
    const temporary = join(this.requestsDir, `.${tenantId}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta da configuração do nó e o id conferido, não do request
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o640, flag: 'wx' });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- idem
      await rename(temporary, join(this.requestsDir, tenantId));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async status(tenantId: string): Promise<TenantBootstrapStatus> {
    assertTenantId(tenantId);
    let text: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta da configuração do nó e o id conferido, não do request
      text = await readFile(join(this.statusDir, tenantId), 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const value = text.slice(0, 16).trim();
    return value === 'ok' || value === 'error' ? value : null;
  }
}

export interface TenantBootstrapReport {
  pending: number;
  requested: number;
  confirmed: number;
}

/** Quantos pedidos uma passagem olha (o resto fica para a seguinte, 10 s depois). */
const BATCH = 50;

/**
 * Os pedidos do primeiro administrador ainda sem confirmação (`CellTenantBootstrap`, gravados na mesma transação do
 * `tenant.upsert` que criou o cliente). A cada passagem da tarefa `cell-commands`, para cada um:
 * - o pedido ainda está na pasta: o host não o atendeu (ou falhou e o timer dele tenta de novo); nada a fazer;
 * - a resposta é `ok` e o pedido saiu: confirmado; o e-mail é apagado da linha;
 * - senão (nunca escrito, ou a pasta do `/run` sumiu num reinício da VM): o pedido é escrito de novo.
 *
 * Uma queda do worker depois do commit do `tenant.upsert` não perde o pedido: ele está no banco e sai na passagem
 * seguinte. Sem o contrato de arquivos (o worker sem `TENANT_BOOTSTRAP_DIR`), os pedidos ficam esperando.
 */
export class CellTenantBootstraps {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signal: TenantBootstrapSignal | null,
    private readonly options: { now?: () => Date; tenantIds?: readonly string[] } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async runOnce(): Promise<TenantBootstrapReport> {
    const report: TenantBootstrapReport = { pending: 0, requested: 0, confirmed: 0 };
    const rows = await this.prisma.cellTenantBootstrap.findMany({
      // `tenantIds`: só os testes, que dividem o banco com outras suítes.
      where: {
        confirmedAt: null,
        ...(this.options.tenantIds !== undefined && { tenantId: { in: [...this.options.tenantIds] } }),
      },
      orderBy: { requestedAt: 'asc' },
      take: BATCH,
      select: { tenantId: true, slug: true, adminEmail: true },
    });
    report.pending = rows.length;
    if (this.signal === null) return report;
    for (const row of rows) {
      if (await this.signal.pending(row.tenantId)) continue;
      if ((await this.signal.status(row.tenantId)) === 'ok') {
        await this.prisma.cellTenantBootstrap.update({
          where: { tenantId: row.tenantId },
          data: { confirmedAt: this.now(), adminEmail: null },
          select: { tenantId: true },
        });
        report.confirmed += 1;
        continue;
      }
      if (row.adminEmail === null) continue;
      await this.signal.request(row.tenantId, row.slug, row.adminEmail);
      await this.prisma.cellTenantBootstrap.update({
        where: { tenantId: row.tenantId },
        data: { signaledAt: this.now(), attempts: { increment: 1 } },
        select: { tenantId: true },
      });
      report.requested += 1;
    }
    report.pending -= report.confirmed;
    return report;
  }
}
