import { generateSecret, generateURI, verify } from 'otplib';

/**
 * O segundo fator do console: TOTP (RFC 6238) pelo `otplib`, com os padrões que todo aplicativo autenticador entende
 * (SHA-1, 6 dígitos, 30 s) e um segredo de 160 bits. Aceita o passo atual e um de cada lado (relógio do celular até
 * 30 s fora). Contra reuso, o passo do último código aceito fica na conta e só um passo posterior vale
 * (`afterTimeStep`): o mesmo código não entra duas vezes, nem um código mais antigo que o último.
 */
export const TOTP_ISSUER = 'Verax Control';
const PERIOD_SECONDS = 30;
const TOLERANCE_SECONDS = PERIOD_SECONDS;
const SECRET_BYTES = 20;
const CODE_PATTERN = /^\d{6}$/;

export function newTotpSecret(): string {
  return generateSecret({ length: SECRET_BYTES });
}

/** O `otpauth://` que o QR do cadastro carrega (gerado no navegador, nunca por serviço de terceiros). */
export function totpUri(secret: string, accountEmail: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: accountEmail, secret });
}

/**
 * O passo (RFC 6238, `T`) em que o código confere, ou `undefined` (código errado, fora da janela ou de um passo igual
 * ou anterior a `afterTimeStep`).
 */
export async function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  afterTimeStep?: number,
): Promise<number | undefined> {
  if (!CODE_PATTERN.test(code)) return undefined;
  try {
    const result = await verify({
      secret,
      token: code,
      epoch: Math.floor(now.getTime() / 1000),
      epochTolerance: TOLERANCE_SECONDS,
      ...(afterTimeStep === undefined ? {} : { afterTimeStep }),
    });
    return result.valid && 'timeStep' in result ? result.timeStep : undefined;
  } catch {
    return undefined;
  }
}
