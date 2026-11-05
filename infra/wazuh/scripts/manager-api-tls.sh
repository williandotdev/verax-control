#!/usr/bin/env bash
# Certificado da API do manager (fase 2, PR-V6). Roda dentro do manager, como root, a cada partida do contêiner: o init
# da imagem executa os `.sh` de /entrypoint-scripts depois de preparar os volumes e antes do `wazuh-control start`, então
# a API sobe já com ele. Montado só leitura pelos dois Compose (o do nó e o do EC2).
#
# Sem isto, a API do manager gera um certificado autoassinado na primeira partida (CN localhost, sem a CA de ninguém), e
# quem a chama de outro contêiner não tem como conferir o TLS. Aqui ela passa a usar o par do manager que o
# init-certs.sh já emite com a CA própria do Wazuh (serverAuth, nome wazuh.manager; o mesmo que o filebeat usa), e quem
# a chama confere com a CA do volume público (o worker, na tarefa wazuh-usage; o host, pelo nome wazuh.manager no
# loopback). Nenhum par novo: a chave da CA é descartada na primeira emissão, e um par novo exigiria trocar a CA dos nós
# já instalados.
#
# O par é conferido antes de entrar (emitido pela CA, para servidor, com o nome wazuh.manager, e a chave é a do
# certificado); com qualquer falha, nada muda e o erro vai para o log do contêiner. A troca é atômica (rename), com o
# dono e o modo que a API usa (wazuh, 0400). Os nomes são os padrões da API (ssl/server.crt e ssl/server.key): o
# api.yaml só aceita um nome de arquivo dentro de ssl/, nunca um caminho.
set -euo pipefail
umask 077

src=/etc/ssl/verax
dst=/var/ossec/api/configuration/ssl
name=wazuh.manager
ca=$src/root-ca.pem cert=$src/$name.pem key=$src/$name-key.pem

fail() {
  echo "verax-api-tls: $1; a API do manager fica com o certificado que já tinha." >&2
  exit 1
}

for file in "$ca" "$cert" "$key"; do
  [[ -s $file ]] || fail "falta $file (o init-certs.sh emite os certificados antes do manager)"
done
openssl verify -CAfile "$ca" -purpose sslserver "$cert" >/dev/null 2>&1 ||
  fail "o certificado do manager não confere com a CA do nó para uso de servidor"
[[ $(openssl x509 -in "$cert" -noout -checkhost "$name" 2>/dev/null) == *'does match'* ]] ||
  fail "o certificado do manager não vale para o nome $name"
[[ $(openssl x509 -in "$cert" -noout -pubkey 2>/dev/null) == "$(openssl pkey -in "$key" -pubout 2>/dev/null)" ]] ||
  fail "a chave não é a do certificado do manager"

install -d -m 0770 -o root -g wazuh "$dst"
# install_file <origem> <nome no destino>: ao lado, com o dono e o modo da API, e no lugar de uma vez.
install_file() {
  install -m 0400 -o wazuh -g wazuh "$1" "$dst/.$2.verax"
  mv -fT "$dst/.$2.verax" "$dst/$2"
}
install_file "$cert" server.crt
install_file "$key" server.key
echo "verax-api-tls: a API do manager usa o certificado de $name emitido pela CA do nó."
