#!/bin/bash
# Confere a assinatura do manifesto de uma versão do nó (manifest.json, publicado no release `node-v<versão>` do GitHub
# pelo workflow `Versão do nó`). Quem assina é a chave de release no Cloud KMS (ECDSA P-256 com SHA-256; a assinatura
# é a DER que o KMS devolve), e só depois de o workflow conferir as atestações de origem das imagens. Aqui basta o
# openssl: nem o gh, nem a API do GitHub, nem a GCP, nem rede.
#   verify-release.sh <manifest.json> <manifest.json.sig> [pasta das chaves]
#
# As chaves confiáveis são as públicas fixadas no pacote JÁ INSTALADO (`keys/release-*.pem`, ao lado desta pasta
# `bin/`), nunca as do pacote que o manifesto descreve: quem trocasse o pacote trocaria a chave junto. Vale a assinatura
# que fechar com uma delas (na troca de chave, o pacote leva a antiga e a nova por uma versão); uma chave revogada sai
# do pacote numa versão nova. Toda chave da pasta precisa ser uma pública EC P-256; outra coisa para tudo.
#
# Saída: 0, com "OK <chave>" na saída padrão, só com a assinatura válida para os bytes exatos do arquivo. 1: assinatura
# que não fecha (manifesto adulterado ou cortado, assinatura de outra chave, cortada ou vazia). 2: uso ou chaves.
# Quem chama lê o manifesto (digests, SHA-256 do pacote) só depois desta conferência e da mesma cópia conferida, numa
# pasta só dele: um arquivo trocado entre a conferência e a leitura passaria sem assinatura.
set -euo pipefail
export LC_ALL=C

usage() {
  echo 'Uso: verify-release.sh <manifest.json> <manifest.json.sig> [pasta das chaves]' >&2
  exit 2
}
reject() {
  echo "Manifesto recusado: $*" >&2
  exit 1
}

(($# == 2 || $# == 3)) || usage
manifest=$1
signature=$2
keys=${3:-$(cd "$(dirname "$0")/.." && pwd)/keys}

# O manifesto tem poucos KB; a assinatura DER de P-256 tem de 8 a 72 bytes. Fora disso nem chega ao openssl.
max_manifest_bytes=65536
max_signature_bytes=72
[[ -f $manifest && -r $manifest ]] || { echo "Manifesto não encontrado: $manifest" >&2; exit 2; }
[[ -f $signature && -r $signature ]] || { echo "Assinatura não encontrada: $signature" >&2; exit 2; }
manifest_bytes=$(wc -c <"$manifest")
signature_bytes=$(wc -c <"$signature")
((manifest_bytes > 0)) || reject 'manifesto vazio.'
((manifest_bytes <= max_manifest_bytes)) || reject "manifesto com mais de $max_manifest_bytes bytes."
((signature_bytes >= 8 && signature_bytes <= max_signature_bytes)) ||
  reject "assinatura com $signature_bytes bytes (uma ECDSA P-256 em DER tem até $max_signature_bytes)."

[[ -d $keys ]] || { echo "Pasta das chaves não encontrada: $keys" >&2; exit 2; }
shopt -s nullglob
candidates=("$keys"/release-*.pem)
shopt -u nullglob
((${#candidates[@]} > 0)) || { echo "Nenhuma chave de release (release-*.pem) em $keys." >&2; exit 2; }
for key in "${candidates[@]}"; do
  grep -q 'ASN1 OID: prime256v1' <<<"$(openssl pkey -pubin -in "$key" -noout -text 2>/dev/null || true)" ||
    { echo "Chave de release que não é uma pública EC P-256: $key" >&2; exit 2; }
done

for key in "${candidates[@]}"; do
  if openssl dgst -sha256 -verify "$key" -signature "$signature" "$manifest" >/dev/null 2>&1; then
    key_name=${key##*/}
    echo "OK ${key_name%.pem}"
    exit 0
  fi
done
reject 'a assinatura não fecha com nenhuma chave de release do pacote instalado.'
