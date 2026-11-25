/** O `id` do balanceador em "Ataques web": é para onde a linha dele, em "Fontes autorizadas", aponta. */
export function webAttacksAnchor(sourceId: string): string {
  return `ataques-web-${sourceId}`;
}
