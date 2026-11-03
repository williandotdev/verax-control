import type { AuditActor } from '@verax/shared';

/** Quem agiu: pessoa (com a marca da equipe da Verax), sistema ou alguém que não chegou a se identificar. */
export function AuditActorName({ actor }: { actor: AuditActor }) {
  if (actor.type === 'system') return <span>Sistema</span>;
  if (actor.type === 'anonymous') return <span className="text-muted-foreground">Sem identificação</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>{actor.name ?? 'Usuário de outro cliente'}</span>
      {actor.verax && (
        <span className="rounded-full border px-1.5 py-0.5 text-[0.7rem] font-medium leading-none">
          Verax
        </span>
      )}
    </span>
  );
}
