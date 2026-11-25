import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WebFindingDraft } from '../draft.js';
import { WEB_RULES, type WebRuleId } from '../rules.js';

/**
 * O que teria virado achado enquanto o balanceador só observa: por regra e nível, quantos achados abririam (cada um uma vez,
 * pela mesma chave do `FindingStore`), o primeiro e o último. É o que o cliente olha antes de passar para `alert`.
 *
 * Nada de endereço, caminho ou host: só contagens. A memória para não contar duas vezes é um pedaço do hash da chave do
 * achado, até `MAX_KEYS`; daí em diante, o achado novo não é contado, e `truncated` diz que os números são um piso. Um
 * reinício que relê as mesmas linhas dá as mesmas chaves, e não soma de novo.
 */

const MAX_KEYS = 4_000;
const KEY_CHARS = 12;
const RULE_IDS = Object.keys(WEB_RULES) as WebRuleId[];
const isHexKey = (text: string): boolean =>
  text.length === KEY_CHARS && [...text].every((char) => '0123456789abcdef'.includes(char));

const instant = z.iso.datetime();
export const observationSchema = z.strictObject({
  /** O começo da observação: o da autorização, ou o de quando o balanceador foi trocado. */
  since: instant,
  rules: z
    .array(
      z.strictObject({
        ruleId: z.enum(RULE_IDS),
        level: z.int().min(0).max(15),
        /** Achados que abririam. */
        findings: z.int().min(1),
        firstSeenAt: instant,
        lastSeenAt: instant,
      }),
    )
    .max(64),
  /** Os números são um piso. */
  truncated: z.boolean(),
  keys: z.array(z.string().refine(isHexKey)).max(MAX_KEYS),
});
export type ObservationState = z.infer<typeof observationSchema>;
type RuleCount = ObservationState['rules'][number];

const keyOf = (draft: WebFindingDraft): string =>
  createHash('sha256').update(draft.sourceEventId, 'utf8').digest('hex').slice(0, KEY_CHARS);

export class Observation {
  private readonly rules = new Map<string, RuleCount>();
  private readonly keys = new Set<string>();
  private truncated = false;

  constructor(readonly since: string) {}

  /** A observação guardada, se é a de agora; senão (a observação recomeçou, o formato é outro), uma nova. */
  static resume(state: unknown, since: string): Observation {
    const observation = new Observation(since);
    const parsed = observationSchema.safeParse(state);
    if (!parsed.success || parsed.data.since !== since) return observation;
    for (const rule of parsed.data.rules) observation.rules.set(`${rule.ruleId}|${rule.level}`, rule);
    for (const key of parsed.data.keys) observation.keys.add(key);
    observation.truncated = parsed.data.truncated;
    return observation;
  }

  /** Conta os achados de uma avaliação. Devolve quantos ainda não tinham sido contados. */
  record(drafts: readonly WebFindingDraft[]): number {
    let added = 0;
    for (const draft of drafts) {
      const id = `${draft.ruleId}|${draft.ruleLevel}`;
      const seenAt = draft.evidence.lastSeenAt;
      const known = this.rules.get(id);
      const key = keyOf(draft);
      if (this.keys.has(key)) {
        // O mesmo achado, com atividade mais nova.
        if (known !== undefined && seenAt > known.lastSeenAt) known.lastSeenAt = seenAt;
        continue;
      }
      if (this.keys.size >= MAX_KEYS) {
        this.truncated = true;
        continue;
      }
      this.keys.add(key);
      added += 1;
      if (known === undefined) {
        this.rules.set(id, {
          ruleId: draft.ruleId as WebRuleId,
          level: draft.ruleLevel,
          findings: 1,
          firstSeenAt: draft.evidence.firstSeenAt,
          lastSeenAt: seenAt,
        });
        continue;
      }
      known.findings += 1;
      if (draft.evidence.firstSeenAt < known.firstSeenAt) known.firstSeenAt = draft.evidence.firstSeenAt;
      if (seenAt > known.lastSeenAt) known.lastSeenAt = seenAt;
    }
    return added;
  }

  state(): ObservationState {
    return {
      since: this.since,
      rules: [...this.rules.values()].map((rule) => ({ ...rule })),
      truncated: this.truncated,
      keys: [...this.keys],
    };
  }
}
