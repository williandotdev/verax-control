import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, tenantsApi } from '@/lib/api';
import type { AccessRevealed, TenantDetail } from '@/lib/api-types';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { ConfirmBySlug } from './confirm-by-slug';
import { WORKER_FAILURE_MESSAGES } from './labels';
import { useInvalidateTenants } from './queries';

/** O runbook da renovação da senha do administrador (`BOOTSTRAP_RENEW_ADMIN_PASSWORD`). */
const RENEWAL_RUNBOOK = 'docs/runbooks/onboarding-cliente.md, §7';

/**
 * O que cada recusa da revelação quer dizer para o responsável. Nas recusas, nada foi mostrado; só `already_revealed`
 * diz que a revelação única já aconteceu (por qualquer porta).
 */
const REVEAL_ERRORS: Readonly<Record<string, string>> = {
  already_revealed:
    'A senha inicial já foi revelada (pelo cliente, na página de status ou pelo link do e-mail, ou por um responsável aqui) e não aparece de novo. Se o cliente não a tem, ele usa o "Esqueci minha senha" do painel, ou a conta de suporte gera uma senha temporária em Usuários.',
  reveal_not_available:
    'O cliente não está esperando o primeiro acesso: não há senha inicial a mostrar. Nada foi marcado.',
  password_expired: `A senha temporária já venceu e nada foi mostrado. Gere uma senha nova pela renovação do runbook de onboarding (${RENEWAL_RUNBOOK}) e tente de novo.`,
  confirmation_mismatch: 'O subdomínio não confere com o do cliente: nada foi mostrado nem marcado.',
  rate_limited:
    'Muitas operações em pouco tempo. Aguarde alguns minutos e tente de novo: nada foi mostrado nem marcado.',
  reveal_unavailable:
    'A senha não pôde ser lida do cofre agora. Nada foi mostrado nem marcado: tente de novo em instantes.',
};

/** A mensagem de um erro da revelação: a do código, a do cp-worker fora do alcance, ou a genérica. */
function revealErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code !== undefined) {
    if (Object.hasOwn(REVEAL_ERRORS, error.code)) return REVEAL_ERRORS[error.code] ?? errorMessage(error);
    if (Object.hasOwn(WORKER_FAILURE_MESSAGES, error.code)) {
      return WORKER_FAILURE_MESSAGES[error.code] ?? errorMessage(error);
    }
  }
  return errorMessage(error);
}

/** A mensagem pronta para o cliente, com o acesso e o que acontece no primeiro login. */
function customerMessage(access: AccessRevealed): string {
  return [
    'Olá! O ambiente de vocês no Verax Control está pronto.',
    '',
    `Painel: ${access.panelUrl}`,
    `Login: ${access.adminEmail}`,
    `Senha temporária: ${access.password}`,
    `Válida até: ${formatDateTime(access.passwordExpiresAt)} (horário de Brasília)`,
    '',
    'No primeiro acesso, o painel pede para trocar a senha e configurar a verificação em duas etapas (MFA), com um aplicativo autenticador.',
  ].join('\n');
}

type CopyTarget = 'panel' | 'login' | 'password' | 'expiry' | 'message';

const COPIED: Readonly<Record<CopyTarget, string>> = {
  panel: 'Endereço do painel copiado.',
  login: 'Login copiado.',
  password: 'Senha copiada.',
  expiry: 'Validade copiada.',
  message: 'Mensagem copiada.',
};

/** O acesso revelado: só no estado desta tela, nunca na URL, no armazenamento do navegador, no cache ou no log. */
function RevealedAccess({ access, onClose }: { access: AccessRevealed; onClose: () => void }) {
  const [copied, setCopied] = useState<CopyTarget | 'failed' | undefined>();
  // O `navigator.clipboard` só existe em contexto seguro (https); sem ele, os botões nem aparecem.
  const clipboard =
    typeof navigator === 'undefined' ? undefined : (navigator.clipboard as Clipboard | undefined);
  const expiry = formatDateTime(access.passwordExpiresAt);

  async function copy(target: CopyTarget, text: string) {
    try {
      await clipboard?.writeText(text);
      setCopied(target);
    } catch {
      setCopied('failed');
    }
  }

  const rows: readonly { target: CopyTarget; label: string; value: string; mono: boolean }[] = [
    { target: 'panel', label: 'Painel', value: access.panelUrl, mono: true },
    { target: 'login', label: 'Login', value: access.adminEmail, mono: true },
    { target: 'password', label: 'Senha temporária', value: access.password, mono: true },
    { target: 'expiry', label: 'Válida até', value: expiry, mono: false },
  ];

  return (
    <section
      aria-label="Acesso para enviar ao cliente"
      className="space-y-3 rounded-lg border border-high/60 bg-high/10 p-3"
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-high" />
        Ela aparece só agora: copie e envie ao cliente por um canal seguro. Ao fechar, ela não volta.
      </p>
      <dl className="space-y-2">
        {rows.map((row) => (
          <div key={row.target} className="flex flex-wrap items-center gap-2">
            <dt className="w-36 shrink-0 text-xs text-muted-foreground">{row.label}</dt>
            {/* O botão fica dentro do `dd`: numa lista de definição, o grupo só pode ter `dt` e `dd` (axe). */}
            <dd className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={row.mono ? 'min-w-0 font-mono text-sm break-all' : 'min-w-0 text-sm'}>
                {row.value}
              </span>
              {clipboard !== undefined && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Copiar: ${row.label}`}
                  onClick={() => void copy(row.target, row.value)}
                >
                  Copiar
                </Button>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        {clipboard !== undefined && (
          <Button size="sm" onClick={() => void copy('message', customerMessage(access))}>
            Copiar mensagem para o cliente
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onClose}>
          Fechar
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {copied === 'failed' && 'Não deu para copiar: selecione e copie à mão.'}
          {copied !== undefined && copied !== 'failed' && COPIED[copied]}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        No primeiro acesso, o painel pede para o cliente trocar a senha e configurar a verificação em duas
        etapas (MFA).
      </p>
    </section>
  );
}

/**
 * A senha inicial do administrador do cliente, mostrada uma única vez para o responsável copiar e mandar. É a revelação
 * única (a mesma da página de status e do link do e-mail): depois dela, a versão do cofre é apagada e o link que o
 * cliente recebeu deixa de funcionar. O botão aparece só com o cliente esperando o primeiro acesso e sem revelação (a
 * API e o cp-worker conferem de novo, na transação que marca). A senha fica só no estado deste componente: a chamada
 * não passa pelo cache das consultas (nem pelo das mutações), e some ao fechar ou ao sair da página.
 */
export function RevealInitialAccess({ tenant }: { tenant: TenantDetail }) {
  const invalidate = useInvalidateTenants();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<AccessRevealed | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const allowed =
    tenant.state === 'waiting_customer_connection' && tenant.access.passwordRevealedAt === undefined;

  async function reveal(confirmSlug: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setRevealed(await tenantsApi.revealAccess(tenant.id, confirmSlug));
      setConfirming(false);
    } catch (caught) {
      setError(revealErrorMessage(caught));
    } finally {
      setBusy(false);
    }
    // Com ou sem sucesso, o detalhe é lido de novo: a data da revelação aparece (ou a de quem revelou antes).
    await invalidate(tenant.id);
  }

  if (revealed !== undefined) {
    return <RevealedAccess access={revealed} onClose={() => setRevealed(undefined)} />;
  }
  if (!allowed && !confirming && error === undefined) return null;

  return (
    <div className="space-y-2">
      {!confirming && allowed && (
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Mostrar senha inicial…
        </Button>
      )}
      {confirming && (
        <ConfirmBySlug
          slug={tenant.slug}
          actionLabel="Confirmar: mostrar a senha"
          busyLabel="Buscando…"
          busy={busy}
          onConfirm={(typed) => void reveal(typed)}
          onCancel={() => {
            setConfirming(false);
            setError(undefined);
          }}
        >
          <p>
            <strong>
              A senha aparece uma única vez. Depois ela é apagada do cofre e o link que o cliente recebeu por
              e-mail deixa de funcionar.
            </strong>
          </p>
          <p>Copie o painel, o login e a senha temporária e mande ao cliente por um canal seguro.</p>
        </ConfirmBySlug>
      )}
      {error !== undefined && (
        <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
