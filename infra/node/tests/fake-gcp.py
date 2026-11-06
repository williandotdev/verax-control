#!/usr/bin/env python3
"""Servidor de metadados da VM, Secret Manager e release do GitHub falsos, para os testes do pacote do nó
(tests/start-test.sh e tests/boot-install-test.sh).

Uso: python3 fake-gcp.py <pasta de estado>

Escuta em 127.0.0.1, numa porta livre, e grava o número em <pasta>/port. Tudo fica em arquivos da pasta:

- attributes/<chave>: os metadados da instância (GET /computeMetadata/v1/instance/attributes/<chave>; sem o arquivo,
  404, como a GCP), entregues byte a byte;
- project-id: o projeto da VM (GET /computeMetadata/v1/project/project-id);
- guest-attributes/<espaço>/<chave>: os guest attributes que a VM grava (PUT) e apaga (DELETE) em
  /computeMetadata/v1/instance/guest-attributes/<espaço>/<chave>; guest-attributes.log tem uma linha por pedido
  (método, chave e valor: nenhum é segredo);
- secrets/<segredo>/<n>: o conteúdo de cada versão gravada (POST /v1/projects/<p>/secrets/<segredo>:addVersion), já
  decodificado do base64, como o Secret Manager guarda;
- fail/<segredo>: códigos HTTP a responder antes de aceitar, um por pedido (ex.: "503 429"): a falha que passa;
- deny/<segredo>: com o arquivo, todo pedido recebe 403 PERMISSION_DENIED (a VM sem permissão, ou o segredo que não
  existe);
- releases/<tag>/<arquivo>: os arquivos do release, como o GitHub os entrega: GET /releases/download/<tag>/<arquivo>
  redireciona (302) para /objects/<tag>/<arquivo>, que entrega o arquivo (sem ele, 404);
- checkip: o IP de saída que o "checkip" responde (GET /checkip; sem o arquivo, 404);
- requests.log: uma linha por pedido (método, caminho e os cabeçalhos que contam); nunca o corpo nem o token.

O servidor de metadados exige `Metadata-Flavor: Google` (sem ele, 403, como o de verdade), e o Secret Manager, o token
que o servidor de metadados entregou (sem ele, 401). O corpo do addVersion precisa ser exatamente
`{"payload": {"data": <base64>}}`.
"""

import base64
import binascii
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = "ya29.token-ficticio-do-teste-0123456789"
STATE = Path(sys.argv[1])
GUEST_ATTRIBUTE = re.compile(r"^/computeMetadata/v1/instance/guest-attributes/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)$")
RELEASE_FILE = re.compile(r"^/(releases/download|objects)/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)$")


def log(line):
    with (STATE / "requests.log").open("a", encoding="utf-8") as file:
        file.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, content_type="application/json"):
        self.reply_bytes(status, body.encode("utf-8"), content_type)

    def reply_bytes(self, status, data, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def google_error(self, status, name, message):
        # Em várias linhas, como o Google responde.
        body = json.dumps({"error": {"code": status, "message": message, "status": name}}, indent=2)
        self.reply(status, body)

    def do_GET(self):
        flavor = self.headers.get("Metadata-Flavor")
        log(f"GET {self.path} flavor={flavor}")
        # O release do GitHub e o "checkip" não são o servidor de metadados: nada de Metadata-Flavor.
        release = RELEASE_FILE.match(self.path)
        if release:
            kind, tag, name = release.groups()
            if kind == "releases/download":
                self.send_response(302)
                self.send_header("Location", f"/objects/{tag}/{name}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            path = STATE / "releases" / tag / name
            if path.is_file():
                self.reply_bytes(200, path.read_bytes(), "application/octet-stream")
            else:
                self.reply(404, "Not Found", "text/plain")
            return
        if self.path == "/checkip":
            path = STATE / "checkip"
            if path.is_file():
                self.reply_bytes(200, path.read_bytes(), "text/plain")
            else:
                self.reply(404, "Not Found", "text/plain")
            return
        if flavor != "Google":
            self.reply(403, "Missing Metadata-Flavor:Google header.", "text/plain")
            return
        prefix = "/computeMetadata/v1/instance/attributes/"
        if self.path == "/computeMetadata/v1/instance/service-accounts/default/token":
            self.reply(200, json.dumps({"access_token": TOKEN, "expires_in": 3599, "token_type": "Bearer"}))
        elif self.path == "/computeMetadata/v1/project/project-id":
            path = STATE / "project-id"
            if path.is_file():
                self.reply_bytes(200, path.read_bytes(), "application/text")
            else:
                self.reply(404, "Not Found", "text/html")
        elif self.path.startswith(prefix):
            path = STATE / "attributes" / self.path[len(prefix):]
            if path.is_file():
                self.reply_bytes(200, path.read_bytes(), "application/text")
            else:
                self.reply(404, "Not Found", "text/html")
        else:
            self.reply(404, "Not Found", "text/html")

    # Guest attributes: PUT grava, DELETE apaga (404 se não existe). Exigem Metadata-Flavor, como os outros.
    def guest_attribute(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        flavor = self.headers.get("Metadata-Flavor")
        log(f"{method} {self.path} flavor={flavor}")
        match = GUEST_ATTRIBUTE.match(self.path)
        if flavor != "Google" or not match:
            self.reply(403 if flavor != "Google" else 404, "Forbidden", "text/plain")
            return
        namespace, key = match.groups()
        path = STATE / "guest-attributes" / namespace / key
        with (STATE / "guest-attributes.log").open("a", encoding="utf-8") as file:
            file.write(f"{method} {namespace}/{key} {raw.decode('utf-8', 'replace')}\n")
        if method == "PUT":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            self.reply(200, "", "text/plain")
        elif path.is_file():
            path.unlink()
            self.reply(200, "", "text/plain")
        else:
            self.reply(404, "Not Found", "text/plain")

    def do_PUT(self):
        self.guest_attribute("PUT")

    def do_DELETE(self):
        self.guest_attribute("DELETE")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        authorized = self.headers.get("Authorization") == f"Bearer {TOKEN}"
        log(f"POST {self.path} authorized={authorized} content-type={self.headers.get('Content-Type')}")
        if not (self.path.startswith("/v1/projects/") and self.path.endswith(":addVersion")):
            self.reply(404, "Not Found", "text/html")
            return
        secret = self.path[: -len(":addVersion")].rsplit("/", 1)[-1]
        project = self.path.split("/")[3]
        if not authorized:
            self.google_error(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.")
            return
        deny = STATE / "deny" / secret
        if deny.exists():
            self.google_error(
                403,
                "PERMISSION_DENIED",
                f"Permission 'secretmanager.versions.add' denied for resource "
                f"'projects/{project}/secrets/{secret}' (or it may not exist).",
            )
            return
        fail = STATE / "fail" / secret
        if fail.exists():
            codes = fail.read_text(encoding="utf-8").split()
            if codes:
                fail.write_text(" ".join(codes[1:]), encoding="utf-8")
                self.google_error(int(codes[0]), "UNAVAILABLE", "falha simulada")
                return
        try:
            body = json.loads(raw)
            if set(body) != {"payload"} or set(body["payload"]) != {"data"}:
                raise ValueError("corpo fora do formato")
            data = base64.b64decode(body["payload"]["data"], validate=True)
        except (ValueError, KeyError, TypeError, binascii.Error):
            self.google_error(400, "INVALID_ARGUMENT", "Invalid JSON payload received.")
            return
        versions = STATE / "secrets" / secret
        versions.mkdir(parents=True, exist_ok=True)
        number = len(list(versions.iterdir())) + 1
        (versions / str(number)).write_bytes(data)
        self.reply(200, json.dumps({"name": f"projects/{project}/secrets/{secret}/versions/{number}", "state": "ENABLED"}))


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
(STATE / "port").write_text(str(server.server_address[1]), encoding="utf-8")
server.serve_forever()
