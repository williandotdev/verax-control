"""Servidor de metadados e Cloud Storage falsos para tests/entrypoint-test.sh, em HTTP no 127.0.0.1.

- GET /token: o token da conta do Job (só com `Metadata-Flavor: Google`), o conteúdo de <pasta>/token;
- POST /upload/storage/v1/b/<bucket>/o?uploadType=media&name=<objeto>: grava o corpo em <pasta>/uploads/ (o nome do
  objeto com `/` trocado por `__`) e cada pedido (caminho, nome, cabeçalho de autorização) em <pasta>/requests.jsonl;
  com <pasta>/fail-upload, responde 500.

Uso: python3 -I fake-gcp.py <pasta>. Escreve a porta em <pasta>/port.
"""

import json
import pathlib
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = pathlib.Path(sys.argv[1])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D401 - sem log no stderr do teste
        return

    def record(self, entry):
        with (STATE / "requests.jsonl").open("a", encoding="utf-8") as out:
            out.write(json.dumps(entry) + "\n")

    def reply(self, status, body=b"", content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        self.record({"method": "GET", "path": url.path, "flavor": self.headers.get("Metadata-Flavor")})
        if url.path != "/token" or self.headers.get("Metadata-Flavor") != "Google":
            self.reply(404)
            return
        token = (STATE / "token").read_text(encoding="utf-8").strip()
        self.reply(200, json.dumps({"access_token": token, "expires_in": 3599, "token_type": "Bearer"}).encode())

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        name = query.get("name", [""])[0]
        self.record(
            {
                "method": "POST",
                "path": url.path,
                "uploadType": query.get("uploadType", [""])[0],
                "name": name,
                "authorization": self.headers.get("Authorization"),
                "contentType": self.headers.get("Content-Type"),
            }
        )
        if (STATE / "fail-upload").exists():
            self.reply(500, b'{"error": {"status": "INTERNAL"}}')
            return
        if not url.path.startswith("/upload/storage/v1/b/") or not url.path.endswith("/o"):
            self.reply(404)
            return
        uploads = STATE / "uploads"
        uploads.mkdir(exist_ok=True)
        (uploads / name.replace("/", "__")).write_bytes(body)
        self.reply(200, json.dumps({"name": name}).encode())


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
(STATE / "port").write_text(str(server.server_address[1]), encoding="utf-8")
server.serve_forever()
