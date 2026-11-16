import { describe, expect, it } from 'vitest';
import { isFleetPath } from './worker-fleet-client.js';

const ULID = '01JD0Z8XQ6M3V4W5Y7A9BCDEFG';

describe('isFleetPath: só os caminhos da frota no cp-worker', () => {
  it.each([
    'releases',
    'inventory',
    'plan',
    'rollouts',
    `rollouts/${ULID}/pause`,
    `rollouts/${ULID}/resume`,
    `rollouts/${ULID}/abort`,
    `rollouts/${ULID}/nodes/cell-verax/skip`,
    `rollouts/${ULID}/nodes/cell-sp-1/rollback`,
    `rollouts/${ULID}/nodes/tenant-${ULID}/skip`,
  ])('aceita %s', (path) => {
    expect(isFleetPath(path)).toBe(true);
  });

  it.each([
    '',
    'releases/',
    '/releases',
    'rollouts/',
    `rollouts/${ULID}`,
    `rollouts/${ULID}/delete`,
    `rollouts/${ULID.toLowerCase()}/pause`,
    `rollouts/${ULID.slice(0, 25)}/pause`,
    `rollouts/${ULID.slice(0, 25)}I/pause`,
    `rollouts/${ULID}/nodes/cell-ab/skip`,
    `rollouts/${ULID}/nodes/cell-${'a'.repeat(33)}/skip`,
    `rollouts/${ULID}/nodes/cell-Verax/skip`,
    `rollouts/${ULID}/nodes/tenant-abc/skip`,
    `rollouts/${ULID}/nodes/outro-${ULID}/skip`,
    `rollouts/${ULID}/nodes/cell-verax/delete`,
    `rollouts/${ULID}/nodes/cell-verax/skip/extra`,
    `rollouts/${ULID}/../../internal/secret`,
    'releases?x=1',
  ])('recusa %j', (path) => {
    expect(isFleetPath(path)).toBe(false);
  });
});
