import { CUSTOM_PERIOD, DETECTION_PARAMS, NO_ASSIGNEE } from './url-state';

/**
 * Os endereços de antes da tela Detecções (Torre, Incidentes, Achados e Relatórios viraram uma tela só, em 16/11/2026)
 * continuam valendo: os links dos e-mails de aviso, do tour e dos favoritos levam à visão equivalente.
 */

/** O status do incidente na URL de antes para o status do filtro de agora (o aberto é o "novo ou aberto"). */
const INCIDENT_STATUS_PARAM: Readonly<Record<string, string>> = {
  open: 'new',
  investigating: 'investigating',
  resolved: 'resolved',
};

/** As abas dos Relatórios e para onde cada uma foi. */
const REPORT_TAB_TARGET: Readonly<Record<string, { view?: string; analysis?: string; path?: string }>> = {
  resumo: {},
  mitre: { analysis: 'mitre' },
  deteccoes: { view: 'achados' },
  entidades: { view: 'achados' },
  incidentes: {},
  cobertura: { analysis: 'cobertura' },
  // As exceções e quantos alertas cada uma silenciou ficam no cadastro de Exceções.
  excecoes: { path: '/cadastros/excecoes' },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function build(path: string, entries: [string, string | null | undefined][]): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) if (value) params.set(key, value);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

const INCIDENT_PREFIX = '/incidentes/';

/** O caminho sem as barras do fim (sem expressão regular sobre a URL). */
function withoutTrailingSlashes(pathname: string): string {
  let end = pathname.length;
  while (end > 0 && pathname.charAt(end - 1) === '/') end -= 1;
  return pathname.slice(0, end);
}

/** O endereço novo de um endereço de antes (caminho e busca). Um caminho que não é de antes volta como veio. */
export function legacyDetectionsUrl(pathname: string, search: string): string {
  const old = new URLSearchParams(search);
  const path = withoutTrailingSlashes(pathname) || '/';
  const P = DETECTION_PARAMS;

  const incidentSegment = path.startsWith(INCIDENT_PREFIX) ? path.slice(INCIDENT_PREFIX.length) : '';
  if (incidentSegment && !incidentSegment.includes('/')) {
    const id = decodeURIComponent(incidentSegment);
    return build('/', [[P.incident, UUID.test(id) ? id : null]]);
  }
  if (path === '/incidentes') {
    return build('/', [
      [P.status, INCIDENT_STATUS_PARAM[old.get('status') ?? '']],
      [P.severity, old.get('severidade')],
      [P.unassigned, old.get('responsavel') === NO_ASSIGNEE ? NO_ASSIGNEE : null],
      [P.page, old.get('pagina')],
    ]);
  }
  if (path === '/achados') {
    return build('/', [
      [P.view, 'achados'],
      [P.severity, old.get('severidade')],
      [P.status, old.get('status')],
      [P.accountId, old.get('conta')],
      [P.period, old.get('periodo')],
      [P.page, old.get('pagina')],
      [P.finding, old.get('achado')],
    ]);
  }
  if (path === '/relatorios') {
    const target = REPORT_TAB_TARGET[old.get('aba') ?? 'resumo'] ?? {};
    if (target.path) return target.path;
    const period = old.get('periodo');
    return build('/', [
      [P.view, target.view],
      [P.analysis, target.analysis],
      [P.period, period === CUSTOM_PERIOD ? null : period],
    ]);
  }
  return `${pathname}${search}`;
}
