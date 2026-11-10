/** Regras das credenciais conferidas na tela antes de mandar (a API confere de novo, sempre). */

/** O segredo em blocos de 4 letras, como os aplicativos pedem para digitar à mão. */
export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

/** Um código de 6 dígitos (espaços que o aplicativo mostra no meio saem); fora disso, `undefined`. */
export function normalizeCode(value: string): string | undefined {
  const digits = value.replace(/\s+/g, '');
  return /^[0-9]{6}$/.test(digits) ? digits : undefined;
}

/** Senha nova: o mínimo da API (12) e o máximo que ela aceita. */
/**
 * As mensagens dos campos de senha das telas de acesso, num lugar só (as telas atribuem a referência, nunca o texto,
 * ao campo com problema).
 */
export const SENHA_MESSAGES = {
  typeCurrent: 'Digite a senha atual.',
  typeIt: 'Digite a senha.',
  differentFromCurrent: 'A senha nova precisa ser diferente da atual.',
} as const;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** O problema da senha nova e da confirmação, conferido antes de mandar (a API confere de novo). */
export function newPasswordProblems(
  typed: string,
  repeated: string,
): { password?: string; confirmation?: string } {
  if (typed.length < PASSWORD_MIN) return { password: `Use pelo menos ${PASSWORD_MIN} caracteres.` };
  if (typed.length > PASSWORD_MAX) return { password: `Use no máximo ${PASSWORD_MAX} caracteres.` };
  // Comparação na tela do próprio responsável, sobre o que ele digitou: nada a vazar por tempo.
  if (typed !== repeated) return { confirmation: 'A confirmação não é igual à senha.' };
  return {};
}
