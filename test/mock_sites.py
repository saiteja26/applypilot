# Serves the mock job pages over HTTPS on 127.0.0.1:8443 and records every form submission.
import http.server, ssl, json, os, sys, urllib.parse
PAGES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pages")
LOG = sys.argv[1]
THANKS = b"<html><body><h1>Thank you for applying!</h1><p>Your application has been submitted.</p></body></html>"
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, body, ctype="text/html"):
        self.send_response(200); self.send_header("content-type", ctype); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        host = self.headers.get("host", "").split(":")[0]; path = urllib.parse.urlparse(self.path).path
        name = "greenhouse.html" if host.endswith("greenhouse.io") else "lever.html" if host == "jobs.lever.co" else "ashby.html" if host == "jobs.ashbyhq.com" else None
        if "hcaptcha" in host: return self.send(b"<div>captcha challenge</div>")
        if not name: self.send_response(404); self.end_headers(); return
        self.send(open(os.path.join(PAGES, name), "rb").read())
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); body = self.rfile.read(n)
        with open(LOG, "a") as f: f.write(json.dumps({"url": f"https://{self.headers.get('host')}{self.path}", "body": body.decode("latin1")}) + "\n")
        self.send(b"ok" if self.path.endswith("__record") else THANKS)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8443), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain("/tmp/mock.crt", "/tmp/mock.key")
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
