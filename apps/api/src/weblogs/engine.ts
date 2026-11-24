import { matchesExpectation, parseAlbKey } from './alb/alb-key.js';
import { ClientClassifier } from './client-class.js';
import type { ProviderRanges } from './data/proxy-ranges.js';
import { DAY_MS, NoiseDigest, type DigestState } from './digest.js';
import { hitIdentity, toWebFindingDraft, type WebFindingDraft, type WebSource } from './draft.js';
import { type EvidenceNote, MAX_EVIDENCE_CLIENTS } from './evidence.js';
import { KeyedHash } from './hash.js';
import { ipOfClientKey } from './ip.js';
import {
  CLOSE_DELAY_MS,
  DEFAULT_LIMITS,
  FUTURE_TOLERANCE_MS,
  KEEP_SLOTS,
  LONG_SLOTS,
  SHORT_SLOTS,
  SLOT_MS,
  type WebLimits,
} from './limits.js';
import { RouteTable, type WebRoute } from './routes.js';
import {
  emptyCounters,
  evaluateWindow,
  NOISE_RULES,
  STEP_ITEMS,
  SUPPRESSIBLE_RULES,
  UNFOLDED_RULES,
  type WebHit,
  type WebRuleId,
  type WindowView,
} from './rules.js';
import { type ClientRef, type LineOutcome, type Slot, type TallyCounters, WebTally } from './tally.js';
import { TrustedSources, type WebTrustedSource } from './trusted-sources.js';

/**
 * Motor de detecção de ataques web pelos logs de acesso do ALB (PR-1 do desenho de 24/11/2026): puro, sem banco, sem AWS e
 * sem relógio próprio. Um motor por balanceador. A tarefa (PR-4) abre um objeto (`openObject`), passa as linhas
 * (`ingest`), e a cada passo chama `evaluate(agora)`, que devolve os achados prontos (`draft.ts`) e os contadores.
 * Não está ligado a nada.
 *
 * **Determinismo:** a mesma sequência de linhas, o mesmo `agora` e a mesma chave de hash dão o mesmo resultado. Reavaliar
 * não soma duas vezes: a chave do achado é a mesma, e quem dedupica é o `FindingStore`.
 *
 * **O que o atacante controla e o que isso pode fazer** (o que foi fechado está no módulo citado; o que não dá, aqui):
 *
 * - _Some da análise?_ Aspa, barra invertida ou campos falsos no User-Agent não descartam a linha (`alb-line.ts`). Método
 *   inventado, maiúsculas, `%XX`, `//`, `/./`, `;x=1`, `\`, NUL, `%3F` e PATH_INFO não mudam o caminho que casa (`path.ts`,
 *   `login-paths.ts`). Data no futuro no nome do objeto não empurra a janela (`openObject`). Encher a memória com IPs, /64,
 *   hosts, rotas de login, caminhos ou respostas não tira quem tem mais contagem, e quem chega sempre tem lugar (`tally.ts`);
 *   quem sai das rotas de login continua na conta da distribuída, uma vez só e com a soma inteira (`evicted.ts`).
 * - _Rebaixa o achado?_ Misturar requisições que o WAF barra não rebaixa o que passou; um cliente barulhento não desliga a
 *   distribuída; o próprio acerto não vira cara de NAT; o tamanho da página inicial visto só pelo atacante não suprime a
 *   resposta dele, se alguém mais pediu a página; a escalada de nível é um achado novo (`draft.ts`).
 * - _Fabrica identidade?_ O log do ALB não tem `X-Forwarded-For`; o host só vale quando o SNI casou com um certificado.
 * - _Grava o que não devia?_ A query não chega à contagem; o caminho sai mascarado; o User-Agent da linha ambígua (que pode
 *   ser um pedaço de query) não vira amostra; e o schema da evidência recusa o que escapar (`evidence.ts`).
 *
 * **Limites que ficam** (dizer ao cliente, não esconder):
 *
 * 1. **Lento ou espalhado:** 19 falhas ou 9 sondas a cada 15 min, ou um /64 (IPv6) por tentativa, não passam de nenhum
 *    limite. A regra por /24 e /48 em 24 h é a 990408 (fase 2). A 990407 só vê o que passa de 500 falhas em 15 min por
 *    host e rota: com certificado curinga, até 50 subdomínios por slot somam à parte, e a linha sem SNI (ou ambígua) também.
 * 2. **Atrás de CDN ou proxy**, ou com a lista de faixas vazia (`data/proxy-ranges.ts`, o caso de hoje): as regras por IP
 *    ficam desligadas. Só a 990403 e a 990407 seguem, sem IP.
 * 3. **Login que responde sempre 200**, por GraphQL, por GET (Basic) ou com nome fora da lista: só volume, ou nada, até o
 *    cliente declarar a rota. Sem configuração e sem o perfil de 7 dias (fase 2), uma rota só "distingue" falha de sucesso
 *    depois de 5 recusas da aplicação (que não 429) em 60 min.
 * 4. **Razões diluíveis:** a 990404 cala se o atacante misturar 40% de páginas que existem, e a razão da 990405, se ele
 *    alternar com logins próprios que dão certo (aí a 990406 pega). A cara de NAT (25 User-Agents e 5 logins próprios
 *    numa rota em que acerta tanto quanto erra) multiplica os limites por 5, nunca mais que isso.
 * 5. **Catch-all:** num site que responde 200 a tudo refletindo o caminho, dá para igualar tamanhos e suprimir a 990403 de
 *    propósito; num host em que ninguém mais pede a página inicial, o tamanho dela pode ser fabricado. O suprimido é
 *    contado (`catchAllSuppressed`). `bytes` tem os cabeçalhos: um 200 de corpo vazio conta como resposta.
 * 6. **Sucesso noutro lugar:** senha achada por um IP e usada por outro, ou mais de 10 minutos depois, não é 990406.
 * 7. **Teto por regra e janela:** 10 achados por IP (os de maior nível e contagem) e um resumo `*`. Com mais de 10 IPs
 *    mais barulhentos que o atacante, ele sai no resumo, entre os 20 maiores. A 990403 e a 990406 não são dobradas (até
 *    100). Um site que reflete o caminho deixa o atacante encher os 500 grupos de respostas do slot: sai barulho de nível
 *    10, e uma resposta de verdade pode ficar de fora dele (`counts_are_floor`).
 * 8. **No teto de rotas de login**, a força bruta pode se dividir entre a rota própria e a comum: a detecção vem com até o
 *    dobro de falhas.
 * 9. **No teto de pares de login**, a 990405 e a 990406 de quem saiu recomeçam do zero (piso). A 990407, não; mas, se o
 *    registro de quem saiu encher (da ordem de 65 mil clientes na janela com uma fonte só, 4 mil com o piso de muitas
 *    fontes), ela conta uma amostra: as falhas e os endereços são estimados (erro de até uns 18% com 30 clientes na
 *    amostra, para mais ou para menos), e os 30 distintos são exigidos **na amostra**. Um ataque de 100 endereços no meio
 *    de uma enchente desse tamanho, na mesma rota e de clientes com mais de 20 falhas cada, pode não aparecer como 990407
 *    (a enchente aparece como 990405). O mesmo cliente dividido entre hosts, ou entre a rota própria e a comum, tem somas
 *    separadas, e pode contar como discreto nas duas.
 * 10. **Troca de configuração:** quando um endereço deixa de ser proxy, o que foi contado antes não acusa ninguém (até 60
 *    minutos sem história). O achado já entregue não volta atrás, e o resumo do dia que fica sem ninguém não é reescrito. A
 *    validade das fontes confiáveis e dos proxies só é olhada em `configure`.
 * 11. **Caminho mascarado na dúvida:** um nome próprio num segmento comum não é reconhecível (`path.ts`). Codificação dupla
 *    (`%252e`) e UTF-8 longo demais (`%c0%ae`) não são decodificados.
 * 12. **Entrega da AWS é "melhor esforço":** linha que não chegou não existe. Não é contabilidade completa.
 */
export interface EngineOptions {
  source: WebSource;
  /** 16 bytes aleatórios por processo. */
  hashKey: Uint8Array;
  now: number;
  /** O prefixo do bucket; vazio sem prefixo. */
  prefix?: string;
  limits?: WebLimits;
  routes?: readonly WebRoute[];
  trusted?: readonly WebTrustedSource[];
  /** Só os testes: as faixas das CDNs no lugar das vendorizadas. */
  ranges?: readonly ProviderRanges[];
}

export interface EvaluateInput {
  now: number;
  /** A fonte do WAF da conta está `collecting`. */
  wafCollecting?: boolean;
  /** Mediana de falhas por 15 min nos 7 dias anteriores, por `baselineKey` (PR-9). */
  baselines?: ReadonlyMap<string, number>;
}

export const ENGINE_NOTES = [
  'behind_proxy',
  'proxy_ranges_stale',
  'proxy_ranges_unavailable',
  'trusted_rejected',
  'truncated',
] as const;
export type EngineNote = (typeof ENGINE_NOTES)[number];

export interface EvaluateResult {
  /** Os que nunca são dobrados primeiro; o resumo do dia por último. */
  drafts: WebFindingDraft[];
  notes: EngineNote[];
  /** Acumulados desde o começo do motor. */
  counters: TallyCounters;
  /** Desta avaliação: o que a fonte confiável calou, por fonte e regra. */
  suppressed: { sourceId: string; rule: WebRuleId; clients: number }[];
  /** Respostas a sondas tidas como catch-all, na maior das janelas avaliadas. */
  catchAllSuppressed: number;
  /** O que veio de quem não é `direct`, na última hora: sem regra por IP, só a contagem. */
  unkeyed: { requests: number; tool: number; probes: number; errors: number; loginFailures: number };
  /** O último slot fechado: objeto dele em diante, para trás, é atrasado. */
  closedThrough: number | null;
}

export type OpenResult =
  | { ok: true; late: boolean; slot: Slot; key: string }
  | { ok: false; reason: 'bad_key' | 'foreign_key' | 'future' | 'late_backlog' };

/** Objetos atrasados guardados até a próxima avaliação. */
const MAX_LATE_SLOTS = 12;
const MAX_PEAKS = 2_000;
/** Achados montados entre um passo e outro. */
const STEP_DRAFTS = 10;
export const MAX_FINDINGS_PER_RULE = 10;
export const MAX_UNFOLDED_FINDINGS = 100;

export class WebLogEngine {
  private readonly source: WebSource;
  private readonly prefix: string;
  private readonly tally: WebTally;
  private readonly digest: NoiseDigest;
  private readonly ranges: readonly ProviderRanges[] | undefined;
  private trusted: TrustedSources;
  private classifier: ClientClassifier;
  private closedThrough: number | null = null;
  private readonly peaks = new Map<string, { level: number; lastMs: number; client: string | null }>();

  constructor(options: EngineOptions) {
    const limits = options.limits ?? DEFAULT_LIMITS;
    this.source = options.source;
    this.prefix = options.prefix ?? '';
    this.ranges = options.ranges;
    this.trusted = new TrustedSources(options.trusted ?? [], options.now);
    this.classifier = this.classifierFor(options.now);
    this.tally = new WebTally({
      loadBalancer: options.source.loadBalancer,
      hash: new KeyedHash(options.hashKey),
      limits,
      routes: new RouteTable(options.routes ?? []),
      classifier: this.classifier,
    });
    this.digest = new NoiseDigest(limits.maxDayClients);
  }

  private classifierFor(now: number): ClientClassifier {
    return new ClientClassifier({
      now,
      proxies: this.trusted.proxies,
      ...(this.ranges !== undefined && { ranges: this.ranges }),
    });
  }

  /**
   * Troca a configuração do cliente. As rotas valem para as linhas seguintes; as fontes confiáveis e os proxies, já na
   * próxima avaliação, para tudo o que está na memória (`WebTally.reconcile`): o resumo do dia, a barra e o maior nível de
   * cada achado esquecem quem deixou de ser direto. O achado já entregue não volta atrás. Não pode ser chamada entre os
   * passos de uma avaliação. A validade das fontes só é olhada aqui: a tarefa a chama a cada passo, mesmo sem mudança.
   */
  configure(config: {
    now: number;
    routes: readonly WebRoute[];
    trusted: readonly WebTrustedSource[];
  }): void {
    const before = this.classifier.signature;
    this.trusted = new TrustedSources(config.trusted, config.now);
    this.classifier = this.classifierFor(config.now);
    this.tally.configure(new RouteTable(config.routes), this.classifier);
    if (this.classifier.signature === before) return;
    this.digest.forget((key) => this.isDirect(key));
    for (const [key, { client }] of this.peaks) {
      if (client !== null && !this.isDirect(client)) this.peaks.delete(key);
    }
  }

  private isDirect(clientKey: string): boolean {
    const ip = ipOfClientKey(clientKey);
    return ip !== null && this.classifier.classify(ip) === 'direct';
  }

  get usage(): WebTally['usage'] {
    return this.tally.usage;
  }

  /**
   * Abre um objeto pela chave dele. O slot é o do fim do arquivo, arredondado para cima. Um arquivo com fim no futuro é
   * recusado; o de um slot já fechado é avaliado sozinho (`late`), e a contagem dele é um piso.
   */
  openObject(key: string, now: number): OpenResult {
    const parsed = parseAlbKey(key);
    if (parsed === null) return { ok: false, reason: 'bad_key' };
    const expected = {
      prefix: this.prefix,
      accountId: this.source.accountId,
      region: this.source.region,
      loadBalancer: this.source.loadBalancer,
    };
    if (!matchesExpectation(parsed, expected)) return { ok: false, reason: 'foreign_key' };
    if (parsed.endMs > now + FUTURE_TOLERANCE_MS) return { ok: false, reason: 'future' };
    const index = Math.ceil(parsed.endMs / SLOT_MS);
    const oldest = Math.ceil(now / SLOT_MS) - KEEP_SLOTS;
    const late = index <= oldest || (this.closedThrough !== null && index <= this.closedThrough);
    if (late && !this.tally.late.has(index) && this.tally.late.size >= MAX_LATE_SLOTS) {
      return { ok: false, reason: 'late_backlog' };
    }
    return { ok: true, late, slot: this.tally.slot(index, late), key };
  }

  /** Uma linha do objeto aberto. */
  ingest(object: Extract<OpenResult, { ok: true }>, line: string): LineOutcome {
    return this.tally.ingest(object.slot, object.key, line);
  }

  private viewAt(index: number): WindowView {
    const take = (count: number): Slot[] => {
      const out: Slot[] = [];
      for (let i = index - count + 1; i <= index; i += 1) {
        const slot = this.tally.slots.get(i);
        if (slot !== undefined) out.push(slot);
      }
      return out;
    };
    return { short: take(SHORT_SLOTS), long: take(LONG_SLOTS), endIndex: index, late: false };
  }

  /**
   * Avalia as janelas que terminam em cada slot aberto (e os objetos atrasados, sozinhos), fecha os slots que venceram e
   * esquece os que saíram de todas as janelas.
   */
  evaluate(input: EvaluateInput): EvaluateResult {
    const steps = this.evaluateSteps(input);
    for (;;) {
      const step = steps.next();
      if (step.done === true) return step.value;
    }
  }

  /**
   * O mesmo, em passos: a tarefa solta o laço de eventos entre eles (um ataque de milhares de endereços custa centenas de
   * milissegundos). Entre o primeiro e o último passo, nenhuma linha lida e nenhuma configuração trocada neste motor.
   */
  *evaluateSteps(input: EvaluateInput): Generator<void, EvaluateResult> {
    const { now } = input;
    const context = {
      wafCollecting: input.wafCollecting ?? false,
      baselines: input.baselines ?? new Map<string, number>(),
      tagOf: (client: ClientRef): number => this.tally.tagOf(client),
    };
    const open = [...this.tally.slots.keys()]
      .filter((index) => this.closedThrough === null || index > this.closedThrough)
      .sort((a, b) => a - b);
    const views: WindowView[] = [
      ...[...this.tally.late.values()].map((slot) => ({
        short: [slot],
        long: [slot],
        endIndex: slot.index,
        late: true,
      })),
      ...open.map((index) => this.viewAt(index)),
    ];

    let catchAllSuppressed = 0;
    const hits: WebHit[] = [];
    const suppressed = new Map<string, Set<string>>();
    for (const view of views) {
      const result = yield* evaluateWindow(view, context);
      yield;
      catchAllSuppressed = Math.max(catchAllSuppressed, result.catchAllSuppressed);
      for (const hit of result.hits) {
        const trusted = this.trustedFor(hit);
        if (trusted === null) {
          hits.push(hit);
          continue;
        }
        const label = `${trusted}|${hit.rule}`;
        const clients = suppressed.get(label) ?? new Set<string>();
        clients.add(hit.client?.key ?? '');
        suppressed.set(label, clients);
      }
    }

    // As sérias marcam o cliente antes de a barra do resumo ser olhada.
    let marked = 0;
    for (const hit of hits) {
      if (NOISE_RULES.has(hit.rule)) this.digest.markNoise(hit);
      else this.digest.markSerious(hit);
      marked += 1;
      if (marked % STEP_ITEMS === 0) yield;
    }
    yield;
    const live = this.digest.live([...this.tally.slots.values(), ...this.tally.late.values()]);
    yield;
    const own = hits.filter((hit) => !NOISE_RULES.has(hit.rule) || this.digest.isTargeted(hit, live));
    const chosen = this.fold(this.strongest(own));
    yield;
    const drafts: WebFindingDraft[] = [];
    for (const hit of chosen) {
      drafts.push(toWebFindingDraft(this.source, hit, this.peak(hit)));
      // Cada evidência passa pelo schema: centenas de uma vez seguram o laço de eventos.
      if (drafts.length % STEP_DRAFTS === 0) yield;
    }
    yield;
    drafts.push(...this.digest.drafts(this.source, live, now));
    yield;

    const result: EvaluateResult = {
      drafts,
      notes: this.notes(),
      counters: { ...this.tally.counters },
      suppressed: [...suppressed]
        .map(([label, clients]) => {
          const at = label.lastIndexOf('|');
          return {
            sourceId: label.slice(0, at),
            rule: label.slice(at + 1) as WebRuleId,
            clients: clients.size,
          };
        })
        .sort((a, b) => (a.sourceId + a.rule < b.sourceId + b.rule ? -1 : 1)),
      catchAllSuppressed,
      unkeyed: this.unkeyed(),
      closedThrough: this.closedThrough,
    };
    yield;
    yield* this.roll(now);
    return { ...result, closedThrough: this.closedThrough };
  }

  private trustedFor(hit: WebHit): string | null {
    if (hit.client === null || !SUPPRESSIBLE_RULES.has(hit.rule)) return null;
    return this.trusted.sourceOf(hit.client.ip);
  }

  private baseKey(hit: WebHit): string {
    const { rule, client, host, route } = hitIdentity(hit, 0);
    return `${rule}|${client ?? ''}|${host ?? ''}|${route ?? ''}`;
  }

  /** A detecção mais forte de cada achado (o nível e depois a contagem), entre as janelas avaliadas. */
  private strongest(hits: readonly WebHit[]): WebHit[] {
    const best = new Map<string, WebHit>();
    for (const hit of hits) {
      const key = this.baseKey(hit);
      const held = best.get(key);
      if (held === undefined) {
        best.set(key, hit);
        continue;
      }
      const stronger = hit.level - held.level || hit.weight - held.weight;
      best.set(key, {
        ...(stronger > 0 ? hit : held),
        firstMs: Math.min(held.firstMs, hit.firstMs),
        lastMs: Math.max(held.lastMs, hit.lastMs),
      });
    }
    return [...best.values()];
  }

  /** O maior nível do achado nas últimas 24 h: a atividade que diminuiu continua no achado que já existe. */
  private peak(hit: WebHit): number {
    const key = this.baseKey(hit);
    const held = this.peaks.get(key);
    const level =
      held === undefined || held.lastMs <= hit.lastMs - DAY_MS ? hit.level : Math.max(held.level, hit.level);
    if (held === undefined && this.peaks.size >= MAX_PEAKS) {
      // No teto, saem as mais antigas: o pior caso é um achado de nível menor a mais.
      const [oldest] = this.peaks.keys();
      if (oldest !== undefined) this.peaks.delete(oldest);
    }
    this.peaks.delete(key);
    const lastMs = Math.max(held?.lastMs ?? 0, hit.lastMs);
    this.peaks.set(key, { level, lastMs, client: hit.client?.key ?? null });
    return level;
  }

  /** O teto por regra: os de maior nível e contagem, e um resumo `*` dos outros. */
  private fold(hits: readonly WebHit[]): WebHit[] {
    const byRule = new Map<WebRuleId, WebHit[]>();
    for (const hit of hits) {
      const list = byRule.get(hit.rule);
      if (list === undefined) byRule.set(hit.rule, [hit]);
      else list.push(hit);
    }
    const out: WebHit[] = [];
    const order = [...byRule.keys()].sort(
      (a, b) => Number(UNFOLDED_RULES.has(b)) - Number(UNFOLDED_RULES.has(a)) || (a < b ? -1 : 1),
    );
    for (const rule of order) {
      const list = (byRule.get(rule) ?? []).sort(
        (a, b) =>
          b.level - a.level ||
          b.weight - a.weight ||
          ((a.client?.key ?? '') < (b.client?.key ?? '') ? -1 : 1) ||
          0,
      );
      const cap = UNFOLDED_RULES.has(rule) ? MAX_UNFOLDED_FINDINGS : MAX_FINDINGS_PER_RULE;
      out.push(...list.slice(0, cap));
      const rest = list.slice(cap);
      if (rest.length > 0) out.push(summaryOf(rule, rest));
    }
    return out;
  }

  private notes(): EngineNote[] {
    const notes: EngineNote[] = [];
    let lines = 0;
    let direct = 0;
    let unverified = 0;
    let truncated = false;
    for (const slot of this.tally.slots.values()) {
      lines += slot.lines;
      direct += slot.direct;
      unverified += slot.unverified;
      truncated ||= slot.truncated;
    }
    const known = lines - unverified;
    if (known > 0 && known - direct >= 0.5 * known) notes.push('behind_proxy');
    if (this.classifier.status === 'stale') notes.push('proxy_ranges_stale');
    if (this.classifier.status === 'unavailable') notes.push('proxy_ranges_unavailable');
    if (this.trusted.rejected.length > 0) notes.push('trusted_rejected');
    if (truncated) notes.push('truncated');
    return notes;
  }

  private unkeyed(): EvaluateResult['unkeyed'] {
    const totals = { requests: 0, tool: 0, probes: 0, errors: 0, loginFailures: 0 };
    for (const slot of this.tally.slots.values()) {
      for (const entry of slot.clients.values()) {
        if (entry.ref.cls === 'direct') continue;
        totals.requests += entry.total;
        totals.tool += entry.tool;
        totals.probes += entry.probes;
        totals.errors += entry.errors;
        totals.loginFailures += entry.loginFailures;
      }
    }
    return totals;
  }

  private *roll(now: number): Generator<void, void> {
    const closed = Math.floor((now - CLOSE_DELAY_MS) / SLOT_MS);
    this.closedThrough = Math.max(this.closedThrough ?? closed, closed);
    const oldest = Math.ceil(now / SLOT_MS) - KEEP_SLOTS;
    for (const slot of [...this.tally.late.values()]) {
      this.digest.settle(slot, now);
      this.tally.drop(slot);
    }
    for (const slot of [...this.tally.slots.values()].sort((a, b) => a.index - b.index)) {
      yield;
      if (slot.index <= oldest) {
        this.digest.settle(slot, now);
        this.tally.drop(slot);
        continue;
      }
      if (slot.index > this.closedThrough) continue;
      if (!slot.closed) this.tally.close(slot);
      if (slot.index <= this.closedThrough - (SHORT_SLOTS - 1)) this.tally.trim(slot);
    }
    this.digest.prune(now);
  }

  /** O que a tarefa guarda entre reinícios, para o resumo do dia não encolher (PR-4). */
  snapshot(): DigestState {
    return this.digest.snapshot();
  }

  /** Quem, no estado guardado, hoje não é direto (a configuração mudou no meio) é esquecido. */
  restore(state: unknown): void {
    this.digest.restore(state);
    this.digest.forget((key) => this.isDirect(key));
  }
}

/** O resumo dos endereços além do teto: o maior nível entre eles e a soma. */
function summaryOf(rule: WebRuleId, rest: readonly WebHit[]): WebHit {
  const counters = emptyCounters();
  const notes = new Set<EvidenceNote>();
  const summary: WebHit = {
    rule,
    level: 0,
    client: null,
    clientClass: null,
    host: null,
    route: null,
    techniques: [...new Set(rest.flatMap((hit) => hit.techniques))],
    eventName: '',
    weight: 0,
    firstMs: Infinity,
    lastMs: 0,
    counters,
    entries: [],
    // A lista já vem dos mais fortes para os mais fracos.
    participants: rest.slice(0, MAX_EVIDENCE_CLIENTS).flatMap((hit) => {
      if (hit.client === null) return [];
      const requests = Math.max(hit.counters.requests, hit.counters.attempts);
      return [{ client: hit.client, requests, count: hit.weight }];
    }),
    families: 0,
    samples: [],
    notes,
    truncated: false,
    fromMs: Infinity,
    toMs: 0,
    load: null,
  };
  for (const hit of rest) {
    for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] += hit.counters[key];
    for (const note of hit.notes) notes.add(note);
    summary.level = Math.max(summary.level, hit.level);
    summary.weight += hit.weight;
    summary.firstMs = Math.min(summary.firstMs, hit.firstMs);
    summary.lastMs = Math.max(summary.lastMs, hit.lastMs);
    summary.fromMs = Math.min(summary.fromMs, hit.fromMs);
    summary.toMs = Math.max(summary.toMs, hit.toMs);
    summary.families |= hit.families;
    summary.truncated ||= hit.truncated;
  }
  counters.clients = rest.length;
  counters.distinctPaths = 0;
  summary.eventName = `mais ${rest.length} endereços ou rotas acima do limite: ${summary.weight} ocorrências`;
  return summary;
}
