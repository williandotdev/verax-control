import { type ReactNode, useId } from 'react';

export function CatalogSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <div>
        <h2 id={headingId} className="text-xl font-semibold">
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
