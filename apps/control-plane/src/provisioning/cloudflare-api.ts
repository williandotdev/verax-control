import { z } from 'zod';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import {
  CloudApiError,
  type CloudResponse,
  cloudRequest,
  expectOk,
  invalidResponse,
  jsonOf,
} from './cloud-http.js';

/** A API v4 do Cloudflare (plano §4c, passos 2, 3 e 5; https://developers.cloudflare.com/api/). */
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

const cloudflareId = z.string().regex(/^[0-9a-f-]{32,36}$/);
/** Ids que vão no caminho de uma chamada que apaga: só o formato do Cloudflare, nada que mude o caminho. */
const TUNNEL_ID = /^[0-9a-f-]{32,36}$/;
const DNS_RECORD_ID = /^[0-9a-f]{32}$/;

const envelope = <T extends z.ZodType>(result: T) => z.object({ success: z.literal(true), result });

const tunnelSchema = z.object({ id: cloudflareId, name: z.string().max(200) });
const dnsRecordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  type: z.string().max(10),
  name: z.string().max(255),
  content: z.string().max(4096),
  proxied: z.boolean().optional(),
});
export type DnsRecord = z.infer<typeof dnsRecordSchema>;

/** Um registro que o provisionamento quer na zona: o CNAME da API (com proxy) ou os do Firebase (sem proxy). */
export interface DesiredDnsRecord {
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT';
  name: string;
  content: string;
  proxied: boolean;
}

/** Os erros do Cloudflare para "esse nome já existe" (túnel e registro de DNS). */
const ALREADY_EXISTS_CODES = new Set(['cf_1013', 'cf_81053', 'cf_81057', 'cf_81058']);

export interface CloudflareSettings {
  accountId: string;
  zoneId: string;
  apiToken: string;
}

/**
 * O que o provisionamento faz no Cloudflare, com o token restrito da conta (`Cloudflare Tunnel: Edit` e `DNS: Edit` na
 * zona da Verax, plano §9 item 13). O token entra na máscara do logger ao construir o cliente. O token do túnel
 * (`tunnelToken`) é o único segredo que sai daqui: entra na máscara antes de voltar, e quem o grava no Secret Manager o
 * esquece depois (`forgetLiveSecret`).
 */
export class CloudflareApi {
  private readonly authorization: string;

  constructor(
    private readonly settings: CloudflareSettings,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly base: string = CLOUDFLARE_API_BASE,
  ) {
    registerLiveSecret(settings.apiToken);
    this.authorization = `Bearer ${settings.apiToken}`;
  }

  /** O túnel vivo com esse nome, se houver (`is_deleted=false`). */
  async findTunnel(name: string): Promise<{ id: string } | undefined> {
    const url = new URL(`${this.base}/accounts/${this.settings.accountId}/cfd_tunnel`);
    url.searchParams.set('name', name);
    url.searchParams.set('is_deleted', 'false');
    const result = this.parse(
      'tunnel_list',
      expectOk('cloudflare', 'tunnel_list', await this.call('GET', 'tunnel_list', url.toString())),
      z.array(tunnelSchema),
    );
    const tunnel = result.find((candidate) => candidate.name === name);
    return tunnel === undefined ? undefined : { id: tunnel.id };
  }

  /**
   * Cria o túnel gerenciado pelo Cloudflare (`config_src: cloudflare`: o ingresso é configurado pela API, sem arquivo
   * na VM). "Já existe" devolve `undefined`: quem chama procura de novo pelo nome.
   */
  async createTunnel(name: string): Promise<{ id: string } | undefined> {
    const response = await this.call(
      'POST',
      'tunnel_create',
      `${this.base}/accounts/${this.settings.accountId}/cfd_tunnel`,
      { name, config_src: 'cloudflare' },
    );
    if (this.alreadyExists(response)) return undefined;
    const tunnel = this.parse(
      'tunnel_create',
      expectOk('cloudflare', 'tunnel_create', response),
      tunnelSchema,
    );
    return { id: tunnel.id };
  }

  /** O ingresso do túnel: o nome da API do cliente para a API do nó, e 404 para o resto. Idempotente (PUT). */
  async putTunnelIngress(tunnelId: string, hostname: string, service: string): Promise<void> {
    const response = await this.call(
      'PUT',
      'tunnel_configuration',
      `${this.base}/accounts/${this.settings.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      { config: { ingress: [{ hostname, service }, { service: 'http_status:404' }] } },
    );
    expectOk('cloudflare', 'tunnel_configuration', response);
  }

  /**
   * O token do túnel ("treat the token as a secret", documentação do Cloudflare). Entra na máscara do logger antes de
   * voltar; quem recebe o esquece (`forgetTunnelToken`) depois de gravar.
   */
  async tunnelToken(tunnelId: string): Promise<string> {
    const response = expectOk(
      'cloudflare',
      'tunnel_token',
      await this.call(
        'GET',
        'tunnel_token',
        `${this.base}/accounts/${this.settings.accountId}/cfd_tunnel/${tunnelId}/token`,
      ),
    );
    const parsed = envelope(z.string().min(16).max(4096)).safeParse(
      jsonOf('cloudflare', 'tunnel_token', response),
    );
    if (!parsed.success) throw invalidResponse('cloudflare', 'tunnel_token');
    registerLiveSecret(parsed.data.result);
    return parsed.data.result;
  }

  forgetTunnelToken(token: string): void {
    forgetLiveSecret(token);
  }

  /** Os registros com esse tipo e nome exato na zona. */
  async listDnsRecords(type: DesiredDnsRecord['type'], name: string): Promise<DnsRecord[]> {
    const url = new URL(`${this.base}/zones/${this.settings.zoneId}/dns_records`);
    url.searchParams.set('type', type);
    url.searchParams.set('name', name);
    return this.parse(
      'dns_list',
      expectOk('cloudflare', 'dns_list', await this.call('GET', 'dns_list', url.toString())),
      z.array(dnsRecordSchema),
    );
  }

  /** Os registros com o nome exato na zona, de qualquer tipo (Exclusão 1, CP-11). */
  async listDnsRecordsByName(name: string): Promise<DnsRecord[]> {
    const url = new URL(`${this.base}/zones/${this.settings.zoneId}/dns_records`);
    url.searchParams.set('name', name);
    url.searchParams.set('per_page', '100');
    return this.parse(
      'dns_list',
      expectOk('cloudflare', 'dns_list', await this.call('GET', 'dns_list', url.toString())),
      z.array(dnsRecordSchema),
    );
  }

  /** O registro pelo id; `undefined` se já não existe. */
  async getDnsRecord(recordId: string): Promise<DnsRecord | undefined> {
    if (!DNS_RECORD_ID.test(recordId)) throw new TypeError('id de registro inválido');
    const response = await this.call(
      'GET',
      'dns_get',
      `${this.base}/zones/${this.settings.zoneId}/dns_records/${recordId}`,
    );
    if (response.status === 404) return undefined;
    return this.parse('dns_get', expectOk('cloudflare', 'dns_get', response), dnsRecordSchema);
  }

  /** Apaga o registro pelo id. Já ausente (404) conta como feito. */
  async deleteDnsRecord(recordId: string): Promise<void> {
    if (!DNS_RECORD_ID.test(recordId)) throw new TypeError('id de registro inválido');
    const response = await this.call(
      'DELETE',
      'dns_delete',
      `${this.base}/zones/${this.settings.zoneId}/dns_records/${recordId}`,
    );
    if (response.status === 404) return;
    expectOk('cloudflare', 'dns_delete', response);
  }

  /**
   * Apaga o túnel (Exclusão 1, CP-11): primeiro as conexões que o Cloudflare ainda lembra (a VM já foi destruída, mas
   * o registro de uma conexão pode demorar a cair), depois o túnel. Já ausente (404) conta como feito.
   */
  async deleteTunnel(tunnelId: string): Promise<void> {
    if (!TUNNEL_ID.test(tunnelId)) throw new TypeError('id de túnel inválido');
    const base = `${this.base}/accounts/${this.settings.accountId}/cfd_tunnel/${tunnelId}`;
    const connections = await this.call('DELETE', 'tunnel_connections_delete', `${base}/connections`);
    if (connections.status !== 404) expectOk('cloudflare', 'tunnel_connections_delete', connections);
    const response = await this.call('DELETE', 'tunnel_delete', base);
    if (response.status === 404) return;
    expectOk('cloudflare', 'tunnel_delete', response);
  }

  /**
   * Garante o registro: igual, nada a fazer; mesmo nome e tipo com outro conteúdo, num CNAME (um nome só aceita um),
   * atualiza; senão cria. "Já existe" na criação relê. Devolve o id do registro.
   */
  async ensureDnsRecord(record: DesiredDnsRecord, comment: string): Promise<string> {
    const existing = await this.listDnsRecords(record.type, record.name);
    const same = existing.find((candidate) => sameContent(candidate, record));
    if (same !== undefined && (same.proxied ?? false) === record.proxied) return same.id;
    const body = {
      type: record.type,
      name: record.name,
      content: record.content,
      proxied: record.proxied,
      ttl: 1,
      comment,
    };
    const replaceable = same ?? (record.type === 'CNAME' ? existing[0] : undefined);
    if (replaceable !== undefined) {
      const updated = await this.call(
        'PUT',
        'dns_update',
        `${this.base}/zones/${this.settings.zoneId}/dns_records/${replaceable.id}`,
        body,
      );
      return this.parse('dns_update', expectOk('cloudflare', 'dns_update', updated), dnsRecordSchema).id;
    }
    const created = await this.call(
      'POST',
      'dns_create',
      `${this.base}/zones/${this.settings.zoneId}/dns_records`,
      body,
    );
    if (this.alreadyExists(created)) {
      const again = (await this.listDnsRecords(record.type, record.name)).find((candidate) =>
        sameContent(candidate, record),
      );
      if (again !== undefined) return again.id;
      throw new CloudApiError('cloudflare', 'dns_create', created.status, 'ALREADY_EXISTS');
    }
    return this.parse('dns_create', expectOk('cloudflare', 'dns_create', created), dnsRecordSchema).id;
  }

  private alreadyExists(response: CloudResponse): boolean {
    if (response.status === 409) return true;
    if (response.status !== 400) return false;
    try {
      expectOk('cloudflare', 'check', response);
    } catch (error) {
      return (
        error instanceof CloudApiError && error.reason !== undefined && ALREADY_EXISTS_CODES.has(error.reason)
      );
    }
    return false;
  }

  private parse<T extends z.ZodType>(operation: string, response: CloudResponse, schema: T): z.infer<T> {
    const parsed = envelope(schema).safeParse(jsonOf('cloudflare', operation, response));
    if (!parsed.success) throw invalidResponse('cloudflare', operation);
    return (parsed.data as { result: z.infer<T> }).result;
  }

  private call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    operation: string,
    url: string,
    json?: unknown,
  ): Promise<CloudResponse> {
    return cloudRequest(this.fetchFn, 'cloudflare', operation, {
      method,
      url,
      authorization: this.authorization,
      ...(json === undefined ? {} : { json }),
    });
  }
}

/** O Cloudflare devolve TXT entre aspas e nomes sem o ponto final; compara do mesmo jeito dos dois lados. */
function sameContent(existing: DnsRecord, desired: DesiredDnsRecord): boolean {
  const normalize = (value: string): string =>
    value
      .replace(/^"(.*)"$/, '$1')
      .replace(/\.$/, '')
      .toLowerCase();
  return existing.type === desired.type && normalize(existing.content) === normalize(desired.content);
}
