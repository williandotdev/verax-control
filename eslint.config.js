// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Padrões proibidos pelas regras de segurança do projeto (CLAUDE.md, regras 1, 5 e 6).
 * Ficam aqui, e não só no Semgrep, para o erro aparecer no editor e no pre-commit.
 */
const forbiddenSyntax = [
  {
    selector: "Property[key.name='rejectUnauthorized'][value.value=false]",
    message: 'Proibido desligar a validação de TLS (regra de segurança 5).',
  },
  {
    selector: "Property[key.value='rejectUnauthorized'][value.value=false]",
    message: 'Proibido desligar a validação de TLS (regra de segurança 5).',
  },
  {
    selector:
      "Literal[value='NODE_TLS_REJECT_UNAUTHORIZED'], Identifier[name='NODE_TLS_REJECT_UNAUTHORIZED']",
    message: 'Proibido mexer em NODE_TLS_REJECT_UNAUTHORIZED (regra de segurança 5).',
  },
  {
    selector: "Property[key.name='origin'][value.value='*']",
    message: 'Proibido CORS com * (regra de segurança 5).',
  },
  {
    selector:
      'Property[key.name=/^(query_string|simple_query_string)$/], Property[key.value=/^(query_string|simple_query_string)$/]',
    message:
      'Consultas ao OpenSearch devem usar query DSL estruturado, nunca query_string (regra de segurança 1).',
  },
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'Proibido injetar HTML bruto no front.',
  },
];

const forbiddenProperties = [
  { property: '$queryRawUnsafe', message: 'Use $queryRaw como tagged template (regra de segurança 1).' },
  { property: '$executeRawUnsafe', message: 'Use $executeRaw como tagged template (regra de segurança 1).' },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/generated/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'docs/**',
      'infra/**/.terraform/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': ['error', ...forbiddenSyntax],
      'no-restricted-properties': ['error', ...forbiddenProperties],
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Gera muito falso positivo com acesso tipado por chave; o TypeScript strict já cobre o caso.
      'security/detect-object-injection': 'off',
    },
  },
  {
    // API: Node, NestJS. Imports de tipo usados em injeção de dependência precisam existir em runtime,
    // então consistent-type-imports fica desligado (o emitDecoratorMetadata depende do import real).
    files: ['apps/api/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.flat['recommended-latest'].rules,
      ...reactRefresh.configs.vite.rules,
    },
  },
  {
    // Arquivos de configuração e scripts ficam fora dos tsconfig dos pacotes: lint sem informação de tipo.
    files: ['**/*.config.{ts,js,mjs}', 'eslint.config.js', 'scripts/**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.node },
    },
  },
);
