// Casos de teste das regras em rules.yaml (semgrep --test). Não é código da aplicação.
declare const db: any;
declare const app: any;
declare const logger: any;
declare const req: any;
declare const sql: any;

// ruleid: verax-prisma-raw-unsafe
db.$queryRawUnsafe('SELECT * FROM users WHERE id = ' + req.params.id);
// ruleid: verax-prisma-raw-unsafe
db.$executeRawUnsafe('DELETE FROM x');
// ok: verax-prisma-raw-unsafe
db.$queryRaw(sql`SELECT 1`);

// ruleid: verax-tls-reject-unauthorized-false
const tls = { ca: 'x', rejectUnauthorized: false };
// ok: verax-tls-reject-unauthorized-false
const tlsOk = { ca: 'x', rejectUnauthorized: true };

// ruleid: verax-node-tls-env
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ruleid: verax-cors-wildcard
app.enableCors({ origin: '*' });
// ruleid: verax-cors-wildcard
app.enableCors();
// ok: verax-cors-wildcard
app.enableCors({ origin: ['https://painel.example.com'], credentials: true });

// ruleid: verax-opensearch-query-string
const q1 = { query: { query_string: { query: req.query.q } } };
// ruleid: verax-opensearch-query-string
const q2 = { query: { simple_query_string: { query: req.query.q } } };
// ok: verax-opensearch-query-string
const q3 = { query: { bool: { filter: [{ term: { 'agent.id': '001' } }] } } };

// ruleid: verax-log-sensitive-header
logger.info('request', req.headers.authorization);
// ruleid: verax-log-sensitive-header
logger.error({ msg: 'x' }, req.headers);
// ok: verax-log-sensitive-header
logger.info('request', req.method, req.url);

export { tls, tlsOk, q1, q2, q3 };
