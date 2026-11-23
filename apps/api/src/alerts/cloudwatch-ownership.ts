import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { CloudWatchSourceOwner } from './cloudwatch-alert.js';

/**
 * A prova de quem é o dono dos alertas do CloudWatch Logs do nó (onboarding self-service da AWS).
 *
 * O evento de um grupo de logs chega ao indexer sem a conta e sem o grupo (`cloudwatch-alert.ts`): nada nele diz de
 * quem é. As autorizações do momento em que o sync lê também não dizem: quando um de dois clientes tira a autorização,
 * o manager do Wazuh segue coletando o grupo dele até a configuração nova ser aplicada, e o que sobrou viraria dono de
 * eventos do outro. O que decide é a **configuração aplicada no manager durante todo o intervalo em que o alerta pode
 * ter sido coletado**.
 *
 * A regra: o alerta só é do cliente T, na conta A, se desde `since` toda configuração que o manager rodou só teve
 * grupos de logs dessa conta desse cliente (ou nenhum), e o alerta cabe inteiro no intervalo provado. Na dúvida, o
 * alerta não é de ninguém.
 *
 * Quem prova é a tarefa `wazuh-config` do worker (a única que conhece a lista planejada e lê o sinal `applied` do host,
 * `infra/node/bin/wazuh-apply.sh`), a cada 30 s (`nextCloudWatchOwnership`). O registro fica no banco
 * (`CloudWatchAlertOwnership`, uma linha por nó, sem `tenantId`: só o sistema a grava, e nenhuma rota a lê):
 *
 * - **nasce** quando o sinal `applied` diz ok para a geração da lista planejada de agora, e essa lista tem grupos de
 *   logs de no máximo um dono. `since` é a hora dessa conferência (ou a do sinal, se for mais tarde): o que o manager
 *   rodava antes disso não é conhecido;
 * - **continua**, com o mesmo `since`, enquanto cada conferência seguinte, a no máximo 5 min da anterior, mostra o
 *   manager numa geração conferida (a do registro ou a planejada de agora) e a lista planejada com no máximo esse
 *   dono. O dono vazio (nenhum grupo de logs em configuração nenhuma) vira o primeiro dono que aparecer, sem recomeçar:
 *   antes dele não havia de quem coletar. É o caso do cliente que autoriza o primeiro grupo num nó já no ar;
 * - **acaba** (a linha é apagada) no instante em que a lista **planejada** passa a ter grupos de mais de um dono, antes
 *   de ela chegar ao manager; quando o dono planejado é outro; quando o sinal some, sai do formato ou cita uma geração
 *   que a tarefa não conferiu (o host aplicou, ou tentou aplicar, uma lista que o worker não viu); ou quando a tarefa
 *   fica mais de 5 min sem conferir (o worker parado não viu o que o host aplicou). Para valer de novo, ele nasce de
 *   novo, com outro `since`.
 *
 * O sync (`cloudwatch-alert-sync.ts`) só atribui o alerta cujo horário está entre `since` mais a margem e a última
 * conferência menos a espera (`cloudWatchProof`):
 *
 * - **a margem de 15 min** (`CLOUDWATCH_OWNERSHIP_MARGIN_MS`) cobre o que a configuração anterior ainda pode entregar
 *   depois de trocada: o módulo lê os grupos a cada 5 min, a troca reinicia o manager e espera o healthcheck dele (até
 *   3 min; com a volta da configuração anterior, mais 3), e o analysisd ainda esvazia a fila. São 5 + 6 min, com 4 de
 *   folga para a fila e para a diferença entre os relógios;
 * - **a espera de 10 min** (`CLOUDWATCH_OWNERSHIP_SETTLE_MS`) cobre o atraso do sinal: o host só grava o `applied`
 *   depois de reiniciar o manager e esperar o healthcheck (até 3 min, e mais 3 na volta), e o timer dele (a cada
 *   15 min) pode aplicar uma lista que o worker ainda não planejou (uma autorização desfeita em menos de 30 s). Nesse
 *   meio tempo o manager já roda a configuração nova, e o registro ainda parece valer. O alerta só é atribuído quando
 *   uma conferência pelo menos 10 min mais nova que ele ainda encontra o registro de pé; até lá, ele espera, sem virar
 *   achado nem ir para a fila.
 *
 * Os relógios: o horário do alerta é o campo `timestamp` do documento no indexer (o relógio do manager, quando o
 * analysisd gerou o alerta; o mesmo campo que ordena e pagina a leitura do sync). `since` e `confirmedAt` são do relógio
 * do worker, e `since` nunca fica antes da hora do sinal do host. No nó, os três processos estão na mesma máquina; a
 * margem e a espera absorvem uma diferença de minutos.
 *
 * O que a prova supõe, e não confere: com o worker no ar, a tarefa lê o sinal ao menos uma vez entre duas trocas de
 * configuração do host (cada troca reinicia o manager e espera o healthcheck dele; a tarefa roda a cada 30 s).
 */

/** A chave da linha do nó. Os testes, que dividem o banco, usam outras. */
export const CLOUDWATCH_OWNERSHIP_KEY = 'node';
/** Depois de `since`, o que a configuração anterior ainda pode entregar. */
export const CLOUDWATCH_OWNERSHIP_MARGIN_MS = 15 * 60 * 1000;
/** O atraso do sinal `applied` em relação ao que o manager já roda. */
export const CLOUDWATCH_OWNERSHIP_SETTLE_MS = 10 * 60 * 1000;
/** O maior intervalo entre duas conferências para o registro continuar (o timer do host aplica a cada 15 min). */
export const CLOUDWATCH_OWNERSHIP_MAX_GAP_MS = 5 * 60 * 1000;

export interface CloudWatchOwnership {
  /** O dono dos grupos de logs; null enquanto nenhuma configuração aplicada desde `since` teve grupo de logs. */
  owner: CloudWatchSourceOwner | null;
  /** A geração que o manager roda, a última conferida pelo sinal `applied`. */
  generation: string;
  since: Date;
  confirmedAt: Date;
}

/** O sinal `applied` do host, já conferido no formato (`aws/wazuh-config.ts`). */
export interface AppliedObservation {
  generation: string | null;
  status: 'ok' | 'error';
  at: string;
}

export interface CloudWatchOwnershipObservation {
  now: Date;
  /** A geração da lista planejada agora. */
  generation: string;
  /** Os donos (cliente e conta) dos grupos de logs da lista planejada agora, sem repetição. */
  owners: readonly CloudWatchSourceOwner[];
  /** O último sinal do host; null sem o sinal ou com ele fora do formato. */
  applied: AppliedObservation | null;
}

const sameOwner = (a: CloudWatchSourceOwner, b: CloudWatchSourceOwner): boolean =>
  a.tenantId === b.tenantId && a.accountId === b.accountId;

const later = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);

/**
 * O registro depois de uma conferência da tarefa `wazuh-config` (null: sem prova). Só anda para a frente: o registro
 * que continua guarda o `since` que tinha, e o que perde a prova some, para nascer de novo com outro.
 */
export function nextCloudWatchOwnership(
  record: CloudWatchOwnership | null,
  { now, generation, owners, applied }: CloudWatchOwnershipObservation,
): CloudWatchOwnership | null {
  // A dúvida começa quando a lista é planejada, antes de chegar ao manager.
  if (owners.length > 1) return null;
  const planned = owners[0] ?? null;

  let current = record;
  // A tarefa ficou sem conferir: o host pode ter aplicado, nesse meio tempo, uma lista que ela não viu.
  if (current !== null && now.getTime() - current.confirmedAt.getTime() > CLOUDWATCH_OWNERSHIP_MAX_GAP_MS) {
    current = null;
  }
  // Outro dono: nada do que foi coletado para o anterior pode ser dele.
  if (current !== null && current.owner !== null && planned !== null && !sameOwner(current.owner, planned)) {
    current = null;
  }

  // Sem o sinal (o nó reiniciou, o host ainda não aplicou nada), não se sabe o que o manager roda.
  if (applied === null) return null;
  const verified = (candidate: string | null): boolean =>
    candidate !== null && (candidate === generation || candidate === current?.generation);

  if (applied.status === 'ok') {
    // O manager roda uma lista que a tarefa não conferiu.
    if (applied.generation === null || !verified(applied.generation)) return null;
    if (current === null) {
      // Só nasce com a lista de agora aplicada: é a única de que a tarefa conhece os donos.
      if (applied.generation !== generation) return null;
      const at = new Date(applied.at);
      const since = Number.isNaN(at.getTime()) ? now : later(now, at);
      return { owner: planned, generation, since, confirmedAt: now };
    }
    return {
      owner: current.owner ?? planned,
      generation: applied.generation,
      since: current.since,
      confirmedAt: now,
    };
  }

  // A última tentativa do host deu erro. Um registro nunca nasce assim.
  if (current === null) return null;
  // Sem geração, a lista nem chegou ao gerador, e o manager ficou como estava. Com uma geração conferida, o manager
  // rodou a lista dela por até 3 min e voltou para a anterior: as duas só têm grupos deste dono.
  if (applied.generation === null || verified(applied.generation)) {
    return { ...current, owner: current.owner ?? planned, confirmedAt: now };
  }
  return null;
}

/** O intervalo em que o alerta pode ser atribuído ao dono: do começo provado até a última conferência já assentada. */
export interface CloudWatchProof {
  /** `since` mais a margem. */
  from: Date;
  /** A última conferência menos a espera. */
  until: Date;
  /**
   * A tarefa segue conferindo. Com ela parada (mais de 5 min sem conferir), o alerta mais novo que `until` não tem
   * como ser provado, e não adianta esperar por ele: a próxima conferência recomeça o registro.
   */
  live: boolean;
}

/** A prova para o dono de agora (o das autorizações): null sem registro, ou com o registro de outro dono. */
export function cloudWatchProof(
  record: CloudWatchOwnership | null,
  owner: CloudWatchSourceOwner,
  now: Date,
): CloudWatchProof | null {
  if (record === null || record.owner === null || !sameOwner(record.owner, owner)) return null;
  return {
    from: new Date(record.since.getTime() + CLOUDWATCH_OWNERSHIP_MARGIN_MS),
    until: new Date(record.confirmedAt.getTime() - CLOUDWATCH_OWNERSHIP_SETTLE_MS),
    live: now.getTime() - record.confirmedAt.getTime() <= CLOUDWATCH_OWNERSHIP_MAX_GAP_MS,
  };
}

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_ID = /^\d{12}$/;
const GENERATION = /^[0-9a-f]{64}$/;

interface OwnershipRow {
  ownerTenantId: string | null;
  ownerAccountId: string | null;
  generation: string;
  since: Date;
  confirmedAt: Date;
}

/** A linha do banco conferida de novo no formato; fora dele, vale como sem registro. */
function toRecord(row: OwnershipRow | null): CloudWatchOwnership | null {
  if (row === null || !GENERATION.test(row.generation)) return null;
  const { ownerTenantId, ownerAccountId } = row;
  let owner: CloudWatchSourceOwner | null = null;
  if (ownerTenantId !== null || ownerAccountId !== null) {
    if (ownerTenantId === null || ownerAccountId === null) return null;
    if (!TENANT_ID.test(ownerTenantId) || !ACCOUNT_ID.test(ownerAccountId)) return null;
    owner = { tenantId: ownerTenantId, accountId: ownerAccountId };
  }
  return { owner, generation: row.generation, since: row.since, confirmedAt: row.confirmedAt };
}

/**
 * O registro no banco. Uma busca e uma gravação de sistema, fora do escopo de cliente: a linha não é de cliente nenhum.
 * `observe` é só da tarefa `wazuh-config`; o sync só lê.
 */
export class CloudWatchOwnershipStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly key: string = CLOUDWATCH_OWNERSHIP_KEY,
  ) {}

  async read(): Promise<CloudWatchOwnership | null> {
    return toRecord(await this.prisma.cloudWatchAlertOwnership.findUnique({ where: { id: this.key } }));
  }

  /** Uma conferência: lê o registro, decide o seguinte e grava, tudo sob a mesma trava (um worker por vez). */
  observe(observation: CloudWatchOwnershipObservation): Promise<CloudWatchOwnership | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:cloudwatch-ownership:${this.key}`}))`;
      const row = await tx.cloudWatchAlertOwnership.findUnique({ where: { id: this.key } });
      const next = nextCloudWatchOwnership(toRecord(row), observation);
      if (next === null) {
        if (row !== null) await tx.cloudWatchAlertOwnership.deleteMany({ where: { id: this.key } });
        return null;
      }
      const data = {
        ownerTenantId: next.owner?.tenantId ?? null,
        ownerAccountId: next.owner?.accountId ?? null,
        generation: next.generation,
        since: next.since,
        confirmedAt: next.confirmedAt,
      };
      await tx.cloudWatchAlertOwnership.upsert({
        where: { id: this.key },
        create: { id: this.key, ...data },
        update: data,
      });
      return next;
    });
  }
}
