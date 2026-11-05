import type { Clock } from '../common/clock.js';

/**
 * Token de identidade do Google da conta do próprio serviço (no cp-public, a `cp-public`), para chamar o cp-worker:
 * o Cloud Run confere o token na entrada (`run.invoker`) e o worker confere `aud` e `email` (`worker-caller.ts`).
 */
export interface IdTokenSource {
  get(audience: string): Promise<string>;
}

/**
 * O servidor de metadados do Cloud Run, que emite o token da conta do serviço. Só existe dentro da GCP, só por HTTP e
 * só com o cabeçalho `Metadata-Flavor: Google` (o que impede um redirecionamento ou um navegador de obtê-lo).
 */
const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
/** Renova 5 min antes do vencimento (o token vale 1 h); sem `exp` legível, guarda por 10 min. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const FALLBACK_CACHE_MS = 10 * 60_000;
const METADATA_TIMEOUT_MS = 5_000;

function expiryOf(jwt: string): number | undefined {
  const payload = jwt.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Busca no servidor de metadados e guarda por audiência até perto do vencimento. */
export class MetadataIdTokenSource implements IdTokenSource {
  private readonly cache = new Map<string, { value: string; refreshAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async get(audience: string): Promise<string> {
    const now = this.clock.now().getTime();
    const cached = this.cache.get(audience);
    if (cached !== undefined && cached.refreshAt > now) return cached.value;
    const url = new URL(METADATA_IDENTITY_URL);
    url.searchParams.set('audience', audience);
    url.searchParams.set('format', 'full');
    const response = await this.fetchFn(url, {
      headers: { 'Metadata-Flavor': 'Google' },
      redirect: 'error',
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`servidor de metadados respondeu ${response.status}`);
    const value = (await response.text()).trim();
    if (value.split('.').length !== 3)
      throw new Error('servidor de metadados devolveu um token fora do formato');
    const expiresAt = expiryOf(value);
    const refreshAt = expiresAt === undefined ? now + FALLBACK_CACHE_MS : expiresAt - REFRESH_MARGIN_MS;
    this.cache.set(audience, { value, refreshAt });
    return value;
  }
}
