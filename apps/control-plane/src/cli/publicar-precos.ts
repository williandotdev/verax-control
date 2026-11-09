/**
 * Publica um modelo de custos e/ou uma tabela de preços no Firestore do plano de controle SEM o console do responsável,
 * pelo mesmo código do console: o `AdminPricingService` (validação zod, rascunho, checagem de publicação com a grade
 * inteira, vigência, versões aposentadas e auditoria `owner:<e-mail>` na mesma transação). Serve para semear a primeira
 * versão e como plano B quando o console não estiver no ar. Nenhum valor comercial está aqui: os números vêm de arquivos
 * JSON FORA do repositório (que é público), no formato que o console exporta: `{ "version", "content" }`.
 *
 * Simulação por padrão: valida os arquivos, roda a checagem de publicação (a mesma do console) e, com `--projeto`, lê o
 * estado do Firestore e mostra o que mudaria (a diferença para a versão vigente e para um rascunho que já exista).
 * Nada é gravado sem `--publicar`, e com ele nada é gravado se a checagem reprovar ou se a versão já estiver publicada
 * com outro conteúdo. O modelo de custos é publicado antes da tabela (a checagem da tabela usa o modelo vigente).
 *
 * Quem publica é o e-mail das credenciais padrão do Google (ADC: `gcloud auth application-default login`, ou a conta de
 * serviço delas): vai em `createdBy`, `updatedBy`, `publishedBy` e no ator `owner:<e-mail>` da auditoria, como no
 * console. A permissão de escrita é a do IAM do projeto no Firestore.
 *
 * Uso (o plano de controle compilado: o Node não executa TypeScript com decorators):
 *
 *   pnpm --filter @verax/control-plane build
 *   node apps/control-plane/dist/cli/publicar-precos.js --custos=<arquivo> --tabela=<arquivo>               # sem banco
 *   node apps/control-plane/dist/cli/publicar-precos.js --custos=<arquivo> --tabela=<arquivo> --projeto=<id> # simulação
 *   node apps/control-plane/dist/cli/publicar-precos.js --custos=<arquivo> --tabela=<arquivo> --projeto=<id> --publicar
 *
 * Opções:
 *   --custos=<arquivo>    o modelo de custos (`costModels/{versão}`)
 *   --tabela=<arquivo>    a tabela de preços (`pricingTables/{versão}`)
 *   --projeto=<id>        o projeto GCP do Firestore (ou FIRESTORE_PROJECT_ID); sem ele, só a validação e a checagem
 *   --banco=<id>          o banco do Firestore (padrão `(default)`)
 *   --vigencia=<ISO 8601> a vigência da tabela, com fuso (padrão: agora)
 *   --publicar            grava (sem ela, simulação)
 *
 * Saída: 0 feito (ou simulado sem problema), 1 recusado (checagem reprovada, versão publicada com outro conteúdo,
 * publicação recusada pela API), 2 uso ou arquivo inválido, 3 erro do Firestore ou das credenciais.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { AdminPricingService } from '../admin/admin-pricing.service.js';
import { AuditService } from '../audit/audit.service.js';
import { type Clock, SystemClock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import { newUlid } from '../common/ulid.js';
import type { DocumentStore } from '../firestore/document-store.js';
import { createFirestore, FirestoreDocumentStore } from '../firestore/firestore-document-store.js';
import {
  contentChanges,
  CostModelStore,
  type OwnerContext,
  PricingTableStore,
  type VersionedStore,
} from '../pricing/pricing-store.js';
import {
  type CostModel,
  costModelSchema,
  DEPLOYMENT_MODES,
  type PriceTable,
  priceTableSchema,
  versionIdSchema,
} from '../pricing/pricing.schema.js';
import { type GuardConfiguration, type GuardReport, runPublishGuard } from '../pricing/publish-guard.js';
import { quote } from '../pricing/quote.js';

export const EXIT = { ok: 0, refused: 1, usage: 2, backend: 3 } as const;

/** A raiz do repositório (público): os arquivos de verdade ficam fora dela. Vale em `src/cli` e em `dist/cli`. */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATABASE_PATTERN = /^(\(default\)|[a-z][a-z0-9-]{2,62})$/;
/** Quantas diferenças a simulação mostra por documento (o resto vira só a contagem). */
const MAX_SHOWN_CHANGES = 60;

/** O arquivo de uma versão: o mesmo formato do "Exportar JSON" do console, com um comentário opcional. */
const versionFileSchema = z.strictObject({
  _comment: z.string().max(2000).optional(),
  version: versionIdSchema,
  content: z.unknown(),
});

export interface OpenedStore {
  store: DocumentStore;
  close: () => Promise<void>;
}

export interface PublishPricingIo {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  /** O banco do projeto. Em uso, o Firestore com as credenciais padrão; nos testes, um dublê ou o emulador. */
  openStore?: (project: string, database: string) => OpenedStore;
  /** Quem publica. Em uso, o e-mail das credenciais padrão (`adcEmail`). */
  identity?: () => Promise<string>;
  clock?: Clock;
}

interface LoadedFile<C> {
  version: string;
  /** O que está no arquivo, como a API recebe (o serviço valida de novo). */
  raw: unknown;
  content: C;
}

type Kind = 'custos' | 'tabela';

/** O que acontece com uma versão: criar, atualizar o rascunho, nada (já publicada igual) ou conflito. */
interface Plan {
  kind: Kind;
  version: string;
  action: 'create' | 'update' | 'publish_draft' | 'already_published' | 'conflict';
}

/** O e-mail das credenciais padrão do Google: o da conta de serviço ou, numa conta de usuário, o do token. */
export async function adcEmail(): Promise<string> {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const credentials = await auth.getCredentials();
  if (credentials.client_email !== undefined && credentials.client_email !== '')
    return credentials.client_email;
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (token === null || token === undefined) throw new Error('as credenciais padrão não deram um token');
  const info = await new OAuth2Client().getTokenInfo(token);
  if (info.email === undefined || info.email === '') {
    throw new Error(
      'o token das credenciais padrão não traz o e-mail (refaça gcloud auth application-default login)',
    );
  }
  return info.email;
}

function openFirestore(project: string, database: string): OpenedStore {
  const db = createFirestore({ FIRESTORE_PROJECT_ID: project, FIRESTORE_DATABASE: database });
  return { store: new FirestoreDocumentStore(db), close: () => db.terminate() };
}

function brl(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percent(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined
    ? '-'
    : `${(ratio * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function describeConfiguration(entry: GuardConfiguration): string {
  const c = entry.configuration;
  return (
    `${c.mode} ${c.size}, ${c.cloudAccounts} contas, ${c.monthlyGib} GiB, ${c.agents} agentes, ${c.historyDays} dias, ` +
    `suporte ${c.support}: ${brl(entry.monthlyTotal)}/mês, margem ${percent(entry.contributionMarginRatio)}`
  );
}

function issuesOf(error: z.ZodError, out: (line: string) => void): void {
  for (const issue of error.issues.slice(0, 30)) {
    out(`  ${issue.path.map(String).join('.') || '(raiz)'}: ${issue.message}`);
  }
  if (error.issues.length > 30) out(`  (mais ${error.issues.length - 30} problemas)`);
}

function loadVersionFile<C>(
  option: string,
  path: string,
  schema: z.ZodType<C>,
  out: (line: string) => void,
): LoadedFile<C> | undefined {
  const absolute = resolve(path);
  const inside = relative(REPOSITORY_ROOT, absolute);
  if (!inside.startsWith('..') && !/^[A-Za-z]:/.test(inside)) {
    out(
      `aviso: ${option} ${inside} está dentro do repositório, que é público. O arquivo com os valores de verdade fica ` +
        'fora dele.',
    );
  }
  let text: string;
  try {
    // O caminho é o que o responsável passou na linha de comando, de propósito.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- arquivo indicado pelo operador
    text = readFileSync(absolute, 'utf8');
  } catch {
    out(`${option}: não consegui ler ${path}.`);
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    out(`${option}: o arquivo não é um JSON válido.`);
    return undefined;
  }
  const file = versionFileSchema.safeParse(json);
  if (!file.success) {
    out(`${option}: esperado { "version", "content" } (o "Exportar JSON" do console):`);
    issuesOf(file.error, out);
    return undefined;
  }
  const content = schema.safeParse(file.data.content);
  if (!content.success) {
    out(`${option} inválido (versão ${file.data.version}):`);
    issuesOf(content.error, out);
    return undefined;
  }
  return { version: file.data.version, raw: file.data.content, content: content.data };
}

function printReport(report: GuardReport, costModelLabel: string, out: (line: string) => void): void {
  out(`Checagem de publicação (modelo de custos ${costModelLabel}, cartão, alíquota ${report.taxRateId}):`);
  out(`  resultado: ${report.ok ? 'APROVADA' : 'REPROVADA'}`);
  for (const problem of report.problems) out(`  problema: ${problem}`);
  out(
    `  ${report.checkedConfigurations} configurações conferidas, ${report.contactUsConfigurations} sob consulta; ` +
      `margem mínima ${percent(report.minimumMargin)}, alerta ${percent(report.alertMargin)}`,
  );
  out(
    `  abaixo da mínima: ${report.belowMinimum.count}; abaixo do alerta: ${report.belowAlert.count}; ` +
      `quebras de monotonia: ${report.monotonicity.violations}`,
  );
  for (const entry of report.belowMinimum.configurations.slice(0, 5)) {
    out(`  abaixo da mínima: ${describeConfiguration(entry)}`);
  }
  for (const mode of DEPLOYMENT_MODES) {
    const worst = report.worstByMode[mode];
    if (worst !== undefined) out(`  pior do modo ${mode}: ${describeConfiguration(worst)}`);
  }
  for (const [size, worst] of Object.entries(report.worstBySize)) {
    out(`  pior do porte ${size}: ${describeConfiguration(worst)}`);
  }
  for (const scenario of report.otherScenarios) {
    if (scenario.worst === null) continue;
    out(
      `  pior com ${scenario.paymentMethod}/${scenario.taxRateId} (só informação): ` +
        describeConfiguration(scenario.worst),
    );
  }
  for (const mode of DEPLOYMENT_MODES) {
    const start = report.startingAt[mode];
    const minimum = report.gridMinimum[mode];
    if (start !== undefined || minimum !== undefined) {
      out(
        `  "a partir de" ${mode}: ${start === undefined ? '-' : brl(start)} ` +
          `(menor preço da grade: ${minimum === undefined ? '-' : brl(minimum)})`,
      );
    }
  }
}

function printPresets(table: PriceTable, out: (line: string) => void): void {
  for (const preset of table.presets) {
    const outcome = quote(preset.configuration, table);
    out(
      outcome.kind === 'quote'
        ? `  pacote ${preset.id} (${preset.label}): porte ${outcome.quote.configuration.size}, ` +
            `${brl(outcome.quote.monthlyTotal)}/mês`
        : `  pacote ${preset.id} (${preset.label}): sob consulta (${outcome.reason})`,
    );
  }
}

function printChanges(title: string, before: unknown, after: unknown, out: (line: string) => void): number {
  const changes = contentChanges(before, after);
  out(`${title}: ${changes.length === 0 ? 'nenhuma diferença' : `${changes.length} diferenças`}`);
  for (const change of changes.slice(0, MAX_SHOWN_CHANGES)) {
    out(
      `  ${change.path}: ${JSON.stringify(change.before) ?? '-'} -> ${JSON.stringify(change.after) ?? '-'}`,
    );
  }
  if (changes.length > MAX_SHOWN_CHANGES) out(`  (mais ${changes.length - MAX_SHOWN_CHANGES})`);
  return changes.length;
}

/** O plano de uma versão contra o que já existe no banco, com a diferença para a vigente e para o rascunho. */
async function planFor<C>(
  kind: Kind,
  file: LoadedFile<C>,
  store: VersionedStore<C>,
  out: (line: string) => void,
): Promise<Plan> {
  const label = kind === 'custos' ? 'Modelo de custos' : 'Tabela de preços';
  const current = await store.current();
  const existing = await store.get(file.version);
  out(`${label} ${file.version}:`);
  out(`  vigente hoje: ${current === undefined ? 'nenhuma' : current.version}`);
  if (current !== undefined && current.version !== file.version) {
    printChanges(`  diferença para a vigente (${current.version})`, current.content, file.content, out);
  }
  if (existing === undefined) {
    out('  a versão não existe: criaria o rascunho e publicaria');
    return { kind, version: file.version, action: 'create' };
  }
  const changed = printChanges(
    `  diferença para a versão gravada (${existing.status})`,
    existing.content,
    file.content,
    out,
  );
  if (existing.status === 'draft') {
    out(changed === 0 ? '  rascunho igual: publicaria' : '  atualizaria o rascunho e publicaria');
    return { kind, version: file.version, action: changed === 0 ? 'publish_draft' : 'update' };
  }
  if (changed === 0) {
    out(`  já está ${existing.status} com este conteúdo: nada a fazer`);
    return { kind, version: file.version, action: 'already_published' };
  }
  out(
    `  CONFLITO: a versão ${file.version} já está ${existing.status} com outro conteúdo. Publicada não muda: use ` +
      'outra versão no arquivo.',
  );
  return { kind, version: file.version, action: 'conflict' };
}

function describeApiError(error: ApiError, out: (line: string) => void): void {
  out(`  recusado pela API: ${error.code ?? error.getStatus()} (${error.message})`);
  const report = error.details?.['report'] as GuardReport | undefined;
  const costModelVersion = error.details?.['costModelVersion'];
  if (report !== undefined) {
    printReport(report, typeof costModelVersion === 'string' ? costModelVersion : '?', out);
  }
  const problems = error.details?.['problems'];
  if (Array.isArray(problems)) out(`  problemas: ${problems.map(String).join(', ')}`);
}

/** Cria ou atualiza o rascunho e publica, pelo serviço do console. */
async function apply<C>(
  plan: Plan,
  file: LoadedFile<C>,
  service: AdminPricingService,
  owner: OwnerContext,
  effectiveFrom: string | undefined,
  out: (line: string) => void,
): Promise<void> {
  const table = plan.kind === 'tabela';
  const label = table ? 'tabela de preços' : 'modelo de custos';
  if (plan.action === 'already_published') {
    out(`${label} ${plan.version}: já publicada, nada gravado`);
    return;
  }
  if (plan.action === 'create') {
    const body = { version: plan.version, content: file.raw };
    if (table) await service.createTable(body, owner);
    else await service.createCostModel(body, owner);
    out(`${label} ${plan.version}: rascunho criado`);
  } else if (plan.action === 'update') {
    const body = { content: file.raw };
    if (table) await service.updateTable(plan.version, body, owner);
    else await service.updateCostModel(plan.version, body, owner);
    out(`${label} ${plan.version}: rascunho atualizado`);
  }
  const result = table
    ? await service.publishTable(plan.version, effectiveFrom === undefined ? {} : { effectiveFrom }, owner)
    : await service.publishCostModel(plan.version, {}, owner);
  out(
    `${label} ${plan.version}: publicada (vigente a partir de ${result.effectiveFrom?.toISOString() ?? '?'}, ` +
      `por ${result.publishedBy ?? '?'})`,
  );
  if (!table && result.report !== null && !result.report.ok) {
    out(
      '  aviso: com este modelo de custos, a tabela de preços vigente NÃO passa na checagem (o alerta ' +
        'pricing_margin_alert não sai daqui, só do console): confira e publique uma tabela ajustada.',
    );
  }
}

function usage(out: (line: string) => void): void {
  out('Uso (depois de pnpm --filter @verax/control-plane build):');
  out(
    '  node apps/control-plane/dist/cli/publicar-precos.js [--custos=<arquivo>] [--tabela=<arquivo>] [--projeto=<id>]',
  );
  out('      [--banco=(default)] [--vigencia=<ISO 8601 com fuso>] [--publicar]');
  out(
    'Os arquivos ficam fora do repositório, no formato { "version", "content" } (o "Exportar JSON" do console).',
  );
  out(
    'Sem --publicar, nada é gravado. Sem --projeto (nem FIRESTORE_PROJECT_ID), só a validação e a checagem.',
  );
}

export async function main(io: PublishPricingIo): Promise<number> {
  const { out } = io;
  z.config(z.locales.ptBR());
  let args;
  try {
    args = parseArgs({
      args: [...io.argv],
      options: {
        custos: { type: 'string' },
        tabela: { type: 'string' },
        projeto: { type: 'string' },
        banco: { type: 'string', default: '(default)' },
        vigencia: { type: 'string' },
        publicar: { type: 'boolean', default: false },
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
  if (args.custos === undefined && args.tabela === undefined) {
    out('Informe --custos=<arquivo> e/ou --tabela=<arquivo>.');
    usage(out);
    return EXIT.usage;
  }
  const project = args.projeto ?? io.env['FIRESTORE_PROJECT_ID'];
  if (project !== undefined && !PROJECT_PATTERN.test(project)) {
    out('--projeto inválido: o id do projeto GCP.');
    return EXIT.usage;
  }
  if (!DATABASE_PATTERN.test(args.banco)) {
    out('--banco inválido: (default) ou o id do banco do Firestore.');
    return EXIT.usage;
  }
  if (args.publicar && project === undefined) {
    out('--publicar exige --projeto=<id> (ou FIRESTORE_PROJECT_ID).');
    return EXIT.usage;
  }
  const clock = io.clock ?? new SystemClock();
  let effectiveFrom: string | undefined;
  if (args.vigencia !== undefined) {
    if (args.tabela === undefined) {
      out('--vigencia só vale com --tabela (o modelo de custos vale na hora).');
      return EXIT.usage;
    }
    if (!z.iso.datetime({ offset: true }).safeParse(args.vigencia).success) {
      out('--vigencia inválida: data e hora ISO 8601 com fuso (ex.: 2026-11-10T09:00:00-03:00).');
      return EXIT.usage;
    }
    if (new Date(args.vigencia).getTime() < clock.now().getTime()) {
      out('--vigencia no passado: a publicação recusaria. Use agora (sem --vigencia) ou uma data futura.');
      return EXIT.usage;
    }
    effectiveFrom = args.vigencia;
  }

  const costFile =
    args.custos === undefined ? undefined : loadVersionFile('--custos', args.custos, costModelSchema, out);
  if (args.custos !== undefined && costFile === undefined) return EXIT.usage;
  const tableFile =
    args.tabela === undefined ? undefined : loadVersionFile('--tabela', args.tabela, priceTableSchema, out);
  if (args.tabela !== undefined && tableFile === undefined) return EXIT.usage;
  out(
    `Arquivos válidos: ${[
      ...(costFile === undefined ? [] : [`modelo de custos ${costFile.version}`]),
      ...(tableFile === undefined ? [] : [`tabela de preços ${tableFile.version}`]),
    ].join(', ')}.`,
  );

  let opened: OpenedStore | undefined;
  try {
    let tables: PricingTableStore | undefined;
    let costs: CostModelStore | undefined;
    let audit: AuditService | undefined;
    if (project !== undefined) {
      opened = (io.openStore ?? openFirestore)(project, args.banco);
      audit = new AuditService(opened.store, clock);
      tables = new PricingTableStore(opened.store, clock, audit);
      costs = new CostModelStore(opened.store, clock, audit);
      out(`Firestore: projeto ${project}, banco ${args.banco}.`);
    } else {
      out('Sem --projeto: só a validação e a checagem, sem ler nem gravar o Firestore.');
    }

    // A checagem roda com o modelo de custos que estará vigente na publicação da tabela: o do arquivo (publicado antes
    // dela) ou, sem ele, o vigente no banco.
    let guardOk = true;
    if (tableFile !== undefined) {
      let model: { label: string; content: CostModel } | undefined;
      if (costFile !== undefined)
        model = { label: `${costFile.version} (arquivo)`, content: costFile.content };
      else if (costs !== undefined) {
        const current = await costs.current();
        if (current !== undefined)
          model = { label: `${current.version} (vigente)`, content: current.content };
      }
      if (model === undefined) {
        out(
          'Sem modelo de custos para a checagem: informe --custos=<arquivo> ou --projeto com um modelo publicado.',
        );
        return EXIT.usage;
      }
      const report = runPublishGuard(tableFile.content, model.content);
      printReport(report, model.label, out);
      out('Pacotes de partida:');
      printPresets(tableFile.content, out);
      guardOk = report.ok;
    }

    const plans: Plan[] = [];
    if (costs !== undefined && costFile !== undefined)
      plans.push(await planFor('custos', costFile, costs, out));
    if (tables !== undefined && tableFile !== undefined) {
      plans.push(await planFor('tabela', tableFile, tables, out));
    }
    const conflict = plans.some((plan) => plan.action === 'conflict');

    if (!args.publicar) {
      out(
        project === undefined
          ? 'Nada foi lido nem gravado.'
          : 'Simulação: nada foi gravado. Para gravar, rode de novo com --publicar.',
      );
      return guardOk && !conflict ? EXIT.ok : EXIT.refused;
    }
    if (!guardOk || conflict) {
      out(
        `Nada foi gravado: ${!guardOk ? 'a checagem de publicação reprovou a tabela' : 'há conflito de versão'}.`,
      );
      return EXIT.refused;
    }
    if (tables === undefined || costs === undefined || audit === undefined) return EXIT.usage;

    let email: string;
    try {
      email = await (io.identity ?? adcEmail)();
    } catch (error) {
      out(
        `Não consegui o e-mail das credenciais padrão (${error instanceof Error ? error.message : 'erro'}): nada foi ` +
          'gravado. Rode gcloud auth application-default login.',
      );
      return EXIT.backend;
    }
    const owner: OwnerContext = { email, requestId: newUlid(clock.now().getTime()) };
    out(`Publicando como owner:${email} (requestId ${owner.requestId ?? ''}).`);
    const logger = new PinoLogger({ pinoHttp: { level: 'silent' } });
    const service = new AdminPricingService(tables, costs, audit, clock, logger);
    try {
      for (const plan of plans) {
        // O modelo de custos vem antes (a lista já está nessa ordem): a checagem da tabela usa o vigente.
        const file = plan.kind === 'custos' ? costFile : tableFile;
        if (file === undefined) continue;
        await apply(plan, file as LoadedFile<unknown>, service, owner, effectiveFrom, out);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        describeApiError(error, out);
        return EXIT.refused;
      }
      throw error;
    }
    out('Feito. Confira GET /v1/public/pricing (até 5 minutos de cache do CDN).');
    return EXIT.ok;
  } catch (error) {
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
}
