import type {
  AwsLogBucketSource,
  AwsLogBuckets,
  CredentialKind,
  LogSourceCredentialInput,
  LogSourceProvider,
  LogSourceSpec,
  LogSourceUpdateRequest,
  NodeSyncOverview,
  ValidationIssue,
} from '@/lib/api-types';
import { BUCKET_SOURCES } from './log-source-labels';

/**
 * Os formulários das fontes de log como documento (o rascunho), e do rascunho ao corpo do pedido: o cadastro com as
 * regras do painel do nó (`cloudAccountCreateSchema`, em `@verax/shared`, que o console não importa), conferidas aqui só
 * no que é certo (o formato do ID da conta, as regiões, o começo do bucket do WAF), e a credencial colada, que fica
 * fora do rascunho e de qualquer cache. A validação de verdade é a da API, que aponta o campo (`details.issues`).
 */

/** O rascunho do cadastro: as listas (regiões, zonas) como o texto digitado, uma por linha. */
export interface SpecDraft {
  provider?: unknown;
  accountId?: unknown;
  regions?: unknown;
  buckets?: Partial<Record<AwsLogBucketSource, unknown>>;
  zones?: unknown;
  pubsubSubscription?: unknown;
}

/** A credencial colada: só no estado do formulário, apagada depois do envio. */
export interface CredentialDraft {
  token: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** O conteúdo do arquivo JSON da chave da conta de serviço da GCP. */
  json: string;
}

export const EMPTY_CREDENTIAL: CredentialDraft = {
  token: '',
  accessKeyId: '',
  secretAccessKey: '',
  json: '',
};

const AWS_ACCOUNT = /^\d{12}$/;
const CLOUDFLARE_ACCOUNT = /^[0-9a-f]{32}$/;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** `sa-east-1`, `us-gov-west-1`: o formato que a API aceita (`isAwsRegion`). */
const AWS_REGION = /^[a-z]{2}(?:-(?:gov|iso|isob|isoe|isof))?-[a-z]{1,16}-\d$/;
const WAF_PREFIX = 'aws-waf-logs-';
/** A assinatura que os comandos da VM do cliente criam no projeto (`read-keys.ts`). */
export const GCP_DEFAULT_SUBSCRIPTION = 'verax-control-security';

export function isProvider(value: unknown): value is LogSourceProvider {
  return value === 'aws' || value === 'gcp' || value === 'cloudflare';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** As linhas (ou itens separados por vírgula ou espaço) de um campo de lista, sem repetir. */
export function listOf(value: unknown): string[] {
  return [
    ...new Set(
      text(value)
        .split(/[\s,;]+/)
        .filter((item) => item !== ''),
    ),
  ];
}

/** O nome do bucket como o cliente cola: sem `s3://`, sem o ARN e sem a barra do fim (`normalizeBucketName`). */
export function bucketName(value: unknown): string {
  let name = text(value);
  if (name.startsWith('s3://')) name = name.slice('s3://'.length);
  else {
    const arn = /^arn:[a-z-]+:s3:::/.exec(name);
    if (arn !== null) name = name.slice(arn[0].length);
  }
  return name.endsWith('/') ? name.slice(0, -1) : name;
}

/** Só o nome digitado vira o nome completo no projeto da conta (`qualifyPubsubSubscription`). */
export function qualifiedSubscription(projectId: string, value: unknown): string {
  const name = text(value);
  return name === '' || name.includes('/') ? name : `projects/${projectId}/subscriptions/${name}`;
}

function bucketsOf(draft: SpecDraft): Record<AwsLogBucketSource, string> {
  return {
    cloudtrail: bucketName(draft.buckets?.cloudtrail),
    guardduty: bucketName(draft.buckets?.guardduty),
    waf: bucketName(draft.buckets?.waf),
  };
}

function awsFieldIssues(
  regions: readonly string[],
  buckets: Record<AwsLogBucketSource, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (regions.length === 0) issues.push({ path: 'spec.regions', message: 'Informe ao menos uma região.' });
  const invalid = regions.filter((region) => !AWS_REGION.test(region));
  if (invalid.length > 0) {
    issues.push({
      path: 'spec.regions',
      message: `Região AWS inválida (${invalid.join(', ')}): use o código, como sa-east-1.`,
    });
  }
  if (buckets.waf !== '' && !buckets.waf.startsWith(WAF_PREFIX)) {
    issues.push({
      path: 'spec.buckets.waf',
      message: `O bucket do WAF começa com ${WAF_PREFIX}: a AWS só grava o log do WAF num bucket com esse começo.`,
    });
  }
  return issues;
}

/** O cadastro do rascunho, com os problemas que dá para ver antes de mandar. */
export function buildSpec(
  provider: LogSourceProvider,
  draft: SpecDraft,
): { spec: LogSourceSpec; issues: ValidationIssue[] } {
  const accountId = text(draft.accountId);
  switch (provider) {
    case 'aws': {
      const regions = listOf(draft.regions);
      const buckets = bucketsOf(draft);
      const filled: AwsLogBuckets = {};
      for (const source of BUCKET_SOURCES) if (buckets[source] !== '') filled[source] = buckets[source];
      const issues = awsFieldIssues(regions, buckets);
      if (!AWS_ACCOUNT.test(accountId)) {
        issues.unshift({ path: 'spec.accountId', message: 'O ID da conta AWS tem 12 dígitos.' });
      }
      return {
        spec: {
          provider,
          accountId,
          regions,
          ...(Object.keys(filled).length === 0 ? {} : { buckets: filled }),
        },
        issues,
      };
    }
    case 'cloudflare': {
      const zones = listOf(draft.zones).map((zone) => zone.toLowerCase());
      const issues: ValidationIssue[] = CLOUDFLARE_ACCOUNT.test(accountId)
        ? []
        : [
            {
              path: 'spec.accountId',
              message: 'O ID da conta do Cloudflare tem 32 caracteres hexadecimais (a URL do painel mostra).',
            },
          ];
      return { spec: { provider, accountId, ...(zones.length === 0 ? {} : { zones }) }, issues };
    }
    case 'gcp': {
      const subscription = qualifiedSubscription(accountId, draft.pubsubSubscription);
      const issues: ValidationIssue[] = GCP_PROJECT.test(accountId)
        ? []
        : [
            {
              path: 'spec.accountId',
              message: 'ID de projeto da GCP inválido: 6 a 30 caracteres, minúsculas, números e hífen.',
            },
          ];
      return {
        spec: { provider, accountId, ...(subscription === '' ? {} : { pubsubSubscription: subscription }) },
        issues,
      };
    }
  }
}

/** O rascunho da alteração, a partir do cadastro de hoje. */
export function draftOf(spec: LogSourceSpec): SpecDraft {
  switch (spec.provider) {
    case 'aws':
      return {
        provider: 'aws',
        accountId: spec.accountId,
        regions: spec.regions.join('\n'),
        buckets: {
          cloudtrail: spec.buckets?.cloudtrail ?? undefined,
          guardduty: spec.buckets?.guardduty ?? undefined,
          waf: spec.buckets?.waf ?? undefined,
        },
      };
    case 'cloudflare':
      return { provider: 'cloudflare', accountId: spec.accountId, zones: (spec.zones ?? []).join('\n') };
    case 'gcp':
      return {
        provider: 'gcp',
        accountId: spec.accountId,
        pubsubSubscription: spec.pubsubSubscription ?? undefined,
      };
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Só o que mudou, campo a campo (um bucket esvaziado vai como `null`, que o tira). */
export function buildUpdate(
  spec: LogSourceSpec,
  draft: SpecDraft,
): { update: LogSourceUpdateRequest; issues: ValidationIssue[] } {
  switch (spec.provider) {
    case 'aws': {
      const regions = listOf(draft.regions);
      const buckets = bucketsOf(draft);
      const update: LogSourceUpdateRequest = {};
      if (!sameList(regions, spec.regions)) update.regions = regions;
      const changed: AwsLogBuckets = {};
      for (const source of BUCKET_SOURCES) {
        const before = spec.buckets?.[source] ?? null;
        const after = buckets[source] === '' ? null : buckets[source];
        if (before !== after) changed[source] = after;
      }
      if (Object.keys(changed).length > 0) update.buckets = changed;
      return { update, issues: awsFieldIssues(regions, buckets) };
    }
    case 'cloudflare': {
      const zones = listOf(draft.zones).map((zone) => zone.toLowerCase());
      return { update: sameList(zones, spec.zones ?? []) ? {} : { zones }, issues: [] };
    }
    case 'gcp': {
      const subscription = qualifiedSubscription(spec.accountId, draft.pubsubSubscription);
      const before = spec.pubsubSubscription ?? null;
      const after = subscription === '' ? null : subscription;
      return { update: before === after ? {} : { pubsubSubscription: after }, issues: [] };
    }
  }
}

const GCP_KEY_MAX_LENGTH = 8192;
const GCP_KEY_FORMAT =
  'Chave da conta de serviço inválida: cole o conteúdo inteiro do arquivo JSON que o Google baixou ao criar a chave.';
const GCP_KEY_NOT_SERVICE_ACCOUNT =
  'Este arquivo não é a chave de uma conta de serviço (o campo type precisa ser service_account).';

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Do texto do arquivo da chave da GCP aos quatro campos que a API recebe (`gcpServiceAccountKeyFromJson`, como o
 * painel). O resto do arquivo nunca sai do navegador; a mensagem de erro nunca repete o conteúdo.
 */
export function gcpKeyFromJson(
  value: string,
):
  | { ok: true; input: Extract<LogSourceCredentialInput, { kind: 'gcp_service_account_key' }> }
  | { ok: false; message: string } {
  if (value.length > GCP_KEY_MAX_LENGTH) return { ok: false, message: GCP_KEY_FORMAT };
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return { ok: false, message: GCP_KEY_FORMAT };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, message: GCP_KEY_FORMAT };
  }
  const record = json as Record<string, unknown>;
  if (record['type'] !== 'service_account') return { ok: false, message: GCP_KEY_NOT_SERVICE_ACCOUNT };
  const projectId = stringField(record, 'project_id');
  const clientEmail = stringField(record, 'client_email');
  const privateKeyId = stringField(record, 'private_key_id');
  const privateKey = stringField(record, 'private_key');
  if (
    projectId === undefined ||
    clientEmail === undefined ||
    privateKeyId === undefined ||
    privateKey === undefined
  ) {
    return { ok: false, message: GCP_KEY_FORMAT };
  }
  return {
    ok: true,
    input: { kind: 'gcp_service_account_key', projectId, clientEmail, privateKeyId, privateKey },
  };
}

/** O campo da tela de cada parte da credencial (o arquivo da GCP é um campo só). */
export const CREDENTIAL_FIELD: Readonly<Record<string, string>> = {
  token: 'credential.token',
  accessKeyId: 'credential.accessKeyId',
  secretAccessKey: 'credential.secretAccessKey',
  projectId: 'credential.json',
  clientEmail: 'credential.json',
  privateKeyId: 'credential.json',
  privateKey: 'credential.json',
};

/**
 * A credencial do rascunho para o tipo do provedor: nada colado, nenhuma (`required` diz se falta); colada pela metade
 * ou fora do formato, o problema no campo.
 */
export function buildCredential(
  kind: CredentialKind,
  draft: CredentialDraft,
  required: boolean,
): { input?: LogSourceCredentialInput; issues: ValidationIssue[] } {
  switch (kind) {
    case 'cloudflare_api_token': {
      const token = draft.token.trim();
      if (token.length === 0) {
        return {
          issues: required ? [{ path: 'credential.token', message: 'Cole o token de API.' }] : [],
        };
      }
      return { input: { kind, token }, issues: [] };
    }
    case 'aws_access_key': {
      const accessKeyId = draft.accessKeyId.trim();
      const secretAccessKey = draft.secretAccessKey.trim();
      if (accessKeyId.length === 0 && secretAccessKey.length === 0 && !required) return { issues: [] };
      const issues: ValidationIssue[] = [];
      if (accessKeyId.length === 0)
        issues.push({ path: 'credential.accessKeyId', message: 'Cole o ID da chave de acesso.' });
      if (secretAccessKey.length === 0) {
        issues.push({ path: 'credential.secretAccessKey', message: 'Cole a chave secreta.' });
      }
      return issues.length > 0 ? { issues } : { input: { kind, accessKeyId, secretAccessKey }, issues };
    }
    case 'gcp_service_account_key': {
      const json = draft.json.trim();
      if (json === '') {
        return {
          issues: required
            ? [{ path: 'credential.json', message: 'Cole o conteúdo do arquivo JSON da chave.' }]
            : [],
        };
      }
      const parsed = gcpKeyFromJson(json);
      return parsed.ok
        ? { input: parsed.input, issues: [] }
        : { issues: [{ path: 'credential.json', message: parsed.message }] };
    }
  }
}

/**
 * Os problemas da API no lugar dos campos da tela: as listas num campo só (`spec.regions.2` vai para `spec.regions`),
 * as partes da chave da GCP no campo do arquivo e, na alteração e no envio da chave (que não têm `spec` nem
 * `credential` no corpo), o prefixo do formulário.
 */
export function issuesForForm(issues: readonly ValidationIssue[], prefix = ''): ValidationIssue[] {
  return issues.map((issue) => {
    let path = `${prefix}${issue.path}`;
    const list = /^(spec\.(?:regions|zones))\.\d+$/.exec(path);
    if (list?.[1] !== undefined) path = list[1];
    if (path.startsWith('credential.')) path = CREDENTIAL_FIELD[path.slice('credential.'.length)] ?? path;
    return { path, message: issue.message };
  });
}

/** Por que a chave não pode ser enviada a este cliente agora (o cp-admin recusa com o mesmo motivo). */
export function sealBlockReason(overview: NodeSyncOverview): string | undefined {
  const node = overview.node;
  if (node === null) {
    return 'O servidor do cliente ainda não sincronizou com a Verax: a chave só pode ser enviada depois disso (ela é cifrada para o cofre dele). Cadastre sem a chave; o cliente também pode colá-la no painel dele.';
  }
  if (node.platformMismatch) {
    return 'O servidor informou outra plataforma que a do lugar deste cliente: confira a instalação antes de enviar chaves.';
  }
  if (!node.vaultReady) {
    return 'O servidor do cliente está sem o cofre de credenciais pronto: não há para quem cifrar a chave. Confira a instalação; o cliente também pode colá-la no painel dele.';
  }
  return undefined;
}
