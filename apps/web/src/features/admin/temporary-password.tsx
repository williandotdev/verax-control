import { TEMPORARY_PASSWORD_HOURS, type TemporaryPassword } from '@verax/shared';
import { Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

const deadlineFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Senha temporária recém-gerada (conta nova ou senha nova), mostrada uma única vez: a API não a devolve de novo, e o
 * painel a esquece ao fechar. Junto, o que fazer com ela: copiar agora, mandar por canal seguro e o prazo.
 */
export function TemporaryPasswordNotice({
  title,
  summary,
  password,
  hasMfa,
  onDone,
}: {
  /** Título da seção, que recebe o foco (o formulário ou a confirmação que tinha o foco saiu da tela). */
  title: string;
  /** O que acabou de acontecer: conta criada, ou senha anterior revogada. */
  summary: string;
  password: TemporaryPassword;
  /** A pessoa já cadastrou o MFA (senha nova para quem esqueceu): ele continua valendo. */
  hasMfa: boolean;
  onDone: () => void;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => heading.current?.focus(), []);

  const copyPassword = () => {
    // Sem a área de transferência (página fora de HTTPS, permissão negada), a pessoa seleciona e copia à mão.
    const writing = navigator.clipboard?.writeText(password.temporaryPassword);
    if (writing === undefined) {
      setCopy('failed');
      return;
    }
    void writing.then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  };

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <p role="status" className="rounded-md border border-ok/50 bg-ok/10 p-3 text-sm">
        {summary}
      </p>
      <div className="space-y-2">
        <h3 id={headingId} ref={heading} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
          {title}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded-md border bg-surface-raised px-3 py-2 font-mono text-base tracking-wide">
            {password.temporaryPassword}
          </code>
          <Button type="button" variant="secondary" size="sm" onClick={copyPassword}>
            <Copy aria-hidden />
            {copy === 'copied' ? 'Copiada' : 'Copiar'}
          </Button>
        </div>
        <p aria-live="polite" className={copy === 'failed' ? 'text-xs text-critical' : 'sr-only'}>
          {copy === 'copied' && 'Senha copiada.'}
          {copy === 'failed' && 'Não foi possível copiar. Selecione a senha e copie à mão.'}
        </p>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>
          <strong>Ela só aparece agora.</strong> Copie antes de concluir; se perder, gere outra.
        </li>
        <li>
          Mande à pessoa por um canal seguro, de preferência fora do e-mail: pessoalmente, por telefone ou por
          mensageiro com criptografia de ponta a ponta.
        </li>
        <li>
          Vale até {deadlineFormat.format(new Date(password.expiresAt))} ({TEMPORARY_PASSWORD_HOURS} horas).
          Depois disso, gere outra.
        </li>
        <li>
          {hasMfa
            ? 'No próximo login, a pessoa troca esta senha por uma só dela. O MFA já cadastrado continua valendo.'
            : 'No primeiro login, a pessoa troca esta senha por uma só dela e cadastra o MFA.'}
        </li>
      </ul>
      <Button type="button" onClick={onDone}>
        Concluir
      </Button>
    </section>
  );
}
