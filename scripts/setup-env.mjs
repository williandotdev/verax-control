// Cria o .env local a partir do .env.example, gerando segredos aleatórios com o CSPRNG do Node.
// Nunca sobrescreve um .env existente.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const target = '.env';
if (existsSync(target)) {
  console.log('.env já existe; nada foi alterado.');
  process.exit(0);
}

const lines = readFileSync('.env.example', 'utf8').split('\n');
const values = new Map();

const output = lines.map((line) => {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!match) return line;
  const [, key, rawValue] = match;
  let value = rawValue;
  if (value === '__GENERATE__') {
    value = randomBytes(32).toString('base64url');
  }
  // Expande ${VAR} com valores definidos antes no próprio arquivo.
  value = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => values.get(name) ?? '');
  values.set(key, value);
  return `${key}=${value}`;
});

writeFileSync(target, output.join('\n'), { mode: 0o600 });
console.log('.env criado com segredos aleatórios. Não versione este arquivo.');
