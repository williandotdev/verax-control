import { NOTICE_HOURLY_LIMIT, PRODUCT_NAME } from '@verax/shared';
import type { MailMessage } from './mail.types.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface LinkMail {
  to: string;
  name: string;
  link: string;
  validMinutes: number;
}

function render(
  subject: string,
  intro: string,
  action: string,
  { to, name, link, validMinutes }: LinkMail,
): MailMessage {
  const closing = `O link vale por ${validMinutes} minutos e só pode ser usado uma vez. Se você não esperava esta mensagem, ignore-a.`;
  return {
    to,
    subject,
    text: `Olá, ${name}.\n\n${intro}\n\n${action}: ${link}\n\n${closing}\n\n${PRODUCT_NAME}`,
    html: [
      `<p>Olá, ${escapeHtml(name)}.</p>`,
      `<p>${escapeHtml(intro)}</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p>`,
      `<p>${escapeHtml(closing)}</p>`,
      `<p>${escapeHtml(PRODUCT_NAME)}</p>`,
    ].join('\n'),
  };
}

export function passwordResetMail(data: LinkMail): MailMessage {
  return render(
    `Redefinição de senha do ${PRODUCT_NAME}`,
    'Recebemos um pedido para redefinir a sua senha.',
    'Redefinir senha',
    data,
  );
}

/** Um caso na lista de um e-mail: o título do dicionário dos casos, as contagens e o link. Nada do evento. */
export interface CaseMailItem {
  title: string;
  critical: number;
  high: number;
  link: string;
}

/** Os casos pendentes de uma fila, e os alertas deles. */
export interface CaseQueueTotals {
  cases: number;
  critical: number;
  high: number;
}

/** O aviso por e-mail (fase 2, PR-16), já com o link do painel. Cada tipo leva só o que o texto fixo dele precisa. */
export type NoticeMail =
  | { kind: 'incident_opened'; severity: 'low' | 'medium' | 'high' | 'critical'; link: string }
  | { kind: 'incident_escalated'; severity: 'high' | 'critical'; link: string }
  | { kind: 'critical_finding'; link: string }
  | { kind: 'high_finding'; link: string }
  | { kind: 'aws_ingestion_stalled'; link: string }
  | { kind: 'plan_usage'; percent: 80 | 100; month: Date; link: string }
  | {
      /** Um caso de detecção (`CASES_MODE=on`): a severidade do aviso, e as contagens de agora. */
      kind: 'case';
      severity: 'high' | 'critical';
      /** O caso já avisado cresceu. */
      growth: boolean;
      /** Do dicionário dos casos; null para quem não é do cliente (o contato de escalonamento). */
      title: string | null;
      critical: number;
      high: number;
      link: string;
    }
  | {
      /** Os casos críticos novos de vulnerabilidade e postura, todos num aviso. */
      kind: 'cases_critical';
      cases: number;
      critical: number;
      items: readonly CaseMailItem[];
      link: string;
    }
  | {
      /** O resumo diário de vulnerabilidades e postura. */
      kind: 'cases_daily';
      vulnerability: CaseQueueTotals;
      posture: CaseQueueTotals;
      items: readonly CaseMailItem[];
      link: string;
    };

const SEVERITY_TEXT = { low: 'baixa', medium: 'média', high: 'alta', critical: 'crítica' } as const;

/** Mês do uso por extenso ("novembro de 2026"); a coluna guarda o primeiro dia à meia-noite UTC. */
const MONTH_FORMAT = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Os detalhes do incidente e do alerta ficam só no painel: um e-mail pode ser encaminhado ou lido por quem não devia. */
const DETAILS_IN_PANEL =
  'Por segurança, os detalhes (contas, recursos, IPs e identidades) aparecem só no painel, depois do login com MFA.';

/**
 * O que a pessoa pode mudar: os avisos de incidente e de alerta alto ou crítico seguem a preferência dela (fase 2, PR-17'). Os
 * do plano e da coleta da AWS, para quem administra o cliente, não.
 */
const PREFERENCE_HINT =
  'Para não receber mais os avisos de alertas e incidentes por e-mail, desligue a opção em Minha conta, no painel.';

/** Os avisos que a preferência da pessoa controla. */
export function isIncidentNotice(notice: NoticeMail): boolean {
  return (
    notice.kind === 'incident_opened' ||
    notice.kind === 'incident_escalated' ||
    notice.kind === 'critical_finding' ||
    notice.kind === 'high_finding' ||
    notice.kind === 'case' ||
    notice.kind === 'cases_critical' ||
    notice.kind === 'cases_daily'
  );
}

/** Contagem como se escreve aqui: 12.835. */
const COUNT_FORMAT = new Intl.NumberFormat('pt-BR');
const numberOf = (count: number, one: string, many: string) =>
  `${COUNT_FORMAT.format(count)} ${count === 1 ? one : many}`;

/** "3 alertas críticos e 12 altos", sem a parte que é zero. */
function alertsText(critical: number, high: number): string {
  if (critical === 0) return numberOf(high, 'alerta alto', 'alertas altos');
  const criticals = numberOf(critical, 'alerta crítico', 'alertas críticos');
  return high === 0 ? criticals : `${criticals} e ${numberOf(high, 'alto', 'altos')}`;
}

/** O tamanho do título de um caso no e-mail: o da coluna. */
const CASE_TITLE_MAX = 200;
/** O título vem do dicionário dos casos, e não do evento; ainda assim, vai numa linha só e com tamanho limitado. */
const caseTitleText = (title: string) => singleLine(title).slice(0, CASE_TITLE_MAX);

const caseItems = (items: readonly CaseMailItem[]): { text: string; link: string }[] =>
  items.map(({ title, critical, high, link }) => ({
    text: `${caseTitleText(title)}: ${alertsText(critical, high)}`,
    link,
  }));

/** Vulnerabilidades ou postura, numa linha do resumo diário. */
const queueLine = (name: string, { cases, critical, high }: CaseQueueTotals): string[] =>
  cases === 0 ? [] : [`${name}: ${numberOf(cases, 'caso', 'casos')} com ${alertsText(critical, high)}.`];

interface NoticeContent {
  /** O assunto, com o nome do produto: sempre fixo, por tipo e severidade. */
  title: string;
  /** O item do resumo da hora, se diz mais que o título. */
  digestTitle?: string;
  lines: string[];
  /** Uma lista de casos, depois das linhas. */
  items?: { text: string; link: string }[];
  action: string;
}

/** O caso que espera a validação: o que o corpo do e-mail explica. */
const CASE_HINT =
  'Um caso reúne alertas parecidos: enquanto ele estiver pendente, os próximos alertas dele não geram um e-mail cada.';

/**
 * Título fixo por tipo e severidade (o assunto é ele com o nome do produto, e o item do resumo é ele) e o que o corpo
 * diz. Nada vem do alerta, do incidente ou da conta; do caso, só o título do dicionário e as contagens, e nunca no assunto.
 */
function noticeContent(notice: NoticeMail): NoticeContent {
  switch (notice.kind) {
    case 'case': {
      const title = `Caso de severidade ${SEVERITY_TEXT[notice.severity]}${notice.growth ? ' cresceu' : ''}`;
      const name = notice.title === null ? null : caseTitleText(notice.title);
      const alerts = alertsText(notice.critical, notice.high);
      const subject = name === null ? 'Um caso' : `O caso "${name}"`;
      return {
        title,
        digestTitle: `${title}: ${name === null ? '' : `${name}, `}${alerts}`,
        lines: notice.growth
          ? [
              `${subject} mudou desde o último aviso: chegaram muito mais alertas, uma tática de ataque que ele não tinha ou um alerta crítico novo durante a análise.`,
              `A validar agora: ${alerts}.`,
              DETAILS_IN_PANEL,
            ]
          : [
              `${subject} tem ${alerts} a validar: pode ser um falso positivo ou virar um incidente.`,
              CASE_HINT,
              DETAILS_IN_PANEL,
            ],
        action: 'Ver o caso',
      };
    }
    case 'cases_critical': {
      const title = 'Casos críticos novos de vulnerabilidade ou postura';
      const cases = numberOf(notice.cases, 'caso', 'casos');
      const alerts = numberOf(notice.critical, 'alerta crítico', 'alertas críticos');
      return {
        title,
        digestTitle: `${title}: ${cases} com ${alerts}`,
        lines: [
          'Entraram alertas críticos novos nas filas de vulnerabilidades e de postura.',
          `Agora há ${cases} com ${alerts} a validar.${notice.items.length > 0 ? ' Os que receberam alerta por último:' : ''}`,
        ],
        items: caseItems(notice.items),
        action: 'Ver a fila',
      };
    }
    case 'cases_daily': {
      const title = 'Resumo diário de vulnerabilidades e postura';
      const { vulnerability, posture } = notice;
      const cases = vulnerability.cases + posture.cases;
      const alerts = alertsText(vulnerability.critical + posture.critical, vulnerability.high + posture.high);
      return {
        title,
        digestTitle: `${title}: ${numberOf(cases, 'caso', 'casos')} com ${alerts}`,
        lines: [
          'Os casos de vulnerabilidade e de postura que esperam validação, com alertas críticos ou altos:',
          ...queueLine('Vulnerabilidades', vulnerability),
          ...queueLine('Postura', posture),
          ...(notice.items.length > 0 ? ['Os piores:'] : []),
        ],
        items: caseItems(notice.items),
        action: 'Ver a fila',
      };
    }
    case 'incident_opened':
      return {
        title: `Incidente de severidade ${SEVERITY_TEXT[notice.severity]} confirmado`,
        lines: [
          `Alertas foram validados e confirmados como um incidente de severidade ${SEVERITY_TEXT[notice.severity]}.`,
          DETAILS_IN_PANEL,
        ],
        action: 'Ver o incidente',
      };
    case 'incident_escalated':
      return {
        title: `Incidente subiu para severidade ${SEVERITY_TEXT[notice.severity]}`,
        lines: [
          `Um incidente em aberto subiu para severidade ${SEVERITY_TEXT[notice.severity]}.`,
          DETAILS_IN_PANEL,
        ],
        action: 'Ver o incidente',
      };
    case 'critical_finding':
    case 'high_finding': {
      const severity = notice.kind === 'critical_finding' ? 'crítica' : 'alta';
      return {
        title: `Alerta de severidade ${severity}`,
        lines: [
          `Chegou um alerta de severidade ${severity}. Ele precisa ser validado: pode ser um falso positivo ou virar um incidente.`,
          DETAILS_IN_PANEL,
        ],
        action: 'Ver o alerta',
      };
    }
    case 'aws_ingestion_stalled':
      return {
        title: 'Coleta da AWS parada',
        lines: [
          'A coleta dos logs de uma conta AWS parou. Enquanto ela estiver parada, a atividade nessa conta não vira alerta.',
          'Confira o estado da conexão em Contas cloud.',
        ],
        action: 'Ver as contas cloud',
      };
    case 'plan_usage': {
      const month = MONTH_FORMAT.format(notice.month);
      return notice.percent === 100
        ? {
            title: 'Volume mensal do plano atingido',
            lines: [
              `O volume de logs lido em ${month} chegou ao limite mensal do plano.`,
              'A coleta, os alertas e os incidentes continuam normalmente. Para ajustar o plano, fale com a Verax.',
            ],
            action: 'Ver o plano e uso',
          }
        : {
            title: '80% do volume mensal do plano',
            lines: [
              `O volume de logs lido em ${month} chegou a 80% do limite mensal do plano.`,
              'A coleta continua normalmente.',
            ],
            action: 'Ver o plano e uso',
          };
    }
  }
}

/** Cabeçalho numa linha só: nenhum CR, LF ou outro caractere de controle chega ao assunto. */
function singleLine(value: string): string {
  // eslint-disable-next-line no-control-regex -- a regra é justamente tirar os caracteres de controle
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/** O fecho dos avisos: por que a pessoa recebe e, nos de incidente, como deixar de receber. */
function closingLines(what: 'este aviso' | 'este resumo', withHint: boolean): string[] {
  const closing = `Você recebe ${what} por ter acesso a este cliente no ${PRODUCT_NAME}.`;
  return withHint ? [closing, PREFERENCE_HINT] : [closing];
}

/** O e-mail de um aviso para uma pessoa: o texto fixo do tipo e o link do painel, com o HTML escapado. */
export function noticeMail(to: string, name: string, notice: NoticeMail): MailMessage {
  const { title, lines, items = [], action } = noticeContent(notice);
  const details = items.length > 0 ? [DETAILS_IN_PANEL] : [];
  const closing = [...details, ...closingLines('este aviso', isIncidentNotice(notice))];
  return {
    to,
    subject: singleLine(`${title} no ${PRODUCT_NAME}`),
    text: [
      `Olá, ${name}.`,
      ...lines,
      ...(items.length === 0 ? [] : [items.map((item) => `- ${item.text}: ${item.link}`).join('\n')]),
      `${action}: ${notice.link}`,
      ...closing,
      PRODUCT_NAME,
    ].join('\n\n'),
    html: [
      `<p>Olá, ${escapeHtml(name)}.</p>`,
      ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
      ...(items.length === 0
        ? []
        : [
            '<ul>',
            ...items.map(
              (item) => `<li><a href="${escapeHtml(item.link)}">${escapeHtml(item.text)}</a></li>`,
            ),
            '</ul>',
          ]),
      `<p><a href="${escapeHtml(notice.link)}">${escapeHtml(action)}</a></p>`,
      ...closing.map((line) => `<p>${escapeHtml(line)}</p>`),
      `<p>${escapeHtml(PRODUCT_NAME)}</p>`,
    ].join('\n'),
  };
}

/** Um aviso no resumo: o texto fixo do tipo, o link dele no painel e quando entrou na fila. */
export interface DigestItem {
  notice: NoticeMail;
  at: Date;
}

/**
 * O resumo de uma hora de avisos de uma pessoa (fase 2, PR-17'), já com os itens que aparecem (até 10, os críticos
 * primeiro) e o total reunido.
 */
export interface DigestMail {
  /** Algum aviso tinha mais de 24 h na fila: o resumo de retomada. */
  catchUp: boolean;
  /** A hora do resumo (minuto zero). */
  hourStart: Date;
  items: readonly DigestItem[];
  /** Avisos reunidos, inclusive os que não aparecem na lista. */
  total: number;
  /** O painel, para os avisos que passam da lista. */
  panelLink: string;
}

/** Data e hora no horário de Brasília (o do cliente), como o painel mostra. */
const AT_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const DAY_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const HOUR_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  hour: 'numeric',
  hourCycle: 'h23',
});

function hourOf(at: Date): string {
  return `${Number.parseInt(HOUR_FORMAT.format(at), 10)}h`;
}

const countOf = (total: number) => numberOf(total, 'aviso', 'avisos');

/** Assunto e abertura fixos do resumo; o texto só leva a hora, a contagem e o limite. */
function digestIntro(digest: DigestMail): { subject: string; intro: string } {
  if (digest.catchUp) {
    return {
      subject: `Retomada dos avisos atrasados no ${PRODUCT_NAME}`,
      intro: `O envio dos avisos por e-mail ficou atrasado por mais de 24 horas. Para não mandar um e-mail por aviso antigo, os avisos desta retomada vieram reunidos aqui: ${countOf(digest.total)} no total.`,
    };
  }
  const hourEnd = new Date(digest.hourStart.getTime() + 3_600_000);
  const window = `das ${hourOf(digest.hourStart)} às ${hourOf(hourEnd)} de ${DAY_FORMAT.format(digest.hourStart)} (horário de Brasília)`;
  return {
    subject: `Resumo dos avisos da hora no ${PRODUCT_NAME}`,
    intro: `Você recebeu ${NOTICE_HOURLY_LIMIT} avisos por e-mail ${window}. Para não lotar a sua caixa, os avisos seguintes dessa hora vieram reunidos aqui: ${countOf(digest.total)} no total.`,
  };
}

/**
 * O e-mail do resumo para uma pessoa: o texto fixo, a lista dos avisos (o título fixo de cada um, a hora e o link do
 * painel), "e mais N" quando passa da lista e o HTML escapado. Como no aviso avulso, nada do achado, do incidente ou da
 * conta.
 */
export function digestMail(to: string, name: string, digest: DigestMail): MailMessage {
  const { subject, intro } = digestIntro(digest);
  const items = digest.items.map(({ notice, at }) => {
    const { title, digestTitle = title } = noticeContent(notice);
    return { when: AT_FORMAT.format(at), title: digestTitle, link: notice.link };
  });
  const more = digest.total - items.length;
  const moreText = more > 0 ? `E mais ${countOf(more)} neste resumo.` : null;
  const closing = closingLines(
    'este resumo',
    digest.items.some(({ notice }) => isIncidentNotice(notice)),
  );
  return {
    to,
    subject: singleLine(subject),
    text: [
      `Olá, ${name}.`,
      intro,
      items.map((item) => `- ${item.when} · ${item.title}: ${item.link}`).join('\n'),
      ...(moreText === null ? [] : [`${moreText} Veja todos no painel: ${digest.panelLink}`]),
      DETAILS_IN_PANEL,
      ...closing,
      PRODUCT_NAME,
    ].join('\n\n'),
    html: [
      `<p>Olá, ${escapeHtml(name)}.</p>`,
      `<p>${escapeHtml(intro)}</p>`,
      '<ul>',
      ...items.map(
        (item) =>
          `<li>${escapeHtml(item.when)} · <a href="${escapeHtml(item.link)}">${escapeHtml(item.title)}</a></li>`,
      ),
      '</ul>',
      ...(moreText === null
        ? []
        : [`<p>${escapeHtml(moreText)} <a href="${escapeHtml(digest.panelLink)}">Ver no painel</a></p>`]),
      `<p>${escapeHtml(DETAILS_IN_PANEL)}</p>`,
      ...closing.map((line) => `<p>${escapeHtml(line)}</p>`),
      `<p>${escapeHtml(PRODUCT_NAME)}</p>`,
    ].join('\n'),
  };
}

/** Os avisos que chegam ao contato de escalonamento (D8): só os críticos, de incidente, de alerta e de caso. */
export type EscalationNotice = Extract<
  NoticeMail,
  { kind: 'incident_opened' | 'incident_escalated' | 'critical_finding' | 'case' | 'cases_critical' }
>;

/** O contato não é pessoa do cliente e não entra no painel: nem o título do caso, nem a lista dos casos. */
function withoutCaseDetails(notice: EscalationNotice): EscalationNotice {
  if (notice.kind === 'case') return { ...notice, title: null };
  return notice.kind === 'cases_critical' ? { ...notice, items: [] } : notice;
}

/** Por que o contato recebe e como deixa de receber: o fecho fixo dos e-mails a ele. */
function escalationClosing(unsubscribeLink: string): { text: string[]; html: string[] } {
  const why = `Você recebe este e-mail por ser o contato de escalonamento cadastrado no ${PRODUCT_NAME}, que recebe só os avisos críticos.`;
  const leave = 'Para não receber mais, use o link';
  return {
    text: [why, `${leave}: ${unsubscribeLink}`],
    html: [
      `<p>${escapeHtml(why)}</p>`,
      `<p><a href="${escapeHtml(unsubscribeLink)}">${escapeHtml('Não quero mais receber estes avisos')}</a></p>`,
    ],
  };
}

/** O pedido de confirmação ao contato de escalonamento: os links vão escapados, e nada do cliente entra no texto. */
export interface EscalationConfirmationMail {
  confirmLink: string;
  unsubscribeLink: string;
  validHours: number;
}

/**
 * O e-mail que pede ao contato de escalonamento (D8) para confirmar o endereço: o que ele vai receber, o link de
 * confirmação (uso único) e o de descadastro. Sem a confirmação, nada mais sai para o endereço. Assunto fixo, HTML
 * escapado, e nada do cliente, de incidente ou de conta.
 */
export function escalationConfirmationMail(
  to: string,
  name: string,
  { confirmLink, unsubscribeLink, validHours }: EscalationConfirmationMail,
): MailMessage {
  const intro = `Este endereço foi cadastrado como contato de escalonamento no ${PRODUCT_NAME}, o painel de segurança em nuvem da Verax. Se você confirmar, vai receber por e-mail só os avisos críticos (incidente de severidade crítica e alerta crítico), sem detalhes: eles ficam no painel, para quem tem acesso.`;
  const action = 'Confirmar o endereço';
  const validity = `O link vale por ${validHours} horas e só pode ser usado uma vez. Se você não reconhece este cadastro, ignore esta mensagem: sem a confirmação, nada mais é enviado a este endereço.`;
  const leave = 'Para não receber nem este pedido de novo, use o link';
  return {
    to,
    subject: singleLine(`Confirme o contato de escalonamento no ${PRODUCT_NAME}`),
    text: [
      `Olá, ${name}.`,
      intro,
      `${action}: ${confirmLink}`,
      validity,
      `${leave}: ${unsubscribeLink}`,
      PRODUCT_NAME,
    ].join('\n\n'),
    html: [
      `<p>Olá, ${escapeHtml(name)}.</p>`,
      `<p>${escapeHtml(intro)}</p>`,
      `<p><a href="${escapeHtml(confirmLink)}">${escapeHtml(action)}</a></p>`,
      `<p>${escapeHtml(validity)}</p>`,
      `<p><a href="${escapeHtml(unsubscribeLink)}">${escapeHtml('Não quero receber estes avisos')}</a></p>`,
      `<p>${escapeHtml(PRODUCT_NAME)}</p>`,
    ].join('\n'),
  };
}

/**
 * O aviso crítico para o contato de escalonamento (D8): o mesmo título e o mesmo texto fixo do aviso das pessoas, o link
 * do painel (que pede login com MFA) e o link de descadastro, no lugar da dica de Minha conta (o contato não tem
 * conta). Nada do achado, do incidente ou da conta; HTML escapado.
 */
export function escalationNoticeMail(
  to: string,
  name: string,
  notice: EscalationNotice,
  unsubscribeLink: string,
): MailMessage {
  const { title, lines, action } = noticeContent(withoutCaseDetails(notice));
  const closing = escalationClosing(unsubscribeLink);
  const panel = `${action} no painel (com login)`;
  return {
    to,
    subject: singleLine(`${title} no ${PRODUCT_NAME}`),
    text: [`Olá, ${name}.`, ...lines, `${panel}: ${notice.link}`, ...closing.text, PRODUCT_NAME].join('\n\n'),
    html: [
      `<p>Olá, ${escapeHtml(name)}.</p>`,
      ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
      `<p><a href="${escapeHtml(notice.link)}">${escapeHtml(panel)}</a></p>`,
      ...closing.html,
      `<p>${escapeHtml(PRODUCT_NAME)}</p>`,
    ].join('\n'),
  };
}
