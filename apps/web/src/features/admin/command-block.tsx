import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** Comando pronto, com o botão de copiar: quebra a linha na tela, mas a cópia é o texto exato. */
export function CommandBlock({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard?.writeText(command).then(() => setCopied(true));
  return (
    <div className="space-y-1">
      <pre className="whitespace-pre-wrap break-all rounded bg-foreground/5 p-2 font-mono text-xs">
        <code>{command}</code>
      </pre>
      <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={label}>
        <Copy aria-hidden />
        {copied ? 'Copiado' : 'Copiar'}
      </Button>
    </div>
  );
}

/** Um valor da pilha, com o nome do parâmetro no template e o botão de copiar; sem valor, o que fazer. */
export function StackValue({
  label,
  parameter,
  value,
  missing,
  hint,
}: {
  label: string;
  parameter: string;
  value: string | null;
  missing: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (value !== null) void navigator.clipboard?.writeText(value).then(() => setCopied(true));
  };
  return (
    <>
      <dt className="text-muted-foreground">
        {label} <code className="font-mono text-xs">({parameter})</code>
      </dt>
      <dd className="space-y-1">
        {value === null ? (
          <p className="text-critical-text">{missing}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-foreground/5 px-2 py-1 font-mono text-xs">{value}</code>
            <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={`Copiar: ${label}`}>
              <Copy aria-hidden />
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        )}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </dd>
    </>
  );
}

/** Uma política de IAM pronta para copiar, com o nome do arquivo que o comando da CLI espera. */
export function PolicyBlock({ file, policy }: { file: string; policy: object }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        <code className="font-mono">{file}</code>
      </p>
      <CommandBlock command={JSON.stringify(policy, null, 2)} label={`Copiar a política ${file}`} />
    </div>
  );
}
