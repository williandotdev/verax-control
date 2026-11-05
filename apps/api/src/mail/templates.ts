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

/** O aviso por e-mail (fase 2, PR-16), já com o link do painel. Cada tipo leva só o que o texto fixo dele precisa. */
export type NoticeMail =
  | { kind: 'incident_opened' | 'incident_escalated'; severity: 'high' | 'critical'; link: string }
  | { kind: 'critical_finding'; link: string }
  | { kind: 'aws_ingestion_stalled'; link: string }
  | { kind: 'plan_usage'; percent: 80 | 100; month: Date; link: string };

const SEVERITY_TEXT = { high: 'alta', critical: 'crítica' } as const;

/** Mês do uso por extenso ("novembro de 2026"); a coluna guarda o primeiro dia à meia-noite UTC. */
const MONTH_FORMAT = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Os detalhes do incidente e do achado ficam só no painel: um e-mail pode ser encaminhado ou lido por quem não devia. */
const DETAILS_IN_PANEL =
  'Por segurança, os detalhes (contas, recursos, IPs e identidades) aparecem só no painel, depois do login com MFA.';

/**
 * O que a pessoa pode mudar: os avisos de incidente e de achado crítico seguem a preferência dela (fase 2, PR-17'). Os
 * do plano e da coleta da AWS, para quem administra o cliente, não.
 */
const PREFERENCE_HINT =
  'Para não receber mais os avisos de incidente por e-mail, desligue a opção em Minha conta, no painel.';

/** Os avisos que a preferência da pessoa controla. */
export function isIncidentNotice(notice: NoticeMail): boolean {
  return (
    notice.kind === 'incident_opened' ||
    notice.kind === 'incident_escalated' ||
    notice.kind === 'critical_finding'
  );
}

/**
 * Título fixo por tipo e severidade (o assunto é ele com o nome do produto, e o item do resumo é ele) e o que o corpo
 * diz. Nada vem do achado, do incidente ou da conta.
 */
function noticeContent(notice: NoticeMail): { title: string; lines: string[]; action: string } {
  switch (notice.kind) {
    case 'incident_opened':
      return {
        title: `Incidente de severidade ${SEVERITY_TEXT[notice.severity]} aberto`,
        lines: [`Um incidente de severidade ${SEVERITY_TEXT[notice.severity]} foi aberto.`, DETAILS_IN_PANEL],
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
      return {
        title: 'Achado de severidade crítica',
        lines: [
          'Chegou um achado de severidade crítica que não entrou em nenhum incidente.',
          DETAILS_IN_PANEL,
        ],
        action: 'Ver o achado',
      };
    case 'aws_ingestion_stalled':
      return {
        title: 'Coleta da AWS parada',
        lines: [
          'A coleta dos logs de uma conta AWS parou. Enquanto ela estiver parada, a atividade nessa conta não vira achado.',
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
              'A coleta, os achados e os incidentes continuam normalmente. Para ajustar o plano, fale com a Verax.',
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
  const { title, lines, action } = noticeContent(notice);
  const closing = closingLines('este aviso', isIncidentNotice(notice));
  return {
    to,
    subject: singleLine(`${title} no ${PRODUCT_NAME}`),
    text: [`Olá, ${name}.`, ...lines, `${action}: ${notice.link}`, ...closing, PRODUCT_NAME].join('\n\n'),
    html: [
      `<p>Olá, ${escapeHtml(name)}.</p>`,
      ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
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

const countOf = (total: number) => `${total} ${total === 1 ? 'aviso' : 'avisos'}`;

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
  const items = digest.items.map(({ notice, at }) => ({
    when: AT_FORMAT.format(at),
    title: noticeContent(notice).title,
    link: notice.link,
  }));
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
