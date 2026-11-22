import { TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';

/** O que copiar: cada linha do acesso e a mensagem pronta. */
export type CopyTarget = 'panel' | 'login' | 'password' | 'expiry' | 'message';

const COPIED: Readonly<Record<CopyTarget, string>> = {
  panel: 'Endereço do painel copiado.',
  login: 'Login copiado.',
  password: 'Senha copiada.',
  expiry: 'Validade copiada.',
  message: 'Mensagem copiada.',
};

export interface AccessRow {
  target: Exclude<CopyTarget, 'message'>;
  label: string;
  value: string;
  mono: boolean;
}

/**
 * Um acesso mostrado uma única vez para o responsável copiar e mandar ao cliente (a senha inicial do administrador, o
 * usuário que a Verax criou): cada linha com o botão de copiar, a mensagem pronta e o fechar. Os valores ficam só no
 * estado de quem chama, nunca na URL, no armazenamento do navegador, no cache ou no log; ao fechar, somem.
 */
export function OneTimeAccess({
  label,
  rows,
  message,
  footer,
  onClose,
}: {
  /** O nome da região (o leitor de tela anuncia). */
  label: string;
  rows: readonly AccessRow[];
  /** A mensagem pronta para o cliente. */
  message: string;
  /** O que acontece depois (o primeiro acesso, a sincronização). */
  footer: ReactNode;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<CopyTarget | 'failed' | undefined>();
  // O `navigator.clipboard` só existe em contexto seguro (https); sem ele, os botões nem aparecem.
  const clipboard =
    typeof navigator === 'undefined' ? undefined : (navigator.clipboard as Clipboard | undefined);

  async function copy(target: CopyTarget, text: string) {
    try {
      await clipboard?.writeText(text);
      setCopied(target);
    } catch {
      setCopied('failed');
    }
  }

  return (
    <section aria-label={label} className="space-y-3 rounded-lg border border-high/60 bg-high/10 p-3">
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
          <Button size="sm" onClick={() => void copy('message', message)}>
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
      <div className="space-y-1 text-xs text-muted-foreground">{footer}</div>
    </section>
  );
}
