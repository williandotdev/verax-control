import type { MailMessage } from '../mail/mail-sender.js';

/** O fragmento do link do e-mail: o navegador não o manda a servidor nenhum, nem no `Referer`, nem ao Hosting. */
export const REVEAL_LINK_FRAGMENT = 'acesso';

/**
 * A página de status do site (plano §9, item 18), tirada de `SITE_SUCCESS_URL` sem a query (`?cs=...`): o mesmo
 * endereço que o Checkout abre depois do pagamento. `undefined` sem a variável.
 */
export function statusPageUrl(siteSuccessUrl: string | undefined): string | undefined {
  if (siteSuccessUrl === undefined) return undefined;
  const url = new URL(siteSuccessUrl);
  return `${url.origin}${url.pathname}`;
}

/** O link de uso único: a página de status com o valor no fragmento (`#acesso=<valor>`). */
export function revealLink(pageUrl: string, value: string): string {
  return `${pageUrl}#${REVEAL_LINK_FRAGMENT}=${value}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});

/** Caracteres com significado no HTML do e-mail (texto e valor de atributo). */
const HTML_SPECIAL_CHARACTERS = ['&', '<', '>', '"', "'"] as const;

/**
 * O que entra no corpo HTML são só valores montados pelo próprio plano de controle: os dois endereços (o painel, de
 * `tenantUrls`, e o link, da página de status com o valor em base64url) e a data formatada. Em vez de escapar à mão,
 * o e-mail é recusado (a task repete e o responsável vê o erro) se algum deles trouxer um caractere especial de HTML,
 * e os endereços precisam ser https.
 */
export class UnsafeEmailValueError extends TypeError {
  constructor() {
    super('valor impróprio para o HTML do e-mail do plano B');
    this.name = 'UnsafeEmailValueError';
  }
}

function htmlText(value: string): string {
  if (HTML_SPECIAL_CHARACTERS.some((character) => value.includes(character)))
    throw new UnsafeEmailValueError();
  return value;
}

function htmlUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeEmailValueError();
  }
  if (url.protocol !== 'https:') throw new UnsafeEmailValueError();
  return htmlText(value);
}

export interface RevealEmailInput {
  to: string;
  panelUrl: string;
  link: string;
  linkExpiresAt: Date;
}

/**
 * O e-mail do plano B (plano §4c, passo 9): o ambiente está pronto e a senha ainda não foi vista. Leva o endereço do
 * painel e o link de uso único (24 h) para a página de status, que mostra a senha uma vez. Nunca leva a senha.
 */
export function buildRevealEmail(input: RevealEmailInput): MailMessage {
  const until = `${DATE_FORMAT.format(input.linkExpiresAt)} (horário de Brasília)`;
  const panelUrl = htmlUrl(input.panelUrl);
  const link = htmlUrl(input.link);
  const subject = 'Seu Verax Control está pronto: veja o acesso do administrador';
  const text = [
    'Olá,',
    '',
    `O seu ambiente do Verax Control está pronto em ${panelUrl}.`,
    '',
    'A senha temporária do primeiro administrador ainda não foi vista. Para vê-la, abra o link abaixo. Ele funciona',
    `uma vez e vale até ${until}:`,
    '',
    link,
    '',
    'A senha aparece uma única vez, na página, e não vai por e-mail. No primeiro acesso ao painel você troca a senha',
    'e cadastra a verificação em duas etapas.',
    '',
    'Se você não contratou o Verax Control, ignore esta mensagem.',
    '',
    'Equipe Verax',
  ].join('\n');
  const html = [
    '<p>Olá,</p>',
    `<p>O seu ambiente do Verax Control está pronto em <a href="${panelUrl}">${panelUrl}</a>.</p>`,
    '<p>A senha temporária do primeiro administrador ainda não foi vista. Para vê-la, abra o link abaixo. Ele funciona',
    `uma vez e vale até ${htmlText(until)}:</p>`,
    `<p><a href="${link}">Ver o acesso do administrador</a></p>`,
    '<p>A senha aparece uma única vez, na página, e não vai por e-mail. No primeiro acesso ao painel você troca a',
    'senha e cadastra a verificação em duas etapas.</p>',
    '<p>Se você não contratou o Verax Control, ignore esta mensagem.</p>',
    '<p>Equipe Verax</p>',
  ].join('\n');
  return { to: input.to, subject, text, html };
}
