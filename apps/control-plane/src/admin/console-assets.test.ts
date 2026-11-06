import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConsoleRoot } from './console-assets.js';

describe('resolveConsoleRoot: onde estão os arquivos do console', () => {
  const dirs: string[] = [];

  function dir(withIndex: boolean): URL {
    const path = mkdtempSync(join(tmpdir(), 'verax-console-root-'));
    dirs.push(path);
    mkdirSync(path, { recursive: true });
    if (withIndex) writeFileSync(join(path, 'index.html'), '<!doctype html>');
    return pathToFileURL(`${path}/`);
  }

  afterEach(() => {
    for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('a primeira pasta com index.html (a da imagem antes da do monorepo)', () => {
    const image = dir(true);
    const monorepo = dir(true);
    expect(resolveConsoleRoot([image, monorepo])).toBe(fileURLToPath(image));
  });

  it('pula a pasta sem index.html; nenhuma, undefined (o console fica desligado e a API segue)', () => {
    const empty = dir(false);
    const monorepo = dir(true);
    expect(resolveConsoleRoot([empty, monorepo])).toBe(fileURLToPath(monorepo));
    expect(resolveConsoleRoot([dir(false)])).toBeUndefined();
  });
});
