"""Servidor de metadados e APIs do Google falsos para tests/entrypoint-test.sh, em HTTP no 127.0.0.1.

- GET /token: o token da conta do Job (só com `Metadata-Flavor: Google`), o conteúdo de <pasta>/token;
- POST /upload/storage/v1/b/<bucket>/o?uploadType=media&name=<objeto>: grava o corpo em <pasta>/uploads/ (o nome do
  objeto com `/` trocado por `__`); com <pasta>/fail-upload, responde 500;
- a Exclusão 1 e a 2 (CP-11), sobre o estado em <pasta>/cloud.json (relido e regravado a cada pedido):
  - Compute: POST .../instances/<vm>/setDeletionProtection, GET .../instances/<vm>, GET e DELETE .../disks/<disco>,
    GET .../global/snapshots (paginado por `pageSize`), DELETE .../global/snapshots/<nome>, DELETE
    .../regions/<região>/addresses/<nome>;
  - Secret Manager: DELETE /secretmanager/v1/projects/<p>/secrets/<cofre>;
  - Cloud Storage: DELETE /storage/v1/b/<bucket> (409 com objetos dentro) e DELETE /storage/v1/b/<bucket>/o/<objeto>;
  - com <pasta>/fail-api (JSON `{"method", "contains", "status"}`), o pedido que casar recebe esse status.
Cada pedido (método, caminho, query e o cabeçalho de autorização) vai para <pasta>/requests.jsonl.

Uso: python3 -I fake-gcp.py <pasta>. Escreve a porta em <pasta>/port.
"""

import json
import pathlib
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = pathlib.Path(sys.argv[1])


def load():
    path = STATE / "cloud.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save(cloud):
    (STATE / "cloud.json").write_text(json.dumps(cloud), encoding="utf-8")


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
        if url.path.startswith(("/compute/", "/storage/", "/secretmanager/")):
            self.api("GET", url)
            return
        self.record({"method": "GET", "path": url.path, "flavor": self.headers.get("Metadata-Flavor")})
        if url.path != "/token" or self.headers.get("Metadata-Flavor") != "Google":
            self.reply(404)
            return
        token = (STATE / "token").read_text(encoding="utf-8").strip()
        self.reply(200, json.dumps({"access_token": token, "expires_in": 3599, "token_type": "Bearer"}).encode())

    def do_DELETE(self):
        self.api("DELETE", urllib.parse.urlsplit(self.path))

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path.startswith("/compute/"):
            self.api("POST", url)
            return
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

    def api(self, method, url):
        self.record(
            {
                "method": method,
                "path": url.path,
                "query": url.query,
                "authorization": self.headers.get("Authorization"),
            }
        )
        fail = STATE / "fail-api"
        if fail.exists():
            rule = json.loads(fail.read_text(encoding="utf-8"))
            if rule["method"] == method and rule["contains"] in url.path:
                self.reply(rule["status"], b'{"error": {"status": "SIMULATED"}}')
                return
        cloud = load()
        status, value = route(cloud, method, url)
        save(cloud)
        self.reply(status, b"" if status == 204 else json.dumps(value if value is not None else {}).encode())


def take(collection, key):
    if key in collection:
        collection.remove(key)
        return True
    return False


def route(cloud, method, url):
    path = urllib.parse.unquote(url.path)
    query = urllib.parse.parse_qs(url.query)
    match = re.fullmatch(r"/compute/v1/projects/[^/]+/zones/[^/]+/instances/([^/]+)(/setDeletionProtection)?", path)
    if match:
        instance = cloud.setdefault("instances", {}).get(match.group(1))
        if instance is None:
            return 404, None
        if method == "POST" and match.group(2):
            instance["deletionProtection"] = query.get("deletionProtection", ["true"])[0] == "true"
            return 200, {"name": "operation-1"}
        return 200, {"name": match.group(1), "deletionProtection": instance["deletionProtection"]}
    match = re.fullmatch(r"/compute/v1/projects/[^/]+/zones/[^/]+/disks/([^/]+)", path)
    if match:
        disks = cloud.setdefault("disks", [])
        if method == "DELETE":
            if match.group(1) in disks and cloud.get("diskInUse"):
                return 400, {"error": {"status": "RESOURCE_IN_USE_BY_ANOTHER_RESOURCE"}}
            return (200, {"name": "operation-2"}) if take(disks, match.group(1)) else (404, None)
        return (200, {"name": match.group(1)}) if match.group(1) in disks else (404, None)
    if re.fullmatch(r"/compute/v1/projects/[^/]+/global/snapshots", path) and method == "GET":
        snapshots = cloud.setdefault("snapshots", [])
        size = int(cloud.get("pageSize", 500))
        start = int(query.get("pageToken", ["p0"])[0][1:])
        page = snapshots[start : start + size]
        value = {"items": page} if page else {}
        if start + size < len(snapshots):
            value["nextPageToken"] = f"p{start + size}"
        return 200, value
    match = re.fullmatch(r"/compute/v1/projects/[^/]+/global/snapshots/([^/]+)", path)
    if match and method == "DELETE":
        snapshots = cloud.setdefault("snapshots", [])
        kept = [s for s in snapshots if s["name"] != match.group(1)]
        cloud["snapshots"] = kept
        return (200, {"name": "operation-3"}) if len(kept) < len(snapshots) else (404, None)
    match = re.fullmatch(r"/compute/v1/projects/[^/]+/regions/[^/]+/addresses/([^/]+)", path)
    if match and method == "DELETE":
        found = take(cloud.setdefault("addresses", []), match.group(1))
        return (200, {"name": "operation-4"}) if found else (404, None)
    match = re.fullmatch(r"/secretmanager/v1/projects/[^/]+/secrets/([^/]+)", path)
    if match and method == "DELETE":
        return (200, {}) if take(cloud.setdefault("secrets", []), match.group(1)) else (404, None)
    match = re.fullmatch(r"/storage/v1/b/([^/]+)/o/(.+)", path)
    if match and method == "DELETE":
        return (204, None) if take(cloud.setdefault("objects", []), match.group(2)) else (404, None)
    match = re.fullmatch(r"/storage/v1/b/([^/]+)", path)
    if match and method == "DELETE":
        buckets = cloud.setdefault("buckets", {})
        bucket = buckets.get(match.group(1))
        if bucket is None:
            return 404, None
        if bucket.get("objects", 0) > 0:
            return 409, {"error": {"status": "CONFLICT"}}
        del buckets[match.group(1)]
        return 204, None
    return 404, None


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
(STATE / "port").write_text(str(server.server_address[1]), encoding="utf-8")
server.serve_forever()
