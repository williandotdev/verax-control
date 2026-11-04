#!/bin/bash
# Testes de bin/verify-release.sh, a conferência da assinatura do manifesto da versão no host do nó. Sem rede, sem
# nuvem e sem chave real: cada execução gera chaves descartáveis (ECDSA P-256, a mesma curva e o mesmo formato DER que
# a chave de release do Cloud KMS devolve) numa pasta temporária, assina com o openssl e confere com o script. Nenhuma
# chave privada fica no repositório nem sobrevive ao teste.
#
# Cenários: assinatura válida; manifesto adulterado (um byte, uma quebra de linha a mais); chave errada; troca de
# chave (a pasta com a antiga e a nova); arquivos cortados (manifesto e assinatura); assinatura vazia ou de outro
# manifesto; pasta sem chave ou com uma chave que não é P-256; argumentos faltando; e o script não chama gh, curl,
# wget nem gcloud (ficam no PATH como simulados que anotam qualquer chamada).
#
#   bash infra/node/tests/verify-release-test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
verify=$here/bin/verify-release.sh
scenario=ambiente

fail() {
  echo "FALHOU ($scenario): $*" >&2
  exit 1
}

for tool in openssl head wc cmp; do
  command -v "$tool" >/dev/null || fail "falta $tool"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/keys" "$work/rotation" "$work/other" "$work/empty" "$work/bad"

# Qualquer chamada a um destes comandos fica anotada: o verificador do nó não depende de rede nem de CLI de nuvem.
for tool in gh curl wget gcloud; do
  printf '#!/bin/sh\necho "%s $*" >>"%s/network.log"\nexit 97\n' "$tool" "$work" >"$work/bin/$tool"
  chmod +x "$work/bin/$tool"
done
export PATH="$work/bin:$PATH"

newkey() { # <nome>: release-<nome>.key (privada, só no teste) e release-<nome>.pem (pública)
  openssl ecparam -name prime256v1 -genkey -noout -out "$work/release-$1.key" 2>/dev/null
  openssl ec -in "$work/release-$1.key" -pubout -out "$work/release-$1.pem" 2>/dev/null
}
sign() { # <chave> <arquivo> <assinatura>
  openssl dgst -sha256 -sign "$work/release-$1.key" -out "$3" "$2"
}
# run <esperado> <manifesto> <assinatura> [pasta]: confere o código de saída e guarda a saída padrão em $out.
run() {
  local expected=$1 code=0
  shift
  out=$(bash "$verify" "$@" 2>"$work/stderr") || code=$?
  [[ $code == "$expected" ]] || fail "saída $code, esperada $expected (stderr: $(cat "$work/stderr"))"
}

newkey atual
newkey nova
newkey intrusa
cp "$work/release-atual.pem" "$work/keys/"
cp "$work/release-atual.pem" "$work/release-nova.pem" "$work/rotation/"
cp "$work/release-intrusa.pem" "$work/other/"

cat >"$work/manifest.json" <<'EOF'
{
  "schema": 1,
  "kind": "verax-node-release",
  "version": "0123456789abcdef0123456789abcdef01234567",
  "release": "node-v1.2.3",
  "package": {
    "url": "https://github.com/exemplo/exemplo/releases/download/node-v1.2.3/verax-node.tar.gz",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
EOF
sign atual "$work/manifest.json" "$work/manifest.json.sig"

scenario='assinatura válida'
run 0 "$work/manifest.json" "$work/manifest.json.sig" "$work/keys"
[[ $out == 'OK release-atual' ]] || fail "saída inesperada: $out"

scenario='pasta padrão das chaves (keys/ ao lado de bin/)'
mkdir -p "$work/pacote/bin" "$work/pacote/keys"
cp "$verify" "$work/pacote/bin/"
cp "$work/release-atual.pem" "$work/pacote/keys/"
code=0
out=$(bash "$work/pacote/bin/verify-release.sh" "$work/manifest.json" "$work/manifest.json.sig" 2>"$work/stderr") || code=$?
[[ $code == 0 && $out == 'OK release-atual' ]] || fail "saída $code: $out $(cat "$work/stderr")"

scenario='manifesto adulterado (um digest trocado)'
sed 's/"sha256": "0/"sha256": "1/' "$work/manifest.json" >"$work/adulterado.json"
cmp -s "$work/manifest.json" "$work/adulterado.json" && fail 'o manifesto adulterado ficou igual'
run 1 "$work/adulterado.json" "$work/manifest.json.sig" "$work/keys"
grep -q 'Manifesto recusado' "$work/stderr" || fail 'sem a mensagem de recusa'
[[ -z $out ]] || fail "imprimiu OK num manifesto adulterado: $out"

scenario='manifesto com uma quebra de linha a mais (bytes exatos)'
{ cat "$work/manifest.json"; echo; } >"$work/quebra.json"
run 1 "$work/quebra.json" "$work/manifest.json.sig" "$work/keys"

scenario='chave errada'
run 1 "$work/manifest.json" "$work/manifest.json.sig" "$work/other"

scenario='assinado por uma chave que não está no pacote'
sign intrusa "$work/manifest.json" "$work/intrusa.sig"
run 1 "$work/manifest.json" "$work/intrusa.sig" "$work/keys"

scenario='troca de chave: a antiga e a nova no pacote'
sign nova "$work/manifest.json" "$work/nova.sig"
run 0 "$work/manifest.json" "$work/nova.sig" "$work/rotation"
[[ $out == 'OK release-nova' ]] || fail "saída inesperada: $out"
run 0 "$work/manifest.json" "$work/manifest.json.sig" "$work/rotation"
[[ $out == 'OK release-atual' ]] || fail "saída inesperada: $out"

scenario='chave revogada (saiu do pacote)'
run 1 "$work/manifest.json" "$work/nova.sig" "$work/keys"

scenario='manifesto cortado'
size=$(wc -c <"$work/manifest.json")
head -c $((size - 10)) "$work/manifest.json" >"$work/cortado.json"
run 1 "$work/cortado.json" "$work/manifest.json.sig" "$work/keys"

scenario='assinatura cortada'
sig_size=$(wc -c <"$work/manifest.json.sig")
head -c $((sig_size - 1)) "$work/manifest.json.sig" >"$work/cortada.sig"
run 1 "$work/manifest.json" "$work/cortada.sig" "$work/keys"
head -c 8 "$work/manifest.json.sig" >"$work/curta.sig"
run 1 "$work/manifest.json" "$work/curta.sig" "$work/keys"

scenario='assinatura vazia'
: >"$work/vazia.sig"
run 1 "$work/manifest.json" "$work/vazia.sig" "$work/keys"

scenario='manifesto vazio'
: >"$work/vazio.json"
run 1 "$work/vazio.json" "$work/manifest.json.sig" "$work/keys"

scenario='assinatura de outro manifesto'
printf '{"schema":1}\n' >"$work/outro.json"
sign atual "$work/outro.json" "$work/outro.sig"
run 1 "$work/manifest.json" "$work/outro.sig" "$work/keys"

scenario='assinatura grande demais'
head -c 200 /dev/zero >"$work/grande.sig"
run 1 "$work/manifest.json" "$work/grande.sig" "$work/keys"

scenario='manifesto grande demais'
head -c 70000 /dev/zero | tr '\0' ' ' >"$work/grande.json"
run 1 "$work/grande.json" "$work/manifest.json.sig" "$work/keys"

scenario='pasta sem chave'
run 2 "$work/manifest.json" "$work/manifest.json.sig" "$work/empty"
run 2 "$work/manifest.json" "$work/manifest.json.sig" "$work/nao-existe"

scenario='chave que não é P-256 na pasta'
cp "$work/release-atual.pem" "$work/bad/"
openssl genpkey -algorithm ed25519 2>/dev/null | openssl pkey -pubout -out "$work/bad/release-ed25519.pem"
run 2 "$work/manifest.json" "$work/manifest.json.sig" "$work/bad"
grep -q 'não é uma pública EC P-256' "$work/stderr" || fail 'sem a mensagem da chave inválida'
rm "$work/bad/release-ed25519.pem"
printf 'isto não é uma chave\n' >"$work/bad/release-lixo.pem"
run 2 "$work/manifest.json" "$work/manifest.json.sig" "$work/bad"

scenario='argumentos'
run 2 "$work/manifest.json"
run 2
run 2 "$work/nao-existe.json" "$work/manifest.json.sig" "$work/keys"
run 2 "$work/manifest.json" "$work/nao-existe.sig" "$work/keys"

scenario='sem rede nem CLI de nuvem'
[[ ! -e $work/network.log ]] || fail "o verificador chamou: $(cat "$work/network.log")"

echo 'verify-release-test: todos os cenários passaram.'
