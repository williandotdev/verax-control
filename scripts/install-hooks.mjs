// Instala os hooks do lefthook em máquinas de desenvolvimento.
// Pula no CI e em builds sem repositório git (ex.: build da imagem Docker).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

if (process.env.CI || !existsSync('.git')) {
  process.exit(0);
}

const require = createRequire(import.meta.url);
const lefthookBin = require.resolve('lefthook/bin/index.js');
execFileSync(process.execPath, [lefthookBin, 'install'], { stdio: 'inherit' });
