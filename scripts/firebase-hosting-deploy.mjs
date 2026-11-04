// Publica uma pasta estática num site do Firebase Hosting pela API REST (sem firebase-tools: nenhuma dependência
// nova na cadeia de publicação). Passos da API: cria uma versão com a configuração (cabeçalhos e rotas), informa o
// hash de cada arquivo comprimido, envia só os que o Firebase ainda não tem, finaliza a versão e a publica.
//
// Uso: node scripts/firebase-hosting-deploy.mjs <site> <pasta> <config.json>
// Credencial: GOOGLE_ACCESS_TOKEN (token OAuth da conta de deploy). GCP_QUOTA_PROJECT é opcional e só serve para
// execução manual com credencial de usuário (a conta de deploy usa o próprio projeto e não precisa dele).
// O token nunca é impresso.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const API = 'https://firebasehosting.googleapis.com/v1beta1';
const MAX_FILES = 1000;

const [site, dir, configFile] = process.argv.slice(2);
const token = process.env.GOOGLE_ACCESS_TOKEN;
const quotaProject = process.env.GCP_QUOTA_PROJECT;
if (!site || !dir || !configFile || !token) {
  console.error(
    'Uso: GOOGLE_ACCESS_TOKEN=... node scripts/firebase-hosting-deploy.mjs <site> <pasta> <config.json>',
  );
  process.exit(2);
}
if (!/^[a-z0-9-]{6,63}$/.test(site)) {
  console.error('Nome de site inválido');
  process.exit(2);
}

function* files(folder) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta do build passada na linha de comando
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta do build passada na linha de comando
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

async function call(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(quotaProject ? { 'x-goog-user-project': quotaProject } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    // Só o status e a mensagem da API; a requisição (com o token) não aparece.
    const detail = await response.text();
    throw new Error(
      `${method} ${new URL(url).pathname} respondeu ${response.status}: ${detail.slice(0, 500)}`,
    );
  }
  return response.json();
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- arquivo de configuração gerado pelo build
const config = JSON.parse(readFileSync(configFile, 'utf8'));
// Configuração-modelo do build único (`VITE_API_URL` com `{tenant}`): publicada assim, a CSP não liberaria a API de
// cliente nenhum. Cada site precisa da sua, gerada antes (`siteHostingConfig` em apps/web/src/hosting.ts).
if (JSON.stringify(config).includes('{tenant}')) {
  console.error('Configuração com o marcador {tenant}: gere a do site antes de publicar');
  process.exit(2);
}

const manifest = {};
const blobs = new Map();
for (const path of files(dir)) {
  // gzip sem data no cabeçalho: o mesmo arquivo gera sempre o mesmo hash, e o Firebase não reenvia o que já tem.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- arquivo da pasta do build
  const compressed = gzipSync(readFileSync(path), { level: 9 });
  const hash = createHash('sha256').update(compressed).digest('hex');
  manifest[`/${relative(dir, path).split(sep).join('/')}`] = hash;
  blobs.set(hash, compressed);
}
const count = Object.keys(manifest).length;
if (count === 0 || count > MAX_FILES)
  throw new Error(`pasta com ${count} arquivos (esperado de 1 a ${MAX_FILES})`);
if (!manifest['/index.html']) throw new Error('a pasta não tem index.html');

const version = await call('POST', `${API}/sites/${site}/versions`, { config });
const populated = await call('POST', `${API}/${version.name}:populateFiles`, { files: manifest });
const required = populated.uploadRequiredHashes ?? [];
for (const hash of required) {
  const response = await fetch(`${populated.uploadUrl}/${hash}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: blobs.get(hash),
  });
  if (!response.ok) throw new Error(`envio de arquivo respondeu ${response.status}`);
}
await call('PATCH', `${API}/${version.name}?update_mask=status`, { status: 'FINALIZED' });
const release = await call(
  'POST',
  `${API}/sites/${site}/releases?versionName=${encodeURIComponent(version.name)}`,
  {},
);
console.log(`Publicado em ${site}: ${count} arquivos (${required.length} enviados), ${release.name}`);
