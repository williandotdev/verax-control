#!/usr/bin/env bash
# Emite os certificados TLS do Wazuh com uma CA própria, uma única vez (T4.2). Roda no serviço `certs-init`
# da compose, como root, sem rede.
#
# Substitui o wazuh-certs-generator oficial, que baixa um script de packages.wazuh.com (e, se falhar, de
# packages-dev) e o executa sem conferir checksum.
#
# Cada componente recebe só o próprio par de chaves, em um volume separado. A chave privada da CA é apagada
# no fim: emitir de novo significa trocar a CA inteira (procedimento no README).
set -euo pipefail
umask 077

out=/out
if [[ -s $out/public/root-ca.pem ]]; then
  echo "Certificados já emitidos; nada a fazer."
  exit 0
fi

extra_sans=${INDEXER_EXTRA_SANS:-}
if [[ ! $extra_sans =~ ^[A-Za-z0-9:.,-]*$ ]]; then
  echo "ERRO: INDEXER_EXTRA_SANS aceita só entradas como DNS:nome,IP:10.0.0.1" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

readonly ca_days=3650 leaf_days=1825
dn() { printf '/C=BR/O=Verax/OU=Wazuh/CN=%s' "$1"; }

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out ca.key 2>/dev/null
openssl req -x509 -new -key ca.key -sha256 -days "$ca_days" -subj "$(dn 'Verax Control Wazuh CA')" \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -out root-ca.pem

# issue <nome> <usos estendidos> [SANs]
issue() {
  local name=$1 eku=$2 sans=${3:-}
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$name-key.pem" 2>/dev/null
  openssl req -new -key "$name-key.pem" -subj "$(dn "$name")" -out "$name.csr"
  {
    echo 'basicConstraints=critical,CA:FALSE'
    echo 'keyUsage=critical,digitalSignature,keyEncipherment'
    echo "extendedKeyUsage=$eku"
    if [[ -n $sans ]]; then echo "subjectAltName=$sans"; fi
  } >"$name.ext"
  openssl x509 -req -in "$name.csr" -CA root-ca.pem -CAkey ca.key -CAcreateserial -sha256 \
    -days "$leaf_days" -extfile "$name.ext" -out "$name.pem" 2>/dev/null
  openssl verify -CAfile root-ca.pem "$name.pem" >/dev/null
}

indexer_sans='DNS:wazuh.indexer,DNS:localhost,IP:127.0.0.1'
if [[ -n $extra_sans ]]; then indexer_sans="$indexer_sans,$extra_sans"; fi

issue wazuh.indexer serverAuth,clientAuth "$indexer_sans"
issue admin clientAuth
issue wazuh.manager serverAuth,clientAuth 'DNS:wazuh.manager'

# place <volume> <uid> <arquivos...>
place() {
  local dir=$out/$1 uid=$2
  shift 2
  install -d -m 0500 -o "$uid" -g "$uid" "$dir"
  for file in "$@"; do
    install -m 0400 -o "$uid" -g "$uid" "$file" "$dir/$file"
  done
}

# O indexer roda como uid 1000; os módulos do manager que falam com o indexer, como `wazuh` (999). Sem dashboard
# (fase 2, PR-W1), nenhum par é emitido para ele.
place indexer 1000 root-ca.pem wazuh.indexer.pem wazuh.indexer-key.pem admin.pem admin-key.pem
place manager 999 root-ca.pem wazuh.manager.pem wazuh.manager-key.pem
# Só o certificado público da CA, para quem precisa validar o indexer (a API e o worker).
install -d -m 0755 "$out/public"
install -m 0444 root-ca.pem "$out/public/root-ca.pem"

openssl x509 -in root-ca.pem -noout -enddate | sed 's/^notAfter=/CA válida até: /'
echo "Certificados emitidos; a chave da CA foi descartada."
