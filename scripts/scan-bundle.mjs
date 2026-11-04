// Varre o bundle final do painel atrás de padrões de segredo (regra 2: nada de segredo no front).
// Uso: node scripts/scan-bundle.mjs <pasta-do-build>. Falha (código 1) ao achar qualquer padrão; imprime só
// o arquivo e o tipo, nunca o trecho encontrado.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PATTERNS = [
  ['ID de chave de acesso AWS', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['chave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['URL com senha', /\b[a-z][\w+.-]*:\/\/[^\s:/?#@"'`]+:[^\s@/?#"'`]+@[\w.-]+/i],
  ['token do GitHub', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['token Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  [
    'nome de variável secreta',
    /\b(?:BETTER_AUTH_SECRET|CSRF_SECRET|DATABASE_URL|POSTGRES_PASSWORD|SEED_ADMIN_PASSWORD|AWS_SECRET_ACCESS_KEY)\b/,
  ],
];

function* files(dir) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta do build passada na linha de comando
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta do build passada na linha de comando
    if (statSync(path).isDirectory()) yield* files(path);
    // O template da AWS (`.yaml`) também é servido pelo painel: entra na varredura como o resto do texto.
    else if (/\.(js|mjs|css|html|json|map|txt|yaml|yml)$/.test(name)) yield path;
  }
}

const root = process.argv[2];
if (!root) {
  console.error('Uso: node scripts/scan-bundle.mjs <pasta-do-build>');
  process.exit(2);
}

const findings = [];
for (const file of files(root)) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- arquivo listado dentro da pasta do build
  const content = readFileSync(file, 'utf8');
  for (const [label, pattern] of PATTERNS) {
    if (pattern.test(content)) findings.push(`${relative(root, file)}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error(`Possível segredo no bundle do painel:\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log('Bundle do painel sem padrões de segredo.');
