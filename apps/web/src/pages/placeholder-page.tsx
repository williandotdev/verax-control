import { EmptyState } from '@/components/states';

/** Página ainda não construída: a estrutura e a permissão já valem; o conteúdo entra no E7. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <EmptyState title="Em construção" description="Esta tela entra no épico 7, com os dados da API." />
    </section>
  );
}
