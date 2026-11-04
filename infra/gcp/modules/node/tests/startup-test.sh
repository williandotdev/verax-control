#!/bin/bash
# Testes do script de boot do módulo (../startup.sh.tftpl), sem root e sem tocar na máquina. O script roda numa pasta
# temporária que faz o papel da raiz: /etc, /var/lib, /swapfile e /dev/mapper viram caminhos dentro dela. Os comandos
# que mexem no kernel ou na rede (apt-get, cryptsetup, losetup, mkswap, swapon, swapoff, sysctl, fallocate e sleep)
# são simulados e anotam cada chamada; o shred, o sed, o grep e o resto são os de verdade. O loop, o dm-crypt e o swap
# de verdade ficam para a VM (passo 8 e manutenção do nó da Verax, no GUIA.md).
#
#   bash tests/startup-test.sh                  roda os cenários
#   bash tests/startup-test.sh render PERFIL    imprime o script como a VM o recebe (para o shellcheck do CI)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
template=$here/../startup.sh.tftpl

# O Terraform só troca `${node_profile}`: o tests/perfis.tftest.hcl confere que o resultado é exatamente este.
render() {
  sed 's/[$]{node_profile}/'"$1"'/g' "$template"
}

if [ "${1:-}" = render ]; then
  render "$2"
  exit 0
fi

fail() {
  echo "FALHOU ($scenario): $*" >&2
  exit 1
}

# Todo caminho absoluto do script (fora dos comentários) precisa estar aqui: é o que a pasta temporária troca, mais o
# que pode ficar como está. Um caminho novo no script obriga a rever o teste.
scenario="caminhos do script"
paths=$(render lean | grep -v '^[[:space:]]*#' | grep -o -E '/[A-Za-z0-9_./-]*' | sort -u)
expected=$(printf '%s\n' /dev/mapper/ /dev/null /dev/urandom /etc/fstab /etc/sysctl.d /etc/sysctl.d/90-verax.conf \
  /swapfile /var/lib/verax /var/lib/verax-swap.img | sort -u)
[ "$paths" = "$expected" ] || fail "caminhos absolutos mudaram: $(echo "$paths" | tr '\n' ' ')"

work=$(readlink -f "$(mktemp -d)")
trap 'rm -rf "$work"' EXIT
# Os caminhos do script viram "$work/root-.../caminho": a pasta não pode conter um dos caminhos trocados.
case $work in
  */etc/* | */var/lib/* | */swapfile* | */dev/mapper/*) fail "pasta temporária num caminho que o teste troca: $work" ;;
esac
mkdir -p "$work/bin" "$work/stubs"

# O PATH do script: os simulados, a pasta onde o apt-get simulado "instala" o cryptsetup, e as pastas das ferramentas
# de verdade. O cryptsetup de verdade (em /usr/sbin no Debian e no Ubuntu) não pode aparecer.
sandbox_path=$work/bin:$work/sbin
for tool in awk chmod env grep mkdir readlink rm sed shred; do
  dir=$(dirname "$(command -v "$tool")")
  case ":$sandbox_path:" in
    *":$dir:"*) ;;
    *) sandbox_path=$sandbox_path:$dir ;;
  esac
done
if PATH=$sandbox_path command -v cryptsetup >/dev/null; then
  scenario="ambiente"
  fail "há um cryptsetup de verdade nas pastas das ferramentas: o teste não consegue simular a instalação"
fi

# Cada simulado anota a chamada em $state/log e guarda o "estado do kernel" (swaps ligados, loops) em $state.
stub() {
  {
    cat <<'HEADER'
#!/bin/bash
set -euo pipefail
PATH=$VERAX_TEST_PATH
state=$VERAX_TEST_STATE root=$VERAX_TEST_ROOT
HEADER
    cat
  } >"$work/$1"
  chmod +x "$work/$1"
}

stub bin/apt-get <<'EOF'
echo "apt-get $*" >>"$state/log"
if [ -e "$state/apt-fails" ]; then exit 100; fi
case " $* " in
  *" install "*) install -m 0755 "$VERAX_TEST_STUBS/cryptsetup" "$VERAX_TEST_SBIN/cryptsetup" ;;
esac
EOF

stub stubs/cryptsetup <<'EOF'
echo "cryptsetup $*" >>"$state/log"
[ "$1" = open ] || exit 1
loop=${*: -2:1} name=${*: -1}
grep -q "^$loop " "$state/loops" || { echo "cryptsetup: $loop não existe" >&2; exit 1; }
if [ -e "$root/dev/mapper/$name" ]; then exit 1; fi
: >"$root/dev/dm-0"
ln -s ../dm-0 "$root/dev/mapper/$name"
# Chave nova: o que havia no dispositivo deixa de ser swap válido até o mkswap.
: >"$state/mkswapped"
EOF

stub bin/losetup <<'EOF'
case $1 in
  --associated) awk -v file="$2" '$2 == file { print $1 ": []: (" file ")" }' "$state/loops" ;;
  --find)
    echo "losetup $*" >>"$state/loop-log"
    echo "losetup $*" >>"$state/log"
    [ "$2" = --show ] && [ "$3" = --direct-io=on ] || exit 1
    dev=$root/dev/loop$(wc -l <"$state/loops")
    echo "$dev $4" >>"$state/loops"
    echo "$dev"
    ;;
  *) exit 1 ;;
esac
EOF

stub bin/mkswap <<'EOF'
echo "mkswap $*" >>"$state/log"
readlink -f "$1" >>"$state/mkswapped"
EOF

stub bin/swapon <<'EOF'
if [ "$1" = --show=NAME ]; then
  cat "$state/swaps"
  exit 0
fi
echo "swapon $*" >>"$state/log"
dev=$(readlink -f "$1")
grep -qx "$dev" "$state/mkswapped" || { echo "swapon: $1 sem assinatura de swap" >&2; exit 1; }
if grep -qx "$dev" "$state/swaps"; then exit 1; fi
echo "$dev" >>"$state/swaps"
EOF

stub bin/swapoff <<'EOF'
echo "swapoff $*" >>"$state/log"
grep -qx "$1" "$state/swaps" || exit 1
{ grep -vx "$1" "$state/swaps" || true; } >"$state/swaps.new"
mv "$state/swaps.new" "$state/swaps"
EOF

stub bin/sysctl <<'EOF'
echo "sysctl $*" >>"$state/log"
EOF

stub bin/fallocate <<'EOF'
echo "fallocate $*" >>"$state/log"
[ "$1" = -l ] && [ "$2" = 2G ] || exit 1
head -c 4096 /dev/zero >"$3"
EOF

stub bin/sleep <<'EOF'
echo "sleep $*" >>"$state/log"
EOF

# O shred de verdade, com duas anotações: o fstab no momento da limpeza e o arquivo logo depois dela. Com o
# `shred-fails`, zera só a primeira metade e falha, como uma VM reiniciada no meio.
stub bin/shred <<'EOF'
echo "shred $*" >>"$state/log"
file=${*: -1}
cp "$root/etc/fstab" "$state/fstab-at-shred"
if [ -e "$state/shred-fails" ]; then
  head -c $(($(wc -c <"$file") / 2)) /dev/zero | dd of="$file" conv=notrunc status=none
  exit 1
fi
"$VERAX_TEST_REAL_SHRED" "$@"
cp "$file" "$state/after-shred"
EOF

real_shred=$(command -v shred)
base_fstab='UUID=0000-exemplo / ext4 rw,discard,errors=remount-ro 0 1'
signature=SWAP-SIGNATURE

# Uma raiz nova para cada cenário.
new_root() {
  scenario=$1
  root=$work/root-$2 state=$work/state-$2
  mkdir -p "$root/etc" "$root/var/lib" "$root/dev/mapper" "$state" "$work/sbin"
  rm -f "$work/sbin/cryptsetup"
  echo "$base_fstab" >"$root/etc/fstab"
  : >"$state/swaps"
  : >"$state/loops"
  : >"$state/mkswapped"
}

# Disco que veio do script antigo: /swapfile em claro, com a linha no fstab.
legacy_swap() {
  echo "$root/swapfile none swap sw 0 0" >>"$root/etc/fstab"
  {
    echo "$signature"
    for _ in $(seq 200); do echo "texto-em-claro-da-memoria"; done
  } >"$root/swapfile"
  chmod 0600 "$root/swapfile"
  cp "$root/swapfile" "$state/legacy-original"
}

installed() {
  install -m 0755 "$work/stubs/cryptsetup" "$work/sbin/cryptsetup"
}

# Liga a VM: o kernel começa sem swap, loop ou dm-crypt, e o systemd liga as linhas de swap do fstab cujo arquivo
# ainda tem a assinatura. Os arquivos do disco ficam.
power_on() {
  : >"$state/swaps"
  : >"$state/loops"
  : >"$state/mkswapped"
  rm -f "$root/dev/mapper/verax-swap" "$root/dev/dm-0"
  local file
  while read -r file _ type _; do
    if [ "$type" = swap ] && [ -f "$file" ] && [ "$(head -c ${#signature} "$file" | tr -d '\0')" = "$signature" ]; then
      readlink -f "$file" >>"$state/swaps"
      readlink -f "$file" >>"$state/mkswapped"
    fi
  done <"$root/etc/fstab"
}

# Roda o script de boot, como o google-startup-scripts, num ambiente limpo. Devolve o código de saída dele.
boot() {
  render "$1" | sed -e "s#/etc/#$root/etc/#g" -e "s#/var/lib/#$root/var/lib/#g" -e "s#/swapfile#$root/swapfile#g" \
    -e "s#/dev/mapper/#$root/dev/mapper/#g" >"$state/boot.sh"
  : >"$state/log"
  local code=0
  env -i PATH="$sandbox_path" VERAX_TEST_PATH="$PATH" VERAX_TEST_ROOT="$root" VERAX_TEST_STATE="$state" \
    VERAX_TEST_STUBS="$work/stubs" VERAX_TEST_SBIN="$work/sbin" VERAX_TEST_REAL_SHRED="$real_shred" \
    "$BASH" "$state/boot.sh" >"$state/out" 2>&1 || code=$?
  return "$code"
}

logged() { grep -qxF -- "$1" "$state/log"; }
not_logged() { ! grep -q -- "$1" "$state/log"; }
line_of() { grep -nxF -m1 -- "$1" "$state/log" | cut -d: -f1; }
before() {
  local first second
  first=$(line_of "$1")
  second=$(line_of "$2")
  [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ]
}
count() { grep -cF -- "$1" "$state/log" || true; }
only_encrypted_swap() { [ "$(cat "$state/swaps")" = "$root/dev/dm-0" ]; }
all_zeros() { [ -s "$1" ] && [ -z "$(tr -d '\0' <"$1")" ]; }
legacy_gone() { [ ! -e "$root/swapfile" ] && [ "$(cat "$root/etc/fstab")" = "$base_fstab" ]; }

update="apt-get -o DPkg::Lock::Timeout=120 update -qq"
install_crypt="apt-get -o DPkg::Lock::Timeout=120 install -y -qq cryptsetup-bin"
open_crypt() {
  echo "cryptsetup open --type plain --cipher aes-xts-plain64 --key-size 512 --key-file /dev/urandom $root/dev/loop0 verax-swap"
}

# --- Nó novo, lean ---------------------------------------------------------------------------------------------------
new_root "nó novo (lean)" novo
power_on
boot lean || fail "o script falhou: $(cat "$state/out")"
logged "$update" || fail "não atualizou a lista do apt com a espera pela trava"
logged "$install_crypt" || fail "não instalou o cryptsetup-bin"
logged "fallocate -l 2G $root/var/lib/verax-swap.img" || fail "não criou o arquivo do swap cifrado"
[ "$(stat -c %a "$root/var/lib/verax-swap.img")" = 600 ] || fail "o arquivo do swap não ficou 0600"
[ "$(stat -c %a "$root/var/lib/verax")" = 750 ] || fail "a pasta dos dados não ficou 0750"
logged "losetup --find --show --direct-io=on $root/var/lib/verax-swap.img" || fail "loop sem acesso direto"
logged "$(open_crypt)" || fail "dm-crypt sem aes-xts-plain64 de 512 bits com chave de /dev/urandom"
before "$install_crypt" "$(open_crypt)" || fail "abriu o dm-crypt antes de instalar o cryptsetup"
before "mkswap $root/dev/mapper/verax-swap" "swapon $root/dev/mapper/verax-swap" || fail "ligou o swap sem formatar"
only_encrypted_swap || fail "o swap ligado não é só o cifrado: $(cat "$state/swaps")"
not_logged sysctl || fail "o lean não ajusta o kernel"
[ "$(cat "$root/etc/fstab")" = "$base_fstab" ] || fail "o fstab mudou num nó novo"
not_logged swapoff || fail "desligou algum swap num nó novo"
not_logged shred || fail "rodou o shred num nó novo"

scenario="nó novo (lean), o script de novo no mesmo boot"
boot lean || fail "o script falhou: $(cat "$state/out")"
[ ! -s "$state/log" ] || fail "refez algo que já estava pronto: $(cat "$state/log")"
only_encrypted_swap || fail "o swap mudou"

scenario="nó novo (lean), boot seguinte"
power_on
boot lean || fail "o script falhou: $(cat "$state/out")"
not_logged apt-get || fail "instalou de novo o cryptsetup"
not_logged fallocate || fail "criou de novo o arquivo do swap"
logged "$(open_crypt)" || fail "não abriu o dm-crypt com uma chave nova"
before "mkswap $root/dev/mapper/verax-swap" "swapon $root/dev/mapper/verax-swap" || fail "ligou o swap sem formatar"
only_encrypted_swap || fail "o swap ligado não é só o cifrado"

# --- Nó novo, standard -----------------------------------------------------------------------------------------------
new_root "nó novo (standard)" standard
installed
power_on
boot standard || fail "o script falhou: $(cat "$state/out")"
[ "$(cat "$root/etc/sysctl.d/90-verax.conf")" = "$(printf 'vm.max_map_count = 262144\nvm.swappiness = 1')" ] ||
  fail "o arquivo do sysctl mudou"
logged "sysctl --quiet --load=$root/etc/sysctl.d/90-verax.conf" || fail "não aplicou o sysctl"
not_logged apt-get || fail "rodou o apt com o cryptsetup já instalado"
only_encrypted_swap || fail "o swap ligado não é só o cifrado"

# --- Disco do script antigo (a manutenção do nó da Verax) ------------------------------------------------------------
new_root "disco do script antigo" antigo
legacy_swap
power_on
[ "$(cat "$state/swaps")" = "$root/swapfile" ] || fail "preparação: o swap antigo deveria estar ligado"
boot lean || fail "o script falhou: $(cat "$state/out")"
before "$install_crypt" "swapoff $root/swapfile" || fail "desligou o swap antigo antes de instalar o cryptsetup"
before "swapon $root/dev/mapper/verax-swap" "swapoff $root/swapfile" ||
  fail "desligou o swap antigo antes de ligar o cifrado (a e2-micro ficaria sem swap)"
before "swapoff $root/swapfile" "shred --iterations=0 --zero $root/swapfile" || fail "zerou o arquivo com o swap ligado"
grep -qxF "$root/swapfile none swap sw 0 0" "$state/fstab-at-shred" ||
  fail "tirou a linha do fstab antes de terminar de zerar o arquivo"
all_zeros "$state/after-shred" || fail "o arquivo antigo não ficou só com zeros antes de ser apagado"
legacy_gone || fail "o arquivo antigo ficou no disco, ou o fstab não ficou só com a linha de antes"
only_encrypted_swap || fail "o swap ligado não é só o cifrado: $(cat "$state/swaps")"

scenario="disco do script antigo, boot seguinte"
power_on
boot lean || fail "o script falhou: $(cat "$state/out")"
not_logged swapoff || fail "mexeu de novo no swap antigo"
not_logged shred || fail "rodou o shred de novo"
only_encrypted_swap || fail "o swap ligado não é só o cifrado"

# --- O apt falha num disco do script antigo --------------------------------------------------------------------------
new_root "apt falha num disco do script antigo" apt
legacy_swap
power_on
touch "$state/apt-fails"
if boot lean; then fail "o script deveria falhar sem o cryptsetup"; fi
[ "$(count "$update")" = 5 ] || fail "deveria tentar o apt-get update 5 vezes"
[ "$(count "sleep 20")" = 4 ] || fail "deveria esperar 20 s entre as tentativas"
not_logged cryptsetup || fail "chamou o cryptsetup sem tê-lo"
not_logged fallocate || fail "criou o arquivo do swap cifrado sem o cryptsetup"
not_logged swapoff || fail "desligou o swap antigo sem ter o cifrado (a e2-micro ficaria sem swap)"
not_logged shred || fail "mexeu no arquivo antigo sem ter o cifrado"
[ "$(cat "$state/swaps")" = "$root/swapfile" ] || fail "o swap antigo deveria continuar ligado"
grep -qxF "$root/swapfile none swap sw 0 0" "$root/etc/fstab" || fail "a linha do fstab deveria continuar"
cmp -s "$root/swapfile" "$state/legacy-original" || fail "o arquivo antigo mudou"

scenario="apt falha num disco do script antigo, boot seguinte com a rede de volta"
rm "$state/apt-fails"
power_on
boot lean || fail "o script falhou: $(cat "$state/out")"
before "swapon $root/dev/mapper/verax-swap" "swapoff $root/swapfile" || fail "desligou o swap antigo antes do cifrado"
legacy_gone || fail "o swap antigo não saiu"
only_encrypted_swap || fail "o swap ligado não é só o cifrado"

# --- A VM reinicia no meio do shred ----------------------------------------------------------------------------------
new_root "VM reiniciada no meio da limpeza" shred
installed
legacy_swap
power_on
touch "$state/shred-fails"
if boot lean; then fail "o script deveria parar com o shred interrompido"; fi
grep -qxF "$root/swapfile none swap sw 0 0" "$root/etc/fstab" || fail "a linha do fstab saiu antes de zerar o arquivo"
[ -e "$root/swapfile" ] || fail "o arquivo sumiu antes de ser zerado"
only_encrypted_swap || fail "só o swap cifrado deveria estar ligado"

scenario="VM reiniciada no meio da limpeza, boot seguinte"
rm "$state/shred-fails"
power_on
[ ! -s "$state/swaps" ] || fail "preparação: o arquivo meio zerado não tem assinatura, o systemd não o liga"
boot lean || fail "o script falhou: $(cat "$state/out")"
logged "shred --iterations=0 --zero $root/swapfile" || fail "não repetiu a limpeza"
all_zeros "$state/after-shred" || fail "o arquivo antigo não ficou só com zeros"
legacy_gone || fail "o swap antigo não saiu"
only_encrypted_swap || fail "o swap ligado não é só o cifrado"

# --- A VM reinicia entre a linha do fstab e o rm ---------------------------------------------------------------------
new_root "arquivo antigo sem a linha do fstab" sem-linha
installed
head -c 4096 /dev/zero >"$root/swapfile"
power_on
boot lean || fail "o script falhou: $(cat "$state/out")"
logged "shred --iterations=0 --zero $root/swapfile" || fail "não zerou o arquivo que sobrou"
[ ! -e "$root/swapfile" ] || fail "o arquivo que sobrou ficou no disco"
[ "$(cat "$root/etc/fstab")" = "$base_fstab" ] || fail "o fstab mudou"

# --- Linha no fstab sem o arquivo ------------------------------------------------------------------------------------
new_root "linha antiga no fstab sem o arquivo" sem-arquivo
installed
echo "$root/swapfile none swap sw 0 0" >>"$root/etc/fstab"
power_on
boot lean || fail "o script falhou: $(cat "$state/out")"
not_logged shred || fail "rodou o shred sem arquivo"
[ "$(cat "$root/etc/fstab")" = "$base_fstab" ] || fail "a linha antiga ficou no fstab"

# --- Perfil inválido -------------------------------------------------------------------------------------------------
new_root "perfil inválido" invalido
installed
power_on
if boot medio; then fail "o script deveria recusar o perfil"; fi
grep -q "Perfil do nó inválido" "$state/out" || fail "sem a mensagem de perfil inválido"
if [ -s "$state/log" ] || [ -e "$root/var/lib/verax" ]; then fail "mexeu na VM com um perfil inválido"; fi

echo "Script de boot do módulo: todos os cenários passaram."
