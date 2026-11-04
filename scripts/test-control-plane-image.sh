#!/usr/bin/env bash
# Testa a imagem do plano de controle como ela roda no Cloud Run (CP-01): produção, raiz só leitura, sem
# capabilities, sem ganho de privilégio e usuário sem privilégio. Numa rede Docker isolada (sem internet), confere:
# - com ROLE=public e com ROLE=worker, o processo sobe e /health responde 200;
# - o processo não é root e a raiz do contêiner não aceita escrita;
# - sem ROLE o processo não sobe, e a mensagem cita só o nome da variável;
# - um valor inválido de segredo não aparece na mensagem de erro.
# Uso: scripts/test-control-plane-image.sh [imagem]   (padrão: verax-control-plane:teste). Precisa de Docker.
set -euo pipefail

image=${1:-verax-control-plane:teste}
run_id=verax-cp-teste-$$
network=$run_id

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

cleanup() {
  docker rm -f "$run_id-public" "$run_id-worker" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create --internal "$network" >/dev/null

hardened=(--network "$network" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL
  --security-opt no-new-privileges:true -e NODE_ENV=production -e TRUST_PROXY_HOPS=1)

# Requisição de dentro da rede isolada, pelo Node da própria imagem (a rede não tem saída para o host).
probe() { # <contêiner>
  docker exec "$1" node -e "fetch('http://127.0.0.1:8080/health').then(r => console.log(r.status)).catch(() => console.log(0))"
}

for role in public worker; do
  name=$run_id-$role
  echo "== ROLE=$role"
  docker run -d --name "$name" "${hardened[@]}" -e ROLE="$role" "$image" >/dev/null
  for _ in {1..30}; do
    [[ $(probe "$name" 2>/dev/null || true) == 200 ]] && break
    sleep 2
  done
  expect "/health ($role)" 200 "$(probe "$name")"
  expect "processo sem root ($role)" 1000 "$(docker exec "$name" id -u)"
  expect "raiz só leitura ($role)" 1 "$(docker exec "$name" sh -c 'touch /app/x 2>/dev/null && echo 0 || echo 1')"
done

echo "== Configuração inválida"
output=$(docker run --rm "${hardened[@]}" "$image" 2>&1 || true)
expect "sem ROLE o processo não sobe e cita a variável" '.*ROLE: obrigatória e não definida.*' "$(tr '\n' ' ' <<<"$output")"

# Chave de produção com STRIPE_LIVE=false: o erro cita a variável e nunca o valor (gerado aqui, nunca literal).
fake_key="sk_live_$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
output=$(docker run --rm "${hardened[@]}" -e ROLE=public -e STRIPE_SECRET_KEY="$fake_key" "$image" 2>&1 || true)
expect "chave de produção com STRIPE_LIVE=false é recusada" '.*STRIPE_SECRET_KEY: chave de produção com STRIPE_LIVE=false.*' "$(tr '\n' ' ' <<<"$output")"
if [[ $output == *"$fake_key"* ]]; then
  expect "o valor da chave não aparece na mensagem" 0 1
else
  expect "o valor da chave não aparece na mensagem" 0 0
fi

if ((failures > 0)); then
  echo "--- log do serviço público"
  docker logs "$run_id-public" 2>&1 | tail -20
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "Imagem do plano de controle aprovada."
