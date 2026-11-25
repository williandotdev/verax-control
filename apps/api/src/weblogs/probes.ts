import { upToScript } from './path.js';

/**
 * Sondas de caminho sensível (990402 e 990403): conjuntos fixos de segmentos e de terminações, sobre o caminho
 * normalizado (`path.ts`). Sem regex.
 *
 * - **Família secreta** (`secret`): nunca é tráfego legítimo. Conta como sonda com qualquer status, e respondida com
 *   conteúdo vira o 990403.
 * - **Família de plataforma:** é legítima para quem usa a plataforma (o `/wp-admin` de um site WordPress). Só conta como
 *   sonda quando o balanceador respondeu 4xx ou 5xx; um 301 de http para https não diz nada.
 *
 * A **assinatura** é o que distingue uma sonda da outra na guarda do catch-all, e vem só deste dicionário: o texto livre
 * do atacante não cria assinatura nova (nem por `/phpinfo.php/a`, `/phpinfo.php/b`: o caminho é cortado no script).
 */
export const PROBE_FAMILIES = [
  'env',
  'git',
  'cloud_keys',
  'dump',
  'actuator',
  'phpinfo',
  'wordpress',
  'db_admin',
  'web_admin',
  'device',
  'php_rce',
  'remote_access',
  'server_config',
] as const;
export type ProbeFamily = (typeof PROBE_FAMILIES)[number];

const SECRET: ReadonlySet<ProbeFamily> = new Set(['env', 'git', 'cloud_keys', 'dump', 'actuator', 'phpinfo']);

export interface ProbeMatch {
  family: ProbeFamily;
  /** O bit da família, para as contagens. */
  bit: number;
  secret: boolean;
  signature: string;
}

const ENV_VARIANTS: ReadonlySet<string> = new Set([
  'local',
  'dev',
  'development',
  'prod',
  'production',
  'stage',
  'staging',
  'test',
  'example',
  'sample',
  'bak',
  'backup',
  'old',
  'save',
  'swp',
]);

const KEY_DIRS: ReadonlySet<string> = new Set(['.aws', '.ssh', '.kube', '.docker', '.gnupg']);
const KEY_FILES: ReadonlySet<string> = new Set(['id_rsa', 'id_ed25519', '.npmrc', '.netrc', '.pgpass']);

const DUMP_SUFFIXES = [
  '.sql',
  '.sql.gz',
  '.sql.zip',
  '.sql.bz2',
  '.sql.xz',
  '.dump',
  '.mdb',
  '.sqlite',
  '.sqlite3',
];
const ARCHIVE_SUFFIXES = ['.zip', '.tar', '.tar.gz', '.tgz', '.rar', '.7z', '.gz', '.bak'];
const DUMP_NAMES: ReadonlySet<string> = new Set([
  'backup',
  'backups',
  'bkp',
  'db',
  'database',
  'dump',
  'mysql',
  'site',
  'www',
  'wwwroot',
  'web',
  'html',
  'public_html',
  'htdocs',
  'old',
]);

const PLATFORM_SEGMENTS: ReadonlyMap<string, ProbeFamily> = new Map<string, ProbeFamily>([
  ['wp-admin', 'wordpress'],
  ['wp-login.php', 'wordpress'],
  ['wp-content', 'wordpress'],
  ['wp-includes', 'wordpress'],
  ['wp-config.php', 'wordpress'],
  ['wp-json', 'wordpress'],
  ['xmlrpc.php', 'wordpress'],
  ['wlwmanifest.xml', 'wordpress'],
  ['phpmyadmin', 'db_admin'],
  ['pma', 'db_admin'],
  ['myadmin', 'db_admin'],
  ['mysqladmin', 'db_admin'],
  ['adminer.php', 'db_admin'],
  ['dbadmin', 'db_admin'],
  ['manager', 'web_admin'],
  ['jmx-console', 'web_admin'],
  ['web-console', 'web_admin'],
  ['jenkins', 'web_admin'],
  ['solr', 'web_admin'],
  ['server-status', 'web_admin'],
  ['wls-wsat', 'web_admin'],
  ['cgi-bin', 'device'],
  ['boaform', 'device'],
  ['hnap1', 'device'],
  ['goform', 'device'],
  ['setup.cgi', 'device'],
  ['gponform', 'device'],
  ['phpunit', 'php_rce'],
  ['eval-stdin.php', 'php_rce'],
  ['_ignition', 'php_rce'],
  ['shell.php', 'php_rce'],
  ['telescope', 'php_rce'],
  ['owa', 'remote_access'],
  ['autodiscover', 'remote_access'],
  ['dana-na', 'remote_access'],
  ['global-protect', 'remote_access'],
  ['sslvpn', 'remote_access'],
  ['remote', 'remote_access'],
  ['.htaccess', 'server_config'],
  ['.htpasswd', 'server_config'],
  ['.ds_store', 'server_config'],
  ['web.config', 'server_config'],
  ['.gitlab-ci.yml', 'server_config'],
  ['docker-compose.yml', 'server_config'],
  ['.vscode', 'server_config'],
  ['.idea', 'server_config'],
]);

/** Segmentos genéricos demais para contar sozinhos: só com o segmento seguinte. */
const NEEDS_NEXT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['manager', new Set(['html', 'text', 'status'])],
  ['remote', new Set(['login', 'fgt_lang', 'logincheck'])],
  ['owa', new Set(['auth', 'auth.owa'])],
]);

function match(family: ProbeFamily, token: string): ProbeMatch {
  return {
    family,
    bit: 1 << PROBE_FAMILIES.indexOf(family),
    secret: SECRET.has(family),
    signature: `${family}:${token}`,
  };
}

function envProbe(segment: string): ProbeMatch | null {
  if (segment === '.env') return match('env', '.env');
  if (segment.startsWith('.env') && segment.length > 4) {
    const separator = segment.charAt(4);
    if (separator === '.' || separator === '-' || separator === '_' || separator === '~') {
      const variant = segment.slice(5);
      return match('env', ENV_VARIANTS.has(variant) ? variant : '*');
    }
    return null;
  }
  return segment.endsWith('.env') ? match('env', 'named') : null;
}

function dumpProbe(segment: string): ProbeMatch | null {
  for (const suffix of DUMP_SUFFIXES) {
    if (!segment.endsWith(suffix) || segment.length === suffix.length) continue;
    const name = segment.slice(0, -suffix.length);
    return match('dump', `${DUMP_NAMES.has(name) ? name : '*'}${suffix}`);
  }
  for (const suffix of ARCHIVE_SUFFIXES) {
    if (!segment.endsWith(suffix)) continue;
    const name = segment.slice(0, -suffix.length);
    if (DUMP_NAMES.has(name)) return match('dump', `${name}${suffix}`);
  }
  return null;
}

function secretProbe(segments: readonly string[]): ProbeMatch | null {
  const last = segments.at(-1) ?? '';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    const next = segments[i + 1];
    if (segment === '.git' || segment === '.svn' || segment === '.hg') {
      return match('git', next === 'config' || next === 'head' || next === 'index' ? next : segment);
    }
    if (KEY_DIRS.has(segment)) return match('cloud_keys', segment);
    if (segment === 'actuator') {
      // O `/actuator` e o `/actuator/health` são rotina de monitoramento; os dois abaixo entregam segredo.
      if (next === 'env' || next === 'heapdump') return match('actuator', next);
    }
    const env = envProbe(segment);
    if (env !== null) return env;
  }
  if (last === 'heapdump') return match('actuator', 'heapdump');
  if (KEY_FILES.has(last)) return match('cloud_keys', last);
  if (last === 'phpinfo.php' || last === 'phpinfo' || last === 'info.php' || last === 'php_info.php') {
    return match('phpinfo', 'phpinfo');
  }
  return dumpProbe(last);
}

/** A sonda que o caminho é, ou null. */
export function matchProbe(all: readonly string[]): ProbeMatch | null {
  if (all.length === 0) return null;
  const segments = upToScript(all);
  const found = secretProbe(segments);
  if (found !== null) return found;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    const family = PLATFORM_SEGMENTS.get(segment);
    if (family === undefined) continue;
    const required = NEEDS_NEXT.get(segment);
    if (required !== undefined && !required.has(segments[i + 1] ?? '')) continue;
    return match(family, segment);
  }
  return null;
}

/** As famílias de uma máscara de bits. */
export function familiesOf(mask: number): ProbeFamily[] {
  return PROBE_FAMILIES.filter((_, index) => (mask & (1 << index)) !== 0);
}

export function countBits(mask: number): number {
  let count = 0;
  for (let bits = mask; bits !== 0; bits &= bits - 1) count += 1;
  return count;
}
