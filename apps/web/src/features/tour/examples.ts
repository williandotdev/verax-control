import { findingSchema, incidentSchema, paginatedSchema } from '@verax/shared';
import { api } from '@/lib/api';
import type { TourStep } from './steps';

const incidentPage = paginatedSchema(incidentSchema);
const findingPage = paginatedSchema(findingSchema);

/**
 * Tela de um passo com exemplo, no cliente da sessão: o primeiro incidente (o de maior nota) ou o primeiro achado da
 * lista. O admin da Verax pode ter trocado de cliente, então o exemplo não é fixo. Sem nenhum, ou se a busca
 * falhar, o passo fica na própria lista.
 */
export async function examplePath(step: TourStep): Promise<string | undefined> {
  try {
    if (step.example === 'incident') {
      const [first] = (await api.get('/v1/incidents?page=1&pageSize=1', incidentPage)).items;
      if (first) return `/incidentes/${encodeURIComponent(first.id)}`;
    } else if (step.example === 'finding') {
      const [first] = (await api.get('/v1/findings?page=1&pageSize=1', findingPage)).items;
      if (first) return `/achados?achado=${encodeURIComponent(first.id)}`;
    }
  } catch {
    // Sem o exemplo, o passo mostra a lista.
  }
  return step.path;
}
