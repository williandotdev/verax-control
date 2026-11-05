#!/usr/bin/env python3
"""Servidor de metadados da VM e Secret Manager falsos, para os testes do pacote do nó (tests/start-test.sh).

Uso: python3 fake-gcp.py <pasta de estado>

Escuta em 127.0.0.1, numa porta livre, e grava o número em <pasta>/port. Tudo fica em arquivos da pasta:

- attributes/<chave>: os metadados da instância (GET /computeMetadata/v1/instance/attributes/<chave>; sem o arquivo,
  404, como a GCP);
- secrets/<segredo>/<n>: o conteúdo de cada versão gravada (POST /v1/projects/<p>/secrets/<segredo>:addVersion), já
  decodificado do base64, como o Secret Manager guarda;
- fail/<segredo>: códigos HTTP a responder antes de aceitar, um por pedido (ex.: "503 429"): a falha que passa;
- deny/<segredo>: com o arquivo, todo pedido recebe 403 PERMISSION_DENIED (a VM sem permissão, ou o segredo que não
  existe);
- requests.log: uma linha por pedido (método, caminho e os cabeçalhos que contam); nunca o corpo nem o token.

O servidor de metadados exige `Metadata-Flavor: Google` (sem ele, 403, como o de verdade), e o Secret Manager, o token
que o servidor de metadados entregou (sem ele, 401). O corpo do addVersion precisa ser exatamente
`{"payload": {"data": <base64>}}`.
"""

import base64
import binascii
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = "ya29.token-ficticio-do-teste-0123456789"
STATE = Path(sys.argv[1])


def log(line):
    with (STATE / "requests.log").open("a", encoding="utf-8") as file:
        file.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, content_type="application/json"):
        data = body.encode("utf-8")
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
        if flavor != "Google":
            self.reply(403, "Missing Metadata-Flavor:Google header.", "text/plain")
            return
        prefix = "/computeMetadata/v1/instance/attributes/"
        if self.path == "/computeMetadata/v1/instance/service-accounts/default/token":
            self.reply(200, json.dumps({"access_token": TOKEN, "expires_in": 3599, "token_type": "Bearer"}))
        elif self.path.startswith(prefix):
            path = STATE / "attributes" / self.path[len(prefix):]
            if path.is_file():
                self.reply(200, path.read_text(encoding="utf-8"), "application/text")
            else:
                self.reply(404, "Not Found", "text/html")
        else:
            self.reply(404, "Not Found", "text/html")

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
