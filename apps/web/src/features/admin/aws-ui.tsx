import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * As peças visuais da seção da AWS. O ícone do tom, o selo, o aviso e a etiqueta são as peças únicas do painel
 * (`components/ui/status.tsx`, E-12), reexportadas aqui para as telas da AWS.
 */
export { Notice, Tag, ToneBadge, ToneIcon } from '@/components/ui/status';

/** Uma seção da tela da conta, com o título ligado a ela (região nomeada para o leitor de tela). */
export function Section({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-titulo`}
      className={cn('space-y-3 rounded-md border p-3', className)}
    >
      <h3 id={`${id}-titulo`} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Uma tabela dentro do quadro que rola de lado quando ela não cabe (no celular, ou com um texto mais largo). Toda
 * tabela desta seção passa por aqui, para nenhuma ficar sem o que o quadro precisa: ele é uma região com o nome da
 * tabela e recebe o foco do teclado, com o contorno de foco à vista. Sem mouse, é o foco no quadro que deixa rolar
 * até as colunas da direita (uma tabela só de texto não tem outro ponto de foco). O mesmo padrão das outras tabelas do
 * painel (`report-table.tsx`, `chart-table.tsx`).
 */
export function ScrollTable({
  caption,
  className,
  tableClassName,
  children,
}: {
  /** O nome da tabela, um para cada tabela da tela: a legenda dela e, com "Tabela: " na frente, o nome do quadro. */
  caption: string;
  className?: string;
  tableClassName?: string;
  /** O cabeçalho e o corpo da tabela (`thead` e `tbody`). */
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={`Tabela: ${caption}`}
      tabIndex={0}
      className={cn(
        'overflow-x-auto rounded-md border focus-visible:outline-2 focus-visible:outline-ring',
        className,
      )}
    >
      <table className={cn('w-full', tableClassName)}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

/** Link para fora do painel, em outra aba, sem dar à página aberta acesso a esta. */
export function OutLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-1 underline', className)}
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  );
}

/** Um termo do console da AWS em inglês, entre parênteses depois do nome em português. */
export function ConsoleTerm({ pt, en }: { pt: string; en: string }) {
  return (
    <>
      <strong className="font-semibold">{pt}</strong> (<span lang="en">{en}</span>)
    </>
  );
}
