import type { FindingChange, FindingChangeList } from './finding-change.js';
import type { FindingSource } from './findings.js';
import { isScopedExceptionBlocked } from './scoped-exceptions.js';

/**
 * A explicação do alerta em português, por modelos de texto (sem LLM): a seção "O que aconteceu" do detalhe. Diz quem fez
 * (uma pessoa, uma automação como a função Lambda X, um serviço da AWS, a conta root), em que objeto (o nome e o id da
 * lista de IPs, da regra, do grupo, do bucket), o que mudou (com o antes e o depois quando o estado anterior é conhecido),
 * por que importa e o que conferir, para quem não é especialista.
 *
 * Tudo o que vem do log entra como texto puro: o painel mostra cada campo como texto, nunca como HTML. A função é pura e
 * roda no painel, com a alteração gravada no alerta (`GET /v1/findings/:id/change`) ou, num nó de antes, a lida do evento
 * bruto (`extractFindingChange`).
 */

export type ExplanationActorKind = 'person' | 'automation' | 'service' | 'root' | 'unknown';

export interface ExplanationActor {
  kind: ExplanationActorKind;
  /** No meio da frase, em minúscula: "uma automação (função Lambda waf-auto-block)". */
  text: string;
}

/** O que mudou numa lista (endereços, regras, permissões), com o antes quando ele é conhecido. */
export interface ExplanationChange {
  /**
   * `diff`: comparado com o estado anterior conhecido; `delta`: o próprio evento traz o que entrou e o que saiu (WAF
   * clássico, grupo de segurança); `snapshot`: só o estado de agora; `unchanged`: igual ao anterior.
   */
  kind: 'diff' | 'delta' | 'snapshot' | 'unchanged';
  /** O que a lista guarda, no plural: "endereços", "regras", "permissões". */
  noun: string;
  added: string[];
  removed: string[];
  /** Itens com o mesmo nome e outro valor (a regra do WAF que passou de "contar" a "bloquear"). */
  changed: string[];
  /** O estado de agora (no `snapshot` e no `unchanged`). */
  current: string[];
  /** O total de itens de agora, quando conhecido (pode ser maior que `current`, cortado no teto). */
  currentTotal: number | null;
  /** Quando o estado anterior foi registrado (o alerta anterior do mesmo objeto). */
  previousAt: string | null;
  /** Uma frase sobre a comparação: de onde veio o antes, ou por que ele não está disponível. */
  note: string;
}

export interface ExplanationFact {
  label: string;
  value: string;
}

export interface FindingExplanation {
  /** A família do evento: `waf`, `iam`, `security_group`, `s3`, `cloudtrail`, `guardduty`, `console_login`... */
  family: string;
  actor: ExplanationActor;
  /** Uma ou duas frases: quem fez o quê em qual objeto. */
  summary: string;
  facts: ExplanationFact[];
  change: ExplanationChange | null;
  why: string;
  check: string;
  /** A AWS recusou a chamada: nada mudou de fato. */
  failed: boolean;
  /** Para a automação que repete a mesma coisa: criar uma exceção em vez de tratar um por um. */
  suggestion: string | null;
  /** De onde vieram os detalhes: a alteração gravada no alerta, o evento bruto ou só os campos do alerta. */
  basis: 'stored' | 'raw_event' | 'fields';
}

export interface ExplainableFinding {
  source: FindingSource;
  ruleId: string;
  title: string;
  eventName: string | null;
  region: string | null;
  resource: string | null;
  actor: { user: string | null; type: string | null };
}

export interface ExplainInput {
  finding: ExplainableFinding;
  change: FindingChange | null;
  /** O estado anterior do mesmo objeto, quando conhecido. */
  previous: { occurredAt: string; change: FindingChange } | null;
  /** Quantos alertas a mesma identidade gerou na mesma regra; `null` num nó de antes. */
  repeats: { count: number; days: number } | null;
  basis: FindingExplanation['basis'];
}

/** A partir de quantos alertas da mesma automação na mesma regra a exceção é sugerida. */
export const EXCEPTION_SUGGESTION_MIN_REPEATS = 3;

// ---------------------------------------------------------------------------------------------------------------------
// Textos auxiliares

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
const quoted = (value: string): string => `"${value}"`;

/** Uma lista curta em português: "a, b e c". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items.at(-1) ?? ''}`;
}

interface ArnParts {
  service: string;
  account: string;
  resource: string;
}

function parseArn(value: string): ArnParts | null {
  const parts = value.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') return null;
  return { service: parts[2] ?? '', account: parts[4] ?? '', resource: parts.slice(5).join(':') };
}

/** O nome do objeto como aparece na frase: `"blocked-ips" (id 1a2b…)`, só o nome, só o id ou nada. */
function objectLabel(change: FindingChange | null): string {
  const found = change?.target;
  if (!found) return '';
  if (found.name !== undefined && found.id !== undefined) return `${quoted(found.name)} (id ${found.id})`;
  if (found.name !== undefined) return quoted(found.name);
  if (found.id !== undefined) return found.id;
  return '';
}

const withLabel = (prefix: string, label: string): string => (label ? `${prefix} ${label}` : prefix);

const value = (change: FindingChange | null, key: string): string | number | boolean | undefined =>
  change?.values?.[key];
const textValue = (change: FindingChange | null, key: string): string | undefined => {
  const found = value(change, key);
  return typeof found === 'string' ? found : undefined;
};
const list = (change: FindingChange | null, key: string): FindingChangeList | undefined =>
  change?.lists?.[key];

// ---------------------------------------------------------------------------------------------------------------------
// Quem fez

/**
 * Quem fez a ação, pela identidade do alerta (o ARN e o tipo) e por onde ela veio (`via`): o papel assumido por uma
 * função Lambda tem a sessão com o nome da função; o de uma instância EC2, o id dela; o do login único (SSO), o nome da
 * pessoa. O usuário IAM pelo console é uma pessoa; pela linha de comando ou por programa, pode ser os dois.
 */
export function describeActor(
  actor: { user: string | null; type: string | null },
  change: Pick<FindingChange, 'via' | 'invokedBy'> | null,
): ExplanationActor {
  const via = change?.via;
  const user = actor.user ?? '';
  const arn = user ? parseArn(user) : null;
  if (actor.type === 'Root' || arn?.resource === 'root') {
    return { kind: 'root', text: 'a conta root (o usuário principal da conta AWS)' };
  }
  if (actor.type === 'AWSService' || (via === 'aws_service' && !user)) {
    const service = change?.invokedBy;
    return { kind: 'service', text: service ? `um serviço da AWS (${service})` : 'um serviço da AWS' };
  }
  if (arn !== null && arn.resource.startsWith('assumed-role/')) {
    const [, role = '', ...rest] = arn.resource.split('/');
    const session = rest.join('/');
    if (via === 'lambda') {
      return { kind: 'automation', text: `uma automação (função Lambda ${session || role})` };
    }
    if (via === 'ec2') {
      return { kind: 'automation', text: `uma automação (servidor EC2 ${session}, papel ${role})` };
    }
    if (via === 'ecs') return { kind: 'automation', text: `uma automação (tarefa do ECS, papel ${role})` };
    if (via === 'cloudformation') {
      return { kind: 'automation', text: `uma automação (CloudFormation, papel ${role})` };
    }
    if (via === 'terraform') return { kind: 'automation', text: `uma automação (Terraform, papel ${role})` };
    if (role.startsWith('AWSServiceRoleFor') || via === 'aws_service') {
      const service = change?.invokedBy;
      return {
        kind: 'service',
        text: service ? `um serviço da AWS (${service}, papel ${role})` : `um serviço da AWS (papel ${role})`,
      };
    }
    if (role.startsWith('AWSReservedSSO_')) {
      const permission = role.slice('AWSReservedSSO_'.length).split('_').slice(0, -1).join('_') || role;
      return { kind: 'person', text: `a pessoa ${session} (login único, permissão ${permission})` };
    }
    if (via === 'console')
      return { kind: 'person', text: `uma pessoa pelo console (papel ${role}, sessão ${session})` };
    if (role.toLowerCase().includes('lambda')) {
      return { kind: 'automation', text: `provavelmente uma automação (papel ${role}, sessão ${session})` };
    }
    return { kind: 'unknown', text: `quem usou o papel ${role} (sessão ${session})` };
  }
  if (arn !== null && arn.service === 'iam' && arn.resource.startsWith('user/')) {
    const name = arn.resource.split('/').at(-1) ?? arn.resource;
    if (via === 'console')
      return { kind: 'person', text: `a pessoa com o usuário IAM ${name} (pelo console)` };
    if (via === 'cli' || via === 'sdk' || via === 'terraform') {
      return {
        kind: 'unknown',
        text: `o usuário IAM ${name}, por linha de comando ou programa (pode ser uma pessoa ou uma automação)`,
      };
    }
    return { kind: 'unknown', text: `o usuário IAM ${name}` };
  }
  if (via === 'lambda') return { kind: 'automation', text: `uma automação (função Lambda)` };
  if (user) return { kind: 'unknown', text: `a identidade ${user}` };
  return { kind: 'unknown', text: 'uma identidade que o evento não informa' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Comparações

/** Endereço como aparece na lista: o `/32` e o `/128` saem (um endereço só). */
const addressText = (address: string): string =>
  address.endsWith('/32') || address.endsWith('/128') ? address.slice(0, address.lastIndexOf('/')) : address;

const complete = (found: FindingChangeList | undefined): found is FindingChangeList =>
  found !== undefined && found.items.length === found.total;

function difference(
  current: readonly string[],
  previous: readonly string[],
): { added: string[]; removed: string[] } {
  const before = new Set(previous);
  const now = new Set(current);
  return {
    added: current.filter((item) => !before.has(item)),
    removed: previous.filter((item) => !now.has(item)),
  };
}

/** A lista inteira de agora contra a do alerta anterior do mesmo objeto (`findingChangeSubject`). */
function compareWhole(
  current: FindingChangeList | undefined,
  previous: ExplainInput['previous'],
  key: string,
  noun: string,
  render: (item: string) => string,
): ExplanationChange | null {
  if (current === undefined) return null;
  const before = previous?.change.lists?.[key];
  const shown = current.items.map(render);
  if (previous !== null && complete(current) && (complete(before) || before === undefined)) {
    const { added, removed } = difference(current.items, before?.items ?? []);
    if (added.length === 0 && removed.length === 0) {
      return {
        kind: 'unchanged',
        noun,
        added: [],
        removed: [],
        changed: [],
        current: shown,
        currentTotal: current.total,
        previousAt: previous.occurredAt,
        note: `A lista ficou igual à registrada no alerta anterior do mesmo objeto (${plural(current.total, noun.slice(0, -1), noun)}).`,
      };
    }
    return {
      kind: 'diff',
      noun,
      added: added.map(render),
      removed: removed.map(render),
      changed: [],
      current: shown,
      currentTotal: current.total,
      previousAt: previous.occurredAt,
      note: 'Comparado com o estado registrado no alerta anterior do mesmo objeto.',
    };
  }
  const reason =
    previous === null
      ? 'O estado anterior não está disponível (não há alerta anterior deste objeto)'
      : 'A lista é grande demais para comparar com a anterior';
  return {
    kind: 'snapshot',
    noun,
    added: [],
    removed: [],
    changed: [],
    current: shown,
    currentTotal: current.total,
    previousAt: null,
    note: `${reason}; a lista agora tem ${plural(current.total, noun.slice(0, -1), noun)}.`,
  };
}

/** As regras do WAF (`nome|ação`), comparadas por nome: as que entraram, as que saíram e as que trocaram de ação. */
function compareRules(change: FindingChange, previous: ExplainInput['previous']): ExplanationChange | null {
  const current = list(change, 'rules');
  if (current === undefined) return null;
  const before = previous?.change.lists?.['rules'];
  const split = (item: string): [string, string] => {
    const cut = item.lastIndexOf('|');
    return cut < 0 ? [item, ''] : [item.slice(0, cut), item.slice(cut + 1)];
  };
  const render = (item: string): string => {
    const [name, action] = split(item);
    return action ? `${name} (${wafActionText(action)})` : name;
  };
  const shown = current.items.map(render);
  // A lista vazia não é gravada: no alerta anterior, a falta dela é "nenhuma regra".
  const earlier = before ?? { items: [], total: 0 };
  if (previous === null || !complete(current) || !complete(earlier)) {
    return {
      kind: 'snapshot',
      noun: 'regras',
      added: [],
      removed: [],
      changed: [],
      current: shown,
      currentTotal: current.total,
      previousAt: null,
      note:
        previous === null
          ? `O estado anterior não está disponível (não há alerta anterior deste objeto); agora são ${plural(current.total, 'regra', 'regras')}.`
          : `A lista de regras é grande demais para comparar com a anterior; agora são ${plural(current.total, 'regra', 'regras')}.`,
    };
  }
  const now = new Map(current.items.map(split));
  const then = new Map(earlier.items.map(split));
  const added = [...now.keys()].filter((name) => !then.has(name));
  const removed = [...then.keys()].filter((name) => !now.has(name));
  const changed = [...now.entries()].flatMap(([name, action]) => {
    const old = then.get(name);
    return old !== undefined && old !== action
      ? [`${name}: de ${wafActionText(old)} para ${wafActionText(action)}`]
      : [];
  });
  const kind = added.length + removed.length + changed.length === 0 ? 'unchanged' : 'diff';
  return {
    kind,
    noun: 'regras',
    added: added.map((name) => render(`${name}|${now.get(name) ?? ''}`)),
    removed: removed.map((name) => render(`${name}|${then.get(name) ?? ''}`)),
    changed,
    current: shown,
    currentTotal: current.total,
    previousAt: previous.occurredAt,
    note:
      kind === 'unchanged'
        ? 'As regras ficaram iguais às do alerta anterior do mesmo objeto (outra configuração pode ter mudado).'
        : 'Comparado com as regras registradas no alerta anterior do mesmo objeto.',
  };
}

/** O que entrou e o que saiu, quando o próprio evento traz as operações (WAF clássico). */
function delta(
  change: FindingChange,
  noun: string,
  render: (item: string) => string,
): ExplanationChange | null {
  const added = list(change, 'added');
  const removed = list(change, 'removed');
  if (added === undefined && removed === undefined) return null;
  return {
    kind: 'delta',
    noun,
    added: (added?.items ?? []).map(render),
    removed: (removed?.items ?? []).map(render),
    changed: [],
    current: [],
    currentTotal: null,
    previousAt: null,
    note: 'O próprio evento diz o que entrou e o que saiu.',
  };
}

/** Frase do que mudou na lista, para o resumo. */
function changeSentence(found: ExplanationChange | null): string {
  if (found === null) return '';
  const { noun } = found;
  const one = noun.slice(0, -1);
  if (found.kind === 'unchanged') return ` O conteúdo da lista não mudou em relação ao alerta anterior.`;
  if (found.kind === 'snapshot') return '';
  const parts = [
    found.added.length > 0 && `incluiu ${plural(found.added.length, one, noun)}`,
    found.removed.length > 0 && `retirou ${plural(found.removed.length, one, noun)}`,
    found.changed.length > 0 && `mudou a ação de ${plural(found.changed.length, one, noun)}`,
  ].filter((part): part is string => typeof part === 'string');
  return parts.length === 0 ? '' : ` ${capitalize(joinList(parts))}.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Famílias

interface FamilyText {
  family: string;
  /** O que foi feito, para depois de quem fez: "alterou a lista de IPs X do WAF". */
  action: string;
  facts?: ExplanationFact[];
  change?: ExplanationChange | null;
  why: string;
  check: string;
}

const WAF_ACTION_TEXTS: Readonly<Record<string, string>> = {
  Allow: 'permitir',
  Block: 'bloquear',
  Count: 'só contar',
  Captcha: 'pedir CAPTCHA',
  Challenge: 'desafio',
  Group: 'ação do próprio grupo',
};
const wafActionText = (action: string): string => WAF_ACTION_TEXTS[action] ?? action;

/** O artigo e o nome de cada objeto do WAF. */
const WAF_KINDS: Readonly<Record<string, { article: 'a' | 'o'; noun: string }>> = {
  waf_ip_set: { article: 'a', noun: 'lista de IPs' },
  waf_web_acl: { article: 'a', noun: 'Web ACL (o conjunto de regras)' },
  waf_rule_group: { article: 'o', noun: 'grupo de regras' },
};

const WAF_WHY_IP_SET =
  'As listas de IPs do WAF são usadas pelas regras do firewall do site para bloquear ou liberar endereços. Um endereço que entra numa lista de liberação passa pelo WAF sem filtro; um endereço legítimo numa lista de bloqueio deixa clientes sem acesso.';
const WAF_WHY_RULES =
  'A Web ACL é o conjunto de regras do firewall do site. Tirar uma regra, ou trocar "bloquear" por "só contar", deixa passar ataques que antes eram barrados.';

function waf(event: string, change: FindingChange | null, previous: ExplainInput['previous']): FamilyText {
  const kind = change?.target?.kind ?? '';
  const label = objectLabel(change);
  const scope = change?.target?.scope;
  const facts: ExplanationFact[] = [];
  if (scope !== undefined)
    facts.push({ label: 'Escopo', value: scope === 'CLOUDFRONT' ? 'CloudFront (global)' : 'Regional' });
  const defaultAction = textValue(change, 'defaultAction');
  if (defaultAction !== undefined) facts.push({ label: 'Ação padrão', value: wafActionText(defaultAction) });
  const resourceArn = textValue(change, 'resourceArn');
  if (resourceArn !== undefined) facts.push({ label: 'Recurso protegido', value: resourceArn });
  const wafKind = WAF_KINDS[kind] ?? { article: 'o', noun: 'objeto' };
  // "lista de IPs "bloqueados" (id ...) do WAF", sem o artigo; com ele, e com "de" ("da lista", "do grupo").
  const noun = `${wafKind.noun}${label ? ` ${label}` : ''} do WAF`;
  const objectText = `${wafKind.article} ${noun}`;
  const ofObject = `d${wafKind.article} ${noun}`;

  if (event === 'UpdateIPSet' || event === 'CreateIPSet') {
    const found =
      change === null
        ? null
        : (delta(change, 'endereços', addressText) ??
          compareWhole(list(change, 'addresses'), previous, 'addresses', 'endereços', addressText));
    return {
      family: 'waf',
      action: `${event === 'CreateIPSet' ? 'criou' : 'alterou'} ${objectText}.${changeSentence(found)}`,
      facts,
      change: found,
      why: WAF_WHY_IP_SET,
      check:
        'Veja se os endereços incluídos são mesmo de quem atacou (lista de bloqueio) ou de parceiros conhecidos (lista de liberação), e se quem alterou é a pessoa ou a automação que cuida do WAF.',
    };
  }
  if (
    event === 'UpdateWebACL' ||
    event === 'UpdateRuleGroup' ||
    event === 'CreateWebACL' ||
    event === 'CreateRuleGroup'
  ) {
    const found =
      change === null ? null : (delta(change, 'regras', (item) => item) ?? compareRules(change, previous));
    return {
      family: 'waf',
      action: `${event.startsWith('Create') ? `criou ${objectText}` : `alterou as regras ${ofObject}`}.${changeSentence(found)}`,
      facts,
      change: found,
      why: WAF_WHY_RULES,
      check:
        'Confira se a mudança foi planejada (um chamado, uma publicação) e se nenhuma regra de proteção saiu ou passou a só contar.',
    };
  }
  if (event.startsWith('Delete') && event !== 'DeleteLoggingConfiguration') {
    return {
      family: 'waf',
      action: `apagou ${objectText}.`,
      facts,
      why: 'Sem esse objeto, as regras que dependiam dele deixam de proteger o site.',
      check: 'Confirme que a remoção foi planejada e que o site continua protegido por outra regra.',
    };
  }
  if (event === 'DisassociateWebACL') {
    return {
      family: 'waf',
      action: `desligou o WAF de um recurso: ${objectText} deixou de proteger ${resourceArn ?? 'o recurso'}.`,
      facts,
      why: 'O recurso fica exposto direto à internet, sem o filtro do WAF.',
      check: 'Confirme se foi intencional; se não foi, associe a Web ACL ao recurso de novo.',
    };
  }
  if (event === 'AssociateWebACL') {
    return {
      family: 'waf',
      action: `ligou ${objectText} a ${resourceArn ?? 'um recurso'}.`,
      facts,
      why: 'Trocar a Web ACL de um recurso muda as regras que o protegem.',
      check: 'Confirme se a Web ACL nova tem as regras esperadas.',
    };
  }
  if (event === 'DeleteLoggingConfiguration') {
    return {
      family: 'waf',
      action: `desligou o registro (log) ${ofObject}.`,
      facts,
      why: 'Sem o log do WAF, as requisições bloqueadas e liberadas deixam de chegar aqui, e ataques ao site ficam invisíveis.',
      check: 'Confirme se foi intencional; se não foi, ligue o log de novo.',
    };
  }
  return {
    family: 'waf',
    action: `fez ${event} em ${objectText}.`,
    facts,
    why: WAF_WHY_RULES,
    check: 'Confirme se a mudança foi planejada e por quem.',
  };
}

const IAM_KINDS: Readonly<Record<string, string>> = {
  iam_user: 'o usuário IAM',
  iam_role: 'o papel IAM',
  iam_group: 'o grupo IAM',
  iam_policy: 'a política',
};

function iamSubject(change: FindingChange | null, fallback: string | null): string {
  const found = change?.target;
  if (found?.name !== undefined || found?.id !== undefined) {
    return `${IAM_KINDS[found.kind] ?? 'o objeto'} ${found.name ?? found.id ?? ''}`;
  }
  if (found?.kind === 'iam_user') return 'o próprio usuário que fez a ação';
  return fallback ?? 'uma identidade';
}

const ADMIN_POLICIES = ['/AdministratorAccess', '/IAMFullAccess', '/PowerUserAccess'];

function iamFamily(event: string, change: FindingChange | null, resource: string | null): FamilyText {
  const subject = iamSubject(change, resource);
  const policyArn = textValue(change, 'policyArn');
  const policyName = textValue(change, 'policyName');
  const everything = value(change, 'grantsEverything') === true;
  const facts: ExplanationFact[] = [];
  if (policyArn !== undefined) facts.push({ label: 'Política', value: policyArn });
  if (policyName !== undefined) facts.push({ label: 'Política embutida', value: policyName });
  const admin = policyArn !== undefined && ADMIN_POLICIES.some((name) => policyArn.endsWith(name));
  const permissionWhy =
    'As políticas definem o que cada identidade pode fazer na conta. Acesso amplo permite tudo, inclusive apagar registros e criar novos acessos para voltar depois.';
  const permissionCheck =
    'Confirme se essa identidade precisa mesmo dessa permissão e quem pediu. Se ninguém reconhece, retire a permissão e trate como incidente.';
  switch (event) {
    case 'CreateAccessKey': {
      const created = textValue(change, 'createdAccessKeyId');
      if (created !== undefined) facts.push({ label: 'Chave criada', value: created });
      return {
        family: 'iam',
        action: `criou uma chave de acesso para ${subject}.`,
        facts,
        why: 'Uma chave de acesso dá entrada à conta por programa, sem senha nem MFA. Quem invade costuma criar uma chave para voltar depois.',
        check:
          'Confirme com o dono do usuário se ele pediu a chave. Se ninguém reconhece, desative a chave na hora.',
      };
    }
    case 'DeleteAccessKey':
    case 'UpdateAccessKey': {
      const key = textValue(change, 'accessKeyId');
      if (key !== undefined) facts.push({ label: 'Chave', value: key });
      const status = textValue(change, 'status');
      return {
        family: 'iam',
        action:
          event === 'DeleteAccessKey'
            ? `apagou uma chave de acesso de ${subject}.`
            : `mudou o status de uma chave de acesso de ${subject}${status ? ` para ${status === 'Active' ? 'ativa' : 'inativa'}` : ''}.`,
        facts,
        why: 'Chaves de acesso são credenciais de programa; reativar uma chave antiga devolve um acesso que estava fechado.',
        check: 'Confirme se a mudança foi pedida pelo dono da chave.',
      };
    }
    case 'AttachUserPolicy':
    case 'AttachRolePolicy':
    case 'AttachGroupPolicy':
      return {
        family: 'iam',
        action: `deu a política ${policyArn?.split('/').at(-1) ?? ''} a ${subject}${admin ? ' (acesso de administrador)' : ''}.`,
        facts,
        why: permissionWhy,
        check: permissionCheck,
      };
    case 'DetachUserPolicy':
    case 'DetachRolePolicy':
    case 'DetachGroupPolicy':
      return {
        family: 'iam',
        action: `retirou a política ${policyArn?.split('/').at(-1) ?? ''} de ${subject}.`,
        facts,
        why: 'Retirar uma política costuma ser limpeza, mas também pode tirar uma trava ou fazer parte de uma troca de permissões.',
        check: 'Confirme se a mudança foi planejada.',
      };
    case 'PutUserPolicy':
    case 'PutRolePolicy':
    case 'PutGroupPolicy':
      return {
        family: 'iam',
        action: `gravou a política embutida ${policyName ?? ''} em ${subject}.${everything ? ' Ela permite qualquer ação em qualquer recurso (acesso total).' : ''}`,
        facts,
        why: permissionWhy,
        check: permissionCheck,
      };
    case 'DeleteUserPolicy':
    case 'DeleteRolePolicy':
    case 'DeleteGroupPolicy':
      return {
        family: 'iam',
        action: `apagou a política embutida ${policyName ?? ''} de ${subject}.`,
        facts,
        why: 'Apagar uma política costuma ser limpeza, mas também pode tirar uma trava.',
        check: 'Confirme se a mudança foi planejada.',
      };
    case 'CreatePolicyVersion':
    case 'SetDefaultPolicyVersion': {
      const asDefault = value(change, 'setAsDefault') === true;
      return {
        family: 'iam',
        action: `${event === 'CreatePolicyVersion' ? 'criou uma versão nova de' : 'trocou a versão em uso de'} ${subject}${event === 'CreatePolicyVersion' && asDefault ? ' e a colocou em uso' : ''}.${everything ? ' A versão nova permite qualquer ação em qualquer recurso (acesso total).' : ''}`,
        facts,
        why: 'Mudar a versão de uma política muda, de uma vez, o que todas as identidades que a usam podem fazer.',
        check: permissionCheck,
      };
    }
    case 'CreateRole':
    case 'UpdateAssumeRolePolicy': {
      const anyone = value(change, 'trustsAnyone') === true;
      return {
        family: 'iam',
        action: `${event === 'CreateRole' ? 'criou' : 'mudou quem pode assumir'} ${subject}.${anyone ? ' A regra de confiança permite que qualquer conta da AWS assuma o papel.' : ''}`,
        facts,
        why: 'Um papel que qualquer conta pode assumir é uma porta aberta para quem está fora da empresa.',
        check: 'Confira a regra de confiança do papel e limite-a às contas e serviços da empresa.',
      };
    }
    case 'CreateUser':
      return {
        family: 'iam',
        action: `criou ${subject}.`,
        facts,
        why: 'Um usuário novo é uma forma nova de entrar na conta; quem invade cria usuários para manter o acesso.',
        check: 'Confirme quem pediu o usuário e se ele segue o padrão de nomes da empresa.',
      };
    case 'DeleteUser':
    case 'DeleteRole':
    case 'UpdateRole':
    case 'DeleteLoginProfile':
      return {
        family: 'iam',
        action: `${event === 'UpdateRole' ? 'alterou' : event === 'DeleteLoginProfile' ? 'apagou a senha de console de' : 'apagou'} ${subject}.`,
        facts,
        why: 'Mudanças em identidades mudam quem consegue entrar na conta e o que pode fazer.',
        check: 'Confirme se a mudança foi planejada.',
      };
    case 'CreateLoginProfile':
    case 'UpdateLoginProfile': {
      const reset = value(change, 'passwordResetRequired');
      return {
        family: 'iam',
        action: `${event === 'CreateLoginProfile' ? 'criou a senha de console de' : 'trocou a senha de console de'} ${subject}.${reset === true ? ' A pessoa terá de trocar a senha no próximo login.' : ''}`,
        facts,
        why: 'Quem define a senha de outro usuário consegue entrar no console como ele.',
        check: 'Confirme com o dono do usuário se ele pediu a troca.',
      };
    }
    case 'AddUserToGroup':
    case 'RemoveUserFromGroup': {
      const userName = textValue(change, 'userName');
      return {
        family: 'iam',
        action: `${event === 'AddUserToGroup' ? 'colocou' : 'tirou'} o usuário ${userName ?? ''} ${event === 'AddUserToGroup' ? 'no' : 'do'} grupo ${change?.target?.name ?? ''}.`,
        facts,
        why: 'Quem entra num grupo ganha todas as permissões dele.',
        check: 'Confirme se a pessoa precisa das permissões do grupo.',
      };
    }
    case 'DeactivateMFADevice':
    case 'DeleteVirtualMFADevice':
      return {
        family: 'iam',
        action: `desativou o MFA (segundo fator de login) de ${subject}.`,
        facts,
        why: 'Sem o MFA, só a senha protege o login; quem a descobrir entra.',
        check: 'Confirme com o dono do usuário e ative o MFA de novo.',
      };
    default:
      return {
        family: 'iam',
        action: `fez ${event} em ${subject}.`,
        facts,
        why: permissionWhy,
        check: 'Confirme se a mudança foi planejada e por quem.',
      };
  }
}

const PORT_NAMES: Readonly<Record<number, string>> = {
  22: 'SSH, acesso remoto',
  80: 'HTTP',
  443: 'HTTPS',
  445: 'compartilhamento de arquivos do Windows',
  1433: 'SQL Server',
  1521: 'Oracle',
  2375: 'Docker',
  3306: 'MySQL',
  3389: 'área de trabalho remota do Windows',
  5432: 'PostgreSQL',
  6379: 'Redis',
  9200: 'Elasticsearch',
  11211: 'Memcached',
  27017: 'MongoDB',
};

/** `tcp|22|22|0.0.0.0/0` em português: "TCP porta 22 (SSH, acesso remoto) de qualquer endereço IPv4 (0.0.0.0/0)". */
export function permissionText(item: string): string {
  const [protocol = '', fromText = '', toText = '', source = ''] = item.split('|');
  const from = fromText === '' ? null : Number(fromText);
  const to = toText === '' ? from : Number(toText);
  const all = protocol === '-1' || protocol === 'all';
  const proto = all ? 'todo o tráfego' : protocol.toUpperCase();
  let ports = '';
  if (!all) {
    if (from === null || from === -1 || (from === 0 && to === 65_535)) ports = ' em todas as portas';
    else if (from === to) ports = ` porta ${from}${PORT_NAMES[from] ? ` (${PORT_NAMES[from]})` : ''}`;
    else ports = ` portas ${from} a ${to ?? from}`;
  }
  let origin = '';
  if (source === '0.0.0.0/0') origin = ' de qualquer endereço IPv4 (0.0.0.0/0, a internet inteira)';
  else if (source === '::/0') origin = ' de qualquer endereço IPv6 (::/0, a internet inteira)';
  else if (source.startsWith('sg-')) origin = ` do grupo ${source}`;
  else if (source) origin = ` de ${source}`;
  return `${proto}${ports}${origin}`;
}

function securityGroup(event: string, change: FindingChange | null, resource: string | null): FamilyText {
  const label = objectLabel(change) || resource || '';
  const items = list(change, 'permissions');
  const rendered = (items?.items ?? []).map(permissionText);
  const open = (items?.items ?? []).some((item) => item.endsWith('|0.0.0.0/0') || item.endsWith('|::/0'));
  const found: ExplanationChange | null =
    items === undefined
      ? null
      : {
          kind: 'delta',
          noun: 'permissões',
          added: event.startsWith('Authorize') || event === 'ModifySecurityGroupRules' ? rendered : [],
          removed: event.startsWith('Revoke') ? rendered : [],
          changed: [],
          current: [],
          currentTotal: null,
          previousAt: null,
          note:
            event === 'ModifySecurityGroupRules'
              ? 'O evento traz as regras como ficaram depois da alteração.'
              : 'O próprio evento diz o que foi liberado ou fechado.',
        };
  const egress = event.endsWith('Egress');
  const verb = event.startsWith('Revoke')
    ? `fechou ${egress ? 'saídas' : 'entradas'} no grupo de segurança ${label}`
    : event === 'ModifySecurityGroupRules'
      ? `alterou regras do grupo de segurança ${label}`
      : `liberou ${egress ? 'saídas' : 'entradas'} no grupo de segurança ${label}`;
  return {
    family: 'security_group',
    action: `${verb}${rendered.length > 0 ? `: ${joinList(rendered.slice(0, 3))}${rendered.length > 3 ? ` e mais ${rendered.length - 3}` : ''}` : ''}.`,
    change: found,
    why: event.startsWith('Revoke')
      ? 'Fechar acesso costuma ser correção, mas pode tirar do ar um serviço que dependia da regra.'
      : 'Os grupos de segurança são o firewall dos servidores. Uma porta aberta para a internet inteira fica ao alcance de robôs que procuram senhas fracas e falhas conhecidas.',
    check: event.startsWith('Revoke')
      ? 'Confira se nada legítimo parou de funcionar.'
      : open
        ? 'Confirme se a porta precisa mesmo ficar aberta para todos. Se não, limite a faixa aos endereços da empresa ou remova a regra.'
        : 'Confirme se a regra nova era esperada e se a faixa de endereços é da empresa.',
  };
}

const ACCESS_BLOCK_TEXTS: Readonly<Record<string, string>> = {
  BlockPublicAcls: 'bloquear ACLs públicas',
  IgnorePublicAcls: 'ignorar ACLs públicas',
  BlockPublicPolicy: 'bloquear políticas públicas',
  RestrictPublicBuckets: 'restringir buckets públicos',
};

function s3Family(event: string, change: FindingChange | null, resource: string | null): FamilyText {
  const fromResource = resource?.startsWith('s3:') ? resource.slice(3) : '';
  const bucket = objectLabel(change) || fromResource;
  const subject = bucket ? `do bucket ${bucket}` : 'de um bucket';
  const anyone = value(change, 'grantsAnyone');
  const why =
    'Bucket aberto ao público é a causa mais comum de vazamento de dados na nuvem: qualquer pessoa pode ler o que está nele.';
  const check =
    'Veja o que há no bucket e se ele precisa mesmo ser público (um site estático, por exemplo). Se não, volte a configuração e ligue o bloqueio de acesso público.';
  const publicText =
    anyone === true
      ? ' A nova configuração permite acesso a qualquer pessoa na internet.'
      : anyone === false
        ? ' Pela leitura da configuração, ela não abre o bucket a qualquer pessoa.'
        : '';
  switch (event) {
    case 'PutBucketPolicy': {
      const statements = value(change, 'statements');
      return {
        family: 's3',
        action: `trocou a política ${subject}.${publicText}`,
        facts:
          typeof statements === 'number'
            ? [{ label: 'Declarações na política', value: String(statements) }]
            : [],
        why,
        check,
      };
    }
    case 'PutBucketAcl':
      return { family: 's3', action: `trocou as permissões (ACL) ${subject}.${publicText}`, why, check };
    case 'PutBucketPublicAccessBlock': {
      const off = list(change, 'disabledBlocks')?.items ?? [];
      return {
        family: 's3',
        action: `mudou o bloqueio de acesso público ${subject}.${off.length > 0 ? ` Desligou: ${joinList(off.map((flag) => ACCESS_BLOCK_TEXTS[flag] ?? flag))}.` : ''}`,
        why: 'O bloqueio de acesso público é a trava que impede o bucket de ficar aberto por engano.',
        check,
      };
    }
    case 'DeleteBucketPublicAccessBlock':
      return {
        family: 's3',
        action: `removeu o bloqueio de acesso público ${subject}.`,
        why: 'O bloqueio de acesso público é a trava que impede o bucket de ficar aberto por engano.',
        check,
      };
    case 'DeleteBucketPolicy':
      return {
        family: 's3',
        action: `apagou a política ${subject}.`,
        why: 'A política do bucket pode ter travas (como exigir criptografia ou limitar quem acessa).',
        check: 'Confirme se a remoção foi planejada.',
      };
    default:
      return { family: 's3', action: `fez ${event} no bucket ${bucket}.`, why, check };
  }
}

function cloudTrailFamily(event: string, change: FindingChange | null): FamilyText {
  const label = objectLabel(change);
  const actions: Readonly<Record<string, string>> = {
    StopLogging: withLabel('parou o registro da trilha do CloudTrail', label),
    DeleteTrail: withLabel('apagou a trilha do CloudTrail', label),
    UpdateTrail: withLabel('alterou a trilha do CloudTrail', label),
    PutEventSelectors: withLabel(
      'mudou quais eventos a trilha do CloudTrail registra',
      label ? `(${label})` : '',
    ),
    DeleteEventDataStore: withLabel('apagou o armazenamento de eventos do CloudTrail Lake', label),
    StopEventDataStoreIngestion: withLabel(
      'parou a gravação do armazenamento de eventos do CloudTrail Lake',
      label,
    ),
  };
  return {
    family: 'cloudtrail',
    action: `${actions[event] ?? `fez ${event} no CloudTrail`}.`,
    why: 'O CloudTrail é o histórico de tudo o que é feito na conta. Parar ou apagar a trilha é um passo comum de quem quer agir sem deixar rastro.',
    check:
      'Confirme na hora com o responsável pela conta. Se ninguém planejou, religue a trilha e trate como incidente.',
  };
}

function guardDutyConfig(event: string, change: FindingChange | null, region: string | null): FamilyText {
  const label = objectLabel(change);
  const where = region ? ` na região ${region}` : '';
  const actions: Readonly<Record<string, string>> = {
    DeleteDetector: `apagou o detector do GuardDuty${where}`,
    UpdateDetector:
      value(change, 'enable') === false
        ? `desligou o detector do GuardDuty${where}`
        : `alterou o detector do GuardDuty${where}`,
    CreateFilter: withLabel('criou um filtro do GuardDuty', label) + ' que arquiva achados automaticamente',
    UpdateFilter:
      withLabel('alterou o filtro do GuardDuty', label) + ' para arquivar achados automaticamente',
    CreateIPSet: withLabel('criou a lista de IPs confiáveis do GuardDuty', label),
    UpdateIPSet: withLabel('alterou a lista de IPs confiáveis do GuardDuty', label),
    DisassociateFromMasterAccount: 'desligou esta conta da conta que centraliza o GuardDuty',
    DisassociateFromAdministratorAccount: 'desligou esta conta da conta que centraliza o GuardDuty',
    DisassociateMembers: 'desligou contas da central do GuardDuty',
    DeletePublishingDestination: 'apagou o destino para onde o GuardDuty exporta os achados',
    UpdatePublishingDestination: 'alterou o destino para onde o GuardDuty exporta os achados',
  };
  const trusted = event === 'CreateIPSet' || event === 'UpdateIPSet';
  return {
    family: 'guardduty',
    action: `${actions[event] ?? `fez ${event} no GuardDuty`}.`,
    why: trusted
      ? 'O GuardDuty não gera alertas para endereços da lista de IPs confiáveis: um endereço incluído ali fica invisível para a detecção.'
      : 'O GuardDuty é a detecção de ameaças da própria AWS. Desligá-lo ou silenciá-lo é um passo comum de quem quer agir sem ser visto.',
    check:
      'Confirme com o responsável pela conta. Se não foi planejado, desfaça a mudança (religue o detector, apague o filtro ou a lista) e trate como incidente.',
  };
}

function consoleLogin(change: FindingChange | null, actor: ExplanationActor): FamilyText {
  const mfa = textValue(change, 'mfaUsed');
  const result = textValue(change, 'result');
  const failed = result === 'Failure';
  const mfaText = mfa === 'Yes' ? ' com MFA' : mfa === 'No' ? ' sem MFA (só com a senha)' : '';
  const facts: ExplanationFact[] = [];
  if (mfa !== undefined) facts.push({ label: 'MFA usado', value: mfa === 'Yes' ? 'sim' : 'não' });
  if (actor.kind === 'root') {
    return {
      family: 'console_login',
      action: failed
        ? 'tentou entrar no console da AWS, sem sucesso.'
        : `entrou no console da AWS${mfaText}.`,
      facts,
      why: 'A conta root pode tudo, inclusive fechar a conta, e não pode ser limitada por políticas. A AWS recomenda usá-la só em tarefas raras.',
      check:
        'Confirme quem entrou e por quê, pelo IP de origem. Se ninguém reconhece, troque a senha da root e confira o MFA dela.',
    };
  }
  return {
    family: 'console_login',
    action: failed ? 'tentou entrar no console da AWS, sem sucesso.' : `entrou no console da AWS${mfaText}.`,
    facts,
    why: failed
      ? 'Muitas tentativas com falha seguidas podem ser alguém tentando adivinhar a senha.'
      : 'Sem MFA, quem descobrir a senha consegue entrar.',
    check: failed
      ? 'Veja se o IP de origem é conhecido. Se não for, confira se o usuário tem MFA e troque a senha.'
      : 'Ative o MFA para este usuário e confirme se o login foi dele.',
  };
}

function kmsFamily(event: string, change: FindingChange | null): FamilyText {
  const key = objectLabel(change);
  const subject = key ? `a chave KMS ${key}` : 'uma chave KMS';
  const days = value(change, 'pendingWindowInDays');
  const grantee = textValue(change, 'grantee');
  const operations = list(change, 'operations')?.items ?? [];
  const actions: Readonly<Record<string, string>> = {
    ScheduleKeyDeletion: `agendou a exclusão de ${subject}${typeof days === 'number' ? ` em ${plural(days, 'dia', 'dias')}` : ''}`,
    DisableKey: `desativou ${subject}`,
    EnableKey: `reativou ${subject}`,
    CancelKeyDeletion: `cancelou a exclusão de ${subject}`,
    DisableKeyRotation: `desligou a troca automática de ${subject}`,
    PutKeyPolicy: `trocou a política de ${subject}${value(change, 'grantsAnyone') === true ? '; a nova política permite o uso por qualquer um' : ''}`,
    CreateGrant: `deu permissão de uso de ${subject}${grantee ? ` a ${grantee}` : ''}${operations.length > 0 ? ` (operações: ${joinList(operations)})` : ''}`,
  };
  return {
    family: 'kms',
    action: `${actions[event] ?? `fez ${event} em ${subject}`}.`,
    why:
      event === 'ScheduleKeyDeletion' || event === 'DisableKey'
        ? 'Dados cifrados com a chave ficam ilegíveis enquanto ela estiver desativada e, depois da exclusão, para sempre. É tática de sabotagem e de sequestro de dados.'
        : 'As chaves KMS protegem dados cifrados; quem controla a chave controla o acesso aos dados.',
    check:
      event === 'ScheduleKeyDeletion'
        ? 'Se não foi planejado, cancele a exclusão antes do prazo e trate como incidente.'
        : 'Confirme se a mudança foi planejada e por quem.',
  };
}

function snapshotFamily(event: string, change: FindingChange | null): FamilyText {
  const kind = change?.target?.kind;
  const label = objectLabel(change);
  const noun =
    kind === 'ami'
      ? 'a imagem de servidor (AMI)'
      : kind === 'rds_snapshot'
        ? 'o snapshot do banco RDS'
        : 'o snapshot de disco';
  const madePublic = value(change, 'madePublic') === true;
  return {
    family: 'snapshot',
    action: `${madePublic ? 'tornou público' : 'alterou o compartilhamento de'} ${noun}${label ? ` ${label}` : ''}.`,
    why: 'Qualquer conta da AWS pode copiar um snapshot ou uma imagem pública, com todos os dados do disco.',
    check: 'Se não for intencional, desfaça o compartilhamento público e veja se alguém copiou os dados.',
  };
}

function domainFamily(event: string, change: FindingChange | null): FamilyText {
  const label = objectLabel(change) || 'um domínio';
  const actions: Readonly<Record<string, string>> = {
    TransferDomainToAnotherAwsAccount: `pediu a transferência do domínio ${label} para outra conta da AWS`,
    DisableDomainTransferLock: `destravou a transferência do domínio ${label}`,
    UpdateDomainNameservers: `trocou os servidores DNS do domínio ${label}`,
  };
  return {
    family: 'domain',
    action: `${actions[event] ?? `fez ${event} no domínio ${label}`}.`,
    why: 'Quem controla o domínio controla o site e os e-mails da empresa.',
    check:
      'Confirme na hora com o responsável pelo domínio. Se ninguém planejou, trave a transferência e volte os servidores DNS.',
  };
}

function organizationFamily(event: string, change: FindingChange | null): FamilyText {
  const label = objectLabel(change);
  const actions: Readonly<Record<string, string>> = {
    LeaveOrganization: 'tirou esta conta da organização da AWS',
    DetachPolicy: withLabel('retirou a política da organização', label),
    DeletePolicy: withLabel('apagou a política da organização', label),
    DisablePolicyType: 'desligou um tipo de política da organização',
  };
  return {
    family: 'organization',
    action: `${actions[event] ?? `fez ${event} na organização`}.`,
    why: 'As políticas da organização são travas centrais de segurança; fora delas, a conta fica sem esses limites.',
    check: 'Confirme com quem administra a organização se a mudança foi planejada.',
  };
}

/** As partes do tipo de achado do GuardDuty: `Propósito:Recurso/Família.Mecanismo!Artefato`. */
const THREAT_PURPOSES: Readonly<Record<string, string>> = {
  Backdoor: 'porta dos fundos (acesso escondido)',
  Behavior: 'comportamento fora do normal',
  CredentialAccess: 'roubo de credenciais',
  CryptoCurrency: 'mineração de criptomoeda',
  DefenseEvasion: 'tentativa de escapar da detecção',
  Discovery: 'reconhecimento do ambiente',
  Execution: 'execução de código suspeito',
  Exfiltration: 'saída de dados',
  Impact: 'sabotagem ou impacto no serviço',
  InitialAccess: 'tentativa de entrada',
  PenTest: 'ferramenta de teste de invasão',
  Persistence: 'tentativa de manter acesso',
  Policy: 'configuração fora da boa prática',
  PrivilegeEscalation: 'aumento de privilégio',
  Recon: 'reconhecimento',
  Stealth: 'ocultação de rastros',
  Trojan: 'programa malicioso',
  UnauthorizedAccess: 'acesso não autorizado',
};
const RESOURCE_TYPES: Readonly<Record<string, string>> = {
  EC2: 'um servidor EC2',
  IAMUser: 'uma identidade IAM',
  S3: 'um bucket S3',
  Kubernetes: 'um cluster Kubernetes',
  EKS: 'um cluster Kubernetes',
  Lambda: 'uma função Lambda',
  RDS: 'um banco RDS',
  Runtime: 'um servidor ou contêiner',
  ECS: 'um contêiner do ECS',
};

function guardDutyFinding(finding: ExplainableFinding): FamilyText {
  const type = finding.eventName ?? '';
  const [purpose = '', rest = ''] = type.split(':');
  const resourceType = rest.split('/')[0] ?? '';
  const purposeText = THREAT_PURPOSES[purpose];
  const resourceText = RESOURCE_TYPES[resourceType];
  return {
    family: 'guardduty_finding',
    action: `${purposeText ? `apontou ${purposeText}` : 'apontou uma atividade suspeita'}${resourceText ? ` envolvendo ${resourceText}` : ''}${finding.resource ? ` (${finding.resource})` : ''}.`,
    facts: type ? [{ label: 'Tipo do achado no GuardDuty', value: type }] : [],
    why: 'O GuardDuty é a detecção de ameaças da própria AWS: ele analisa o tráfego e as chamadas da conta e aponta padrões de ataque conhecidos.',
    check:
      'Veja o recurso apontado e o IP de origem, e leia no console do GuardDuty a descrição completa do achado. Se o recurso foi comprometido, isole-o antes de investigar.',
  };
}

const RULE_FAMILIES: Readonly<Record<string, string>> = {
  '100300': 'console_login',
  '100301': 'console_login',
  '100302': 'console_login',
  '80254': 'console_login',
  '80255': 'console_login',
  '100311': 'guardduty',
  '100312': 'guardduty',
  '100313': 'guardduty',
  '100322': 'waf',
  '100323': 'waf',
};

const SOURCE_FAMILIES: Readonly<Record<string, string>> = {
  'wafv2.amazonaws.com': 'waf',
  'waf.amazonaws.com': 'waf',
  'waf-regional.amazonaws.com': 'waf',
  'iam.amazonaws.com': 'iam',
  'ec2.amazonaws.com': 'ec2',
  'rds.amazonaws.com': 'snapshot',
  's3.amazonaws.com': 's3',
  'cloudtrail.amazonaws.com': 'cloudtrail',
  'guardduty.amazonaws.com': 'guardduty',
  'kms.amazonaws.com': 'kms',
  'signin.amazonaws.com': 'console_login',
  'organizations.amazonaws.com': 'organization',
  'route53domains.amazonaws.com': 'domain',
};

/** As chamadas do IAM reconhecidas pelo nome do evento, quando não há a alteração gravada. */
const IAM_EVENTS = new Set([
  'CreateAccessKey',
  'DeleteAccessKey',
  'UpdateAccessKey',
  'AttachUserPolicy',
  'AttachRolePolicy',
  'AttachGroupPolicy',
  'DetachUserPolicy',
  'DetachRolePolicy',
  'DetachGroupPolicy',
  'PutUserPolicy',
  'PutRolePolicy',
  'PutGroupPolicy',
  'DeleteUserPolicy',
  'DeleteRolePolicy',
  'DeleteGroupPolicy',
  'CreatePolicyVersion',
  'SetDefaultPolicyVersion',
  'CreateRole',
  'UpdateAssumeRolePolicy',
  'CreateUser',
  'DeleteUser',
  'DeleteRole',
  'UpdateRole',
  'CreateLoginProfile',
  'UpdateLoginProfile',
  'DeleteLoginProfile',
  'AddUserToGroup',
  'RemoveUserFromGroup',
  'DeactivateMFADevice',
  'DeleteVirtualMFADevice',
]);

/** A família pelo serviço da alteração ou, sem ela, pela regra e pelo nome do evento. */
function familyOf(finding: ExplainableFinding, change: FindingChange | null): string | null {
  if (finding.source === 'guardduty') return 'guardduty_finding';
  if (change !== null) {
    const family = SOURCE_FAMILIES[change.eventSource] ?? null;
    if (family !== 'ec2') return family;
    return change.target?.kind === 'security_group' ? 'security_group' : 'snapshot';
  }
  const byRule = RULE_FAMILIES[finding.ruleId];
  if (byRule !== undefined) return byRule;
  const event = finding.eventName ?? '';
  if (event.includes('SecurityGroup')) return 'security_group';
  if (['StopLogging', 'DeleteTrail', 'DeleteEventDataStore', 'StopEventDataStoreIngestion'].includes(event)) {
    return 'cloudtrail';
  }
  if (['ScheduleKeyDeletion', 'DisableKey', 'PutKeyPolicy', 'CreateGrant'].includes(event)) return 'kms';
  if (event.startsWith('PutBucket') || event.startsWith('DeleteBucket')) return 's3';
  if (event === 'ConsoleLogin') return 'console_login';
  if (event.startsWith('Modify') && event.includes('Attribute')) return 'snapshot';
  if (IAM_EVENTS.has(event)) return 'iam';
  return null;
}

function familyText(family: string, input: ExplainInput, actor: ExplanationActor): FamilyText {
  const { finding, change, previous } = input;
  const event = change?.eventName ?? finding.eventName ?? '';
  switch (family) {
    case 'waf':
      return waf(event, change, previous);
    case 'iam':
      return iamFamily(event, change, finding.resource);
    case 'security_group':
      return securityGroup(event, change, finding.resource);
    case 's3':
      return s3Family(event, change, finding.resource);
    case 'cloudtrail':
      return cloudTrailFamily(event, change);
    case 'guardduty':
      return guardDutyConfig(event, change, finding.region);
    case 'console_login':
      return consoleLogin(change, actor);
    case 'kms':
      return kmsFamily(event, change);
    case 'snapshot':
      return snapshotFamily(event, change);
    case 'domain':
      return domainFamily(event, change);
    case 'organization':
      return organizationFamily(event, change);
    case 'guardduty_finding':
      return guardDutyFinding(finding);
    default:
      return genericText(finding, actor);
  }
}

function genericText(finding: ExplainableFinding, actor: ExplanationActor): FamilyText {
  const event = finding.eventName;
  return {
    family: 'generic',
    action: `${event ? `fez a chamada ${event}` : 'fez a ação registrada'}${finding.resource ? ` no recurso ${finding.resource}` : ''}.`,
    why:
      actor.kind === 'root'
        ? 'A conta root pode tudo e não pode ser limitada por políticas; o uso dela no dia a dia é um risco por si só.'
        : `A regra que gerou o alerta (${finding.title}) marca este tipo de ação como relevante para a segurança.`,
    check:
      'Confira se quem fez a ação é conhecido e se a ação era esperada. Se for rotina, marque como legítimo e crie uma exceção.',
  };
}

/** A sugestão de exceção para a automação ou o serviço que repete a mesma coisa. */
function suggestionOf(input: ExplainInput, actor: ExplanationActor): string | null {
  const repeats = input.repeats;
  if (repeats === null || repeats.count < EXCEPTION_SUGGESTION_MIN_REPEATS) return null;
  if (actor.kind !== 'automation' && actor.kind !== 'service') return null;
  const who = actor.kind === 'automation' ? 'Esta mesma automação' : 'Este mesmo serviço';
  const wide = isScopedExceptionBlocked(input.finding.ruleId)
    ? ''
    : ' Para cobrir mais de uma identidade, um administrador pode criar uma exceção ampla da regra nesta conta, na aba Exceções da tela Detecções.';
  return `${who} gerou ${plural(repeats.count, 'alerta', 'alertas')} desta regra nos últimos ${repeats.days} dias. Se a mudança é o trabalho esperado dela, em vez de tratar um por um, marque este alerta como legítimo e crie a exceção por "Usuário" (a identidade da automação): alertas iguais passam a entrar como esperados.${wide}`;
}

/**
 * A explicação do alerta, ou `null` quando não há o que dizer além dos campos (alertas que não são de mudança na conta: os
 * agentes, a GCP, o Cloudflare, os ataques web do ALB, que têm a evidência própria).
 */
export function explainFinding(input: ExplainInput): FindingExplanation | null {
  const { finding, change } = input;
  const family = familyOf(finding, change);
  if (family === null && finding.source !== 'cloudtrail') return null;
  const actor =
    family === 'guardduty_finding'
      ? { kind: 'service' as const, text: 'o GuardDuty (a detecção de ameaças da própria AWS)' }
      : describeActor(finding.actor, change);
  const text = familyText(family ?? 'generic', input, actor);
  const failed = change?.failed === true;
  const facts = [...(text.facts ?? [])];
  if (finding.region && family !== 'guardduty_finding')
    facts.push({ label: 'Região', value: finding.region });
  return {
    family: text.family,
    actor,
    summary: `${capitalize(actor.text)} ${text.action}`,
    facts,
    change: text.change ?? null,
    why: text.why,
    check: failed
      ? 'A AWS recusou a chamada, então nada mudou de fato. Ainda assim, confirme quem tentou e por quê: uma tentativa recusada pode ser alguém testando permissões.'
      : text.check,
    failed,
    suggestion: suggestionOf(input, actor),
    basis: input.basis,
  };
}
