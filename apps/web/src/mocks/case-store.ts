import {
  CASE_PREVIEW_SAMPLES,
  CASE_QUEUES,
  type CaseDetail,
  type CaseFilterFields,
  type CaseGroup,
  type CaseGrouping,
  type CaseQueueName,
  type CaseSealReasonName,
  type CaseSort,
  type CaseState,
  type CaseSummary,
  type CaseTimeline,
  type Finding,
  type FindingDetail,
  FINDING_SEVERITIES,
  type FindingSeverity,
  MAX_CASE_GROUPS,
  MAX_RARE_VALUES,
  filterWindow,
  RADAR_CASES_LIMIT,
  RADAR_WINDOW_HOURS,
  radarSectorOf,
  type SummaryReport,
  type TowerCases,
  type TowerRadarCases,
} from '@verax/shared';
import { DEMO_STILL_ACTIVE } from './case-fixtures';

/**
 * Os casos da demonstração, montados dos mesmos alertas das outras telas: as contagens são calculadas na hora, então
 * triar um alerta em qualquer tela muda o caso. A chave é uma versão simples da da API (`case-key.ts`): o bastante para os
 * casos da demonstração parecerem os de verdade.
 */

export interface DemoCase {
  id: string;
  queue: CaseQueueName;
  family: string;
  title: string;
  keyParts: CaseSummary['keyParts'];
  sealedAt: string | null;
  sealReason: CaseSealReasonName | null;
  previousCaseId: string | null;
  recurrence: number;
  /** Promovido inteiro: o incidente dele. */
  incidentId: string | null;
  findingIds: Set<string>;
}

/** Um incidente como o radar de casos precisa dele. */
export interface DemoRadarIncident {
  id: string;
  open: boolean;
  severity: FindingSeverity;
}

interface Key {
  queue: CaseQueueName;
  family: string;
  title: string;
  parts: CaseSummary['keyParts'];
  group: string | null;
}

const part = (name: string, value: string | null | undefined): CaseSummary['keyParts'] =>
  value ? [{ name, value }] : [];

const PACKAGE_MARK = ' - ';

function keyOf(finding: FindingDetail): Key {
  const high = finding.severity === 'critical' || finding.severity === 'high';
  const rule = part('rule', finding.ruleId);
  const detection = (family: string, title: string, fine: CaseSummary['keyParts']): Key => ({
    queue: 'detection',
    family,
    title,
    parts: high ? fine : rule,
    group: null,
  });
  const actorOrResource = part('actor', finding.actor.user).concat(
    finding.actor.user ? [] : part('resource', finding.resource),
  );
  switch (finding.source) {
    case 'inspector': {
      const mark = finding.title.lastIndexOf(PACKAGE_MARK);
      const name = mark > 0 ? finding.title.slice(mark + PACKAGE_MARK.length) : null;
      return {
        queue: 'vulnerability',
        family: name ? 'package' : 'code',
        title: name ? 'Vulnerabilidade em pacote' : 'Vulnerabilidade no código',
        parts: [...part('package', name), ...part('resource', finding.resource)],
        group: name,
      };
    }
    case 'security_hub': {
      const control = finding.eventName ?? '';
      const service = control.split('.')[0] ?? control;
      return {
        queue: 'posture',
        family: 'control',
        title: 'Controle de segurança reprovado',
        parts: high ? part('control', control) : part('service', service),
        group: finding.resource,
      };
    }
    case 'guardduty':
      return detection('guardduty', 'Ameaça acusada pelo GuardDuty', [
        ...part('type', finding.eventName),
        ...part(finding.resource ? 'resource' : 'actor', finding.resource ?? finding.actor.user),
      ]);
    case 'waf':
      return detection('waf', 'Ataques web acusados pelo WAF', [
        ...rule,
        ...part('resource', finding.resource),
      ]);
    case 'gcp_audit':
      return detection('gcp-audit', 'Atividade suspeita no projeto da GCP', [...rule, ...actorOrResource]);
    case 'wazuh_agent':
      return detection('host', 'Atividade suspeita numa instância', [
        ...rule,
        ...part('resource', finding.resource),
      ]);
    default:
      // Na demonstração, o título de cada regra da AWS é fixo, como o do dicionário da API.
      return detection('cloudtrail', finding.title, [...rule, ...actorOrResource]);
  }
}

const uuid = (number: number): string =>
  `018f2c1e-0000-7000-8000-${(0xca5e00000 + number).toString(16).padStart(12, '0')}`;

const PENDING: ReadonlySet<string> = new Set(['new', 'investigating']);
export const isPending = (finding: Pick<Finding, 'status' | 'incidentId'>): boolean =>
  finding.incidentId === null && PENDING.has(finding.status);

const noPending = () => ({ critical: 0, high: 0, medium: 0, low: 0 });
const BRASILIA_MS = 3 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Um caso tratado há mais tempo que isto não recebe os alertas seguintes (a janela da detecção). */
const WINDOW_MS = 7 * DAY_MS;

export class DemoCases {
  readonly cases: DemoCase[] = [];
  private readonly caseOfFinding = new Map<string, string>();
  readonly groupOfFinding = new Map<string, string | null>();
  private sequence = 0;

  constructor(
    /** Os alertas do cliente, os mesmos (o mesmo array) das outras telas. */
    readonly findings: FindingDetail[],
    private readonly protectedIdentifiers: readonly string[],
  ) {
    const open = new Map<string, DemoCase>();
    // Do mais antigo para o mais recente: o caso tratado e distante fica para trás, e a chave volta em outro.
    for (const finding of [...findings].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
      const key = keyOf(finding);
      const id = JSON.stringify([key.queue, key.family, key.title, finding.accountId, key.parts]);
      let current = open.get(id);
      const last = current && this.lastSeen(current);
      if (
        current &&
        last !== undefined &&
        key.queue === 'detection' &&
        Date.parse(finding.occurredAt) - Date.parse(last) > WINDOW_MS
      ) {
        current.sealedAt = last;
        current.sealReason = this.hasPending(current) ? 'window' : 'treated';
        current = this.open(key, current);
        open.set(id, current);
      } else if (!current) {
        current = this.open(key, null);
        open.set(id, current);
      }
      this.put(current, finding, key.group);
    }
  }

  private open(key: Key, previous: DemoCase | null): DemoCase {
    const created: DemoCase = {
      id: uuid((this.sequence += 1)),
      queue: key.queue,
      family: key.family,
      title: key.title,
      keyParts: key.parts,
      sealedAt: null,
      sealReason: null,
      previousCaseId: previous?.id ?? null,
      recurrence: previous === null ? 0 : previous.recurrence + 1,
      incidentId: null,
      findingIds: new Set(),
    };
    this.cases.push(created);
    return created;
  }

  private put(target: DemoCase, finding: FindingDetail, group: string | null): void {
    target.findingIds.add(finding.id);
    this.caseOfFinding.set(finding.id, target.id);
    this.groupOfFinding.set(finding.id, group);
  }

  byId(id: string): DemoCase | undefined {
    return this.cases.find((candidate) => candidate.id === id.toLowerCase());
  }

  /** Os alertas de um caso, do mais recente para trás. */
  findingsOf(target: DemoCase): FindingDetail[] {
    return this.findings
      .filter((finding) => target.findingIds.has(finding.id))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
  }

  private lastSeen(target: DemoCase): string | undefined {
    return this.findingsOf(target)[0]?.occurredAt;
  }
  private hasPending(target: DemoCase): boolean {
    return this.findingsOf(target).some(isPending);
  }

  /** Alertas que chegaram agora na chave de um caso (a demonstração do conjunto que mudou). */
  addTo(target: DemoCase, count: number, template: FindingDetail): void {
    for (let index = 0; index < count; index += 1) {
      const finding: FindingDetail = {
        ...structuredClone(template),
        id: uuid(0x80000 + (this.sequence += 1)),
        status: 'new',
        incidentId: null,
        comments: [],
        commentCount: 0,
        occurredAt: new Date(Date.now() - DAY_MS * 1.2 - index * 60_000).toISOString(),
      };
      this.findings.push(finding);
      this.put(target, finding, this.groupOfFinding.get(template.id) ?? null);
    }
    this.findings.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  /** Divide: os alertas escolhidos vão para um caso novo, que nasce selado. */
  split(target: DemoCase, ids: ReadonlySet<string>, now: string): DemoCase {
    const created: DemoCase = {
      ...target,
      id: uuid((this.sequence += 1)),
      sealedAt: now,
      sealReason: 'split',
      previousCaseId: target.id,
      incidentId: null,
      findingIds: new Set(ids),
    };
    for (const id of ids) {
      target.findingIds.delete(id);
      this.caseOfFinding.set(id, created.id);
    }
    this.cases.push(created);
    return created;
  }

  private touchesProtected(findings: readonly FindingDetail[]): boolean {
    return findings.some((finding) =>
      [finding.resource, finding.actor.user, finding.actor.ip].some(
        (value) =>
          value !== null &&
          this.protectedIdentifiers.some(
            (item) => value === item || value.endsWith(`:${item}`) || value.endsWith(`/${item}`),
          ),
      ),
    );
  }

  summary(target: DemoCase): CaseSummary {
    const findings = this.findingsOf(target);
    const pending = noPending();
    const counts = {
      total: findings.length,
      new: 0,
      investigating: 0,
      legitimate: 0,
      resolved: 0,
      incident: 0,
    };
    for (const finding of findings) {
      if (finding.incidentId !== null) counts.incident += 1;
      else counts[finding.status] += 1;
      if (isPending(finding)) pending[finding.severity] += 1;
    }
    const unique = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => v !== null))];
    const head = (values: (string | null)[]) => unique(values).slice(0, CASE_PREVIEW_SAMPLES);
    const last = findings[0]?.occurredAt ?? new Date(0).toISOString();
    const first = findings.at(-1)?.occurredAt ?? last;
    return {
      id: target.id,
      queue: target.queue,
      family: target.family,
      title: target.title,
      keyParts: target.keyParts,
      sources: unique(findings.map((finding) => finding.source)) as CaseSummary['sources'],
      severity: FINDING_SEVERITIES.find((severity) => pending[severity] > 0) ?? null,
      protected: this.touchesProtected(findings),
      pending,
      counts,
      sealedAt: target.sealedAt,
      sealReason: target.sealReason,
      recurrence: target.recurrence,
      recurrenceTreated: this.treatedBefore(target),
      openedAt: first,
      firstSeenAt: first,
      lastSeenAt: last,
      lastAlertAt: last,
      preview: {
        accounts: head(findings.map((finding) => finding.accountId)),
        actors: head(findings.map((finding) => finding.actor.user)),
        ips: head(findings.map((finding) => finding.actor.ip)),
        resources: head(findings.map((finding) => finding.resource)),
      },
      mitreTactics: unique(findings.flatMap((finding) => finding.mitreTactics)).slice(0, 20),
    };
  }

  /** Das voltas, quantas foram depois de o caso anterior ter sido tratado. */
  private treatedBefore(target: DemoCase): number {
    const before = target.previousCaseId === null ? undefined : this.byId(target.previousCaseId);
    if (!before) return 0;
    return (before.sealReason === 'treated' ? 1 : 0) + this.treatedBefore(before);
  }

  /** Os casos pendentes por fila e pior severidade, como o resumo da situação os conta. */
  pendingByQueue(): TowerCases {
    const result: TowerCases = {
      detection: noPending(),
      vulnerability: noPending(),
      posture: noPending(),
      oldestPendingAt: { detection: null, vulnerability: null, posture: null },
    };
    for (const target of this.cases) {
      const row = this.summary(target);
      if (row.severity === null) continue;
      result[row.queue][row.severity] += 1;
      const oldest = result.oldestPendingAt[row.queue];
      if (oldest === null || row.openedAt < oldest) result.oldestPendingAt[row.queue] = row.openedAt;
    }
    return result;
  }

  /** O que falta validar, pelos casos: cada alerta alto ou crítico em "novo" num lugar só. */
  validation(): { cases: number; vulnerabilityCases: number; uncovered: number } {
    const serious = this.findings.filter(
      ({ status, severity }) => status === 'new' && (severity === 'critical' || severity === 'high'),
    );
    const covered = serious.filter(({ incidentId }) => incidentId === null);
    const ids = new Set(covered.map(({ id }) => this.caseOfFinding.get(id)));
    const queues = [...ids].map((id) => this.cases.find((row) => row.id === id)?.queue);
    const vulnerabilityCases = queues.filter((queue) => queue === 'vulnerability').length;
    return {
      cases:
        queues.filter((queue) => CASE_QUEUES.some((known) => known === queue)).length - vulnerabilityCases,
      vulnerabilityCases,
      uncovered: serious.length - covered.length,
    };
  }

  /** Os casos de detecção do radar, os mais graves primeiro. */
  radar(incidents: readonly DemoRadarIncident[], now: Date): TowerRadarCases {
    const since = new Date(now.getTime() - RADAR_WINDOW_HOURS * HOUR_MS).toISOString();
    const until = now.toISOString();
    const recentOf = (target: DemoCase) =>
      this.findingsOf(target).filter(({ occurredAt }) => occurredAt >= since && occurredAt <= until).length;
    const active = this.list(
      { queue: 'detection', state: 'all', sort: 'priority', from: since, to: until },
      now,
    ).flatMap((row) => {
      const target = this.byId(row.id);
      if (!target) return [];
      const own = new Set(this.findingsOf(target).map(({ incidentId }) => incidentId));
      const open = incidents
        .filter((incident) => incident.open && own.has(incident.id))
        .sort((a, b) => FINDING_SEVERITIES.indexOf(a.severity) - FINDING_SEVERITIES.indexOf(b.severity))[0];
      const incident = open ?? incidents.find(({ id }) => id === target.incidentId) ?? null;
      return [{ row, incident, recent: recentOf(target) }];
    });
    const rank = ({ row, incident }: (typeof active)[number]) =>
      Math.min(
        row.severity === null ? FINDING_SEVERITIES.length : FINDING_SEVERITIES.indexOf(row.severity),
        incident?.open ? FINDING_SEVERITIES.indexOf(incident.severity) : FINDING_SEVERITIES.length,
      );
    return {
      total: active.length,
      alerts: active.reduce((sum, { recent }) => sum + recent, 0),
      limit: RADAR_CASES_LIMIT,
      items: active
        .sort((a, b) => rank(a) - rank(b))
        .slice(0, RADAR_CASES_LIMIT)
        .map(({ row, incident, recent }) => ({
          id: row.id,
          title: row.title,
          severity: row.severity,
          sources: row.sources,
          sector: radarSectorOf(row.sources[0] ?? 'cloudtrail'),
          total: row.counts.total,
          pending: row.counts.new + row.counts.investigating,
          recent,
          lastActivityAt: row.lastSeenAt > until ? until : row.lastSeenAt,
          incident,
        })),
    };
  }

  /** Os casos abertos num período e em que pé estão. Na demonstração, todo alerta é triado 42 minutos depois. */
  outcomes(from: string, to: string): NonNullable<SummaryReport['cases']> {
    const opened = this.cases
      .map((target) => ({ target, row: this.summary(target) }))
      .filter(({ row }) => row.counts.total > 0 && row.openedAt >= from && row.openedAt <= to);
    const treated = opened.filter(({ row }) => row.severity === null);
    const minutes = treated
      .map(({ row }) => (Date.parse(row.lastSeenAt) - Date.parse(row.openedAt)) / 60_000 + 42)
      .sort((a, b) => a - b);
    const middle = Math.floor(minutes.length / 2);
    const median =
      minutes.length % 2 === 1 ? minutes[middle] : ((minutes[middle - 1] ?? 0) + (minutes[middle] ?? 0)) / 2;
    return {
      opened: opened.length,
      treated: treated.length,
      pending: opened.length - treated.length,
      medianMinutesToTreat: minutes.length === 0 ? null : Math.round(median ?? 0),
    };
  }

  /** Quantos casos têm alerta de cada tática num período. */
  casesByTactic(from: string, to: string): Map<string, number> {
    const ids = new Map<string, Set<string>>();
    for (const finding of this.findings) {
      const id = this.caseOfFinding.get(finding.id);
      if (id === undefined || finding.occurredAt < from || finding.occurredAt > to) continue;
      for (const tactic of finding.mitreTactics) ids.set(tactic, (ids.get(tactic) ?? new Set()).add(id));
    }
    return new Map([...ids].map(([tactic, cases]) => [tactic, cases.size]));
  }

  private groupValue(row: CaseSummary, by: CaseGrouping): string | null {
    if (by === 'account') return row.preview.accounts[0] ?? null;
    return row.keyParts.find(({ name }) => name === by)?.value ?? null;
  }

  /** Os casos de um filtro da lista, com a mesma regra da API. */
  matching(filter: CaseFilterFields & { state: CaseState }, now: Date = new Date()): DemoCase[] {
    return this.rows(filter, now).map(({ target }) => target);
  }

  private rows(filter: CaseFilterFields & { state: CaseState }, now: Date) {
    const window = filterWindow(filter, now);
    const needle = filter.q?.toLowerCase();
    return this.cases.flatMap((target) => {
      const row = this.summary(target);
      if (row.counts.total === 0) return [];
      const pending = row.counts.new + row.counts.investigating;
      if (filter.queue && row.queue !== filter.queue) return [];
      if (filter.state === 'pending' && pending === 0) return [];
      if (filter.state === 'investigating' && row.counts.investigating === 0) return [];
      if (filter.state === 'treated' && pending > 0) return [];
      if (filter.severity && row.pending[filter.severity] === 0) return [];
      if (filter.source && !row.sources.includes(filter.source)) return [];
      const findings = this.findingsOf(target);
      if (filter.accountId && !findings.some((finding) => finding.accountId === filter.accountId)) return [];
      if (filter.tactic && !row.mitreTactics.includes(filter.tactic)) return [];
      if (
        filter.technique &&
        !findings.some((finding) => finding.mitreTechniques.includes(filter.technique ?? ''))
      ) {
        return [];
      }
      if (window.from && row.lastSeenAt < window.from.toISOString()) return [];
      if (window.to && row.firstSeenAt > window.to.toISOString()) return [];
      if (needle) {
        const texts = [
          row.title,
          ...row.keyParts.map(({ value }) => value),
          ...Object.values(row.preview).flat(),
          ...findings.flatMap((finding) => [finding.actor.user, finding.actor.ip, finding.resource]),
        ];
        if (!texts.some((value) => value?.toLowerCase().includes(needle))) return [];
      }
      if (filter.groupBy && this.groupValue(row, filter.groupBy) !== (filter.group ?? null)) return [];
      return [{ target, row }];
    });
  }

  list(
    filter: CaseFilterFields & { state: CaseState; sort: CaseSort },
    now: Date = new Date(),
  ): CaseSummary[] {
    const rank = (severity: FindingSeverity | null) =>
      severity === null ? FINDING_SEVERITIES.length : FINDING_SEVERITIES.indexOf(severity);
    const pendingOf = (row: CaseSummary) => row.counts.new + row.counts.investigating;
    return this.rows(filter, now)
      .map(({ row }) => row)
      .sort((a, b) => {
        const recent = b.lastAlertAt.localeCompare(a.lastAlertAt) || b.id.localeCompare(a.id);
        if (filter.sort === 'recent') return recent;
        if (filter.sort === 'volume') {
          return pendingOf(b) - pendingOf(a) || b.counts.total - a.counts.total || recent;
        }
        return rank(a.severity) - rank(b.severity) || Number(b.protected) - Number(a.protected) || recent;
      });
  }

  groups(
    by: CaseGrouping,
    filter: {
      state: 'pending' | 'investigating';
      severity?: FindingSeverity | undefined;
      accountId?: string | undefined;
      q?: string | undefined;
    },
    now: Date = new Date(),
  ): CaseGroup[] {
    const { q, ...rest } = filter;
    const groups = new Map<string | null, CaseGroup>();
    for (const { row } of this.rows({ ...rest, queue: 'vulnerability' }, now)) {
      const value = this.groupValue(row, by);
      if (q && !(value ?? '').toLowerCase().includes(q.toLowerCase())) continue;
      const group = groups.get(value) ?? { value, cases: 0, pending: noPending() };
      group.cases += 1;
      for (const severity of FINDING_SEVERITIES) group.pending[severity] += row.pending[severity];
      groups.set(value, group);
    }
    const total = (group: CaseGroup) =>
      FINDING_SEVERITIES.reduce((sum, severity) => sum + group.pending[severity], 0);
    return [...groups.values()].sort((a, b) => {
      for (const severity of FINDING_SEVERITIES) {
        const difference = Number(b.pending[severity] > 0) - Number(a.pending[severity] > 0);
        if (difference !== 0) return difference;
      }
      return total(b) - total(a) || (a.value ?? '').localeCompare(b.value ?? '');
    });
  }

  /** O detalhe, menos as operações e o que a pessoa pode fazer (são do motor e da sessão). */
  detail(
    target: DemoCase,
    incidentOf: (id: string) => Pick<CaseDetail['incidents'][number], 'status' | 'severity'> | undefined,
  ): Omit<CaseDetail, 'operations' | 'can'> {
    const findings = this.findingsOf(target);
    const unique = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => v !== null))];
    const rare = (values: (finding: FindingDetail) => string | null) => {
      const found = new Map<string, { value: string; count: number; lastSeenAt: string }>();
      for (const finding of findings) {
        const value = values(finding);
        if (value === null) continue;
        const entry = found.get(value) ?? { value, count: 0, lastSeenAt: finding.occurredAt };
        entry.count += 1;
        if (finding.occurredAt > entry.lastSeenAt) entry.lastSeenAt = finding.occurredAt;
        found.set(value, entry);
      }
      const sorted = [...found.values()].sort(
        (a, b) => a.count - b.count || b.lastSeenAt.localeCompare(a.lastSeenAt),
      );
      return { distinct: sorted.length, values: sorted.slice(0, MAX_RARE_VALUES) };
    };
    const groups = new Map<string, { value: string; total: number; pending: ReturnType<typeof noPending> }>();
    for (const finding of findings) {
      const value = this.groupOfFinding.get(finding.id) ?? null;
      if (value === null) continue;
      const group = groups.get(value) ?? { value, total: 0, pending: noPending() };
      group.total += 1;
      if (isPending(finding)) group.pending[finding.severity] += 1;
      groups.set(value, group);
    }
    const incidents = new Map<string, number>(target.incidentId === null ? [] : [[target.incidentId, 0]]);
    for (const { incidentId } of findings) {
      if (incidentId !== null) incidents.set(incidentId, (incidents.get(incidentId) ?? 0) + 1);
    }
    const previous: CaseDetail['previous'] = [];
    for (
      let before = target.previousCaseId === null ? undefined : this.byId(target.previousCaseId);
      before && previous.length < 10;
      before = before.previousCaseId === null ? undefined : this.byId(before.previousCaseId)
    ) {
      const row = this.summary(before);
      previous.push({
        id: row.id,
        openedAt: row.openedAt,
        sealedAt: row.sealedAt,
        sealReason: row.sealReason,
        lastAlertAt: row.lastAlertAt,
        pending: row.counts.new + row.counts.investigating,
        counts: row.counts,
      });
    }
    return {
      ...this.summary(target),
      samples: {
        ruleIds: unique(findings.map((finding) => finding.ruleId)).slice(0, 20),
        accounts: unique(findings.map((finding) => finding.accountId)).slice(0, 50),
        actors: unique(findings.map((finding) => finding.actor.user)).slice(0, 20),
        ips: unique(findings.map((finding) => finding.actor.ip)).slice(0, 20),
        resources: unique(findings.map((finding) => finding.resource)).slice(0, 20),
        mitreTechniques: unique(findings.flatMap((finding) => finding.mitreTechniques)).slice(0, 50),
      },
      analysis: {
        alerts: findings.length,
        complete: true,
        rare: { ips: rare((finding) => finding.actor.ip), users: rare((finding) => finding.actor.user) },
        groups: {
          distinct: groups.size,
          values: [...groups.values()]
            .sort((a, b) => {
              for (const severity of FINDING_SEVERITIES) {
                const difference = b.pending[severity] - a.pending[severity];
                if (difference !== 0) return difference;
              }
              return b.total - a.total || a.value.localeCompare(b.value);
            })
            .slice(0, MAX_CASE_GROUPS),
        },
        stillActive: findings.filter((finding) => this.stillActive(finding)).length,
      },
      previous,
      incidents: [...incidents].flatMap(([id, alerts]) => {
        const incident = incidentOf(id);
        return incident === undefined
          ? []
          : [{ id, ...incident, alerts, promoted: id === target.incidentId }];
      }),
    };
  }

  stillActive(finding: FindingDetail): boolean {
    return (
      finding.incidentId === null &&
      finding.status === 'resolved' &&
      finding.eventName !== null &&
      DEMO_STILL_ACTIVE.has(finding.eventName)
    );
  }

  /** A linha do tempo: por hora até 7 dias; além disso, por dia de Brasília. */
  timeline(target: DemoCase): CaseTimeline {
    const findings = this.findingsOf(target);
    const newest = findings[0];
    const oldest = findings.at(-1);
    if (!newest || !oldest)
      return { granularity: 'hour', from: null, to: null, truncated: false, buckets: [] };
    const span = Date.parse(newest.occurredAt) - Date.parse(oldest.occurredAt);
    const daily = span > 7 * DAY_MS;
    const size = daily ? DAY_MS : HOUR_MS;
    const floor = (at: string) =>
      daily
        ? Math.floor((Date.parse(at) - BRASILIA_MS) / size) * size + BRASILIA_MS
        : Math.floor(Date.parse(at) / size) * size;
    const from = floor(oldest.occurredAt);
    const to = floor(newest.occurredAt) + size;
    const buckets = Array.from({ length: (to - from) / size }, (_, index) => ({
      at: new Date(from + index * size).toISOString(),
      ...noPending(),
    }));
    for (const finding of findings) {
      const bucket = buckets[(floor(finding.occurredAt) - from) / size];
      if (bucket) bucket[finding.severity] += 1;
    }
    return {
      granularity: daily ? 'day' : 'hour',
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      truncated: false,
      buckets,
    };
  }
}
