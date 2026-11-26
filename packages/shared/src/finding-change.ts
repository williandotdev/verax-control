import { z } from 'zod';

/**
 * A alteração registrada num evento do CloudTrail, reduzida ao que explica o alerta em português (seção "O que aconteceu"
 * do detalhe): o objeto alterado (nome e id da lista de IPs, da regra, do grupo, do bucket), o que mudou (a lista de
 * endereços, as regras, as portas abertas) e por onde a ação veio (uma função Lambda, o console, a linha de comando).
 *
 * - Só campos de uma lista fechada, evento por evento, são lidos do `requestParameters` e do `responseElements`; nada é
 *   copiado inteiro. Documentos de política, senhas, tokens, dados de usuário (`userData`), descrições livres, URLs e
 *   cabeçalhos nunca entram: da política sai só o que ela concede ("qualquer um", "tudo em tudo"), calculado aqui, e o
 *   documento é descartado.
 * - Cada texto é curto, de uma linha, sem caractere de controle e no formato do campo (id, nome, ARN, faixa de IP); o que
 *   não passa fica de fora. Cada lista tem teto de itens e guarda o total visto; o JSON inteiro tem teto em bytes
 *   (`MAX_FINDING_CHANGE_BYTES`), e as listas maiores são cortadas até caber.
 * - É gravado no achado na chegada (`Finding.change`, só nos alertas da trilha da AWS) e devolvido em
 *   `GET /v1/findings/:id/change`, com o estado anterior do mesmo objeto. O painel de um nó de antes (sem a rota) lê o mesmo
 *   formato do evento bruto, pela mesma função.
 *
 * Estrito nos campos e nos tetos, aberto nos códigos (o tipo do objeto, os nomes dos valores, a origem da ação): um código
 * novo de um nó mais novo não derruba o painel de antes, que só não tem o texto dele. Mudança de forma é outra `version`.
 *
 * Nada aqui usa `node:crypto` nem expressão regular sobre o texto do log fora dos schemas: o pacote também vai para o
 * navegador.
 */

export const FINDING_CHANGE_VERSION = 1 as const;
/** Teto do JSON da alteração, em bytes UTF-8 (o mesmo do CHECK da coluna). */
export const MAX_FINDING_CHANGE_BYTES = 16 * 1024;
/** Endereços guardados de uma lista de IPs do WAF: acima disso, a lista é cortada e a comparação não é feita. */
export const MAX_CHANGE_ADDRESSES = 300;
/** Itens das outras listas (regras do WAF, permissões do grupo de segurança, operações). */
export const MAX_CHANGE_LIST_ITEMS = 100;
/** O maior texto de um item de lista. */
export const MAX_CHANGE_ITEM_LENGTH = 160;
/** O maior texto de um valor. */
export const MAX_CHANGE_VALUE_LENGTH = 512;
/** Valores e listas por alteração. */
export const MAX_CHANGE_VALUES = 16;
export const MAX_CHANGE_LISTS = 4;
/** O maior documento de política lido para saber o que ele concede (o resto é ignorado). */
const MAX_POLICY_LENGTH = 64 * 1024;

const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f);
const hasControl = (value: string): boolean => [...value].some((char) => isControl(char.charCodeAt(0)));

/** Texto de uma linha, sem caractere de controle (nem quebra de linha). */
const lineText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasControl(value));

/** Um código: minúscula no começo, letras e algarismos. */
const codeSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/);

const changeValueSchema = z.union([lineText(MAX_CHANGE_VALUE_LENGTH), z.number().finite(), z.boolean()]);
export type FindingChangeValue = z.infer<typeof changeValueSchema>;

const changeListSchema = z
  .strictObject({
    items: z
      .array(lineText(MAX_CHANGE_ITEM_LENGTH))
      .max(Math.max(MAX_CHANGE_ADDRESSES, MAX_CHANGE_LIST_ITEMS)),
    /** Quantos itens o evento trazia: maior que `items.length` quando a lista foi cortada. */
    total: z.int().min(0).max(1_000_000),
  })
  .refine((list) => list.items.length <= list.total, { error: 'a lista tem mais itens que o total' });
export type FindingChangeList = z.infer<typeof changeListSchema>;

const boundedRecord = <T extends z.ZodType>(value: T, max: number) =>
  z
    .record(codeSchema, value)
    .refine((record) => Object.keys(record).length <= max, { error: `no máximo ${max} chaves` });

export const findingChangeSchema = z
  .strictObject({
    version: z.literal(FINDING_CHANGE_VERSION),
    /** O serviço que recebeu a chamada (`wafv2.amazonaws.com`). */
    eventSource: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,127}$/),
    eventName: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
    /** A AWS recusou a chamada (`errorCode`): nada mudou. */
    failed: z.boolean().optional(),
    /**
     * Por onde a ação veio, pelo `userAgent`, pelo `invokedBy` e pelo nome da sessão (`lambda`, `ecs`, `ec2`,
     * `aws_service`, `cloudformation`, `console`, `cli`, `sdk`, `terraform`), e o serviço da AWS que chamou em nome de
     * alguém. O texto do `userAgent` não é guardado.
     */
    via: codeSchema.optional(),
    invokedBy: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{2,127}$/)
      .optional(),
    /** O objeto alterado: o tipo (`waf_ip_set`, `security_group`, `s3_bucket`...), o id, o nome e o escopo. */
    target: z
      .strictObject({
        kind: codeSchema,
        id: lineText(256).optional(),
        name: lineText(256).optional(),
        scope: lineText(32).optional(),
      })
      .optional(),
    values: boundedRecord(changeValueSchema, MAX_CHANGE_VALUES).optional(),
    lists: boundedRecord(changeListSchema, MAX_CHANGE_LISTS).optional(),
  })
  .refine((change) => changeBytes(change) <= MAX_FINDING_CHANGE_BYTES, {
    error: `a alteração passa de ${MAX_FINDING_CHANGE_BYTES} bytes`,
  });
export type FindingChange = z.infer<typeof findingChangeSchema>;

/**
 * A resposta de `GET /v1/findings/:id/change`: a alteração gravada no alerta (ou `null`, no alerta gravado antes dela ou
 * que não é da trilha), o estado anterior conhecido do mesmo objeto (o alerta anterior da mesma lista de IPs, da mesma Web
 * ACL ou do mesmo grupo de regras, no mesmo cliente e na mesma conta) e quantas vezes a mesma identidade disparou a mesma
 * regra nos últimos dias. Rota à parte do detalhe: o contrato dele é estrito, e o nó de antes responde 404.
 */
export const FINDING_CHANGE_REPEAT_DAYS = 30;

export const findingChangeContextSchema = z.strictObject({
  change: findingChangeSchema.nullable(),
  previous: z
    .strictObject({
      findingId: z.uuid(),
      occurredAt: z.iso.datetime(),
      change: findingChangeSchema,
    })
    .nullable(),
  repeats: z.strictObject({
    days: z.int().min(1).max(365),
    count: z.int().min(0),
  }),
});
export type FindingChangeContext = z.infer<typeof findingChangeContextSchema>;

/** Vírgulas e dois-pontos da estrutura: o `jsonb` escreve um espaço depois de cada um (como o CHECK mede). */
function separators(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const items: unknown[] = Object.values(value);
  const own = Array.isArray(value) ? Math.max(0, items.length - 1) : Math.max(0, 2 * items.length - 1);
  return items.reduce((sum: number, item) => sum + separators(item), own);
}

/** O tamanho do JSON como o banco o mede (`octet_length("change"::text)`), sem depender do `Buffer` do Node. */
export function changeBytes(change: unknown): number {
  return utf8Length(JSON.stringify(change)) + separators(change);
}

/** Bytes em UTF-8, por ponto de código (o pacote não tem os tipos do `TextEncoder` nem do `Buffer`). */
function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// ---------------------------------------------------------------------------------------------------------------------
// Leitura do evento

/**
 * Lê um caminho no evento. Numa lista, segue o primeiro item (o Wazuh transforma listas de um item em objeto). Só lê:
 * cada passo pega a propriedade própria pelo descritor, sem passar pelo protótipo nem chamar getter.
 */
function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current)) current = current[0];
    if (current === null || typeof current !== 'object') return undefined;
    current = Object.getOwnPropertyDescriptor(current, key)?.value;
  }
  return current;
}

/** Como `at`, mas o nome do campo sem diferenciar maiúsculas (o `ModifySecurityGroupRules` usa `IpProtocol`). */
function atAnyCase(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const wanted = key.toLowerCase();
  const found = Object.keys(value).find((name) => name.toLowerCase() === wanted);
  return found === undefined ? undefined : Object.getOwnPropertyDescriptor(value, found)?.value;
}

/** A lista, como o Wazuh a grava: a própria lista, o item sozinho (lista de um) ou `{ items: [...] }` da EC2. */
function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    const items = atAnyCase(value, 'items');
    if (items !== undefined) return listOf(items);
    return Object.keys(value).length === 0 ? [] : [value];
  }
  return [value];
}

function safe<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Texto curto de uma linha, sem caractere de controle. O número que o Wazuh gravou como texto continua texto. */
function text(value: unknown, max = 256): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.length > 0 && value.length <= max && !hasControl(value)
    ? value
    : undefined;
}

/** Os formatos de cada campo guardado. Os padrões são ancorados, com classes de caracteres e tamanho limitado. */
const FORMATS = {
  /** Nome de recurso da AWS: letras, algarismos e os símbolos que os serviços aceitam em nomes. */
  name: z.string().regex(/^[A-Za-z0-9 _.@+=,:/#-]{1,256}$/),
  id: z.string().regex(/^[A-Za-z0-9_.:/=+-]{1,256}$/),
  arn: z.string().regex(/^arn:aws[A-Za-z0-9_.:/=+@*,-]{4,1100}$/),
  /** Uma faixa de IP (v4 ou v6, com ou sem máscara). */
  cidr: z.string().regex(/^[0-9A-Fa-f.:/]{2,49}$/),
  scope: z.enum(['REGIONAL', 'CLOUDFRONT']),
  accessKey: z.string().regex(/^(AKIA|ASIA)[A-Z0-9]{12,124}$/),
  /** Um serviço da AWS pelo domínio (`lambda.amazonaws.com`): um IP nunca passa. */
  service: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{2,127}$/)
    .refine((value) => value.endsWith('.amazonaws.com')),
  protocol: z.string().regex(/^(-1|all|tcp|udp|icmp|icmpv6|\d{1,3})$/i),
  port: z.union([z.number().int().min(-1).max(65_535), z.string().regex(/^-?\d{1,5}$/)]).transform(Number),
  days: z.union([z.number().int().min(0).max(36_500), z.string().regex(/^\d{1,5}$/)]).transform(Number),
} as const;

const fmt = (format: keyof typeof FORMATS, value: unknown): string | undefined => {
  const found = text(value, 1100);
  return found === undefined ? undefined : (safe(FORMATS[format] as z.ZodType<string>, found) ?? undefined);
};

/** O booleano como a AWS grava e como o Wazuh o transforma em texto (`"true"`, `"false"`). */
function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** O documento de política, como objeto ou como texto JSON (o IAM grava texto; o S3, objeto). */
function policyDocument(value: unknown): unknown {
  if (typeof value === 'object' && value !== null) return value;
  if (typeof value !== 'string' || value.length > MAX_POLICY_LENGTH) return undefined;
  let decoded = value;
  // O IAM grava o documento codificado como URL (`%7B%22Version...`).
  if (value.startsWith('%7B')) {
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    return undefined;
  }
}

const isStar = (value: unknown): boolean => listOf(value).some((item) => item === '*');

/** Alguma declaração `Allow` sem condição vale para qualquer um (`Principal: "*"` ou `{ AWS: "*" }`)? */
export function grantsAnyone(document: unknown): boolean {
  return listOf(at(document, 'Statement')).some((statement) => {
    if (at(statement, 'Effect') !== 'Allow' || at(statement, 'Condition') !== undefined) return false;
    const principal = at(statement, 'Principal');
    return principal === '*' || isStar(atAnyCase(principal, 'AWS'));
  });
}

/** Alguma declaração `Allow` dá toda ação em todo recurso (`Action: "*"` e `Resource: "*"`)? */
export function grantsEverything(document: unknown): boolean {
  return listOf(at(document, 'Statement')).some(
    (statement) =>
      at(statement, 'Effect') === 'Allow' &&
      isStar(at(statement, 'Action')) &&
      isStar(at(statement, 'Resource')),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Montagem

type Values = Record<string, FindingChangeValue>;
type Lists = Record<string, FindingChangeList>;

interface Parts {
  target?: FindingChange['target'];
  values?: Values;
  lists?: Lists;
}

function compactValues(values: Record<string, FindingChangeValue | undefined>): Values | undefined {
  const kept = Object.entries(values).filter(
    (entry): entry is [string, FindingChangeValue] => entry[1] !== undefined,
  );
  return kept.length === 0 ? undefined : Object.fromEntries(kept.slice(0, MAX_CHANGE_VALUES));
}

function target(
  kind: string,
  fields: { id?: string | undefined; name?: string | undefined; scope?: string | undefined },
): FindingChange['target'] {
  return {
    kind,
    ...(fields.id !== undefined && { id: fields.id }),
    ...(fields.name !== undefined && { name: fields.name }),
    ...(fields.scope !== undefined && { scope: fields.scope }),
  };
}

/** Uma lista com teto: os itens válidos, sem repetição, na ordem do evento; o total é o de itens válidos. */
function boundedList(items: readonly (string | undefined)[], max: number): FindingChangeList {
  const unique = [...new Set(items.filter((item): item is string => item !== undefined))];
  return { items: unique.slice(0, max), total: unique.length };
}

const normalizeCidr = (value: string): string => value.toLowerCase();

// ---- WAF

const WAF_ACTIONS = ['Allow', 'Block', 'Count', 'Captcha', 'Challenge'] as const;

/** A ação de uma regra do WAF v2 (`{ Block: {} }`) ou a substituição do grupo (`overrideAction: { Count: {} }`). */
function wafRuleAction(rule: unknown): string | undefined {
  const action = atAnyCase(rule, 'action');
  const found = WAF_ACTIONS.find((name) => atAnyCase(action, name) !== undefined);
  if (found !== undefined) return found;
  const override = atAnyCase(rule, 'overrideAction');
  if (atAnyCase(override, 'Count') !== undefined) return 'Count';
  if (atAnyCase(override, 'None') !== undefined) return 'Group';
  return undefined;
}

/** Cada regra como `nome|ação`, para comparar com o estado anterior por nome. */
function wafRules(value: unknown): FindingChangeList {
  return boundedList(
    listOf(value).map((rule) => {
      const name = fmt('name', atAnyCase(rule, 'name'));
      if (name === undefined) return undefined;
      const action = wafRuleAction(rule);
      return action === undefined ? name : `${name}|${action}`;
    }),
    MAX_CHANGE_LIST_ITEMS,
  );
}

function wafV2(event: string, params: unknown): Parts | null {
  const fields = {
    id: fmt('id', at(params, 'id')),
    name: fmt('name', at(params, 'name')),
    scope: fmt('scope', at(params, 'scope')),
  };
  switch (event) {
    case 'UpdateIPSet':
    case 'CreateIPSet': {
      const addresses = boundedList(
        listOf(at(params, 'addresses')).map((item) => {
          const cidr = fmt('cidr', item);
          return cidr && normalizeCidr(cidr);
        }),
        MAX_CHANGE_ADDRESSES,
      );
      return { target: target('waf_ip_set', fields), lists: { addresses } };
    }
    case 'DeleteIPSet':
      return { target: target('waf_ip_set', fields) };
    case 'UpdateWebACL':
    case 'CreateWebACL': {
      const defaultAction = WAF_ACTIONS.find(
        (name) => atAnyCase(at(params, 'defaultAction'), name) !== undefined,
      );
      return {
        target: target('waf_web_acl', fields),
        values: compactValues({ defaultAction }),
        lists: { rules: wafRules(at(params, 'rules')) },
      };
    }
    case 'DeleteWebACL':
      return { target: target('waf_web_acl', fields) };
    case 'UpdateRuleGroup':
    case 'CreateRuleGroup':
      return { target: target('waf_rule_group', fields), lists: { rules: wafRules(at(params, 'rules')) } };
    case 'DeleteRuleGroup':
      return { target: target('waf_rule_group', fields) };
    case 'AssociateWebACL':
    case 'DisassociateWebACL':
      return {
        target: target('waf_web_acl', { id: fmt('arn', at(params, 'webACLArn')) }),
        values: compactValues({ resourceArn: fmt('arn', at(params, 'resourceArn')) }),
      };
    case 'DeleteLoggingConfiguration':
    case 'PutLoggingConfiguration':
      return {
        target: target('waf_web_acl', {
          id:
            fmt('arn', at(params, 'resourceArn')) ??
            fmt('arn', at(params, 'loggingConfiguration', 'resourceArn')),
        }),
      };
    default:
      return null;
  }
}

/** WAF clássico: a alteração já vem como operações (`INSERT`/`DELETE`), sem a lista inteira. */
function wafClassic(event: string, params: unknown): Parts | null {
  const updates = listOf(at(params, 'updates'));
  const split = (pick: (update: unknown) => string | undefined) => {
    const added = updates.map((update) => (at(update, 'action') === 'INSERT' ? pick(update) : undefined));
    const removed = updates.map((update) => (at(update, 'action') === 'DELETE' ? pick(update) : undefined));
    return {
      added: boundedList(added, MAX_CHANGE_ADDRESSES),
      removed: boundedList(removed, MAX_CHANGE_ADDRESSES),
    };
  };
  switch (event) {
    case 'UpdateIPSet':
      return {
        target: target('waf_ip_set', { id: fmt('id', at(params, 'iPSetId')) }),
        lists: split((update) => {
          const cidr = fmt('cidr', at(update, 'iPSetDescriptor', 'value'));
          return cidr && normalizeCidr(cidr);
        }),
      };
    case 'DeleteIPSet':
      return { target: target('waf_ip_set', { id: fmt('id', at(params, 'iPSetId')) }) };
    case 'UpdateWebACL':
      return {
        target: target('waf_web_acl', { id: fmt('id', at(params, 'webACLId')) }),
        lists: split((update) => fmt('id', at(update, 'activatedRule', 'ruleId'))),
      };
    case 'DeleteWebACL':
      return { target: target('waf_web_acl', { id: fmt('id', at(params, 'webACLId')) }) };
    case 'UpdateRuleGroup':
    case 'DeleteRuleGroup':
      return { target: target('waf_rule_group', { id: fmt('id', at(params, 'ruleGroupId')) }) };
    default:
      return null;
  }
}

// ---- IAM

function iamTarget(params: unknown): FindingChange['target'] | undefined {
  const user = fmt('name', at(params, 'userName'));
  if (user !== undefined) return target('iam_user', { name: user });
  const role = fmt('name', at(params, 'roleName'));
  if (role !== undefined) return target('iam_role', { name: role });
  const group = fmt('name', at(params, 'groupName'));
  if (group !== undefined) return target('iam_group', { name: group });
  return undefined;
}

function iam(event: string, params: unknown, response: unknown): Parts | null {
  const subject = iamTarget(params);
  const policyArn = fmt('arn', at(params, 'policyArn'));
  switch (event) {
    case 'CreateAccessKey':
      return {
        target: subject ?? target('iam_user', {}),
        values: compactValues({
          createdAccessKeyId: fmt('accessKey', at(response, 'accessKey', 'accessKeyId')),
        }),
      };
    case 'DeleteAccessKey':
    case 'UpdateAccessKey':
      return {
        target: subject ?? target('iam_user', {}),
        values: compactValues({
          accessKeyId: fmt('accessKey', at(params, 'accessKeyId')),
          status: fmt('name', at(params, 'status')),
        }),
      };
    case 'AttachUserPolicy':
    case 'AttachRolePolicy':
    case 'AttachGroupPolicy':
    case 'DetachUserPolicy':
    case 'DetachRolePolicy':
    case 'DetachGroupPolicy':
      return { ...(subject && { target: subject }), values: compactValues({ policyArn }) };
    case 'PutUserPolicy':
    case 'PutRolePolicy':
    case 'PutGroupPolicy': {
      const document = policyDocument(at(params, 'policyDocument'));
      return {
        ...(subject && { target: subject }),
        values: compactValues({
          policyName: fmt('name', at(params, 'policyName')),
          grantsEverything: document === undefined ? undefined : grantsEverything(document),
        }),
      };
    }
    case 'DeleteUserPolicy':
    case 'DeleteRolePolicy':
    case 'DeleteGroupPolicy':
      return {
        ...(subject && { target: subject }),
        values: compactValues({ policyName: fmt('name', at(params, 'policyName')) }),
      };
    case 'CreatePolicyVersion':
    case 'SetDefaultPolicyVersion': {
      const document = policyDocument(at(params, 'policyDocument'));
      return {
        target: target('iam_policy', { id: policyArn }),
        values: compactValues({
          setAsDefault: event === 'SetDefaultPolicyVersion' ? true : bool(at(params, 'setAsDefault')),
          grantsEverything: document === undefined ? undefined : grantsEverything(document),
        }),
      };
    }
    case 'CreateRole':
    case 'UpdateAssumeRolePolicy': {
      const document = policyDocument(
        at(params, event === 'CreateRole' ? 'assumeRolePolicyDocument' : 'policyDocument'),
      );
      return {
        ...(subject && { target: subject }),
        values: compactValues({ trustsAnyone: document === undefined ? undefined : grantsAnyone(document) }),
      };
    }
    case 'CreateUser':
    case 'DeleteUser':
    case 'DeleteRole':
    case 'UpdateRole':
    case 'DeleteLoginProfile':
      return subject ? { target: subject } : {};
    case 'CreateLoginProfile':
    case 'UpdateLoginProfile':
      // A senha nunca é lida; a AWS já a omite do log.
      return {
        target: subject ?? target('iam_user', {}),
        values: compactValues({ passwordResetRequired: bool(at(params, 'passwordResetRequired')) }),
      };
    case 'AddUserToGroup':
    case 'RemoveUserFromGroup':
      return {
        target: target('iam_group', { name: fmt('name', at(params, 'groupName')) }),
        values: compactValues({ userName: fmt('name', at(params, 'userName')) }),
      };
    case 'DeactivateMFADevice':
    case 'DeleteVirtualMFADevice':
      return { target: subject ?? target('iam_user', {}) };
    default:
      return null;
  }
}

// ---- EC2

/** Uma permissão do grupo como `protocolo|de|até|faixa`, para cada faixa. */
function permissionItems(permission: unknown): string[] {
  const protocol = fmt('protocol', atAnyCase(permission, 'ipProtocol'))?.toLowerCase();
  if (protocol === undefined) return [];
  const from = safe(FORMATS.port, atAnyCase(permission, 'fromPort'));
  const to = safe(FORMATS.port, atAnyCase(permission, 'toPort'));
  const ports = `${from ?? ''}|${to ?? from ?? ''}`;
  const ranges = [
    ...listOf(atAnyCase(permission, 'ipRanges')).map((range) => fmt('cidr', atAnyCase(range, 'cidrIp'))),
    ...listOf(atAnyCase(permission, 'ipv6Ranges')).map((range) => fmt('cidr', atAnyCase(range, 'cidrIpv6'))),
    fmt('cidr', atAnyCase(permission, 'cidrIpv4')),
    fmt('cidr', atAnyCase(permission, 'cidrIpv6')),
    fmt('cidr', atAnyCase(permission, 'cidrIp')),
  ].filter((range): range is string => range !== undefined);
  const groups = listOf(atAnyCase(permission, 'groups'))
    .map((group) => fmt('id', atAnyCase(group, 'groupId')))
    .concat(fmt('id', atAnyCase(permission, 'referencedGroupId')))
    .filter((group): group is string => group !== undefined);
  const sources = [...ranges.map(normalizeCidr), ...groups];
  return (sources.length === 0 ? [''] : sources).map((source) => `${protocol}|${ports}|${source}`);
}

function ec2(event: string, params: unknown): Parts | null {
  switch (event) {
    case 'AuthorizeSecurityGroupIngress':
    case 'AuthorizeSecurityGroupEgress':
    case 'RevokeSecurityGroupIngress':
    case 'RevokeSecurityGroupEgress': {
      const permissions = listOf(at(params, 'ipPermissions')).flatMap(permissionItems);
      return {
        target: target('security_group', {
          id: fmt('id', at(params, 'groupId')),
          name: fmt('name', at(params, 'groupName')),
        }),
        lists: { permissions: boundedList(permissions, MAX_CHANGE_LIST_ITEMS) },
      };
    }
    case 'ModifySecurityGroupRules': {
      const request = atAnyCase(params, 'ModifySecurityGroupRulesRequest') ?? params;
      const rules = listOf(atAnyCase(request, 'SecurityGroupRule')).flatMap((rule) =>
        permissionItems(atAnyCase(rule, 'SecurityGroupRule') ?? rule),
      );
      return {
        target: target('security_group', { id: fmt('id', atAnyCase(request, 'GroupId')) }),
        lists: { permissions: boundedList(rules, MAX_CHANGE_LIST_ITEMS) },
      };
    }
    case 'ModifySnapshotAttribute':
    case 'ModifyImageAttribute': {
      const attribute = at(
        params,
        event === 'ModifySnapshotAttribute' ? 'createVolumePermission' : 'launchPermission',
      );
      const added = listOf(at(attribute, 'add'));
      return {
        target:
          event === 'ModifySnapshotAttribute'
            ? target('ebs_snapshot', { id: fmt('id', at(params, 'snapshotId')) })
            : target('ami', { id: fmt('id', at(params, 'imageId')) }),
        values: compactValues({ madePublic: added.some((item) => atAnyCase(item, 'group') === 'all') }),
      };
    }
    default:
      return null;
  }
}

function rds(event: string, params: unknown): Parts | null {
  if (event !== 'ModifyDBSnapshotAttribute' && event !== 'ModifyDBClusterSnapshotAttribute') return null;
  const id =
    fmt('id', at(params, 'dBSnapshotIdentifier')) ?? fmt('id', at(params, 'dBClusterSnapshotIdentifier'));
  return {
    target: target('rds_snapshot', { id }),
    values: compactValues({ madePublic: listOf(at(params, 'valuesToAdd')).includes('all') }),
  };
}

// ---- S3

const PUBLIC_ACLS = new Set(['public-read', 'public-read-write', 'authenticated-read']);
const PUBLIC_GROUPS = new Set([
  'http://acs.amazonaws.com/groups/global/AllUsers',
  'https://acs.amazonaws.com/groups/global/AllUsers',
  'http://acs.amazonaws.com/groups/global/AuthenticatedUsers',
  'https://acs.amazonaws.com/groups/global/AuthenticatedUsers',
]);
const ACCESS_BLOCK_FLAGS = [
  'BlockPublicAcls',
  'IgnorePublicAcls',
  'BlockPublicPolicy',
  'RestrictPublicBuckets',
];

function s3(event: string, params: unknown): Parts | null {
  const bucket = target('s3_bucket', { name: fmt('name', at(params, 'bucketName')) });
  switch (event) {
    case 'PutBucketPolicy': {
      const document = policyDocument(at(params, 'bucketPolicy'));
      return {
        target: bucket,
        values: compactValues({
          grantsAnyone: document === undefined ? undefined : grantsAnyone(document),
          statements: document === undefined ? undefined : listOf(at(document, 'Statement')).length,
        }),
      };
    }
    case 'DeleteBucketPolicy':
    case 'DeleteBucketPublicAccessBlock':
    case 'DeleteBucket':
      return { target: bucket };
    case 'PutBucketAcl': {
      const canned = listOf(at(params, 'x-amz-acl')).some(
        (acl) => typeof acl === 'string' && PUBLIC_ACLS.has(acl),
      );
      const grants = listOf(at(params, 'AccessControlPolicy', 'AccessControlList', 'Grant')).some((grant) => {
        const uri = at(grant, 'Grantee', 'URI');
        return typeof uri === 'string' && PUBLIC_GROUPS.has(uri);
      });
      return { target: bucket, values: compactValues({ grantsAnyone: canned || grants }) };
    }
    case 'PutBucketPublicAccessBlock': {
      const config = at(params, 'PublicAccessBlockConfiguration');
      const off = ACCESS_BLOCK_FLAGS.filter((flag) => bool(at(config, flag)) === false);
      return { target: bucket, lists: { disabledBlocks: boundedList(off, ACCESS_BLOCK_FLAGS.length) } };
    }
    default:
      return null;
  }
}

// ---- CloudTrail, GuardDuty, KMS, Organizations, domínios, login

function cloudTrail(event: string, params: unknown): Parts | null {
  switch (event) {
    case 'StopLogging':
    case 'DeleteTrail':
    case 'UpdateTrail':
    case 'PutEventSelectors':
    case 'StartLogging': {
      const name =
        fmt('arn', at(params, 'name')) ??
        fmt('name', at(params, 'name')) ??
        fmt('arn', at(params, 'trailName'));
      return { target: target('cloudtrail_trail', { name }) };
    }
    case 'DeleteEventDataStore':
    case 'StopEventDataStoreIngestion':
      return {
        target: target('cloudtrail_data_store', {
          id: fmt('arn', at(params, 'eventDataStore')) ?? fmt('id', at(params, 'eventDataStore')),
        }),
      };
    default:
      return null;
  }
}

function guardDuty(event: string, params: unknown): Parts | null {
  const detector = fmt('id', at(params, 'detectorId'));
  switch (event) {
    case 'DeleteDetector':
    case 'DisassociateFromMasterAccount':
    case 'DisassociateFromAdministratorAccount':
    case 'DisassociateMembers':
    case 'DeletePublishingDestination':
    case 'UpdatePublishingDestination':
      return { target: target('guardduty_detector', { id: detector }) };
    case 'UpdateDetector':
      return {
        target: target('guardduty_detector', { id: detector }),
        values: compactValues({ enable: bool(at(params, 'enable')) }),
      };
    case 'CreateFilter':
    case 'UpdateFilter':
      return {
        target: target('guardduty_filter', {
          name: fmt('name', at(params, 'name')) ?? fmt('name', at(params, 'filterName')),
        }),
        values: compactValues({ action: fmt('name', at(params, 'action')) }),
      };
    case 'CreateIPSet':
    case 'UpdateIPSet':
    case 'CreateThreatIntelSet':
    case 'UpdateThreatIntelSet':
      // A localização (uma URL do S3) não é guardada.
      return {
        target: target(event.includes('IPSet') ? 'guardduty_ip_set' : 'guardduty_threat_list', {
          id: fmt('id', at(params, 'ipSetId')) ?? fmt('id', at(params, 'threatIntelSetId')),
          name: fmt('name', at(params, 'name')),
        }),
        values: compactValues({ activate: bool(at(params, 'activate')) }),
      };
    default:
      return null;
  }
}

function kms(event: string, params: unknown): Parts | null {
  const key = fmt('arn', at(params, 'keyId')) ?? fmt('id', at(params, 'keyId'));
  switch (event) {
    case 'DisableKey':
    case 'EnableKey':
    case 'CancelKeyDeletion':
    case 'DisableKeyRotation':
      return { target: target('kms_key', { id: key }) };
    case 'ScheduleKeyDeletion':
      return {
        target: target('kms_key', { id: key }),
        values: compactValues({ pendingWindowInDays: safe(FORMATS.days, at(params, 'pendingWindowInDays')) }),
      };
    case 'PutKeyPolicy': {
      const document = policyDocument(at(params, 'policy'));
      return {
        target: target('kms_key', { id: key }),
        values: compactValues({ grantsAnyone: document === undefined ? undefined : grantsAnyone(document) }),
      };
    }
    case 'CreateGrant':
      return {
        target: target('kms_key', { id: key }),
        values: compactValues({ grantee: fmt('arn', at(params, 'granteePrincipal')) }),
        lists: {
          operations: boundedList(
            listOf(at(params, 'operations')).map((operation) => fmt('id', operation)),
            MAX_CHANGE_LIST_ITEMS,
          ),
        },
      };
    default:
      return null;
  }
}

function signin(event: string, response: unknown, extra: unknown): Parts | null {
  if (event !== 'ConsoleLogin') return null;
  return {
    values: compactValues({
      result: fmt('name', at(response, 'ConsoleLogin')),
      mfaUsed: fmt('name', at(extra, 'MFAUsed')),
    }),
  };
}

function organizations(event: string, params: unknown): Parts | null {
  switch (event) {
    case 'LeaveOrganization':
      return {};
    case 'DetachPolicy':
    case 'DeletePolicy':
      return {
        target: target('org_policy', { id: fmt('id', at(params, 'policyId')) }),
        values: compactValues({ targetId: fmt('id', at(params, 'targetId')) }),
      };
    case 'DisablePolicyType':
      return { values: compactValues({ policyType: fmt('name', at(params, 'policyType')) }) };
    default:
      return null;
  }
}

function domains(event: string, params: unknown): Parts | null {
  if (
    !['TransferDomainToAnotherAwsAccount', 'DisableDomainTransferLock', 'UpdateDomainNameservers'].includes(
      event,
    )
  ) {
    return null;
  }
  return { target: target('domain', { name: fmt('name', at(params, 'domainName')) }) };
}

const EXTRACTORS: Readonly<
  Record<string, (event: string, params: unknown, response: unknown, extra: unknown) => Parts | null>
> = {
  'wafv2.amazonaws.com': (event, params) => wafV2(event, params),
  'waf.amazonaws.com': (event, params) => wafClassic(event, params),
  'waf-regional.amazonaws.com': (event, params) => wafClassic(event, params),
  'iam.amazonaws.com': (event, params, response) => iam(event, params, response),
  'ec2.amazonaws.com': (event, params) => ec2(event, params),
  'rds.amazonaws.com': (event, params) => rds(event, params),
  's3.amazonaws.com': (event, params) => s3(event, params),
  'cloudtrail.amazonaws.com': (event, params) => cloudTrail(event, params),
  'guardduty.amazonaws.com': (event, params) => guardDuty(event, params),
  'kms.amazonaws.com': (event, params) => kms(event, params),
  'signin.amazonaws.com': (event, _params, response, extra) => signin(event, response, extra),
  'organizations.amazonaws.com': (event, params) => organizations(event, params),
  'route53domains.amazonaws.com': (event, params) => domains(event, params),
};

/**
 * Por onde a ação veio, sem guardar o `userAgent`: a função Lambda (o ambiente de execução se anuncia no `userAgent`), o
 * ECS, a instância EC2 (a sessão do papel leva o id dela), o serviço da AWS que chamou em nome de alguém (`invokedBy`), o
 * CloudFormation, o console, a linha de comando, o Terraform ou um SDK.
 */
function viaOf(aws: unknown): { via?: string; invokedBy?: string } {
  const agent =
    typeof at(aws, 'userAgent') === 'string' ? (at(aws, 'userAgent') as string).slice(0, 1024) : '';
  const invokedBy = fmt('service', at(aws, 'userIdentity', 'invokedBy'));
  const sourceService = fmt('service', at(aws, 'sourceIPAddress'));
  const service = invokedBy ?? sourceService;
  const arn = text(at(aws, 'userIdentity', 'arn'), 2048) ?? '';
  const session = arn.includes(':assumed-role/') ? (arn.split('/').at(-1) ?? '') : '';
  const lower = agent.toLowerCase();
  const via = ((): string | undefined => {
    if (agent.includes('AWS_Lambda_') || lower.includes('exec-env/aws_lambda')) return 'lambda';
    if (agent.includes('AWS_ECS_') || lower.includes('exec-env/aws_ecs')) return 'ecs';
    if (service === 'cloudformation.amazonaws.com' || lower.includes('cloudformation'))
      return 'cloudformation';
    if (lower.includes('terraform')) return 'terraform';
    if (session.length > 2 && session.startsWith('i-') && safe(FORMATS.id, session) !== undefined)
      return 'ec2';
    if (service !== undefined && service !== 'signin.amazonaws.com') return 'aws_service';
    if (
      lower.startsWith('console.amazonaws.com') ||
      lower.startsWith('aws internal') ||
      lower.startsWith('mozilla/') ||
      at(aws, 'eventName') === 'ConsoleLogin' ||
      at(aws, 'sessionCredentialFromConsole') === 'true'
    ) {
      return 'console';
    }
    if (lower.startsWith('aws-cli/')) return 'cli';
    if (lower.startsWith('boto3/') || lower.startsWith('botocore/') || lower.startsWith('aws-sdk-'))
      return 'sdk';
    return undefined;
  })();
  return {
    ...(via !== undefined && { via }),
    ...(service !== undefined && via === 'aws_service' && { invokedBy: service }),
  };
}

/**
 * Corta as listas maiores pela metade até o JSON caber no teto. O total continua o do evento: quem lê sabe que a lista
 * está incompleta.
 */
function fitInBudget(change: FindingChange): FindingChange {
  let current = change;
  for (let round = 0; round < 32 && changeBytes(current) > MAX_FINDING_CHANGE_BYTES; round++) {
    const lists = current.lists;
    if (lists === undefined) break;
    const [largest] = Object.entries(lists).sort((a, b) => b[1].items.length - a[1].items.length);
    if (largest === undefined || largest[1].items.length === 0) break;
    const [name, list] = largest;
    current = {
      ...current,
      lists: { ...lists, [name]: { ...list, items: list.items.slice(0, Math.floor(list.items.length / 2)) } },
    };
  }
  return current;
}

/**
 * A alteração de um evento do CloudTrail (o `data.aws` do alerta do Wazuh, ou o próprio registro da trilha), ou `null`
 * quando o evento não é de um serviço e de uma chamada conhecidos. Nunca lança: o que não está no formato fica de fora.
 */
export function extractFindingChange(aws: unknown): FindingChange | null {
  const eventSource = fmt('service', at(aws, 'eventSource'));
  const eventName = text(at(aws, 'eventName'), 64);
  if (eventSource === undefined || eventName === undefined) return null;
  const extractor = EXTRACTORS[eventSource];
  if (extractor === undefined) return null;
  const parts = extractor(
    eventName,
    at(aws, 'requestParameters'),
    at(aws, 'responseElements'),
    at(aws, 'additionalEventData'),
  );
  if (parts === null) return null;
  const failed = text(at(aws, 'errorCode'), 128) !== undefined;
  const lists = parts.lists && Object.entries(parts.lists).filter(([, list]) => list.total > 0);
  const candidate: FindingChange = {
    version: FINDING_CHANGE_VERSION,
    eventSource,
    eventName,
    ...(failed && { failed }),
    ...viaOf(aws),
    ...(parts.target && { target: parts.target }),
    ...(parts.values && { values: parts.values }),
    ...(lists && lists.length > 0 && { lists: Object.fromEntries(lists) }),
  };
  const parsed = findingChangeSchema.safeParse(fitInBudget(candidate));
  return parsed.success ? parsed.data : null;
}

/**
 * Os tipos de objeto em que o estado anterior é procurado: a lista inteira vem em cada alteração (a lista de IPs e as
 * regras do WAF v2), e a anterior do mesmo objeto diz o que mudou.
 */
const SUBJECT_KINDS = new Set(['waf_ip_set', 'waf_web_acl', 'waf_rule_group']);

/** O maior texto da chave do objeto (o tamanho da coluna `Finding.changeSubject`). */
export const MAX_CHANGE_SUBJECT_LENGTH = 320;

/**
 * A chave do objeto alterado, para achar o estado anterior: `<serviço>/<tipo>/<escopo>/<região>/<id>`. Só nos objetos
 * cuja alteração traz o estado inteiro (`SUBJECT_KINDS`), com id; nos outros, `null`. A conta e o cliente ficam de fora: a
 * busca já filtra pelos dois.
 */
export function findingChangeSubject(change: FindingChange, region: string | null): string | null {
  const found = change.target;
  if (found === undefined || found.id === undefined || !SUBJECT_KINDS.has(found.kind)) return null;
  if (change.eventSource !== 'wafv2.amazonaws.com') return null;
  const key = [change.eventSource, found.kind, found.scope ?? '', region ?? '', found.id].join('/');
  return key.length <= MAX_CHANGE_SUBJECT_LENGTH ? key : null;
}
