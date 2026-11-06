import { alertsAfter, type AlertCursor, type AlertSearch } from '../indexer/alert-queries.js';
import { MANAGER_AGENT_ID } from './agent-alert.js';
import { AWS_SOURCES } from './wazuh-alert.js';

/**
 * Leitura incremental dos alertas para o sync (T5.3).
 *
 * Cada execução relê uma janela que começa um pouco antes do último alerta processado: o Wazuh grava o horário de
 * processamento, mas o alerta chega ao indexer pelo filebeat e pode ser indexado fora de ordem. Como a gravação é
 * idempotente (`source` + `sourceEventId`), reler a sobreposição não duplica achado. Dentro da execução, as páginas
 * seguem pelo cursor (horário e id), sem pular nem repetir.
 */

export interface SyncSettings {
  /**
   * Nível mínimo da regra para virar achado. Na AWS, 5: abaixo ficam os eventos de auditoria do CloudTrail (nível 3).
   * Nos agentes, 7 (`AGENT_MIN_LEVEL`).
   */
  minLevel: number;
  /** Quanto reler antes do último alerta processado. */
  overlapMs: number;
  /** Na primeira execução (sem alerta processado), quanto olhar para trás. */
  initialLookbackMs: number;
  pageSize: number;
}

export const DEFAULT_SYNC_SETTINGS: Readonly<SyncSettings> = {
  minLevel: 5,
  overlapMs: 10 * 60 * 1000,
  initialLookbackMs: 24 * 60 * 60 * 1000,
  pageSize: 500,
};

/**
 * Nível mínimo dos alertas dos agentes nas instâncias do cliente: 7, acima do 5 da AWS (decisão do responsável,
 * 05/11/2026). Uma instância gera muito mais alerta de rotina que a trilha de uma conta, e os níveis 5 e 6 (severidade
 * baixa) de uma instância trazem eventos do dia a dia que só encheriam a lista de achados: o arquivo novo do FIM depois
 * de uma atualização de pacotes (regra 554, nível 5), o resumo do SCA (19003, nível 5), a conexão SSH malformada de um
 * robô de varredura (5706, nível 6). Do 7 para cima (média, alta e crítica), vira achado.
 *
 * Atenção: a checagem do SCA com falha (19007), o arquivo alterado ou apagado (550 e 553) e o pacote instalado (2902)
 * são nível 7 no Wazuh 4.14 e continuam virando achado médio; o primeiro SCA de cada instância ainda gera um achado por
 * checagem com falha (que se juntam no incidente da instância). Só o sync dos agentes usa este nível; o da AWS não
 * muda.
 */
export const AGENT_MIN_LEVEL = 7;

/** As regras de leitura do sync dos agentes: as da AWS, com o nível mínimo próprio. */
export const DEFAULT_AGENT_SYNC_SETTINGS: Readonly<SyncSettings> = {
  ...DEFAULT_SYNC_SETTINGS,
  minLevel: AGENT_MIN_LEVEL,
};

/** Início da janela de uma execução, em ISO 8601 UTC. */
export function syncWindowStart(lastProcessedAt: string | null, now: Date, settings: SyncSettings): string {
  const start =
    lastProcessedAt === null
      ? now.getTime() - settings.initialLookbackMs
      : new Date(lastProcessedAt).getTime() - settings.overlapMs;
  if (!Number.isFinite(start)) {
    throw new RangeError('horário do último alerta processado inválido');
  }
  return new Date(start).toISOString();
}

/**
 * Uma página: só alertas do módulo aws-s3, das fontes coletadas, a partir do nível mínimo, e só os do próprio manager
 * (`agent.id` 000), onde o módulo roda. Um alerta de agente numa instância do cliente com cara de evento da AWS (o log
 * é de quem usa a instância) fica com o sync dos agentes (`agentSyncPage`), nunca com este.
 */
export function syncPage(
  windowStart: string,
  cursor: AlertCursor | null,
  settings: SyncSettings,
): AlertSearch {
  return alertsAfter({
    cursor,
    since: windowStart,
    size: settings.pageSize,
    filters: [
      { field: 'data.integration', equals: 'aws' },
      { field: 'data.aws.source', oneOf: AWS_SOURCES },
      { field: 'rule.level', atLeast: settings.minLevel },
      { field: 'agent.id', equals: MANAGER_AGENT_ID },
    ],
  });
}

/**
 * Uma página dos alertas dos agentes nas instâncias do cliente: tudo o que não veio do manager (`agent.id` diferente
 * de 000), de qualquer módulo, a partir do nível mínimo (o dos agentes, `DEFAULT_AGENT_SYNC_SETTINGS`). As duas páginas
 * nunca trazem o mesmo alerta: a da AWS só lê os do manager, e esta só os outros.
 */
export function agentSyncPage(
  windowStart: string,
  cursor: AlertCursor | null,
  settings: SyncSettings,
): AlertSearch {
  return alertsAfter({
    cursor,
    since: windowStart,
    size: settings.pageSize,
    filters: [
      { field: 'agent.id', notEquals: MANAGER_AGENT_ID },
      { field: 'rule.level', atLeast: settings.minLevel },
    ],
  });
}

/**
 * Cursor da próxima página, a partir dos valores de ordenação do último resultado: o indexer devolve o horário em
 * milissegundos e o id. Vem da ordenação, e não do alerta, porque um alerta inválido também precisa ser pulado.
 */
export function cursorFromSort(sort: readonly unknown[]): AlertCursor {
  const [time, id] = sort;
  const ms =
    typeof time === 'number'
      ? time
      : typeof time === 'string' && /^\d{1,15}$/.test(time)
        ? Number(time)
        : NaN;
  if (!Number.isSafeInteger(ms) || typeof id !== 'string') {
    throw new RangeError('valores de ordenação do indexer fora do esperado');
  }
  return { timestamp: new Date(ms).toISOString(), id };
}
