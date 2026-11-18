#!/bin/bash
# Testa a guarda do metadata da VM própria do cliente (bin/vm-metadata-guard.sh) num espaço de nomes de rede próprio,
# sem tocar nas regras da máquina: no CI, `sudo unshare -n bash tests/vm-metadata-guard-test.sh`; localmente, num
# contêiner com NET_ADMIN e o iptables instalado. Cenários: antes do Docker (sem DOCKER-USER), de novo com tudo já no
# lugar (idempotente), todos os contêineres sem o metadata (nenhuma exceção de origem, só o DNS na porta 53), o IPv6
# (fd00:ec2::254) quando há ip6tables, a troca do conteúdo da cadeia numa transação só e nenhuma regra da guarda dos
# nós da GCP (VERAX-METADATA).
set -euo pipefail
cd "$(dirname "$0")/.."

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

chain_order() { "$1" -S VERAX-IMDS | grep '^-A' | sed 's/^-A VERAX-IMDS //' | tr '\n' ';'; }
user_rules() { "$1" -S DOCKER-USER | grep '^-A' | tr '\n' ';'; }

expected_order='-p udp -m udp --dport 53 -j RETURN;-p tcp -m tcp --dport 53 -j RETURN;-j DROP;'
ipv6=false
if command -v ip6tables >/dev/null && ip6tables -S >/dev/null 2>&1; then ipv6=true; fi

echo "== Antes do Docker: sem DOCKER-USER"
expect "DOCKER-USER ainda não existe" 1 "$(iptables -S DOCKER-USER >/dev/null 2>&1 && echo 0 || echo 1)"
bash bin/vm-metadata-guard.sh
expect "cadeia com o DNS e o DROP, sem exceção de origem (nem o worker)" "$expected_order" "$(chain_order iptables)"
expect "um salto no DOCKER-USER, sem filtro de origem" '-A DOCKER-USER -d 169.254.169.254/32 -j VERAX-IMDS;' \
  "$(user_rules iptables)"
if $ipv6; then
  expect "IPv6: a mesma cadeia" "$expected_order" "$(chain_order ip6tables)"
  expect "IPv6: o salto para o metadata da AWS" '-A DOCKER-USER -d fd00:ec2::254/128 -j VERAX-IMDS;' \
    "$(user_rules ip6tables)"
else
  echo 'aviso  sem ip6tables neste ambiente: a parte do IPv6 não foi conferida'
fi
expect "nada da guarda dos nós da GCP" 0 "$(iptables -S | grep -c VERAX-METADATA || true)"

echo "== O Docker subiu (RETURN no fim do DOCKER-USER) e a partida reaplica a guarda"
iptables -A DOCKER-USER -j RETURN
bash bin/vm-metadata-guard.sh
expect "mesmas regras" "$expected_order" "$(chain_order iptables)"
expect "um salto só, antes do RETURN do Docker" '-A DOCKER-USER -d 169.254.169.254/32 -j VERAX-IMDS;-A DOCKER-USER -j RETURN;' \
  "$(user_rules iptables)"

echo "== Troca atômica: a cadeia em uso é esvaziada e preenchida num commit"
iptables -I VERAX-IMDS 1 -s 172.30.53.10 -j RETURN
bash bin/vm-metadata-guard.sh
expect "a exceção posta à mão saiu junto com o resto" "$expected_order" "$(chain_order iptables)"
expect "nenhum -F ou -A solto no iptables (só na transação do restore)" 0 \
  "$(grep -cE "^\s*\"?[$]tool\"? -(F|A|D) \"?[$]chain" bin/vm-metadata-guard.sh || true)"

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "Guarda do metadata da VM própria: todas as verificações passaram."
