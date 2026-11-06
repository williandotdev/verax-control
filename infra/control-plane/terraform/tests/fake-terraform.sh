#!/bin/bash
# Terraform falso para tests/entrypoint-test.sh: grava cada chamada (subcomando e argumentos) e as variáveis TF_* que
# recebeu, e responde com os arquivos do cenário (FAKE_TERRAFORM_DIR): o plano em JSON, as saídas e, com
# `fail-<subcomando>`, uma falha com as linhas de erro que o Terraform de verdade mostra (inclusive o valor de uma
# variável, que o entrypoint não pode repassar ao log). Nada fala com rede nenhuma.
set -euo pipefail
dir=${FAKE_TERRAFORM_DIR:?}
[[ $1 == -chdir=* ]] || exit 64
shift
subcommand=$1
shift
printf '%s %s\n' "$subcommand" "$*" >>"$dir/calls"
if [[ -e $dir/fail-$subcommand ]]; then
  printf '%s\n' \
    '╷' \
    '│ Error: Invalid value for variable' \
    '│' \
    '│   on variables.tf line 12:' \
    "│   │ var.bootstrap_admin_email is \"${TF_VAR_bootstrap_admin_email-}\"" \
    '╵'
  exit 1
fi
case $subcommand in
  init)
    env | grep -E '^TF_' | sort >"$dir/env-init"
    echo 'Terraform has been successfully initialized!'
    ;;
  # O estado do cenário: um endereço por linha em `state` (CP-11: `state list` e `state rm` antes do destroy).
  state)
    case $1 in
      list) if [[ -e $dir/state ]]; then cat "$dir/state"; fi ;;
      rm)
        address=${*: -1}
        grep -vxF -- "$address" "$dir/state" >"$dir/state.new" || true
        mv "$dir/state.new" "$dir/state"
        printf 'Removed %s\n' "$address"
        ;;
      *) exit 64 ;;
    esac
    ;;
  plan)
    env | grep -E '^TF_' | sort >"$dir/env-plan"
    for arg in "$@"; do
      if [[ $arg == -out=* ]]; then printf 'plano binário' >"${arg#-out=}"; fi
    done
    # O plano mostra os metadados da VM: o e-mail e o nome do cliente aparecem aqui, e não podem ir para o log do Job.
    printf '  + metadata = { "verax-admin-email" = "%s", "verax-tenant-name" = "%s" }\n' \
      "${TF_VAR_bootstrap_admin_email-}" "${TF_VAR_bootstrap_tenant_name-}"
    ;;
  show)
    plan_file=${*: -1}
    [[ -s $plan_file ]] || exit 1
    cat "$dir/plan.json"
    ;;
  apply) printf 'Apply complete! %s\n' "${TF_VAR_bootstrap_tenant_name-}" ;;
  output) cat "$dir/outputs.json" ;;
  *) exit 64 ;;
esac
