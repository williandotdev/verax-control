#!/usr/bin/env bash
# Emulador oficial do Firestore para os testes de integração do plano de controle, no CI e na máquina de
# desenvolvimento. Imagem fixada por digest (o mesmo do plano da fase 3, conferido no registro em 04/11/2026).
#
# Uso: scripts/firestore-emulator.sh start|stop|status
#      FIRESTORE_EMULATOR_HOST=127.0.0.1:8681 pnpm --filter @verax/control-plane test
# A porta vem de FIRESTORE_EMULATOR_PORT (padrão 8681) e só é exposta na interface local.
set -euo pipefail

image=gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators@sha256:c3b114528245d315af73d92d95d8e2fed9747ce29003ad46232f22b4542da036
name=${FIRESTORE_EMULATOR_CONTAINER:-verax-cp-firestore-emulator}
port=${FIRESTORE_EMULATOR_PORT:-8681}

case ${1:-} in
  start)
    if docker ps --format '{{.Names}}' | grep -qx "$name"; then
      echo "emulador já no ar em 127.0.0.1:$port ($name)"
      exit 0
    fi
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" -p "127.0.0.1:$port:$port" "$image" \
      gcloud emulators firestore start --host-port="0.0.0.0:$port" --database-mode=firestore-native >/dev/null
    for _ in $(seq 1 60); do
      if curl -fs "http://127.0.0.1:$port/" >/dev/null 2>&1; then
        echo "emulador do Firestore no ar: FIRESTORE_EMULATOR_HOST=127.0.0.1:$port"
        exit 0
      fi
      sleep 1
    done
    echo "o emulador não respondeu em 60 s" >&2
    docker logs "$name" >&2 || true
    exit 1
    ;;
  stop)
    docker rm -f "$name" >/dev/null 2>&1 || true
    echo "emulador parado"
    ;;
  status)
    docker ps --filter "name=^$name$" --format '{{.Names}} {{.Status}}'
    ;;
  *)
    echo "uso: $0 start|stop|status" >&2
    exit 2
    ;;
esac
