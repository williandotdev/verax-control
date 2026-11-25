import {
  type CloudAccount,
  type CloudflareConnection,
  CLOUDFLARE_OAUTH_RECONNECT_ERROR,
} from '@verax/shared';
import { LoadingState } from '@/components/states';
import { FormError } from '@/features/admin/admin-ui';
import { formatDate, formatRelative, plural } from '@/lib/format';
import { useCloudflareConnection } from './cloudflare-oauth-api';
import { ConnectCloudflareButton } from './connect-button';
import { GRANT_STATUS_TEXTS } from './labels';

/**
 * A leitura da conta do Cloudflare no nó em que ela é conectada por OAuth: a autorização em uso, ou o botão para conectar,
 * reconectar ou migrar a conta que ainda usa o token colado. A migração não para a coleta: o token continua lendo até a
 * autorização nova ser conferida na mesma conta, e só então sai do cofre. Desconectar é desativar o monitoramento ou
 * excluir a conta (os botões ficam no fim do detalhe).
 */
export function CloudflareOauthSteps({
  account,
  canConnect,
}: {
  account: CloudAccount;
  canConnect: boolean;
}) {
  const connection = useCloudflareConnection(account.id, true);
  const inactive = account.status !== 'active';
  return (
    <section aria-labelledby="conector-passos" className="space-y-3 rounded-md border p-3">
      <h3 id="conector-passos" className="text-sm font-semibold">
        Leitura da conta {account.accountId}
      </h3>
      <p className="text-sm text-muted-foreground">
        O Verax lê a auditoria e os eventos de segurança com uma autorização só de leitura, dada por você na
        tela do próprio Cloudflare, sem criar nem colar token. O acesso fica cifrado no cofre do nó e nunca
        aparece nesta tela.
      </p>
      {connection.isPending ? (
        <LoadingState rows={1} label="Carregando a conexão" />
      ) : connection.data === undefined ? (
        <FormError error={connection.error} />
      ) : connection.data.method === 'oauth' && connection.data.grant ? (
        <GrantDetails account={account} grant={connection.data.grant} canConnect={canConnect && !inactive} />
      ) : connection.data.method === 'token' ? (
        <Migration account={account} canConnect={canConnect} inactive={inactive} />
      ) : (
        <div className="space-y-2 text-sm">
          <p>Esta conta ainda não está conectada.</p>
          {!canConnect ? (
            <p className="text-muted-foreground">
              Quem administra as contas conecta pelo botão Conectar com Cloudflare.
            </p>
          ) : inactive ? (
            <p className="text-muted-foreground">Reative o monitoramento para conectar a conta.</p>
          ) : (
            <ConnectCloudflareButton cloudAccountId={account.id}>
              Conectar com Cloudflare
            </ConnectCloudflareButton>
          )}
        </div>
      )}
    </section>
  );
}

function GrantDetails({
  account,
  grant,
  canConnect,
}: {
  account: CloudAccount;
  grant: NonNullable<CloudflareConnection['grant']>;
  canConnect: boolean;
}) {
  const reconnect =
    grant.status === 'reconnect' || account.connectionError === CLOUDFLARE_OAUTH_RECONNECT_ERROR;
  const others = grant.accounts - 1;
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Autorização</dt>
        <dd>{GRANT_STATUS_TEXTS[reconnect ? 'reconnect' : grant.status]}</dd>
        <dt className="text-muted-foreground">Autorizada em</dt>
        <dd>{formatDate(grant.consentedAt)}</dd>
        <dt className="text-muted-foreground">Última renovação</dt>
        <dd>{grant.lastRefreshAt ? formatRelative(grant.lastRefreshAt) : 'ainda não renovada'}</dd>
        <dt className="text-muted-foreground">Permissões</dt>
        <dd className="break-all font-mono text-xs">{grant.scopes.join(' ')}</dd>
      </dl>
      {others > 0 && (
        <p className="text-muted-foreground">
          A mesma autorização lê {plural(others, 'outra conta cadastrada', 'outras contas cadastradas')}.
        </p>
      )}
      {reconnect && (
        <div className="space-y-2">
          <p>
            A autorização foi revogada ou venceu no Cloudflare, e a coleta desta conta está parada. Conecte de
            novo para voltar a ler; a auditoria recupera até 30 dias do que ficou para trás.
          </p>
          {canConnect && (
            <ConnectCloudflareButton cloudAccountId={account.id}>Conectar de novo</ConnectCloudflareButton>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Para desconectar, desative o monitoramento ou exclua a conta abaixo. Quando nenhuma conta usa mais a
        autorização, o Verax a revoga no Cloudflare; você também pode revogá-la na lista de aplicativos
        conectados do seu perfil no Cloudflare.
      </p>
    </div>
  );
}

function Migration({
  account,
  canConnect,
  inactive,
}: {
  account: CloudAccount;
  canConnect: boolean;
  inactive: boolean;
}) {
  const token = account.keyStatus;
  return (
    <div className="space-y-2 text-sm">
      <p>
        Esta conta é lida com um token colado
        {token ? (
          <>
            {' '}
            (ID terminado em <span className="font-mono">…{token.keyIdSuffix}</span>
            {token.expiresAt ? `, vence em ${formatDate(token.expiresAt)}` : ''})
          </>
        ) : null}
        . Neste ambiente, a conexão é feita pela autorização no Cloudflare, sem token.
      </p>
      <p className="text-muted-foreground">
        Ao migrar, a coleta continua com o token até a autorização nova ser conferida nesta mesma conta; só
        então o token sai do cofre do Verax. Nada já coletado se perde. Depois, apague o token antigo no
        Cloudflare: o Verax não mexe em nada lá.
      </p>
      {!canConnect ? (
        <p className="text-muted-foreground">Quem administra as contas faz a migração.</p>
      ) : inactive ? (
        <p className="text-muted-foreground">Reative o monitoramento para migrar a conta.</p>
      ) : (
        <ConnectCloudflareButton cloudAccountId={account.id}>
          Migrar para Conectar com Cloudflare
        </ConnectCloudflareButton>
      )}
    </div>
  );
}
