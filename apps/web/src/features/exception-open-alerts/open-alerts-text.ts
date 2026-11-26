import type { ExceptionOpenPreview, ExceptionOpenResolution } from '@verax/shared';
import { formatCount, plural } from '@/lib/format';

const kept = (count: number): string =>
  `${formatCount(count)} ${count === 1 ? 'fica porque está' : 'ficam porque estão'} em incidente`;

/** "Vai resolver N alertas em aberto (M ficam porque estão em incidente)." */
export function openPreviewText(preview: ExceptionOpenPreview): string {
  if (preview.resolve === 0 && preview.keptInIncident === 0) {
    return 'Nenhum alerta em aberto é coberto por ela agora.';
  }
  const atLeast = preview.complete ? '' : 'pelo menos ';
  const main = `Vai resolver ${atLeast}${plural(preview.resolve, 'alerta em aberto', 'alertas em aberto')}`;
  return preview.keptInIncident > 0 ? `${main} (${kept(preview.keptInIncident)}).` : `${main}.`;
}

/** "N alertas em aberto resolvidos. M ficaram porque estão em incidente." */
export function openResolutionText(resolution: ExceptionOpenResolution): string {
  const parts: string[] = [];
  if (resolution.resolved > 0) {
    parts.push(
      `${plural(resolution.resolved, 'alerta em aberto resolvido', 'alertas em aberto resolvidos')} como legítimo${
        resolution.resolved === 1 ? '' : 's'
      }.`,
    );
  } else if (resolution.keptInIncident === 0 && !resolution.more) {
    parts.push('Nenhum alerta em aberto era coberto por ela.');
  }
  if (resolution.keptInIncident > 0) {
    const count = resolution.keptInIncident;
    parts.push(
      `${formatCount(count)} ${count === 1 ? 'ficou porque está' : 'ficaram porque estão'} em incidente.`,
    );
  }
  if (resolution.more) parts.push('Ainda há alertas em aberto cobertos por ela.');
  return parts.join(' ');
}
