import type { CaseMode } from '@verax/shared';
import type { DetectionView } from '@/features/detections/url-state';

export const VIEW_LABELS: Readonly<Record<DetectionView, string>> = {
  cases: 'Casos',
  alerts: 'Alertas',
  incidents: 'Incidentes',
  vulnerabilities: 'Vulnerabilidades',
};

/** As visões da lista, na ordem dos botões. Sem os casos, as de sempre. */
export function viewsOf(mode: CaseMode, canIncidents: boolean): DetectionView[] {
  const incidents: DetectionView[] = canIncidents ? ['incidents'] : [];
  return mode === 'off' ? ['alerts', ...incidents] : ['cases', 'alerts', ...incidents, 'vulnerabilities'];
}
