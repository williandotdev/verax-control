import { statfs } from 'node:fs/promises';
import type { Prisma } from '../generated/prisma/client.js';

/** A cada 5 minutos: o plano de controle lê a frota pelos guest attributes (plano §4c e CP-12). */
export const NODE_STATUS_INTERVAL_MS = 5 * 60 * 1000;
/** Quatro PUTs no servidor de metadados da própria VM e duas consultas pequenas ao banco. */
export const NODE_STATUS_BUDGET_MS = 60 * 1000;

/** Raiz dos guest attributes da VM no servidor de metadados. Só o worker o alcança (`metadata-guard.sh`). */
export const GUEST_ATTRIBUTES_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes';
/** O namespace dos atributos do nó: `verax/<chave>`. */
export const NODE_STATUS_NAMESPACE = 'verax';

/**
 * Um arquivo do disco de dados do nó já montado no worker: a CA do banco (`/var/lib/verax/tls/ca.crt`, montada só
 * leitura pelo compose.yaml). O `statfs` de um caminho diz o espaço do sistema de arquivos que o contém: o de
 * `/var/lib/verax`, onde ficam o banco, os backups e (no mesmo disco de boot) os volumes do Docker com o Wazuh. Nenhuma
 * montagem nova, e o worker não lê nada além do tamanho e do espaço livre.
 */
export const DATA_DISK_PROBE = '/etc/verax/tls/ca.crt';

const TIMEOUT_MS = 5_000;

/** Os valores publicados: agregados do nó, nunca dado de cliente (nome, ID de conta, e-mail ou evento). */
export interface NodeStatusValues {
  /** O commit instalado (`NODE_VERSION`). */
  version: string;
  /** Contas cloud ativas com a coleta conectada. */
  accountsConnected: number;
  /** O evento mais recente entre as contas ativas (`CloudAccount.lastEventAt`). */
  lastEventAt: Date | null;
  /** Espaço livre do disco de dados, em porcentagem inteira (0 a 100), ou null se o `statfs` falhou. */
  diskFreePercent: number | null;
}

/** O relatório de uma execução (vai para o log do agendador). */
export interface NodeStatusReport {
  /** Atributos gravados nesta execução. */
  written: number;
  /** Os guest attributes estão desligados na VM: nada foi publicado. */
  disabled?: true;
  /** O disco não pôde ser medido: o atributo `disk-free` ficou como estava. */
  diskFree?: 'unavailable';
}

export interface NodeStatusLogger {
  warn(fields: object, message: string): void;
}

/** O que a tarefa lê do banco: só as contas cloud. */
export type NodeStatusSource = Pick<Prisma.TransactionClient, 'cloudAccount'>;

export type StatFs = (path: string) => Promise<{ bavail: number | bigint; blocks: number | bigint }>;

export interface NodeStatusOptions {
  version: string;
  logger: NodeStatusLogger;
  /** Só os testes trocam (um servidor de metadados falso em 127.0.0.1). */
  baseUrl?: string;
  diskProbe?: string;
  fetch?: typeof fetch;
  statfs?: StatFs;
  timeoutMs?: number;
}

/** O servidor de metadados respondeu com erro (o status vai para o log pelo nome do erro, nunca o corpo). */
export class GuestAttributeWriteError extends Error {
  constructor(readonly status: number) {
    super(`servidor de metadados respondeu ${status} ao gravar o guest attribute`);
    this.name = 'GuestAttributeWriteError';
  }
}

/**
 * Tarefa `node-status` do worker (nó de cliente, fase 3, CP-10): publica o estado do nó nos guest attributes da VM,
 * que o plano de controle lê com `getGuestAttributes` (o papel dele no projeto dos nós não lê banco nem disco):
 *
 * - `verax/version`: o commit instalado;
 * - `verax/accounts-connected`: quantas contas cloud ativas estão conectadas (o `active` do cliente, plano §4b);
 * - `verax/last-event-at`: o evento mais recente, em ISO 8601 UTC, ou `none` antes do primeiro;
 * - `verax/disk-free`: a porcentagem livre do disco de dados (inteiro de 0 a 100).
 *
 * Só agregados, sem nada que identifique cliente, conta ou pessoa. O worker é o único contêiner que alcança o servidor
 * de metadados (a guarda do host), então a tarefa roda nele. Com os guest attributes desligados na VM (o padrão da GCP,
 * `enable-guest-attributes` fora dos metadados), o servidor recusa o primeiro PUT: a tarefa avisa uma vez no log e cada
 * execução seguinte para nesse PUT, sem ler o banco, até o atributo ser ligado.
 */
export class NodeStatusReporter {
  private readonly baseUrl: string;
  private readonly diskProbe: string;
  private readonly fetch: typeof fetch;
  private readonly statfs: StatFs;
  private readonly timeoutMs: number;
  private disabledLogged = false;

  /**
   * `db`: no worker, o cliente sem escopo (busca de sistema, entre todos os clientes do nó). Os testes passam o escopo
   * de um cliente, para conferir as consultas sem depender dos outros arquivos que usam o mesmo banco.
   */
  constructor(
    private readonly db: NodeStatusSource,
    private readonly options: NodeStatusOptions,
  ) {
    this.baseUrl = options.baseUrl ?? GUEST_ATTRIBUTES_URL;
    this.diskProbe = options.diskProbe ?? DATA_DISK_PROBE;
    this.fetch = options.fetch ?? fetch;
    this.statfs = options.statfs ?? statfs;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  /** Os valores do momento, lidos do banco e do disco. */
  async collect(): Promise<Omit<NodeStatusValues, 'version'>> {
    const [accountsConnected, latest, diskFreePercent] = await Promise.all([
      this.db.cloudAccount.count({ where: { status: 'active', connection: 'connected' } }),
      this.db.cloudAccount.aggregate({ where: { status: 'active' }, _max: { lastEventAt: true } }),
      this.diskFree(),
    ]);
    return { accountsConnected, lastEventAt: latest._max.lastEventAt, diskFreePercent };
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<NodeStatusReport> {
    // A versão primeiro: sem banco, ela já diz se os guest attributes estão ligados.
    if ((await this.put('version', this.options.version, signal)) === 'disabled') {
      if (!this.disabledLogged) {
        this.disabledLogged = true;
        this.options.logger.warn(
          { task: 'node-status' },
          'guest attributes desligados na VM (enable-guest-attributes): o estado do nó não é publicado',
        );
      }
      return { written: 0, disabled: true };
    }
    this.disabledLogged = false;
    const values = await this.collect();
    const attributes: [string, string][] = [
      ['accounts-connected', String(values.accountsConnected)],
      ['last-event-at', values.lastEventAt?.toISOString() ?? 'none'],
    ];
    if (values.diskFreePercent !== null) attributes.push(['disk-free', String(values.diskFreePercent)]);
    let written = 1;
    for (const [key, value] of attributes) {
      signal.throwIfAborted();
      if ((await this.put(key, value, signal)) === 'disabled') return { written, disabled: true };
      written += 1;
    }
    return { written, ...(values.diskFreePercent === null && { diskFree: 'unavailable' as const }) };
  }

  private async diskFree(): Promise<number | null> {
    try {
      const { bavail, blocks } = await this.statfs(this.diskProbe);
      const total = Number(blocks);
      if (!(total > 0)) return null;
      return Math.min(100, Math.max(0, Math.floor((Number(bavail) / total) * 100)));
    } catch {
      return null;
    }
  }

  /**
   * Um PUT por atributo, com o cabeçalho que o servidor de metadados exige e sem seguir redirecionamento. O corpo da
   * resposta não é lido. 403 e 404 são os guest attributes desligados (a documentação da GCP não fixa o código).
   */
  private async put(key: string, value: string, signal: AbortSignal): Promise<'ok' | 'disabled'> {
    const response = await this.fetch(`${this.baseUrl}/${NODE_STATUS_NAMESPACE}/${key}`, {
      method: 'PUT',
      headers: { 'Metadata-Flavor': 'Google', 'content-type': 'text/plain; charset=utf-8' },
      body: value,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    await response.body?.cancel();
    if (response.ok) return 'ok';
    if (response.status === 403 || response.status === 404) return 'disabled';
    throw new GuestAttributeWriteError(response.status);
  }
}
