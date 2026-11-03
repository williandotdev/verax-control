import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Entrada do Cloud Logging como chega pelo Pub/Sub (o sink copia a `LogEntry` inteira, em JSON). Só os campos que as
 * regras usam são validados, cada texto com tamanho máximo: o resto é descartado, e nada do evento bruto é gravado.
 */

const text = (max: number) => z.string().max(max);

const bindingDeltaSchema = z.object({
  action: text(32).optional(),
  role: text(256).optional(),
  member: text(512).optional(),
});

const auditConfigDeltaSchema = z.object({
  action: text(32).optional(),
  service: text(256).optional(),
  logType: text(64).optional(),
});

const auditLogSchema = z.object({
  serviceName: text(256).optional(),
  methodName: text(256).optional(),
  resourceName: text(2048).optional(),
  status: z.object({ code: z.number().int().optional(), message: text(4096).optional() }).optional(),
  authenticationInfo: z
    .object({
      principalEmail: text(512).optional(),
      serviceAccountKeyName: text(1024).optional(),
    })
    .optional(),
  requestMetadata: z
    .object({
      callerIp: text(64).optional(),
      callerSuppliedUserAgent: text(4096).optional(),
    })
    .optional(),
  request: z.record(z.string(), z.unknown()).optional(),
  response: z.record(z.string(), z.unknown()).optional(),
  serviceData: z
    .object({
      policyDelta: z
        .object({
          bindingDeltas: z.array(bindingDeltaSchema).max(1000).optional(),
          auditConfigDeltas: z.array(auditConfigDeltaSchema).max(200).optional(),
        })
        .optional(),
    })
    .optional(),
});

export const logEntrySchema = z.object({
  insertId: text(256).min(1),
  logName: text(512),
  timestamp: z.iso.datetime({ offset: true }),
  severity: text(32).optional(),
  resource: z
    .object({
      type: text(128),
      labels: z.record(z.string(), text(512)).optional(),
    })
    .optional(),
  protoPayload: auditLogSchema.optional(),
});

export type LogEntry = z.infer<typeof logEntrySchema>;
export type AuditLog = NonNullable<LogEntry['protoPayload']>;

/** ID de projeto da GCP: 6 a 30 caracteres, minúsculas, dígitos e hífen, começando por letra. */
const PROJECT_LOG = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/logs\//;

/** Projeto dono do log. Log de organização ou de pasta não tem projeto, e fica sem dono. */
export function projectOf(entry: Pick<LogEntry, 'logName'>): string | null {
  return PROJECT_LOG.exec(entry.logName)?.[1] ?? null;
}

export type ParsedEntry =
  { ok: true; entry: LogEntry; project: string | null } | { ok: false; insertId: string | null };

/** Decodifica e valida a mensagem do Pub/Sub (`data` em base64 com a LogEntry em JSON). */
export function parseLogMessage(data: string | undefined): ParsedEntry {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(data ?? '', 'base64').toString('utf8'));
  } catch {
    return { ok: false, insertId: null };
  }
  const parsed = logEntrySchema.safeParse(json);
  if (!parsed.success) {
    const insertId = (json as { insertId?: unknown } | null)?.insertId;
    return { ok: false, insertId: typeof insertId === 'string' ? insertId.slice(0, 256) : null };
  }
  return { ok: true, entry: parsed.data, project: projectOf(parsed.data) };
}

/** IP de quem chamou, quando é um IP de verdade (a GCP também grava `private` e `gce-internal-ip`). */
export function callerIp(log: AuditLog | undefined): string | null {
  const ip = log?.requestMetadata?.callerIp;
  return ip && isIP(ip) !== 0 ? ip : null;
}

/** Conta de serviço gerenciada pelo Google (agentes de serviço): o próprio Google agindo, não alguém do cliente. */
export function isGoogleServiceAgent(email: string): boolean {
  return (
    /@gcp-sa-[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(email) ||
    /@(cloudservices|system|cloudbuild|serverless-robot-prod)\.gserviceaccount\.com$/.test(email) ||
    /^service-\d+@/.test(email)
  );
}

/** Chave de conta de serviço usada na chamada: só o ID da chave, o fim do nome completo. */
export function serviceAccountKeyId(log: AuditLog | undefined): string | null {
  const name = log?.authenticationInfo?.serviceAccountKeyName;
  if (!name) return null;
  return name.split('/').at(-1)?.slice(0, 128) ?? null;
}
