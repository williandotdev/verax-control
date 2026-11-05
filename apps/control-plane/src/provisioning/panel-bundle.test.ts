import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { hostingTemplate, panelBundle, sha256, ustar } from '../../test/support/release-fixtures.js';
import { openPanelBundle, PanelBundleError, readTar, siteHostingConfig } from './panel-bundle.js';

const API = 'https://api-cliente-demo-a.veraxsistemas.com.br';

describe('bundle do painel', () => {
  it('abre o tar: os arquivos de dist/ viram os caminhos do site, e a configuração-modelo fica à parte', () => {
    const archive = panelBundle();
    const bundle = openPanelBundle(archive, sha256(archive));
    expect([...bundle.files.keys()].sort()).toEqual(['/assets/app-abc123.js', '/index.html']);
    expect(bundle.files.get('/index.html')?.toString()).toContain('Verax Control');
    expect(bundle.template).toContain('{tenant}');
  });

  it('SHA-256 diferente do manifesto: recusado antes de abrir', () => {
    const archive = panelBundle();
    expect(() => openPanelBundle(archive, '0'.repeat(64))).toThrow(
      expect.objectContaining({ code: 'panel_bundle_sha256_mismatch' }) as Error,
    );
  });

  it.each([
    ['caminho com ..', [{ path: './dist/../../etc/passwd', content: 'x' }]],
    ['caminho absoluto', [{ path: '/etc/passwd', content: 'x' }]],
    ['link simbólico', [{ path: './dist/link', type: '2' as const, linkTarget: '/etc/passwd' }]],
    [
      'cabeçalho pax de um arquivo (troca de nome)',
      [{ path: './PaxHeaders/x', type: 'x' as const, content: '30 path=../../etc/passwd\n' }],
    ],
    ['arquivo fora de dist/', [{ path: './outro.txt', content: 'x' }]],
    ['arquivo repetido', [{ path: './dist/index.html', content: 'outra' }]],
    ['barra invertida', [{ path: './dist/a\\b.js', content: 'x' }]],
  ])('recusa: %s', (_name, extra) => {
    const archive = panelBundle(extra);
    expect(() => openPanelBundle(archive, sha256(archive))).toThrow(PanelBundleError);
  });

  it('sem index.html ou sem a configuração-modelo: recusado', () => {
    for (const entries of [
      [{ path: './dist-hosting.json', content: hostingTemplate() }],
      [{ path: './dist/index.html', content: 'x' }],
    ]) {
      const archive = gzipSync(ustar(entries));
      expect(() => openPanelBundle(archive, sha256(archive))).toThrow(PanelBundleError);
    }
  });

  it('cabeçalho com a soma errada ou tar cortado: recusado', () => {
    const tar = ustar([{ path: './dist/index.html', content: 'x'.repeat(600) }]);
    const corrupted = Buffer.from(tar);
    corrupted[0] = 0x41;
    expect(() => readTar(corrupted)).toThrow(PanelBundleError);
    expect(() => readTar(tar.subarray(0, 700))).toThrow(PanelBundleError);
  });

  it('o cabeçalho global do pax (o do git archive) é ignorado', () => {
    const files = readTar(
      ustar([
        { path: 'pax_global_header', type: 'g', content: '52 comment=abc\n' },
        { path: 'dist/a.js', content: 'a' },
      ]),
    );
    expect([...files.keys()]).toEqual(['dist/a.js']);
  });
});

describe('configuração do site do cliente', () => {
  it('troca o marcador pelo subdomínio: a CSP libera só a API do cliente', () => {
    const config = siteHostingConfig(hostingTemplate(), 'cliente-demo-a', API);
    const csp = config.headers[0]?.headers['Content-Security-Policy'];
    expect(csp).toBe(`default-src 'self'; connect-src 'self' ${API}`);
    expect(JSON.stringify(config)).not.toContain('{tenant}');
    expect(config.rewrites).toEqual([{ glob: '**', path: '/index.html' }]);
  });

  it('recusa a configuração sem o marcador (a mesma API para todos os sites) e a que não cita a API do cliente', () => {
    expect(() =>
      siteHostingConfig(hostingTemplate().replaceAll('{tenant}', 'outro'), 'cliente-demo-a', API),
    ).toThrow(PanelBundleError);
    expect(() => siteHostingConfig(hostingTemplate('outra-zona.example'), 'cliente-demo-a', API)).toThrow(
      PanelBundleError,
    );
    expect(() => siteHostingConfig('{"headers": "{tenant}"}', 'cliente-demo-a', API)).toThrow(
      PanelBundleError,
    );
  });
});
