import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AlertNotices, type AlertNoticeTarget } from '../notifications/finding-notices.js';
import { CASE_NOTICE_SLACK_MS } from './case-notice-policy.js';

/**
 * A linha dos avisos por caso no `SyncState`: em `cursorTimestamp`, a primeira vez em que eles valeram (gravada uma vez
 * só); em `cursorId`, se valem agora (`on`) ou se já foram devolvidos ao aviso por alerta (`off`). Nenhuma coluna nova:
 * esta linha não usa cursor de leitura.
 */
export const CASE_NOTICES_STATE = 'case-notices';
const REGIME_ON = 'on';
const REGIME_OFF = 'off';

/** O começo dos avisos por caso, como ficou gravado. */
export interface CaseNoticeEpoch {
  /** A primeira passagem com eles. */
  activatedAt: Date;
  /** O alerta que chegou antes disto é do passado (com a folga da virada). */
  mark: Date;
}

export const epochOf = (activatedAt: Date): CaseNoticeEpoch => ({
  activatedAt,
  mark: new Date(activatedAt.getTime() - CASE_NOTICE_SLACK_MS),
});

/**
 * A virada do aviso por alerta para o aviso por caso, neste processo (`CASES_MODE=on`).
 *
 * O aviso por alerta só para **depois** de a virada estar gravada no banco: até lá (o banco fora do ar na partida), o
 * worker avisa alerta por alerta, como sempre. Assim todo alerta alto ou crítico ou tem a linha do aviso dele, ou chegou
 * depois do marco e é dos avisos por caso.
 */
export class CaseNoticeRegime {
  private activated = false;
  private readonly name: string;

  constructor(
    private readonly prisma: PrismaService,
    { name = CASE_NOTICES_STATE }: { name?: string } = {},
  ) {
    this.name = name;
  }

  /** Os avisos por caso valem neste processo: o aviso por alerta não sai mais. */
  get active(): boolean {
    return this.activated;
  }

  /** Grava a virada (uma vez só), diz que ela vale agora e devolve o começo dela. Repetir não muda o começo. */
  async activate(now: Date): Promise<CaseNoticeEpoch> {
    const { name } = this;
    await this.prisma.syncState.createMany({ data: [{ name }], skipDuplicates: true });
    await this.prisma.syncState.updateMany({
      where: { name, cursorTimestamp: null },
      data: { cursorTimestamp: now },
    });
    const { cursorTimestamp } = await this.prisma.syncState.update({
      where: { name },
      data: { cursorId: REGIME_ON, lastRunAt: now },
      select: { cursorTimestamp: true },
    });
    this.activated = true;
    return epochOf(cursorTimestamp ?? now);
  }
}

/** O começo dos avisos por caso, se eles valiam e ainda não foram devolvidos; null no nó que nunca os ligou. */
export async function pendingHandBack(
  prisma: PrismaService,
  name = CASE_NOTICES_STATE,
): Promise<CaseNoticeEpoch | null> {
  const state = await prisma.syncState.findUnique({
    where: { name },
    select: { cursorId: true, cursorTimestamp: true },
  });
  if (state?.cursorId !== REGIME_ON || state.cursorTimestamp === null) return null;
  return epochOf(state.cursorTimestamp);
}

/** Os avisos por caso foram devolvidos: nada mais a fazer até eles voltarem. */
export async function finishHandBack(prisma: PrismaService, name = CASE_NOTICES_STATE): Promise<void> {
  await prisma.syncState.updateMany({ where: { name, cursorId: REGIME_ON }, data: { cursorId: REGIME_OFF } });
}

/**
 * O passo do `FindingStore` com os avisos por caso: o alerta novo não põe nada na fila, porque o aviso sai do caso dele.
 *
 * Só o que nenhum caso avisa segue alerta por alerta: a severidade que sobe na origem num alerta que está num incidente,
 * já foi tratado ou ainda não tem caso (`outsideCases`).
 */
export class CaseAlertNotices extends AlertNotices {
  constructor(private readonly regime: Pick<CaseNoticeRegime, 'active'>) {
    super();
  }

  override async enqueue(db: Prisma.TransactionClient, finding: AlertNoticeTarget): Promise<number> {
    if (this.regime.active && finding.outsideCases !== true) return 0;
    return super.enqueue(db, finding);
  }
}
