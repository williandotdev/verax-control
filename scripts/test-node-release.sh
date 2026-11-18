#!/bin/bash
# Testes de scripts/node-release.sh (pacote, manifesto e assinatura da versão do nó) e, de ponta a ponta, do
# verificador do host (infra/node/bin/verify-release.sh). Sem rede e sem nuvem: um repositório git descartável recebe
# uma cópia de infra/node e de infra/wazuh, com uma chave de release de teste (ECDSA P-256, gerada aqui e apagada no
# fim; nenhuma chave privada fica no repositório). O Cloud KMS é um curl simulado que assina o digest recebido com
# essa chave, como o asymmetricSign, e anota os argumentos de cada chamada.
#
# Cenários: o pacote é o mesmo byte a byte em duas máquinas (outra máscara de permissões e outra hora), vem do commit
# e não da pasta, tem o que o deploy.sh copia (menos os testes), com dono root e a data do commit; o manifesto traz as
# imagens do Verax no GHCR e as de terceiros exatamente como os compose do pacote fixam, e para com uma imagem de
# terceiro sem digest ou uma imagem por variável desconhecida; a assinatura só é gravada quando a resposta vem da
# versão pedida da chave e fecha com as chaves do pacote, e o token nunca aparece nos argumentos do curl.
#
#   bash scripts/test-node-release.sh
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
script=$root/scripts/node-release.sh
scenario=ambiente

fail() {
  echo "FALHOU ($scenario): $*" >&2
  exit 1
}

for tool in git jq openssl tar gzip sha256sum base64; do
  command -v "$tool" >/dev/null || fail "falta $tool"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
state=$work/state
mkdir -p "$work/bin" "$state"
export VERAX_TEST_STATE=$state

# Chaves descartáveis: a do pacote (a "de release") e uma intrusa, que nunca entra no pacote.
openssl ecparam -name prime256v1 -genkey -noout -out "$state/release.key" 2>/dev/null
openssl ec -in "$state/release.key" -pubout -out "$state/release-teste-v1.pem" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$state/intrusa.key" 2>/dev/null

# Repositório descartável, com datas fixas: o pacote depende só do commit.
repo=$work/repo
mkdir -p "$repo/infra/wazuh"
cp -R "$root/infra/node" "$repo/infra/node"
cp -R "$root/infra/wazuh/scripts" "$root/infra/wazuh/config" "$repo/infra/wazuh/"
mkdir -p "$repo/infra/node/keys"
cp "$state/release-teste-v1.pem" "$repo/infra/node/keys/"
export GIT_AUTHOR_NAME=Teste GIT_AUTHOR_EMAIL=teste@exemplo.com.br GIT_COMMITTER_NAME=Teste
export GIT_COMMITTER_EMAIL=teste@exemplo.com.br GIT_AUTHOR_DATE='2026-11-04T12:00:00Z'
export GIT_COMMITTER_DATE='2026-11-04T12:00:00Z' GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" commit -q -m 'pacote de teste'
commit=$(git -C "$repo" rev-parse HEAD)

release() { (cd "$repo" && bash "$script" "$@"); }
# expect_fail <trecho da mensagem> <comando...>: o comando falha e diz o motivo.
expect_fail() {
  local message=$1 code=0
  shift
  "$@" >"$work/out" 2>"$work/err" || code=$?
  ((code != 0)) || fail "devia falhar: $*"
  grep -qF -- "$message" "$work/err" || fail "mensagem esperada \"$message\", veio: $(cat "$work/err")"
}

scenario='pacote igual byte a byte em duas máquinas'
mkdir -p "$work/dist-a" "$work/dist-b"
(umask 022 && release package "$commit" "$work/dist-a/verax-node.tar.gz")
# Outra máquina: outra máscara, outra hora e a pasta de trabalho mexida (o pacote sai do commit, não da pasta).
touch -d '2030-01-01T00:00:00Z' "$repo/infra/node/compose.yaml"
echo '# mudança fora do commit' >>"$repo/infra/node/bin/install.sh"
(umask 077 && release package "$commit" "$work/dist-b/verax-node.tar.gz")
git -C "$repo" checkout -q -- infra/node/bin/install.sh
sha_a=$(sha256sum "$work/dist-a/verax-node.tar.gz" | cut -d' ' -f1)
sha_b=$(sha256sum "$work/dist-b/verax-node.tar.gz" | cut -d' ' -f1)
[[ $sha_a == "$sha_b" ]] || fail "pacotes diferentes: $sha_a e $sha_b"
package=$work/dist-a/verax-node.tar.gz

scenario='conteúdo do pacote'
tar -tzf "$package" >"$work/lista"
for path in verax-node/bin/install.sh verax-node/bin/start.sh verax-node/bin/verify-release.sh \
  verax-node/compose.yaml verax-node/compose.wazuh.yaml verax-node/compose.vault.yaml verax-node/pg_hba.conf \
  verax-node/keys/release-teste-v1.pem verax-node/systemd/verax-node.service \
  verax-node/wazuh/scripts/lib-passwords.sh verax-node/wazuh/config/manager/ossec.conf \
  verax-node/wazuh/config/indexer/opensearch.yml; do
  grep -qx "$path" "$work/lista" || fail "falta $path"
done
grep -q '^verax-node/tests' "$work/lista" && fail 'os testes do pacote entraram'
grep -qv '^verax-node/' "$work/lista" && fail "caminho fora de verax-node/: $(grep -v '^verax-node/' "$work/lista" | head -1)"
grep -q 'verax-node/wazuh/tests\|docker-compose.yml' "$work/lista" && fail 'entrou arquivo de infra/wazuh fora do que o deploy.sh copia'
TZ=UTC tar --numeric-owner --full-time -tvzf "$package" >"$work/detalhe"
awk '$2 != "0/0" { exit 1 }' "$work/detalhe" || fail "entrada sem dono 0/0: $(awk '$2 != "0/0"' "$work/detalhe" | head -1)"
expected_time=$(TZ=UTC date -d @"$(git -C "$repo" show -s --format=%ct "$commit")" '+%Y-%m-%d %H:%M:%S')
awk -v t="$expected_time" '$4 " " $5 != t { exit 1 }' "$work/detalhe" || fail 'entrada com data diferente da do commit'
awk '$1 ~ /^.....w|^........w/ { exit 1 }' "$work/detalhe" || fail 'entrada com escrita para grupo ou outros'
tar -xzOf "$package" verax-node/bin/install.sh | cmp -s - "$root/infra/node/bin/install.sh" ||
  fail 'o install.sh do pacote não é o do commit'

scenario='commit diferente, pacote diferente'
echo '# outra versão' >>"$repo/infra/node/node.conf.example"
git -C "$repo" commit -q -am 'outra versão'
commit2=$(git -C "$repo" rev-parse HEAD)
release package "$commit2" "$work/outro.tar.gz"
[[ $(sha256sum "$work/outro.tar.gz" | cut -d' ' -f1) != "$sha_a" ]] || fail 'o pacote não mudou com o commit'

scenario='pacote: entrada inválida'
expect_fail 'commit inválido' release package abc "$work/x.tar.gz"
expect_fail 'não está neste clone' release package 0123456789abcdef0123456789abcdef01234567 "$work/x.tar.gz"

api=sha256:$(printf 'api' | sha256sum | cut -d' ' -f1)
migrate=sha256:$(printf 'migrate' | sha256sum | cut -d' ' -f1)
manifest_args=(--commit "$commit" --release node-v1.2.3 --api-digest "$api" --migrate-digest "$migrate"
  --package "$package" --repository williandotdev/verax-control)

scenario='manifesto'
release manifest "${manifest_args[@]}" >"$work/manifest.json"
jq -e --arg commit "$commit" --arg sha "$sha_a" --arg api "ghcr.io/williandotdev/verax-control/api@$api" \
  --arg migrate "ghcr.io/williandotdev/verax-control/migrate@$migrate" '
  .schema == 1 and .kind == "verax-node-release" and .version == $commit and .release == "node-v1.2.3" and
  (.releasedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
  .package.sha256 == $sha and
  .package.url == "https://github.com/williandotdev/verax-control/releases/download/node-v1.2.3/verax-node.tar.gz" and
  .images == {api: $api, migrate: $migrate} and
  .notes == "https://github.com/williandotdev/verax-control/releases/tag/node-v1.2.3"
' "$work/manifest.json" >/dev/null || fail "manifesto inesperado: $(cat "$work/manifest.json")"
# As de terceiros: as fixadas pelo digest nos compose do repositório, sem repetição, e nenhuma do Verax.
expected=$(cat "$root"/infra/node/compose*.yaml | sed -nE 's/^[[:space:]]*image:[[:space:]]*([^$][^[:space:]]*@sha256:[0-9a-f]{64}).*/\1/p' |
  sort -u | jq -R . | jq -cs .)
got=$(jq -c .thirdPartyImages "$work/manifest.json")
[[ $got == "$expected" ]] || fail "imagens de terceiros: $got, esperado $expected"
jq -e '.thirdPartyImages | length >= 4 and all(test("^(postgres|cloudflare/cloudflared|wazuh/wazuh-(manager|indexer)):[^@]+@sha256:[0-9a-f]{64}$"))' \
  "$work/manifest.json" >/dev/null || fail "lista de terceiros fora do esperado: $got"
grep -q 'pkg\.dev\|gcr\.io' "$work/manifest.json" && fail 'o manifesto cita um registro privado'

scenario='bundle do painel igual byte a byte, no formato que o plano de controle lê'
make_dist() { # <pasta>
  mkdir -p "$1/dist/assets"
  printf '<!doctype html><title>Verax</title>' >"$1/dist/index.html"
  printf 'console.log(1)' >"$1/dist/assets/index-abc123.js"
  printf '{"headers":[{"glob":"**","headers":{"Content-Security-Policy":"connect-src https://api-{tenant}.veraxsistemas.com.br"}}],"rewrites":[{"glob":"**","path":"/index.html"}]}' \
    >"$1/dist-hosting.json"
}
make_dist "$work/web-a"
make_dist "$work/web-b"
touch -d '2031-02-03T04:05:06Z' "$work/web-b/dist/index.html"
panel_file=$work/panel-a/panel-$commit.tar.gz
mkdir -p "$work/panel-a" "$work/panel-b"
(umask 022 && release panel "$commit" "$work/web-a/dist" "$work/web-a/dist-hosting.json" "$panel_file")
(umask 077 && release panel "$commit" "$work/web-b/dist" "$work/web-b/dist-hosting.json" \
  "$work/panel-b/panel-$commit.tar.gz")
cmp -s "$panel_file" "$work/panel-b/panel-$commit.tar.gz" || fail 'o bundle do painel muda com a máquina'
tar -tzf "$panel_file" >"$work/panel.list"
[[ $(tr '\n' ' ' <"$work/panel.list") == 'dist/ dist/assets/ dist/assets/index-abc123.js dist/index.html dist-hosting.json ' ]] ||
  fail "conteúdo do bundle: $(tr '\n' ' ' <"$work/panel.list")"
[[ $(gzip -dc "$panel_file" | head -c 262 | tail -c 5) == ustar ]] || fail 'o bundle não é ustar'
TZ=UTC tar --numeric-owner --full-time -tvzf "$panel_file" >"$work/panel.detalhe"
awk '$2 != "0/0" { exit 1 }' "$work/panel.detalhe" || fail 'entrada do bundle sem dono 0/0'
awk -v t="$expected_time" '$4 " " $5 != t { exit 1 }' "$work/panel.detalhe" || fail 'entrada do bundle fora da data do commit'

scenario='bundle do painel: entrada inválida'
expect_fail "panel-$commit.tar.gz" release panel "$commit" "$work/web-a/dist" "$work/web-a/dist-hosting.json" \
  "$work/painel.tar.gz"
mkdir -p "$work/sem-index/dist"
expect_fail 'não tem' release panel "$commit" "$work/sem-index/dist" "$work/web-a/dist-hosting.json" \
  "$work/sem-index/panel-$commit.tar.gz"
printf '{"headers":[{"glob":"**","headers":{}}],"rewrites":[]}' >"$work/destino-unico.json"
expect_fail 'falta o marcador {tenant}' release panel "$commit" "$work/web-a/dist" "$work/destino-unico.json" \
  "$work/x/panel-$commit.tar.gz"
ln -s /etc/passwd "$work/web-b/dist/link"
expect_fail 'não é arquivo nem pasta' release panel "$commit" "$work/web-b/dist" "$work/web-b/dist-hosting.json" \
  "$work/panel-b/panel-$commit.tar.gz"

scenario='manifesto com o bundle do painel'
release manifest "${manifest_args[@]}" --panel "$panel_file" >"$work/manifest-painel.json"
jq -e --arg sha "$(sha256sum "$panel_file" | cut -d' ' -f1)" --arg commit "$commit" '
  .panel == {url: ("https://github.com/williandotdev/verax-control/releases/download/node-v1.2.3/panel-" + $commit + ".tar.gz"), sha256: $sha}
' "$work/manifest-painel.json" >/dev/null || fail "campo panel: $(jq -c .panel "$work/manifest-painel.json")"
jq -e 'has("panel") | not' "$work/manifest.json" >/dev/null || fail 'o manifesto sem --panel ganhou o campo panel'
cp "$panel_file" "$work/outro-nome.tar.gz"
expect_fail "panel-$commit.tar.gz" release manifest "${manifest_args[@]}" --panel "$work/outro-nome.tar.gz"

scenario='instalador da VM própria: a versão, o verificador e as chaves do commit embutidos, igual byte a byte'
mkdir -p "$work/inst-a" "$work/inst-b"
(umask 022 && release installer "$commit" node-v1.2.3 "$work/inst-a/verax-install.sh")
echo '# mudança fora do commit' >>"$repo/infra/node/bin/verax-install.sh"
(umask 077 && release installer "$commit" node-v1.2.3 "$work/inst-b/verax-install.sh")
git -C "$repo" checkout -q -- infra/node/bin/verax-install.sh
cmp -s "$work/inst-a/verax-install.sh" "$work/inst-b/verax-install.sh" || fail 'o instalador muda com a máquina ou a pasta'
installer_file=$work/inst-a/verax-install.sh
grep -qx "installer_release='node-v1.2.3'" "$installer_file" || fail 'a versão não foi embutida'
# As funções embutidas devolvem o verificador e a chave do commit, byte a byte.
sed -n '/^embedded_verifier() {$/,/^}$/p; /^embedded_keys() {$/,/^}$/p' "$installer_file" >"$work/embutido.sh"
# shellcheck source=/dev/null
source "$work/embutido.sh"
cmp -s <(embedded_verifier) "$repo/infra/node/bin/verify-release.sh" || fail 'o verificador embutido não é o do commit'
expected_keys=$(for key in "$repo"/infra/node/keys/release-*.pem; do printf '%s %s\n' "${key##*/}" "$(base64 -w0 <"$key")"; done)
[[ $(embedded_keys) == "$expected_keys" ]] || fail "chaves embutidas: $(embedded_keys)"
grep -qx "release-teste-v1.pem $(base64 -w0 <"$repo/infra/node/keys/release-teste-v1.pem")" <<<"$expected_keys" ||
  fail 'a chave de teste não foi embutida'
# Fora o que foi embutido, o resto é o arquivo do commit.
diff <(grep -v -e '^installer_release=' -e '^[A-Za-z0-9+/=]*$' -e '^release-[A-Za-z0-9._-]*\.pem ' "$installer_file") \
  <(grep -v -e '^installer_release=' -e '^[A-Za-z0-9+/=]*$' "$repo/infra/node/bin/verax-install.sh") >/dev/null ||
  fail 'o instalador montado mudou além da versão, do verificador e das chaves'
expect_fail 'versão inválida' release installer "$commit" v1.2.3 "$work/x/verax-install.sh"
expect_fail 'se chama verax-install.sh' release installer "$commit" node-v1.2.3 "$work/x/instalador.sh"

scenario='manifesto com o instalador'
release manifest "${manifest_args[@]}" --installer "$installer_file" >"$work/manifest-instalador.json"
jq -e --arg sha "$(sha256sum "$installer_file" | cut -d' ' -f1)" '.installer == {name: "verax-install.sh", sha256: $sha}' \
  "$work/manifest-instalador.json" >/dev/null || fail "campo installer: $(jq -c .installer "$work/manifest-instalador.json")"
jq -e 'has("installer") | not' "$work/manifest.json" >/dev/null || fail 'o manifesto sem --installer ganhou o campo installer'
args=("${manifest_args[@]}")
args[3]=node-v1.2.4
expect_fail 'não é o de node-v1.2.4' release manifest "${args[@]}" --installer "$installer_file"

scenario='manifesto: imagem de terceiro sem digest'
sed -i -E 's#image: (postgres:[^@]+)@sha256:[0-9a-f]{64}#image: \1#' "$repo/infra/node/compose.yaml"
git -C "$repo" commit -q -am 'postgres sem digest'
release package "$(git -C "$repo" rev-parse HEAD)" "$work/sem-digest.tar.gz"
args=("${manifest_args[@]}")
args[9]=$work/sem-digest.tar.gz
expect_fail 'imagem de terceiro sem digest fixo: postgres:' release manifest "${args[@]}"
git -C "$repo" revert --no-edit HEAD >/dev/null

scenario='manifesto: imagem por variável desconhecida'
# shellcheck disable=SC2016 # o texto do compose, sem expansão
sed -i 's#image: ${API_IMAGE:?}#image: ${OUTRA_IMAGEM:?}#' "$repo/infra/node/compose.yaml"
grep -q 'OUTRA_IMAGEM' "$repo/infra/node/compose.yaml" || fail 'a troca do compose não pegou'
git -C "$repo" commit -q -am 'imagem por variável'
release package "$(git -C "$repo" rev-parse HEAD)" "$work/variavel.tar.gz"
args[9]=$work/variavel.tar.gz
expect_fail 'imagem por variável que o manifesto não cobre' release manifest "${args[@]}"
git -C "$repo" revert --no-edit HEAD >/dev/null

scenario='manifesto: entrada inválida'
args=("${manifest_args[@]}")
args[3]=v1.2.3
expect_fail 'versão inválida' release manifest "${args[@]}"
args=("${manifest_args[@]}")
args[5]=sha256:abc
expect_fail 'digests inválidos' release manifest "${args[@]}"
args=("${manifest_args[@]}")
args[11]='dono/repo;rm'
expect_fail 'repositório inválido' release manifest "${args[@]}"

# O Cloud KMS simulado. Lê os cabeçalhos (também os de um arquivo, -H @arquivo), confere o token, assina o digest
# recebido com a chave do modo e devolve a resposta do asymmetricSign. Modos: ok, outra-versao (a resposta cita a
# versão 2), intrusa (assina com a chave que não está no pacote), lixo (assinatura que não é base64) e falha (403).
cat >"$work/bin/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
state=$VERAX_TEST_STATE
printf '%s\n' "$*" >>"$state/curl.args"
headers='' data='' url=''
while (($#)); do
  case $1 in
    -H)
      if [[ $2 == @* ]]; then headers+=$(cat "${2#@}")$'\n'; else headers+=$2$'\n'; fi
      shift 2
      ;;
    --data) data=$2; shift 2 ;;
    --proto | --max-time | --retry | -X) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
mode=$(cat "$state/kms-mode")
if [[ $mode == falha ]]; then echo 'curl: (22) The requested URL returned error: 403' >&2; exit 22; fi
grep -qxF "Authorization: Bearer $(cat "$state/token")" <<<"$headers" || { echo 'curl simulado: sem o token' >&2; exit 22; }
[[ $url =~ ^https://cloudkms\.googleapis\.com/v1/(projects/.+):asymmetricSign$ ]] || { echo "URL: $url" >&2; exit 22; }
name=${BASH_REMATCH[1]}
jq -er '.digest.sha256' <<<"$data" | base64 -d >"$state/digest.bin"
key=$state/release.key
[[ $mode == intrusa ]] && key=$state/intrusa.key
signature=$(openssl pkeyutl -sign -inkey "$key" -in "$state/digest.bin" | base64 | tr -d '\n')
[[ $mode == outra-versao ]] && name=${name%/*}/2
[[ $mode == lixo ]] && signature='não é base64'
jq -n --arg signature "$signature" --arg name "$name" '{signature: $signature, name: $name, protectionLevel: "SOFTWARE"}'
EOF
chmod +x "$work/bin/curl"

key_version=projects/projeto-exemplo/locations/us-east1/keyRings/verax-release/cryptoKeys/node-manifest/cryptoKeyVersions/1
token=token-de-teste-$RANDOM$RANDOM
printf '%s' "$token" >"$state/token"
mkdir -p "$work/pacote"
tar -xzf "$package" -C "$work/pacote"
sign() { # <modo> [argumentos a mais]
  printf '%s' "$1" >"$state/kms-mode"
  shift
  rm -f "$work/manifest.json.sig"
  (cd "$repo" && PATH="$work/bin:$PATH" GOOGLE_ACCESS_TOKEN=$token bash "$script" sign --key-version "$key_version" \
    --manifest "$work/manifest.json" --out "$work/manifest.json.sig" --node-package-dir "$work/pacote/verax-node" "$@")
}

scenario='assinatura no KMS'
sign ok
[[ -s $work/manifest.json.sig ]] || fail 'sem a assinatura'
grep -qF "$key_version:asymmetricSign" "$state/curl.args" || fail 'não chamou o asymmetricSign da versão pedida'
grep -qF -- "$token" "$state/curl.args" && fail 'o token apareceu nos argumentos do curl'
cmp -s "$state/digest.bin" <(openssl dgst -sha256 -binary "$work/manifest.json") ||
  fail 'o KMS não recebeu o SHA-256 do manifesto'

scenario='ponta a ponta: o host confere com o pacote instalado'
out=$(bash "$work/pacote/verax-node/bin/verify-release.sh" "$work/manifest.json" "$work/manifest.json.sig")
[[ $out == 'OK release-teste-v1' ]] || fail "saída: $out"
sed 's/node-v1.2.3/node-v9.9.9/' "$work/manifest.json" >"$work/adulterado.json"
code=0
bash "$work/pacote/verax-node/bin/verify-release.sh" "$work/adulterado.json" "$work/manifest.json.sig" 2>/dev/null || code=$?
[[ $code == 1 ]] || fail "manifesto adulterado não foi recusado (saída $code)"

scenario='KMS responde com outra versão da chave'
expect_fail 'assinou com outra versão da chave' sign outra-versao
[[ ! -e $work/manifest.json.sig ]] || fail 'gravou a assinatura'

scenario='KMS assina com uma chave que não está no pacote'
expect_fail 'não fecha com as chaves do pacote' sign intrusa
[[ ! -e $work/manifest.json.sig ]] || fail 'gravou a assinatura'

scenario='KMS devolve lixo'
expect_fail 'fora do formato' sign lixo
[[ ! -e $work/manifest.json.sig ]] || fail 'gravou a assinatura'

scenario='KMS recusa'
expect_fail 'o Cloud KMS recusou' sign falha
[[ ! -e $work/manifest.json.sig ]] || fail 'gravou a assinatura'

scenario='assinatura: entrada inválida'
printf 'ok' >"$state/kms-mode"
expect_fail 'falta GOOGLE_ACCESS_TOKEN' env -u GOOGLE_ACCESS_TOKEN bash -c "cd '$repo' && bash '$script' sign \
  --key-version '$key_version' --manifest '$work/manifest.json' --out '$work/x.sig' --node-package-dir '$work/pacote/verax-node'"
expect_fail 'versão da chave do KMS inválida' sign ok --key-version 'projects/x/../cryptoKeyVersions/1'
mkdir -p "$work/sem-verificador"
expect_fail 'não traz o verificador' sign ok --node-package-dir "$work/sem-verificador"

echo 'test-node-release: todos os cenários passaram.'
