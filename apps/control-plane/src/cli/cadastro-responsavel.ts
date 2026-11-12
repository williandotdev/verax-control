/**
 * O cadastro da conta do responsável no console (cp-admin), pela linha de comando de quem tem as credenciais de dono
 * do projeto do plano de controle. O console não tem tela de cadastro (a antiga `/configurar` saiu: era superfície de
 * ataque aberta na internet); este é o único caminho para criar a conta e o de emergência para refazê-la (celular e
 * códigos de recuperação perdidos) ou derrubar todas as sessões.
 *
 * Usa o mesmo código do console (`AdminAuthService.enrollOwner`): a senha em scrypt, o segredo do TOTP cifrado e os
 * códigos de recuperação assinados com as chaves derivadas (HKDF) de `cp-admin-totp-key`, lida do Secret Manager com as
 * credenciais de quem roda. A auditoria registra `owner:<e-mail das credenciais>` com o e-mail da conta no detalhe.
 *
 * - `--novo`: confere o e-mail em `OWNER_PRINCIPALS` (ou `--responsaveis`), lê a senha (sem eco no terminal, 12 ou
 *   mais, duas vezes), gera o segredo do TOTP e mostra o `otpauth://` e a chave SÓ neste terminal, pede o primeiro
 *   código do aplicativo e, aceito, grava a conta e mostra os 10 códigos de recuperação uma única vez;
 * - `--substituir` (com `--novo`): troca uma conta que já existe (senha, aplicativo e códigos), depois de digitar o
 *   e-mail de novo; as sessões dela caem. Sem ele, uma conta existente recusa o cadastro;
 * - `--encerrar-sessoes`: apaga todas as sessões do console (um computador perdido com o console aberto).
 *
 * Uso (o plano de controle compilado: o Node não executa TypeScript com decorators):
 *
 *   pnpm --filter @verax/control-plane build
 *   OWNER_PRINCIPALS=<e-mail> node apps/control-plane/dist/cli/cadastro-responsavel.js --projeto=<id> --email=<e-mail> --novo
 *   node apps/control-plane/dist/cli/cadastro-responsavel.js --projeto=<id> --encerrar-sessoes
 *
 * Opções:
 *   --projeto=<id>         o projeto GCP do plano de controle (Firestore e Secret Manager; ou FIRESTORE_PROJECT_ID)
 *   --banco=<id>           o banco do Firestore (padrão `(default)`)
 *   --email=<e-mail>       a conta a cadastrar (com --novo)
 *   --responsaveis=<lista> os e-mails de `owner_principals`, separados por vírgula (ou OWNER_PRINCIPALS); aceita o
 *                          prefixo `user:` do Terraform
 *   --novo                 cadastra a conta
 *   --substituir           com --novo: substitui a conta que já existe
 *   --encerrar-sessoes     apaga todas as sessões do console
 *
 * Saída: 0 feito, 1 recusado (e-mail fora da lista, conta existente, confirmação errada, código errado três vezes),
 * 2 uso inválido, 3 erro do Firestore, do Secret Manager ou das credenciais.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { PinoLogger } from 'nestjs-pino';
import { AdminAuthService } from '../admin/auth/admin-auth.service.js';
import { newPasswordSchema, normalizeEmail } from '../admin/auth/admin-auth.schema.js';
import { type AdminSecretSource, SecretManagerAdminSecrets } from '../admin/auth/admin-secrets.js';
import { newTotpSecret, totpUri } from '../admin/auth/totp.js';
import { AuditService } from '../audit/audit.service.js';
import { type Clock, SystemClock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import { newUlid } from '../common/ulid.js';
import { createFirestore, FirestoreDocumentStore } from '../firestore/firestore-document-store.js';
import { adcEmail, type OpenedStore } from './publicar-precos.js';

export const EXIT = { ok: 0, refused: 1, usage: 2, backend: 3 } as const;

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATABASE_PATTERN = /^(\(default\)|[a-z][a-z0-9-]{2,62})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
/** Tentativas da senha (curta ou as duas diferentes) e do primeiro código do aplicativo. */
const MAX_ATTEMPTS = 3;

/** Uma pergunta ao operador; `hidden` é a senha (sem eco no terminal). */
export type Ask = (question: string, options: { hidden: boolean }) => Promise<string>;

export interface EnrollOwnerIo {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  /** As perguntas ao operador. Em uso, o terminal (`terminalAsk`); nos testes, respostas prontas. */
  ask?: Ask;
  /** O banco do projeto. Em uso, o Firestore com as credenciais padrão; nos testes, um dublê ou o emulador. */
  openStore?: (project: string, database: string) => OpenedStore;
  /** O cofre `cp-admin-totp-key`. Em uso, o Secret Manager do projeto com as credenciais padrão. */
  secrets?: (project: string) => AdminSecretSource;
  /** Quem cadastra (o ator da auditoria). Em uso, o e-mail das credenciais padrão (`adcEmail`). */
  identity?: () => Promise<string>;
  clock?: Clock;
}

class Cancelled extends Error {}

/** A entrada padrão linha a linha, quando ela não é um terminal (um arquivo ou um pipe). */
let pipedLines: AsyncIterator<string> | undefined;

async function nextPipedLine(): Promise<string> {
  pipedLines ??= createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const next = await pipedLines.next();
  if (next.done === true) throw new Cancelled('a entrada acabou');
  return next.value;
}

/** A senha sem eco: o terminal em modo cru, cada tecla lida aqui; Ctrl+C cancela. */
function readHidden(): Promise<string> {
  const { stdin, stdout } = process;
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString()) {
        if (char === '\r' || char === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u0003' || char === '\u0004') {
          finish();
          reject(new Cancelled('cancelado'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** As perguntas no terminal: a senha sem eco; o resto, uma linha comum. */
export const terminalAsk: Ask = async (question, { hidden }) => {
  process.stdout.write(question);
  if (!process.stdin.isTTY) {
    if (hidden) {
      process.stdout.write('(a entrada não é um terminal: lida da entrada padrão) ');
    }
    return nextPipedLine();
  }
  if (hidden) return readHidden();
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once('line', resolve);
      rl.once('close', () => reject(new Cancelled('cancelado')));
    });
  } finally {
    rl.removeAllListeners('close');
    rl.close();
  }
};

function openFirestore(project: string, database: string): OpenedStore {
  const db = createFirestore({ FIRESTORE_PROJECT_ID: project, FIRESTORE_DATABASE: database });
  return { store: new FirestoreDocumentStore(db), close: () => db.terminate() };
}

/** Os e-mails da lista (`user:` e `serviceAccount:` do Terraform saem), normalizados. */
function ownerList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((item) => normalizeEmail(item.replace(/^(user|serviceAccount):/, '')))
    .filter((item) => item !== '');
}

/** A chave em grupos de 4 (como os aplicativos mostram), para digitar à mão. */
function groupedKey(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

function usage(out: (line: string) => void): void {
  out('Uso (depois de pnpm --filter @verax/control-plane build):');
  out(
    '  OWNER_PRINCIPALS=<e-mail> node apps/control-plane/dist/cli/cadastro-responsavel.js --projeto=<id> --email=<e-mail> --novo [--substituir]',
  );
  out('  node apps/control-plane/dist/cli/cadastro-responsavel.js --projeto=<id> --encerrar-sessoes');
  out(
    'Opções: --banco=(default), --responsaveis=<e-mails separados por vírgula> (no lugar de OWNER_PRINCIPALS).',
  );
  out('Credenciais: as padrão do Google (gcloud auth application-default login), de quem é dono do projeto.');
}

async function askPassword(ask: Ask, out: (line: string) => void): Promise<string | undefined> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const password = await ask('Senha nova (12 caracteres ou mais): ', { hidden: true });
    const parsed = newPasswordSchema.safeParse(password);
    if (!parsed.success) {
      out(parsed.error.issues[0]?.message ?? 'Senha inválida.');
      continue;
    }
    const again = await ask('Repita a senha: ', { hidden: true });
    // Comparação em tempo constante (pelo digest, que tem sempre o mesmo tamanho), como em todo o resto do console.
    if (sameSecret(again, password)) return password;
    out('As duas senhas não conferem.');
  }
  return undefined;
}

async function enroll(
  service: AdminAuthService,
  email: string,
  replace: boolean,
  operator: { email: string; requestId: string },
  ask: Ask,
  out: (line: string) => void,
): Promise<number> {
  const exists = await service.hasAccount(email);
  if (exists && !replace) {
    out(
      `Já existe uma conta para ${email}. Nada foi gravado. Para trocá-la (senha, aplicativo e códigos), rode de novo ` +
        'com --substituir; para só derrubar as sessões, use --encerrar-sessoes.',
    );
    return EXIT.refused;
  }
  if (exists) {
    out(
      `A conta de ${email} vai ser SUBSTITUÍDA: a senha, o aplicativo e os códigos de recuperação atuais deixam de`,
    );
    out('valer, e as sessões dela caem.');
    const typed = await ask('Para confirmar, digite o e-mail da conta de novo: ', { hidden: false });
    if (normalizeEmail(typed) !== email) {
      out('O e-mail digitado não confere. Nada foi gravado.');
      return EXIT.refused;
    }
  } else if (replace) {
    out(`Não há conta para ${email}: ela vai ser criada.`);
  }

  const password = await askPassword(ask, out);
  if (typeof password !== 'string') {
    out('Nada foi gravado.');
    return EXIT.refused;
  }

  const secret = newTotpSecret();
  out('');
  out('Cadastre no aplicativo autenticador (só neste terminal; não copie para chat, e-mail nem arquivo):');
  out(`  ${totpUri(secret, email)}`);
  out(`  chave para digitar à mão: ${groupedKey(secret)}`);
  out(
    '  (no aplicativo: adicionar conta, "inserir a chave", tipo baseado em tempo; ou gere um QR desse otpauth://',
  );
  out('  num gerador local, nunca num site)');
  out('');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const code = await ask('Código de 6 dígitos que o aplicativo mostra: ', { hidden: false });
    try {
      const result = await service.enrollOwner({ email, password, secret, code, replace }, operator);
      out('');
      out(
        `Conta ${result.replaced ? 'substituída' : 'criada'}: ${result.email}` +
          (result.sessionsRevoked > 0 ? ` (${result.sessionsRevoked} sessões encerradas).` : '.'),
      );
      out(
        'Códigos de recuperação (cada um vale uma vez, no lugar do código do aplicativo). Eles aparecem SÓ AGORA:',
      );
      out('guarde no gerenciador de senhas ou imprima.');
      for (const recoveryCode of result.recoveryCodes) out(`  ${recoveryCode}`);
      out('');
      out(
        'Limpe a tela e o histórico do terminal se ele for gravado. Entre em /entrar com o e-mail, a senha e o',
      );
      out('próximo código do aplicativo (o código usado aqui não vale de novo).');
      return EXIT.ok;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'invalid_code') {
        out(
          attempt < MAX_ATTEMPTS
            ? 'Código incorreto. Confira o relógio do celular e digite o código atual.'
            : 'Código incorreto.',
        );
        continue;
      }
      if (error instanceof ApiError && error.code === 'account_exists') {
        out('Outra conta para este e-mail foi criada enquanto isso. Nada foi gravado; rode de novo.');
        return EXIT.refused;
      }
      throw error;
    }
  }
  out('Nada foi gravado: o aplicativo não confirmou o código. Rode de novo (um segredo novo é gerado).');
  return EXIT.refused;
}

export async function main(io: EnrollOwnerIo): Promise<number> {
  const { out } = io;
  const ask = io.ask ?? terminalAsk;
  let args;
  try {
    args = parseArgs({
      args: [...io.argv],
      options: {
        projeto: { type: 'string' },
        banco: { type: 'string', default: '(default)' },
        email: { type: 'string' },
        responsaveis: { type: 'string' },
        novo: { type: 'boolean', default: false },
        substituir: { type: 'boolean', default: false },
        'encerrar-sessoes': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    usage(out);
    return EXIT.usage;
  }
  if (args.help) {
    usage(out);
    return EXIT.ok;
  }
  const revoke = args['encerrar-sessoes'];
  if (!args.novo && !revoke) {
    out('Informe --novo (cadastrar a conta) e/ou --encerrar-sessoes.');
    usage(out);
    return EXIT.usage;
  }
  if (args.substituir && !args.novo) {
    out('--substituir só vale com --novo.');
    return EXIT.usage;
  }
  const project = args.projeto ?? io.env['FIRESTORE_PROJECT_ID'];
  if (project === undefined || !PROJECT_PATTERN.test(project)) {
    out('Informe --projeto=<id> (ou FIRESTORE_PROJECT_ID): o id do projeto GCP do plano de controle.');
    return EXIT.usage;
  }
  if (!DATABASE_PATTERN.test(args.banco)) {
    out('--banco inválido: (default) ou o id do banco do Firestore.');
    return EXIT.usage;
  }
  let email: string | undefined;
  const owners = ownerList(args.responsaveis ?? io.env['OWNER_PRINCIPALS']);
  if (args.novo) {
    if (args.email === undefined || !EMAIL_PATTERN.test(args.email.trim())) {
      out('--novo exige --email=<e-mail> (um de owner_principals).');
      return EXIT.usage;
    }
    if (owners.length === 0) {
      out(
        'Informe os responsáveis em OWNER_PRINCIPALS (ou --responsaveis): os e-mails de owner_principals do ' +
          'Terraform, separados por vírgula. O console só deixa entrar quem está na lista.',
      );
      return EXIT.usage;
    }
    email = normalizeEmail(args.email);
    if (!owners.includes(email)) {
      out(`${email} não está em OWNER_PRINCIPALS: o console não o deixaria entrar. Nada foi gravado.`);
      return EXIT.refused;
    }
  }

  const clock = io.clock ?? new SystemClock();
  let operatorEmail: string;
  try {
    operatorEmail = normalizeEmail(await (io.identity ?? adcEmail)());
  } catch (error) {
    out(
      `Não consegui o e-mail das credenciais padrão (${error instanceof Error ? error.message : 'erro'}): nada foi ` +
        'gravado. Rode gcloud auth application-default login.',
    );
    return EXIT.backend;
  }
  const operator = { email: operatorEmail, requestId: newUlid(clock.now().getTime()) };
  out(`Firestore: projeto ${project}, banco ${args.banco}. Operador: owner:${operatorEmail}.`);

  let opened: OpenedStore | undefined;
  try {
    opened = (io.openStore ?? openFirestore)(project, args.banco);
    const secrets = (io.secrets ?? ((id: string) => new SecretManagerAdminSecrets(id)))(project);
    const logger = new PinoLogger({ pinoHttp: { level: 'silent' } });
    const service = new AdminAuthService(
      opened.store,
      clock,
      { OWNER_PRINCIPALS: owners },
      secrets,
      new AuditService(opened.store, clock),
      logger,
    );
    let code: number = EXIT.ok;
    if (email !== undefined) {
      try {
        await service.ensureKeys();
      } catch (error) {
        if (error instanceof ApiError && error.code === 'admin_unavailable') {
          out(
            'Não consegui abrir a chave do console (cp-admin-totp-key): o segredo está sem versão ativa, fora do ' +
              'formato (32 bytes em base64) ou sem permissão de leitura para estas credenciais. Nada foi gravado.',
          );
          return EXIT.backend;
        }
        throw error;
      }
      code = await enroll(service, email, args.substituir, operator, ask, out);
      if (code !== EXIT.ok) return code;
    }
    if (revoke) {
      const count = await service.revokeAllSessions(operator);
      out(`Sessões do console encerradas: ${count}.`);
    }
    return code;
  } catch (error) {
    if (error instanceof Cancelled) {
      out('Cancelado. Nada foi gravado.');
      return EXIT.refused;
    }
    out(`Erro do Firestore: ${error instanceof Error ? `${error.name}: ${error.message}` : 'desconhecido'}.`);
    return EXIT.backend;
  } finally {
    await opened?.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main({
    argv: process.argv.slice(2),
    env: process.env,
    out: (line) => console.log(line),
  });
  // A entrada padrão lida linha a linha (fora de um terminal) seguraria o processo aberto.
  process.stdin.destroy();
}

/** Igualdade de dois segredos em tempo constante: compara os SHA-256, de tamanho fixo. */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
