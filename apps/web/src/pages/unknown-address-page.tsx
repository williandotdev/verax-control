import { AuthShell } from '@/features/auth/auth-shell';
import { PANEL_DOMAIN } from '@/lib/tenant-address';

/**
 * Build único aberto fora do endereço de um cliente (`tenant-address.ts`): sem API derivada, o painel não chama nada e
 * só explica onde funciona. Fica fora do roteador e da sessão, montado direto pelo `main.tsx`.
 */
export function UnknownAddressPage() {
  return (
    <AuthShell
      title="Endereço não reconhecido"
      description={`Este painel só abre no endereço do seu ambiente, no formato sua-empresa.${PANEL_DOMAIN}.`}
    >
      <p className="text-sm">Confira o link que você recebeu ou fale com o suporte da Verax.</p>
    </AuthShell>
  );
}
