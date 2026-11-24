import type { IpCountryMeta } from '../ip-country.js';

/** GERADO por `scripts/update-ip-country.mjs` junto com `ip-country.bin.gz`; não editar à mão. Fonte e licença: README.md. */
export const IP_COUNTRY_META: IpCountryMeta = {
  formatVersion: 1,
  generatedAt: '2026-11-24T21:35:31.010Z',
  sources: [
    {
      name: 'user-country-ipv4.csv',
      sha256: '22ce5e5d01333d3ec90cc66bf0beab328790eb87f0ee2843c7a06745225503a9',
      ranges: 303658,
    },
    {
      name: 'user-country-ipv6.csv',
      sha256: 'b345f0240dd3465f8120f4b0d77f8a4599279718f24eb38edaa3e864ba28921e',
      ranges: 295458,
    },
  ],
  counts: { codes: 250, v4Boundaries: 311419, v6Boundaries: 354427 },
  sha256: 'ebfda73855880458925bef41188904d4fb5f677114eacad571cab2232099b657',
  contentSha256: 'fdfead95fb6136051d5cec8ece4d6dc983c51d13e0c5179f9672f432c519e05f',
};
