import { render, screen } from '@testing-library/react';
import { CONTROL_PLANE_AUDIT_ACTOR_NAME } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { AuditActorName } from './audit-actor';

describe('quem agiu na trilha', () => {
  it('o sistema sem nome é "Sistema"; o que o nó aplicou do console da Verax, "Verax (administrativo)"', () => {
    const { rerender } = render(
      <AuditActorName actor={{ type: 'system', id: null, name: null, verax: false }} />,
    );
    expect(screen.getByText('Sistema')).toBeInTheDocument();
    rerender(
      <AuditActorName
        actor={{ type: 'system', id: null, name: CONTROL_PLANE_AUDIT_ACTOR_NAME, verax: false }}
      />,
    );
    expect(screen.getByText('Verax (administrativo)')).toBeInTheDocument();
    expect(screen.queryByText('Sistema')).not.toBeInTheDocument();
  });
});
