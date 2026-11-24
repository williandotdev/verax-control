# País por endereço IP: fonte e licença

- **Fonte:** base `user-country` (IPv4 e IPv6) do projeto [sapics/ip-location-db](https://github.com/sapics/ip-location-db).
- **Licença:** domínio público, pela PDDL (Open Data Commons Public Domain Dedication and License). Não exige atribuição;
  a origem fica registrada aqui por clareza.
- **Arquivos:** `ip-country.bin.gz` (a tabela, formato em `../ip-country-format.ts`) e `ip-country-meta.ts` (data, SHA-256
  dos CSV de origem e do arquivo, contagens). Os dois são gerados juntos e não se editam à mão.

Atualizar (a cada versão do nó, ou antes de 180 dias, quando a tabela passa a se dizer velha):

1. Baixe `user-country-ipv4.csv` e `user-country-ipv6.csv` de
   `https://github.com/sapics/ip-location-db/releases/download/latest/<arquivo>` e os `.sha256` de
   `https://github.com/sapics/ip-location-db/releases/download/checksum/<arquivo>.sha256`, e confira.
2. Na raiz do repositório: `node scripts/update-ip-country.mjs <ipv4.csv> <ipv6.csv> apps/api/src/geo/data`. O script não
   acessa a rede e recusa qualquer linha fora das regras. Código novo fora da ISO 3166-1 exige decisão em
   `../country-codes.ts`.
3. Rode os testes de `apps/api/src/geo` e revise o diff do `ip-country-meta.ts` (as contagens mudam pouco de uma versão
   para a outra; salto grande é sinal de fonte errada).

Cada atualização soma cerca de 0,6 MB ao histórico do git.
