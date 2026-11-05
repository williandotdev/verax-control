import { PRODUCT_NAME } from '@verax/shared';
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

/** Assunto fixo por tipo e severidade, e o que o corpo diz. Nada vem do achado, do incidente ou da conta. */
function noticeContent(notice: NoticeMail): { subject: string; lines: string[]; action: string } {
  switch (notice.kind) {
    case 'incident_opened':
      return {
        subject: `Incidente de severidade ${SEVERITY_TEXT[notice.severity]} aberto no ${PRODUCT_NAME}`,
        lines: [`Um incidente de severidade ${SEVERITY_TEXT[notice.severity]} foi aberto.`, DETAILS_IN_PANEL],
        action: 'Ver o incidente',
      };
    case 'incident_escalated':
      return {
        subject: `Incidente subiu para severidade ${SEVERITY_TEXT[notice.severity]} no ${PRODUCT_NAME}`,
        lines: [
          `Um incidente em aberto subiu para severidade ${SEVERITY_TEXT[notice.severity]}.`,
          DETAILS_IN_PANEL,
        ],
        action: 'Ver o incidente',
      };
    case 'critical_finding':
      return {
        subject: `Achado de severidade crítica no ${PRODUCT_NAME}`,
        lines: [
          'Chegou um achado de severidade crítica que não entrou em nenhum incidente.',
          DETAILS_IN_PANEL,
        ],
        action: 'Ver o achado',
      };
    case 'aws_ingestion_stalled':
      return {
        subject: `Coleta da AWS parada no ${PRODUCT_NAME}`,
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
            subject: `Volume mensal do plano atingido no ${PRODUCT_NAME}`,
            lines: [
              `O volume de logs lido em ${month} chegou ao limite mensal do plano.`,
              'A coleta, os achados e os incidentes continuam normalmente. Para ajustar o plano, fale com a Verax.',
            ],
            action: 'Abrir o painel',
          }
        : {
            subject: `80% do volume mensal do plano no ${PRODUCT_NAME}`,
            lines: [
              `O volume de logs lido em ${month} chegou a 80% do limite mensal do plano.`,
              'A coleta continua normalmente.',
            ],
            action: 'Abrir o painel',
          };
    }
  }
}

/** Cabeçalho numa linha só: nenhum CR, LF ou outro caractere de controle chega ao assunto. */
function singleLine(value: string): string {
  // eslint-disable-next-line no-control-regex -- a regra é justamente tirar os caracteres de controle
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/** O e-mail de um aviso para uma pessoa: o texto fixo do tipo e o link do painel, com o HTML escapado. */
export function noticeMail(to: string, name: string, notice: NoticeMail): MailMessage {
  const { subject, lines, action } = noticeContent(notice);
  const closing = `Você recebe este aviso por ter acesso a este cliente no ${PRODUCT_NAME}.`;
  return {
    to,
    subject: singleLine(subject),
    text: [`Olá, ${name}.`, ...lines, `${action}: ${notice.link}`, closing, PRODUCT_NAME].join('\n\n'),
    html: [
      `<p>Olá, ${escapeHtml(name)}.</p>`,
      ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
      `<p><a href="${escapeHtml(notice.link)}">${escapeHtml(action)}</a></p>`,
      `<p>${escapeHtml(closing)}</p>`,
      `<p>${escapeHtml(PRODUCT_NAME)}</p>`,
    ].join('\n'),
  };
}
