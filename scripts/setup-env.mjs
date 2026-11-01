// Cria o .env local a partir do .env.example, gerando segredos aleatórios com o CSPRNG do Node.
// Se o .env já existe, nunca altera o que está nele: só acrescenta as variáveis novas do .env.example.
// Nenhum valor é impresso, só os nomes das variáveis.
//
// O arquivo é aberto uma única vez ("a+": cria se não existir, lê e acrescenta pelo mesmo descritor). Não
// há checagem separada da escrita, então não há janela para condição de corrida.
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fstatSync, openSync, readFileSync, writeSync } from 'node:fs';

const target = '.env';
const VARIABLE = /^([A-Z0-9_]+)=(.*)$/;

function parse(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = VARIABLE.exec(line.trim());
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function resolve(rawValue, values) {
  const value = rawValue === '__GENERATE__' ? randomBytes(32).toString('base64url') : rawValue;
  // Expande ${VAR} com valores já conhecidos (do .env existente ou definidos antes no exemplo).
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => values.get(name) ?? '');
}

const exampleLines = readFileSync('.env.example', 'utf8').split('\n');

function createNew(fd) {
  const values = new Map();
  const output = exampleLines.map((line) => {
    const match = VARIABLE.exec(line);
    if (!match) return line;
    const value = resolve(match[2], values);
    values.set(match[1], value);
    return `${match[1]}=${value}`;
  });
  writeSync(fd, output.join('\n'));
  console.log('.env criado com segredos aleatórios. Não versione este arquivo.');
}

function completeExisting(fd) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- descritor do próprio .env, aberto acima
  const values = parse(readFileSync(fd, 'utf8'));
  const added = [];
  const additions = [];
  for (const line of exampleLines) {
    const match = VARIABLE.exec(line);
    if (!match || values.has(match[1])) continue;
    const value = resolve(match[2], values);
    values.set(match[1], value);
    additions.push(`${match[1]}=${value}`);
    added.push(match[1]);
  }
  if (added.length === 0) {
    console.log('.env já está completo; nada foi alterado.');
    return;
  }
  // Modo "a+": a escrita vai sempre para o fim do arquivo.
  writeSync(fd, `\n# Acrescentado por pnpm setup:env\n${additions.join('\n')}\n`);
  console.log(`.env existente mantido; variáveis acrescentadas: ${added.join(', ')}`);
}

const fd = openSync(target, 'a+', 0o600);
try {
  if (fstatSync(fd).size === 0) createNew(fd);
  else completeExisting(fd);
  fchmodSync(fd, 0o600);
} finally {
  closeSync(fd);
}
