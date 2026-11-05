#!/usr/bin/env bash
# Usuário da API do manager para o worker (fase 2, PR-V6): `verax_stats`, com um papel e uma política só dele, que dão
# apenas `manager:read` (a tarefa wazuh-usage lê os contadores do analysisd em GET /manager/daemons/stats). Roda no fim
# do `start.sh wazuh-up` do nó (com o manager no ar, antes do smoke test) e no ci-test.sh, e pode ser chamado sozinho,
# com as mesmas variáveis. Fala com o projeto do Compose em vigor (as variáveis COMPOSE_*, como o smoke-test.sh).
#
# Idempotente: cria o que falta e acerta o que mudou, sem duplicar nada.
# - a política `verax_stats_manager_read` ({manager:read, *:*:*, allow}), criada ou refeita se alguém a mudou;
# - o papel `verax_stats` só com essa política (outra política ligada a ele sai), sem regra de run_as;
# - o usuário `verax_stats` só com esse papel, sem run_as e com a senha de WAZUH_STATS_PASSWORD: a senha só é trocada
#   quando a atual não entra (uma troca derruba os tokens dele).
# No fim, confere como o worker vai usar: o verax_stats entra, lê os contadores do analysisd e é recusado fora do
# `manager:read` (o estado do cluster).
#
# Tudo pela API do manager com o wazuh-wui (o administrador que o init da imagem cria com API_PASSWORD), de dentro do
# contêiner do manager, pelo loopback e com o TLS conferido com a CA do nó e o nome wazuh.manager (o certificado que o
# manager-api-tls.sh instala). As duas senhas vão pela entrada padrão do Python do manager, nunca por argumento nem
# variável do contêiner; nada é impresso além do resumo e, num erro, do código HTTP e do código de erro do Wazuh.
set -euo pipefail

manager_exec() { # <comando...>, no contêiner do manager, com a entrada padrão
  docker compose exec -T wazuh.manager "$@"
}

# O programa vai por argumento (não tem segredo); as senhas, pela entrada padrão.
read -r -d '' PROGRAM <<'PY' || true
import base64, http.client, json, socket, ssl, sys, time

HOST, PORT, CA = 'wazuh.manager', 55000, '/etc/ssl/verax/root-ca.pem'
ADMIN, USER, ROLE, POLICY = 'wazuh-wui', 'verax_stats', 'verax_stats', 'verax_stats_manager_read'
RULES = {'actions': ['manager:read'], 'resources': ['*:*:*'], 'effect': 'allow'}


class Failure(Exception):
    pass


class Connection(http.client.HTTPSConnection):
    """O próprio manager pelo loopback, com o certificado conferido com a CA do nó e o nome wazuh.manager."""

    def connect(self):
        sock = socket.create_connection(('127.0.0.1', PORT), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=HOST)


context = ssl.create_default_context(cafile=CA)
context.minimum_version = ssl.TLSVersion.TLSv1_2


def auth_headers(token=None, credentials=None):
    headers = {}
    if token is not None:
        headers['Authorization'] = 'Bearer ' + token
    if credentials is not None:
        headers['Authorization'] = 'Basic ' + base64.b64encode(':'.join(credentials).encode()).decode()
    return headers


def send(method, path, token=None, credentials=None, body=None):
    headers = auth_headers(token, credentials)
    payload = None
    if body is not None:
        payload = json.dumps(body)
        headers['Content-Type'] = 'application/json'
    connection = Connection(HOST, PORT, context=context, timeout=30)
    try:
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        return response.status, response.read(1048576)
    finally:
        connection.close()


def login(user, password):
    status, raw = send('POST', '/security/user/authenticate?raw=true', credentials=(user, password))
    return raw.decode() if status == 200 else None


def call(token, method, path, body=None):
    status, raw = send(method, path, token=token, body=body)
    try:
        document = json.loads(raw)
    except ValueError:
        document = None
    code = document.get('error') if isinstance(document, dict) else None
    if status != 200 or code != 0:
        raise Failure('%s %s: HTTP %s, erro %s do Wazuh' % (method, path.split('?')[0], status, code))
    return document['data']


def find(token, path, field, value):
    for item in call(token, 'GET', path + '?limit=500')['affected_items']:
        if item.get(field) == value:
            return item
    return None


def same_policy(policy):
    def normal(rules):
        return (sorted(rules.get('actions') or []), sorted(rules.get('resources') or []), rules.get('effect'))

    return normal(policy) == normal(RULES)


def ids(values):
    return ','.join(str(value) for value in values)


def main():
    lines = sys.stdin.read().split('\n')
    if len(lines) < 2 or not lines[0] or not lines[1]:
        raise Failure('as duas senhas não chegaram pela entrada padrão')
    admin_password, stats_password = lines[0], lines[1]
    admin = login(ADMIN, admin_password)
    if admin is None:
        raise Failure('a API do manager recusou o login do wazuh-wui')
    changes = []

    policy = find(admin, '/security/policies', 'name', POLICY)
    if policy is None:
        policy = call(admin, 'POST', '/security/policies', {'name': POLICY, 'policy': RULES})['affected_items'][0]
        changes.append('política criada')
    elif not same_policy(policy['policy']):
        call(admin, 'PUT', '/security/policies/%s' % policy['id'], {'policy': RULES})
        changes.append('política refeita')

    role = find(admin, '/security/roles', 'name', ROLE)
    if role is None:
        role = call(admin, 'POST', '/security/roles', {'name': ROLE})['affected_items'][0]
        changes.append('papel criado')
    extra = [value for value in role.get('policies') or [] if value != policy['id']]
    if extra:
        call(admin, 'DELETE', '/security/roles/%s/policies?policy_ids=%s' % (role['id'], ids(extra)))
        changes.append('política a mais tirada do papel')
    if policy['id'] not in (role.get('policies') or []):
        call(admin, 'POST', '/security/roles/%s/policies?policy_ids=%s' % (role['id'], policy['id']))
        changes.append('política ligada ao papel')
    if role.get('rules'):
        call(admin, 'DELETE', '/security/roles/%s/rules?rule_ids=%s' % (role['id'], ids(role['rules'])))
        changes.append('regra de run_as tirada do papel')

    user = find(admin, '/security/users', 'username', USER)
    if user is None:
        user = call(admin, 'POST', '/security/users', {'username': USER, 'password': stats_password})['affected_items'][0]
        changes.append('usuário criado')
    elif login(USER, stats_password) is None:
        call(admin, 'PUT', '/security/users/%s' % user['id'], {'password': stats_password})
        changes.append('senha trocada')
    if user.get('allow_run_as'):
        call(admin, 'PUT', '/security/users/%s/run_as?allow_run_as=false' % user['id'])
        changes.append('run_as desligado')
    extra = [value for value in user.get('roles') or [] if value != role['id']]
    if extra:
        call(admin, 'DELETE', '/security/users/%s/roles?role_ids=%s' % (user['id'], ids(extra)))
        changes.append('papel a mais tirado do usuário')
    if role['id'] not in (user.get('roles') or []):
        call(admin, 'POST', '/security/users/%s/roles?role_ids=%s' % (user['id'], role['id']))
        changes.append('papel ligado ao usuário')

    # Uma mudança no usuário, no papel ou na política invalida os tokens emitidos até o segundo dela, inclusive (a API
    # guarda o instante em segundos e só aceita token emitido depois dele: wazuh/rbac/orm.py, is_token_valid). Um login
    # no mesmo segundo da última mudança entra, mas o token é recusado (401) em seguida: espera o segundo virar.
    if changes:
        time.sleep(1.5)

    # Como o worker vai usar: entra, lê os contadores do analysisd e não passa do manager:read.
    token = login(USER, stats_password)
    if token is None:
        raise Failure('o verax_stats não entrou com a senha de agora')
    status, _ = send('GET', '/manager/daemons/stats?daemons_list=wazuh-analysisd', token=token)
    if status != 200:
        raise Failure('o verax_stats não leu os contadores do analysisd (HTTP %s)' % status)
    status, _ = send('GET', '/cluster/status', token=token)
    if status != 403:
        raise Failure('o verax_stats lê fora do manager:read (HTTP %s no estado do cluster)' % status)
    print('init-api-users: verax_stats só com manager:read (%s).' % ('; '.join(changes) or 'nada mudou'))


try:
    main()
except Failure as error:
    sys.stderr.write('init-api-users: %s\n' % error)
    sys.exit(1)
except (OSError, http.client.HTTPException) as error:
    # Rede ou TLS (ssl.SSLError é um OSError): só o tipo do erro.
    sys.stderr.write('init-api-users: falha de conexão ou de TLS com a API do manager (%s)\n' % type(error).__name__)
    sys.exit(1)
except (KeyError, IndexError, TypeError):
    sys.stderr.write('init-api-users: resposta da API do manager fora do formato esperado\n')
    sys.exit(1)
PY

main() {
  : "${WAZUH_API_PASSWORD:?defina WAZUH_API_PASSWORD (wazuh-wui)}"
  : "${WAZUH_STATS_PASSWORD:?defina WAZUH_STATS_PASSWORD (verax_stats)}"
  if [[ $WAZUH_API_PASSWORD == *$'\n'* || $WAZUH_STATS_PASSWORD == *$'\n'* ]]; then
    echo 'init-api-users: senha com quebra de linha.' >&2
    return 1
  fi
  printf '%s\n%s\n' "$WAZUH_API_PASSWORD" "$WAZUH_STATS_PASSWORD" |
    manager_exec /var/ossec/framework/python/bin/python3 -c "$PROGRAM"
}

main
