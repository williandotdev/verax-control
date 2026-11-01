// Prova que as regras de segurança do ESLint disparam para cada padrão proibido.
// Se alguém afrouxar o eslint.config.js, este script falha no CI.
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

const probes = [
  {
    name: '$queryRawUnsafe',
    filePath: 'apps/api/src/probe.ts',
    code: 'declare const db: any;\nvoid db.$queryRawUnsafe("SELECT 1");\n',
    rule: 'no-restricted-properties',
  },
  {
    name: '$executeRawUnsafe',
    filePath: 'apps/api/src/probe.ts',
    code: 'declare const db: any;\nvoid db.$executeRawUnsafe("DELETE FROM x");\n',
    rule: 'no-restricted-properties',
  },
  {
    name: 'eval',
    filePath: 'apps/api/src/probe.ts',
    code: 'eval("1 + 1");\n',
    rule: 'no-eval',
  },
  {
    name: 'new Function',
    filePath: 'apps/api/src/probe.ts',
    code: 'export const f = new Function("return 1");\n',
    rule: 'no-new-func',
  },
  {
    name: 'rejectUnauthorized: false',
    filePath: 'apps/api/src/probe.ts',
    code: 'export const tls = { rejectUnauthorized: false };\n',
    rule: 'no-restricted-syntax',
  },
  {
    name: "'rejectUnauthorized': false",
    filePath: 'apps/api/src/probe.ts',
    code: "export const tls = { 'rejectUnauthorized': false };\n",
    rule: 'no-restricted-syntax',
  },
  {
    name: 'process.env de TLS = 0',
    filePath: 'apps/api/src/probe.ts',
    code: "process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';\n",
    rule: 'no-restricted-syntax',
  },
  {
    name: 'CORS *',
    filePath: 'apps/api/src/probe.ts',
    code: "export const cors = { origin: '*' };\n",
    rule: 'no-restricted-syntax',
  },
  {
    name: 'OpenSearch query_string',
    filePath: 'apps/api/src/probe.ts',
    code: "export const q = { query: { query_string: { query: 'x' } } };\n",
    rule: 'no-restricted-syntax',
  },
  {
    name: 'dangerouslySetInnerHTML',
    filePath: 'apps/web/src/probe.tsx',
    code: 'export const C = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n',
    rule: 'no-restricted-syntax',
  },
];

// As sondas são arquivos virtuais, fora de qualquer tsconfig: as regras com informação de tipo
// ficam desligadas aqui, e as regras de segurança acima não dependem de tipo.
const eslint = new ESLint({ overrideConfig: [tseslint.configs.disableTypeChecked] });

let failures = 0;
for (const probe of probes) {
  const [result] = await eslint.lintText(probe.code, { filePath: probe.filePath });
  const hit = result?.messages.some((m) => m.ruleId === probe.rule && m.severity === 2);
  if (hit) {
    console.log(`ok   ${probe.name} → ${probe.rule}`);
  } else {
    failures += 1;
    const seen =
      result?.messages.map((m) => `${m.ruleId ?? 'parser'}: ${m.message}`).join('; ') || 'nenhuma mensagem';
    console.error(`FAIL ${probe.name}: esperado ${probe.rule}; recebido: ${seen}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} regra(s) de segurança do lint não dispararam.`);
  process.exit(1);
}
console.log(`\nTodas as ${probes.length} regras de segurança do lint disparam como esperado.`);
