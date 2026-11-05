import type { MailMessage } from '../mail/mail-sender.js';
import { slugSchema } from '../tenants/tenant.schema.js';

/** Quando cada parte do ambiente sai, para o registro de exclusão (o e-mail ao admin do cliente na Exclusão 1). */
export interface DeletionRecordInput {
  to: string;
  slug: string;
  canceledAt?: Date;
  deletedAt: Date;
  cryptoDestroyAfter?: Date;
}

/** Um valor que vai ao HTML sem escapar nada: só o que o próprio plano de controle formatou. */
export class UnsafeRecordValueError extends Error {
  constructor() {
    super('valor fora do formato no registro de exclusão');
    this.name = 'UnsafeRecordValueError';
  }
}

const DATE_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const SAFE_TEXT = /^[0-9a-z/ -]{1,40}$/;

function day(date: Date): string {
  const text = DATE_FORMAT.format(date);
  if (!SAFE_TEXT.test(text)) throw new UnsafeRecordValueError();
  return text;
}

/**
 * O registro de exclusão (plano §4d, Exclusão 1): o que foi apagado, quando, e o que ainda fica até a Exclusão 2 (os
 * backups, pela retenção do bucket, e a chave do cofre de credenciais). Leva só o subdomínio e datas (o HTML é montado
 * com valores do próprio plano de controle, conferidos: nada vindo do cliente entra nele). Nunca a razão social, o CNPJ
 * nem senha alguma.
 */
export function buildDeletionRecord(input: DeletionRecordInput): MailMessage {
  if (!slugSchema.safeParse(input.slug).success) throw new UnsafeRecordValueError();
  const deleted = day(input.deletedAt);
  const canceled = input.canceledAt === undefined ? undefined : day(input.canceledAt);
  const final = input.cryptoDestroyAfter === undefined ? undefined : day(input.cryptoDestroyAfter);
  const lines = [
    `O ambiente ${input.slug} do Verax Control foi excluído em ${deleted}.`,
    ...(canceled === undefined ? [] : [`A assinatura foi cancelada em ${canceled}.`]),
    '',
    'Foram apagados: a máquina do ambiente, o disco e os snapshots, o painel e o endereço da API, o túnel e os',
    'registros de DNS, e os cofres de senha do ambiente. O e-mail do administrador deixa de ficar no nosso cadastro.',
    '',
    final === undefined
      ? 'Os backups do banco saem pela retenção de 90 dias do bucket, e a chave que protege as credenciais conectadas é destruída em seguida.'
      : `Os backups do banco saem pela retenção de 90 dias do bucket, e a chave que protege as credenciais conectadas é destruída em ${final}.`,
    'Ficam, por obrigação fiscal, a razão social, o CNPJ e as faturas, por 5 anos.',
    '',
    'Equipe Verax',
  ];
  const html = lines
    .map((line) => (line === '' ? '' : `<p>${line}</p>`))
    .filter((line) => line !== '')
    .join('\n');
  return {
    to: input.to,
    subject: `Registro de exclusão do ambiente ${input.slug}`,
    text: lines.join('\n'),
    html,
  };
}
