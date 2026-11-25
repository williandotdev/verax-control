import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { FindingSeverity } from '../generated/prisma/client.js';
import type { CaseMailItem, NoticeMail } from '../mail/templates.js';
import { CASE_CRITICAL_ITEMS, CASE_DAILY_ITEMS, CASE_SKIP, caseNoticeType } from './case-notice-policy.js';
import { listedCases, type ListedCase, queueCounts, skipStaleCaseNotices } from './case-notice-store.js';

/** Avisos de caso que deixaram de valer, fechados por lote, e os lotes por execução. */
const STALE_BATCH = 1_000;
const STALE_BATCHES = 20;

/** O que a entrega usa de um aviso para saber se é de caso. */
export interface CaseNoticeRef {
  id: string;
  severity: FindingSeverity | null;
  caseId: string | null;
  dedupeKey: string;
}

/** O conteúdo de cada aviso de caso; null se ele não tem mais o que dizer (tratado, ou o caso saiu). */
export type CaseNoticeContents = ReadonlyMap<string, NoticeMail | null>;

/**
 * O lado da entrega dos avisos por caso (`CASES_MODE=on`): o conteúdo do e-mail sai do caso na hora do envio, com o título
 * do dicionário e as contagens, e o aviso que deixou de valer não sai. Nada vem do evento.
 */
export class CaseNoticeMail {
  constructor(private readonly prisma: PrismaService) {}

  /** Fecha os avisos de caso da fila que deixaram de valer (todos, ou só os dados). Devolve quantos. */
  async skipStale(
    now: Date,
    ids: readonly string[] | null = null,
  ): Promise<{ sent: number; skipped: number }> {
    const total = { sent: 0, skipped: 0 };
    for (let batches = 0; batches < STALE_BATCHES; batches += 1) {
      const closed = await skipStaleCaseNotices(this.prisma, now, { ids, limit: STALE_BATCH });
      for (const { status } of closed) total[status] += 1;
      if (closed.length < STALE_BATCH) break;
    }
    return total;
  }

  /** O conteúdo dos avisos de caso de um cliente, lidos de uma vez. Os que não são de caso ficam de fora do mapa. */
  async contents(
    tenantId: string,
    rows: readonly CaseNoticeRef[],
    webOrigin: string,
  ): Promise<CaseNoticeContents> {
    const contents = new Map<string, NoticeMail | null>();
    const caseIds = new Set<string>();
    for (const { caseId } of rows) if (caseId !== null) caseIds.add(caseId);
    const cases = new Map(
      caseIds.size === 0
        ? []
        : (
            await this.prisma.forTenant(tenantId).alertCase.findMany({
              where: { id: { in: [...caseIds] } },
              select: { id: true, title: true, pendingCritical: true, pendingHigh: true },
            })
          ).map((row) => [row.id, row] as const),
    );
    // O aviso imediato e o resumo diário falam das filas inteiras, agora: de vários na mesma lista, só o último.
    const latest = new Map<'critical' | 'daily', CaseNoticeRef>();
    for (const row of rows) {
      const type = caseNoticeType(row);
      if (type === null) continue;
      if (type === 'critical' || type === 'daily') {
        const known = latest.get(type);
        if (known === undefined || row.dedupeKey > known.dedupeKey) latest.set(type, row);
        contents.set(row.id, null);
        continue;
      }
      const found = row.caseId === null ? undefined : cases.get(row.caseId);
      const critical = found?.pendingCritical ?? 0;
      const high = found?.pendingHigh ?? 0;
      const pending = row.severity === 'critical' ? critical > 0 : critical + high > 0;
      contents.set(
        row.id,
        found === undefined || !pending
          ? null
          : {
              kind: 'case',
              severity: row.severity === 'critical' ? 'critical' : 'high',
              growth: type === 'growth',
              title: found.title,
              critical,
              high,
              link: caseLink(webOrigin, found.id),
            },
      );
    }
    for (const [type, row] of latest) {
      contents.set(
        row.id,
        type === 'critical'
          ? await this.criticalContent(tenantId, webOrigin)
          : await this.dailyContent(tenantId, webOrigin),
      );
    }
    return contents;
  }

  /**
   * Os avisos que entraram num resumo e ficaram de fora dele por já estarem tratados: se ninguém os recebeu, deixam de
   * valer como aviso dado (o caso que voltar por um desfazer avisa).
   */
  async dropUnsaid(tenantId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.forTenant(tenantId).notification.updateMany({
      where: {
        id: { in: [...ids] },
        status: 'sent',
        caseId: { not: null },
        deliveredUserIds: { isEmpty: true },
        OR: [{ escalationDelivery: null }, { escalationDelivery: { not: 'sent' } }],
      },
      data: { status: 'skipped', lastError: CASE_SKIP.treated },
    });
  }

  private async criticalContent(tenantId: string, webOrigin: string): Promise<NoticeMail | null> {
    const counts = await queueCounts(this.prisma, tenantId);
    const cases = sum(counts.map((row) => row.criticalCases));
    if (cases === 0) return null;
    const items = await listedCases(this.prisma, tenantId, 'latest_critical', CASE_CRITICAL_ITEMS);
    return {
      kind: 'cases_critical',
      cases,
      critical: sum(counts.map((row) => row.critical)),
      items: items.map((item) => mailItem(webOrigin, item)),
      link: queueLink(
        webOrigin,
        counts.some((row) => row.queue === 'vulnerability' && row.criticalCases > 0),
      ),
    };
  }

  private async dailyContent(tenantId: string, webOrigin: string): Promise<NoticeMail | null> {
    const counts = await queueCounts(this.prisma, tenantId);
    if (counts.length === 0) return null;
    const items = await listedCases(this.prisma, tenantId, 'worst', CASE_DAILY_ITEMS);
    const of = (queue: 'vulnerability' | 'posture') => {
      const row = counts.find((count) => count.queue === queue);
      return { cases: row?.cases ?? 0, critical: row?.critical ?? 0, high: row?.high ?? 0 };
    };
    return {
      kind: 'cases_daily',
      vulnerability: of('vulnerability'),
      posture: of('posture'),
      items: items.map((item) => mailItem(webOrigin, item)),
      link: queueLink(
        webOrigin,
        counts.some((row) => row.queue === 'vulnerability'),
      ),
    };
  }
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const caseLink = (webOrigin: string, caseId: string): string =>
  new URL(`/?caso=${encodeURIComponent(caseId)}`, webOrigin).href;

/** A tela da fila (cada item da lista do e-mail já abre o caso dele): a das vulnerabilidades, se há alguma. */
const queueLink = (webOrigin: string, vulnerabilities: boolean): string =>
  new URL(vulnerabilities ? '/?visao=vulnerabilidades' : '/?visao=casos&fila=postura', webOrigin).href;

const mailItem = (webOrigin: string, item: ListedCase): CaseMailItem => ({
  title: item.title,
  critical: item.critical,
  high: item.high,
  link: caseLink(webOrigin, item.id),
});
