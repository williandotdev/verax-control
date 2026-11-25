import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useStartCloudflareOauth } from './cloudflare-oauth-api';
import { oauthErrorText } from './labels';

/**
 * "Conectar com Cloudflare": começa a tentativa na API do nó e leva o navegador à autorização do Cloudflare. Com
 * `cloudAccountId`, reconecta ou migra a conta já cadastrada (a que usa o token colado). A resposta da API (a URL) não
 * fica guardada em lugar nenhum.
 */
export function ConnectCloudflareButton({
  cloudAccountId,
  children,
  variant = 'primary',
  disabled = false,
}: {
  cloudAccountId?: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}) {
  const start = useStartCloudflareOauth();
  // Depois do sucesso, o navegador já está saindo para o Cloudflare: o botão não começa outra tentativa.
  const leaving = start.isPending || start.isSuccess;
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant={variant}
        disabled={disabled || leaving}
        onClick={() => start.mutate(cloudAccountId)}
      >
        {children}
      </Button>
      {leaving && (
        <p role="status" className="text-xs text-muted-foreground">
          Abrindo a autorização no Cloudflare…
        </p>
      )}
      {start.error && (
        <p role="alert" className="text-sm text-critical-text">
          {oauthErrorText(start.error)}
        </p>
      )}
    </div>
  );
}
