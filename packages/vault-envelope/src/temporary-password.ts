import { randomInt } from 'node:crypto';

/**
 * Senha temporária (no lugar do convite por e-mail): o administrador cria a conta ou gera uma senha nova, ela aparece
 * uma vez para ele, e no primeiro login a pessoa troca a senha e cadastra o MFA. A mesma geradora serve à API do nó e
 * ao plano de controle (o usuário que a Verax cria pelo console).
 */

/** Sem os caracteres que se confundem ao ler ou ditar (0/O, 1/l/I). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const LENGTH = 20;

/** 20 sorteios de 57 símbolos (cerca de 116 bits), em quatro grupos de cinco para ler e ditar. */
export function generateTemporaryPassword(): string {
  const chars = Array.from({ length: LENGTH }, () => ALPHABET.charAt(randomInt(ALPHABET.length)));
  return [0, 5, 10, 15].map((start) => chars.slice(start, start + 5).join('')).join('-');
}
