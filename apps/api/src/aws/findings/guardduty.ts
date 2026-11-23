import { createHash } from 'node:crypto';
import { GetFindingsCommand, ListDetectorsCommand, ListFindingsCommand } from '@aws-sdk/client-guardduty';
import { toFindingDraft } from '../../alerts/finding-draft.js';
import { at, guardDutyAlertFields, type WazuhAwsAlert } from '../../alerts/wazuh-alert.js';
import type { DiscoveryClients } from '../discovery/clients.js';
import { isRecord, label, MAX_FINDING_RECORD_BYTES, recordBytes } from './finding-fields.js';
import { guardDutyRuleDescription, guardDutyWazuhRule } from './finding-keys.js';
import {
  type FindingsCaller,
  type FindingsPage,
  type FindingsWindow,
  INACTIVE,
  INVALID,
  nextTokenOf,
  type ParseOutcome,
} from './finding-records.js';

/**
 * GuardDuty pela API (tarefa `aws-findings`): `ListFindings` com o critério `updatedAt` (maior ou igual, em
 * milissegundos) e `service.archived = false`, 50 por página, e `GetFindings` com os IDs da página.
 *
 * O achado sai igual ao do caminho do bucket (o export para o S3, lido pelo Wazuh): o registro da API é o mesmo do
 * export, só com a primeira letra de cada campo em maiúscula. Aqui ele volta para o formato do export e passa pelas
 * mesmas regras do alerta do Wazuh (`guardDutyAlertFields` e `toFindingDraft`): os mesmos campos, a mesma origem
 * (`wazuh`) e a mesma chave (`wazuh/<conta>/guardduty:<id>:<regra>`, com a regra do Wazuh reproduzida em
 * `finding-keys.ts`). O que o módulo do Wazuh faz com o registro também é repetido:
 * - a lista de um item só vira o próprio item;
 * - a sondagem de porta com mais de um item em `portProbeDetails` vira um alerta por item (`/<IP>:<porta>` na chave), e
 *   a reincidência é uma só, pelo achado inteiro.
 *
 * O achado lido pela API não tem evento bruto no indexer (`rawEventId` fica vazio). O arquivado na origem fica de fora
 * da listagem; nada é fechado sozinho no painel.
 */

export const GUARDDUTY_PAGE_SIZE = 50;
/** Teto de itens de uma sondagem de porta que viram achado (um por IP e porta). */
const MAX_PORT_PROBE_ITEMS = 200;
const MAX_DEPTH = 24;
const MAX_LIST = 500;
const FINDING_ID = /^[A-Za-z0-9._:+/=-]{1,128}$/;

export interface GuardDutyTarget {
  region: string;
  detectorId: string;
}

export async function readGuardDutyPage(
  clients: DiscoveryClients,
  call: FindingsCaller,
  target: GuardDutyTarget,
  window: FindingsWindow,
  token: string | null,
): Promise<FindingsPage> {
  const client = clients.guardduty(target.region);
  const listed = await call('guardduty:ListFindings', () =>
    client.send(
      new ListFindingsCommand({
        DetectorId: target.detectorId,
        MaxResults: GUARDDUTY_PAGE_SIZE,
        ...(token !== null && { NextToken: token }),
        FindingCriteria: {
          Criterion: {
            updatedAt: { GreaterThanOrEqual: window.since.getTime() },
            'service.archived': { Equals: ['false'] },
          },
        },
      }),
    ),
  );
  const ids = (Array.isArray(listed.FindingIds) ? (listed.FindingIds as unknown[]) : [])
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 300)
    .slice(0, GUARDDUTY_PAGE_SIZE);
  const nextToken = nextTokenOf(listed.NextToken);
  if (ids.length === 0) return { records: [], nextToken };
  const got = await call('guardduty:GetFindings', () =>
    client.send(new GetFindingsCommand({ DetectorId: target.detectorId, FindingIds: ids })),
  );
  return { records: Array.isArray(got.Findings) ? got.Findings : [], nextToken };
}

/** O detector ainda existe na região? Conferido quando a listagem é recusada como pedido inválido. */
export async function guardDutyDetectorExists(
  clients: DiscoveryClients,
  call: FindingsCaller,
  target: GuardDutyTarget,
): Promise<boolean> {
  const listed = await call('guardduty:ListDetectors', () =>
    clients.guardduty(target.region).send(new ListDetectorsCommand({ MaxResults: 50 })),
  );
  return (Array.isArray(listed.DetectorIds) ? (listed.DetectorIds as unknown[]) : []).includes(
    target.detectorId,
  );
}

/**
 * O registro da API no formato do export: a primeira letra de cada campo em minúscula, a lista de um item só como o
 * próprio item (o que o módulo do Wazuh faz) e os horários em texto. Limitado em profundidade e em itens por lista.
 */
function toExportFormat(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_LIST).map((item) => toExportFormat(item, depth + 1));
    return items.length === 1 ? items[0] : items;
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key === '__proto__') continue;
    Object.defineProperty(out, key.charAt(0).toLowerCase() + key.slice(1), {
      value: toExportFormat(item, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** O registro com um item só da sondagem de porta, como o módulo do Wazuh o separa. */
function withProbeItem(aws: Record<string, unknown>, item: unknown): Record<string, unknown> {
  const service = isRecord(aws['service']) ? aws['service'] : {};
  const action = isRecord(service['action']) ? service['action'] : {};
  const probe = isRecord(action['portProbeAction']) ? action['portProbeAction'] : {};
  return {
    ...aws,
    service: { ...service, action: { ...action, portProbeAction: { ...probe, portProbeDetails: item } } },
  };
}

/** Um registro por item da sondagem de porta; os outros achados, um registro só. */
function variantsOf(aws: Record<string, unknown>): Record<string, unknown>[] {
  const items = at(aws, 'service', 'action', 'portProbeAction', 'portProbeDetails');
  if (!Array.isArray(items)) return [aws];
  // A lista vazia não diz nada: o achado segue sem os itens.
  if (items.length === 0) return [withProbeItem(aws, undefined)];
  return items.slice(0, MAX_PORT_PROBE_ITEMS).map((item) => withProbeItem(aws, item));
}

function probePort(aws: Record<string, unknown>): number | undefined {
  const port = at(
    aws,
    'service',
    'action',
    'portProbeAction',
    'portProbeDetails',
    'localPortDetails',
    'port',
  );
  return typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

/**
 * Um achado do `GetFindings`, conferido. Fora do formato (sem ID, sem severidade ou sem o horário da versão), o
 * registro é recusado: sem eles não há chave igual à do outro caminho, nem versão para comparar.
 */
export function parseGuardDutyFinding(raw: unknown): ParseOutcome {
  const bytes = recordBytes(raw);
  if (bytes === null || bytes > MAX_FINDING_RECORD_BYTES || !isRecord(raw)) return INVALID;
  const aws = toExportFormat(raw);
  if (!isRecord(aws)) return INVALID;
  if (at(aws, 'service', 'archived') === true) return INACTIVE;

  const variants = variantsOf(aws).map((variant) => ({
    aws: variant,
    fields: guardDutyAlertFields(variant),
  }));
  const [first] = variants;
  if (first === undefined) return INVALID;
  const id = aws['id'];
  const { awsSeverity, lastSeenAt, accounts } = first.fields;
  if (typeof id !== 'string' || !FINDING_ID.test(id)) return INVALID;
  if (awsSeverity === undefined || lastSeenAt === undefined) return INVALID;

  const actionType = label(at(aws, 'service', 'action', 'actionType'), 64);
  const title = label(aws['title'], 300) ?? first.fields.eventName ?? 'GuardDuty';
  const rule = guardDutyWazuhRule(awsSeverity, actionType);
  const alerts: WazuhAwsAlert[] = variants.map(({ aws: variant, fields }) => ({
    // Só entra na chave quando o item da sondagem de porta está fora do formato (sem ID nativo): o mesmo a cada leitura.
    id: `api-${createHash('sha256')
      .update(
        `${id}|${JSON.stringify(at(variant, 'service', 'action', 'portProbeAction', 'portProbeDetails') ?? null)}`,
      )
      .digest('hex')
      .slice(0, 40)}`,
    nativeId: fields.nativeId,
    findingId: id,
    timestamp: lastSeenAt,
    rule: {
      id: rule.id,
      level: rule.level,
      description: guardDutyRuleDescription({
        actionType,
        title,
        probe: { ip: fields.actor.ip, port: probePort(variant) },
      }),
      groups: [],
      mitre: { ids: [], tactics: [], techniques: [] },
    },
    source: 'guardduty',
    bucket: '',
    accounts: fields.accounts,
    region: fields.region,
    eventName: fields.eventName,
    awsSeverity,
    lastSeenAt,
    actor: fields.actor,
    resource: fields.resource,
  }));
  const [summary] = alerts;
  if (summary === undefined) return INVALID;

  return {
    ok: true,
    finding: {
      label: 'guardduty',
      nativeId: id,
      updatedAt: lastSeenAt,
      accounts,
      bytes,
      summary: { title: summary.rule.description, ruleId: rule.id, ruleLevel: rule.level },
      drafts: (owner) =>
        alerts.map((alert) => {
          const draft = toFindingDraft(alert, { owned: true, ...owner });
          // O evento bruto do detalhe é o do indexer do Wazuh; o achado lido pela API não tem um lá.
          delete draft.rawEventId;
          return draft;
        }),
    },
  };
}
