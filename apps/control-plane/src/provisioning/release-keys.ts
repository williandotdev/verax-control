/**
 * As chaves públicas de release (ECDSA P-256) com que o plano de controle confere o manifesto da versão antes de usar
 * o SHA-256 do pacote do nó e o do bundle do painel: as mesmas de `infra/node/keys/release-*.pem`, que o nó usa na
 * instalação (PR-N7). Copiadas aqui (e não lidas do disco) porque a imagem do plano de controle não leva `infra/`; o
 * teste `release-manifest.test.ts` confere byte a byte que são as do repositório, então uma chave nova (ou revogada) lá
 * derruba o teste até ser copiada aqui. Chaves públicas: nada de segredo.
 */
export const RELEASE_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  'release-node-manifest-v1': `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkfkGsybeRVw4Ti0Q2xjoXmDUeXfE
rSwvZRrcL//2oqVMkvxVsCSoo1utVjbxKgfugpPShIUvDndgNBSDgpGF4Q==
-----END PUBLIC KEY-----
`,
};
