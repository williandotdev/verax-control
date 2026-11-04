# Chaves públicas de release do nó

As chaves desta pasta conferem a assinatura do manifesto de cada versão do nó (`manifest.json` do release
`node-v<versão>` no GitHub). O conferente é `bin/verify-release.sh`, que usa só o `openssl`, sem o `gh` e sem rede.
Elas vão dentro do pacote do nó (`verax-node/keys/`).

- **Formato:** `release-<chave>-v<versão>.pem`, uma pública EC P-256 (PEM) por versão da chave de release no Cloud KMS.
  Exemplo: `release-node-manifest-v1.pem`. O verificador recusa uma pasta com qualquer outra coisa chamada
  `release-*.pem`.
- **Origem:** a saída `release_public_key_pem` do Terraform de `infra/gcp/envs/release`. O arquivo entra por PR depois
  do primeiro `apply` (roteiro em `docs/runbooks/versao-no.md`). Nenhuma chave privada passa pelo repositório: a privada
  nunca sai do Cloud KMS.
- **Confiança:** o nó confere uma versão nova com as chaves do pacote **já instalado**, nunca com as do pacote novo.
  Quem trocasse o pacote trocaria a chave junto.
- **Troca de chave:** a versão nova da chave entra aqui e a antiga fica por pelo menos uma versão publicada, para todo nó
  ter recebido a nova antes de a antiga sair.
- **Revogação:** apague o arquivo e publique uma versão nova. Os nós que a instalarem deixam de aceitar manifestos
  assinados com a chave apagada.
