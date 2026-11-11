import type {
  LegalAuditEntry,
  LegalKind,
  LegalTextRecord,
  LegalVersionSummary,
  ValidationIssue,
} from '@/lib/api-types';
import type { FakeResponse } from './fake-admin-api';
import { FICTITIOUS_OWNER } from './fixtures';

/**
 * Os textos legais da API simulada (`/v1/admin/legal/...`), em memória. Imita os contratos de
 * `apps/control-plane/src/admin/admin-legal.*`: a revisão (`draft_changed`), a versão digitada na publicação, a
 * imutabilidade da publicada, o texto em branco (422) e a trilha. Textos FICTÍCIOS.
 */
export interface FakeLegalState {
  texts: Record<LegalKind, Map<string, LegalTextRecord>>;
  audit: Record<LegalKind, LegalAuditEntry[]>;
}

const KINDS: readonly LegalKind[] = ['terms', 'privacy', 'dpa'];
const MAX_BYTES = 100 * 1024;
const DAY = 86_400_000;

export const FICTITIOUS_TERMS = '# Termos de uso (teste)\n\nTexto **fictício**, só para os testes.\n';

function isKind(value: string | undefined): value is LegalKind {
  return value !== undefined && (KINDS as readonly string[]).includes(value);
}

/** Um SHA-256 de enfeite (o fictício não precisa do de verdade): 64 dígitos hexadecimais derivados do texto. */
function fakeHash(text: string): string {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash.toString(16).padStart(8, '0').repeat(8);
}

/**
 * O estado inicial: os Termos publicados (`2026-11-01`, o vigente) e um rascunho (`2026-11-10`); a Privacidade
 * publicada; o DPA sem nada (o aviso de que o checkout fica fechado). `empty` começa sem nada.
 */
export function createFakeLegal(now: () => Date, empty = false): FakeLegalState {
  const state: FakeLegalState = {
    texts: { terms: new Map(), privacy: new Map(), dpa: new Map() },
    audit: { terms: [], privacy: [], dpa: [] },
  };
  if (empty) return state;
  const at = (days: number): string => new Date(now().getTime() - days * DAY).toISOString();
  const base = { createdBy: FICTITIOUS_OWNER, updatedBy: FICTITIOUS_OWNER };
  state.texts.terms.set('2026-11-01', {
    kind: 'terms',
    version: '2026-11-01',
    status: 'published',
    content: FICTITIOUS_TERMS,
    publishedAt: at(9),
    publishedBy: FICTITIOUS_OWNER,
    contentSha256: fakeHash(FICTITIOUS_TERMS),
    createdAt: at(10),
    updatedAt: at(9),
    ...base,
  });
  state.texts.terms.set('2026-11-10', {
    kind: 'terms',
    version: '2026-11-10',
    status: 'draft',
    content: FICTITIOUS_TERMS,
    basedOn: '2026-11-01',
    createdAt: at(1),
    updatedAt: at(1),
    ...base,
  });
  const privacy = '# Política de privacidade (teste)\n\nTexto fictício.\n';
  state.texts.privacy.set('2026-11-01', {
    kind: 'privacy',
    version: '2026-11-01',
    status: 'published',
    content: privacy,
    publishedAt: at(9),
    publishedBy: FICTITIOUS_OWNER,
    contentSha256: fakeHash(privacy),
    createdAt: at(10),
    updatedAt: at(9),
    ...base,
  });
  state.audit.terms.push({
    id: '01JC0000000000000000000L01',
    at: at(9),
    actor: `owner:${FICTITIOUS_OWNER}`,
    event: 'published',
    version: '2026-11-01',
    contentSha256: fakeHash(FICTITIOUS_TERMS),
    bytes: FICTITIOUS_TERMS.length,
  });
  return state;
}

function error(
  status: number,
  message: string,
  code: string,
  details?: Record<string, unknown>,
): FakeResponse {
  return {
    status,
    body: { statusCode: status, message, code, ...(details === undefined ? {} : { details }) },
  };
}

function invalid(issues: ValidationIssue[]): FakeResponse {
  return error(400, 'Dados inválidos.', 'invalid_request', { issues });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validVersion(version: unknown): version is string {
  if (typeof version !== 'string' || version.length === 0 || version.length > 40) return false;
  for (const char of version) {
    const ok = (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '-';
    if (!ok) return false;
  }
  return version[0] !== '-';
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

function current(records: Map<string, LegalTextRecord>): LegalTextRecord | undefined {
  let best: LegalTextRecord | undefined;
  for (const record of records.values()) {
    if (record.publishedAt === undefined) continue;
    if (best === undefined || (best.publishedAt ?? '') < record.publishedAt) best = record;
  }
  return best;
}

function summary(record: LegalTextRecord, currentVersion: string | undefined): LegalVersionSummary {
  const { content, ...rest } = record;
  return { ...rest, current: record.version === currentVersion, bytes: bytesOf(content) };
}

const IMMUTABLE = (): FakeResponse =>
  error(409, 'Só o rascunho muda: para alterar um texto publicado, crie outra versão.', 'version_immutable');
const CHANGED = (): FakeResponse =>
  error(
    409,
    'O rascunho mudou depois que você o abriu (outra aba ou outra pessoa). Recarregue e confira.',
    'draft_changed',
  );

/** Atende `/v1/admin/legal/...`; `parts` é o caminho depois de `legal`. */
export function handleLegalRequest(
  state: FakeLegalState,
  email: string,
  now: Date,
  method: string,
  parts: readonly string[],
  body: unknown,
): FakeResponse {
  const [kind, section, version, action] = parts;
  if (kind === undefined && method === 'GET') {
    const overview = Object.fromEntries(
      KINDS.map((key) => {
        const records = state.texts[key];
        const currentVersion = current(records)?.version;
        const list = [...records.values()]
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .map((record) => summary(record, currentVersion));
        return [key, list];
      }),
    );
    return { status: 200, body: overview };
  }
  if (!isKind(kind)) return error(404, 'Texto inexistente.', 'legal_kind_not_found');
  const records = state.texts[kind];
  const trail = state.audit[kind];
  const log = (
    event: LegalAuditEntry['event'],
    record: LegalTextRecord,
    extra: Partial<LegalAuditEntry> = {},
  ) => {
    trail.unshift({
      id: `01JC00000000000000000L${String(trail.length + 100).padStart(4, '0')}`,
      at: now.toISOString(),
      actor: `owner:${email}`,
      event,
      version: record.version,
      ...extra,
    });
  };

  if (section === 'audit' && version === undefined && method === 'GET') return { status: 200, body: trail };
  if (section !== 'versions') return error(404, 'Recurso não encontrado', 'not_found');

  if (version === undefined && method === 'POST') {
    const requested = isRecord(body) ? body['version'] : undefined;
    if (!validVersion(requested)) {
      return invalid([{ path: 'version', message: 'versão inválida (minúsculas, números e traço)' }]);
    }
    if (records.has(requested)) return error(409, 'Esta versão já existe.', 'version_exists');
    const from = isRecord(body) && typeof body['from'] === 'string' ? body['from'] : undefined;
    const source = from === undefined ? undefined : records.get(from);
    if (from !== undefined && source === undefined)
      return error(404, 'Versão inexistente.', 'version_not_found');
    const record: LegalTextRecord = {
      kind,
      version: requested,
      status: 'draft',
      content: source?.content ?? '',
      ...(source === undefined ? {} : { basedOn: source.version }),
      createdAt: now.toISOString(),
      createdBy: email,
      updatedAt: now.toISOString(),
      updatedBy: email,
    };
    records.set(requested, record);
    log('draft.created', record, {
      bytes: bytesOf(record.content),
      ...(source === undefined ? {} : { basedOn: source.version }),
    });
    return { status: 201, body: record };
  }

  if (version === undefined) return error(404, 'Recurso não encontrado', 'not_found');
  const record = records.get(version);
  if (record === undefined) return error(404, 'Versão inexistente.', 'version_not_found');

  if (action === undefined && method === 'GET') return { status: 200, body: record };

  const expected = isRecord(body) ? body['expectedUpdatedAt'] : undefined;
  if (action === undefined && method === 'PUT') {
    const content = isRecord(body) ? body['content'] : undefined;
    if (typeof content !== 'string') {
      return invalid([{ path: 'content', message: 'Entrada inválida: esperado string' }]);
    }
    if (bytesOf(content) > MAX_BYTES) return invalid([{ path: 'content', message: 'texto acima de 100 KB' }]);
    if (record.status !== 'draft') return IMMUTABLE();
    if (expected !== record.updatedAt) return CHANGED();
    if (content === record.content) return { status: 200, body: record };
    const next = { ...record, content, updatedAt: now.toISOString(), updatedBy: email };
    records.set(version, next);
    log('draft.updated', next, { bytes: bytesOf(content) });
    return { status: 200, body: next };
  }

  if (action === 'publish' && method === 'POST') {
    const confirm = isRecord(body) ? body['confirmVersion'] : undefined;
    if (confirm !== version) {
      return invalid([
        { path: 'confirmVersion', message: 'Digite a versão exatamente como está para confirmar.' },
      ]);
    }
    if (record.status !== 'draft') return IMMUTABLE();
    if (expected !== record.updatedAt) return CHANGED();
    if (record.content.trim() === '') return error(422, 'O texto está em branco.', 'legal_text_empty');
    const published: LegalTextRecord = {
      ...record,
      status: 'published',
      publishedAt: now.toISOString(),
      publishedBy: email,
      contentSha256: fakeHash(record.content),
      updatedAt: now.toISOString(),
      updatedBy: email,
    };
    records.set(version, published);
    log('published', published, {
      bytes: bytesOf(published.content),
      ...(published.contentSha256 === undefined ? {} : { contentSha256: published.contentSha256 }),
    });
    return { status: 200, body: summary(published, version) };
  }

  return error(404, 'Recurso não encontrado', 'not_found');
}
