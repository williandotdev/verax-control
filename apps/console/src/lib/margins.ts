export type MarginLevel = 'below_minimum' | 'below_alert' | 'ok';

/** Onde uma margem fica em relação às metas do modelo de custos (a mesma regra da checagem de publicação). */
export function marginLevel(ratio: number, margins: { minimum: number; alert: number }): MarginLevel {
  if (belowTarget(ratio, margins.minimum)) return 'below_minimum';
  if (belowTarget(ratio, margins.alert)) return 'below_alert';
  return 'ok';
}

function belowTarget(ratio: number, target: number): boolean {
  return ratio < target;
}
