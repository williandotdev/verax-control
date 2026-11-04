#!/bin/bash
# Certificado do registro dos agentes do Wazuh (WAZUH_AGENTS=true no node.conf): uma CA só dos agentes e o certificado
# do authd do manager (porta 1515), com o IP fixo dos agentes no CN e no SAN, como a documentação do Wazuh 4.14 pede
# para o agente conferir o manager antes de mandar a senha (agent-enrollment/security-options/
# manager-identity-verification.html). O agente recebe só a CA, no comando de instalação (WAZUH_REGISTRATION_CA).
#   wazuh-agents-certs.sh <pasta> <IP dos agentes>
# Roda como root na VM, chamado pelo install.sh; o teste do pacote (infra/wazuh/scripts/test-agents.sh) o roda num
# contêiner. Pode rodar de novo: com um certificado válido para o mesmo IP, nada muda. Com outro IP (o endereço foi
# trocado no Terraform) ou a menos de 30 dias do vencimento, CA e certificado nascem de novo: os agentes já registrados
# não usam mais o certificado (o registro é uma vez só), e os comandos de instalação do painel passam a levar a CA nova
# na próxima partida do nó. Como no init-certs.sh do Wazuh, a chave da CA não fica em lugar nenhum.
set -euo pipefail
umask 077

dir=${1:?informe a pasta}
address=${2:?informe o IP dos agentes}
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
if [[ ! $address =~ ^$octet(\.$octet){3}$ ]]; then
  echo 'IP dos agentes inválido: use um IPv4, sem máscara.' >&2
  exit 2
fi

current() {
  [[ -s $dir/ca.crt && -s $dir/manager.crt && -s $dir/manager.key ]] || return 1
  openssl verify -CAfile "$dir/ca.crt" "$dir/manager.crt" >/dev/null 2>&1 || return 1
  openssl x509 -in "$dir/manager.crt" -noout -checkend 2592000 >/dev/null || return 1
  local checked
  checked=$(openssl x509 -in "$dir/manager.crt" -noout -checkip "$address") || return 1
  [[ $checked == *'does match certificate'* && $checked != *'does NOT match'* ]]
}

install -d -m 0755 -o 0 -g 0 "$dir"
if current; then
  echo "Certificado do registro dos agentes já emitido para $address."
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dn='/C=BR/O=Verax/OU=Wazuh agentes'
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$work/ca.key" 2>/dev/null
openssl req -x509 -new -key "$work/ca.key" -sha256 -days 3650 -subj "$dn/CN=Verax Control - CA dos agentes" \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -out "$work/ca.crt"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$work/manager.key" 2>/dev/null
openssl req -new -key "$work/manager.key" -subj "$dn/CN=$address" -out "$work/manager.csr"
{
  echo 'basicConstraints=critical,CA:FALSE'
  echo 'keyUsage=critical,digitalSignature,keyEncipherment'
  echo 'extendedKeyUsage=serverAuth'
  echo "subjectAltName=IP:$address"
} >"$work/manager.ext"
openssl x509 -req -in "$work/manager.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -sha256 \
  -days 1825 -extfile "$work/manager.ext" -out "$work/manager.crt" 2>/dev/null
openssl verify -CAfile "$work/ca.crt" "$work/manager.crt" >/dev/null

# A chave do manager é lida pelo authd, que roda como root no contêiner; os certificados não são segredo (a CA vai para
# o painel). Os três entram juntos, por último a chave.
install -m 0644 -o 0 -g 0 "$work/ca.crt" "$dir/ca.crt.new"
install -m 0644 -o 0 -g 0 "$work/manager.crt" "$dir/manager.crt.new"
install -m 0600 -o 0 -g 0 "$work/manager.key" "$dir/manager.key.new"
mv -f "$dir/ca.crt.new" "$dir/ca.crt"
mv -f "$dir/manager.crt.new" "$dir/manager.crt"
mv -f "$dir/manager.key.new" "$dir/manager.key"
echo "Certificado do registro dos agentes emitido para $address (CA nova; a chave da CA foi descartada)."
