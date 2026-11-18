# End-to-end test: real Chrome + the extension + the local server (mock AI), with mock
# Greenhouse / Lever / Ashby pages served at their real addresses through Playwright routing.
import json, os, subprocess, sys, time, shutil, urllib.request, urllib.parse
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = os.path.join(ROOT, "test", "pages")
PORT = int(os.environ.get("AP_E2E_PORT", "8787"))
API = f"http://127.0.0.1:{PORT}"
CHROME = os.environ.get("AP_E2E_CHROME") or shutil.which("google-chrome") or shutil.which("chrome")
DATA = "/tmp/ap-e2e"
shutil.rmtree(DATA, ignore_errors=True); os.makedirs(DATA)
TOKEN = "ap_" + "t" * 30
now = int(time.time() * 1000)
LEVER_ID = "11111111-1111-1111-1111-111111111111"
ASHBY_ID = "22222222-2222-2222-2222-222222222222"
def job(i, ats, url, company, posted):
    return {"id": f"{ats}-test-{i}", "ats": ats, "slug": "test", "externalId": str(i), "company": company, "title": "Product Designer", "location": "Remote", "url": url,
            "description": "Design delightful products.", "status": "queued", "source": "discovery", "attempts": 0, "createdAt": now + i, "updatedAt": now, "postedAt": posted}
db = {"token": TOKEN, "settings": {"dailyLimit": 10, "autoDiscover": False},
      "profile": {"firstName": "Jordan", "lastName": "Rivera", "email": "jordan@example.com", "phone": "555-201-3344", "city": "Chicago", "state": "IL", "country": "United States", "salaryExpectation": "Flexible", "noncompeteStatus": "no", "recruiterSmsConsent": "ask", "recruitmentMarketingConsent": "ask", "linkedin": "https://linkedin.com/in/jordanr", "visaStatus": "U.S. citizen", "workAuthorized": "yes", "sponsorNow": "no", "sponsorFuture": "no", "usPerson": "yes",
                  "skills": "Figma, Prototyping", "experience": [{"title": "Product Designer", "company": "Acme", "start": "2022", "current": True, "bullets": "Shipped onboarding redesign"}]},
      "jobs": {j["id"]: j for j in [
          job(1, "greenhouse", "https://job-boards.greenhouse.io/test/jobs/1", "Testco", "2026-11-17"),
          job(2, "lever", f"https://jobs.lever.co/test/{LEVER_ID}/apply", "Leverco", "2026-11-16"),
          job(3, "ashby", f"https://jobs.ashbyhq.com/test/{ASHBY_ID}/application", "Ashbyco", "2026-11-15"),
          job(4, "greenhouse", "https://job-boards.greenhouse.io/test/jobs/2?captcha=1", "Captchaco", "2026-11-14"),
      ]}}
json.dump(db, open(f"{DATA}/db.json", "w"))

env = {**os.environ, "APPLYPILOT_DATA": DATA, "APPLYPILOT_MOCK_AI": "1", "PORT": str(PORT)}
srv = subprocess.Popen(["node", os.path.join(ROOT, "server", "server.js")], env=env, stdout=open("/tmp/ap-e2e.log", "w"), stderr=subprocess.STDOUT)
time.sleep(2.5)

def jobs():
    req = urllib.request.Request(f"{API}/api/jobs", headers={"x-applypilot-token": TOKEN})
    return {j["id"]: j for j in json.load(urllib.request.urlopen(req))}
def detail(i):
    req = urllib.request.Request(f"{API}/api/jobs/{i}", headers={"x-applypilot-token": TOKEN})
    return json.load(urllib.request.urlopen(req))

recorded = []
def page_html(name): return open(os.path.join(PAGES, name)).read()
THANKS = "<html><body><h1>Thank you for applying!</h1><p>Your application has been submitted.</p></body></html>"

def handler(route, request):
    u = urllib.parse.urlparse(request.url)
    host, path = u.hostname, u.path
    if request.method == "POST":
        body = request.post_data_buffer or b""
        recorded.append({"url": request.url, "bytes": len(body), "text": body.decode("latin1")})
        if path.endswith("/__record"): return route.fulfill(status=200, body="ok")
        return route.fulfill(status=200, content_type="text/html", body=THANKS)
    if host.endswith("greenhouse.io") and "/jobs/" in path: return route.fulfill(status=200, content_type="text/html", body=page_html("greenhouse.html"))
    if host == "jobs.lever.co" and path.endswith("/apply"): return route.fulfill(status=200, content_type="text/html", body=page_html("lever.html"))
    if host == "jobs.ashbyhq.com": return route.fulfill(status=200, content_type="text/html", body=page_html("ashby.html"))
    if "hcaptcha" in host: return route.fulfill(status=200, content_type="text/html", body="<div>captcha</div>")
    return route.fulfill(status=404, body="nope")

SUBS = "/tmp/ap-e2e-subs.jsonl"
open(SUBS, "w").close()
mock = subprocess.Popen([sys.executable, "-I", os.path.join(ROOT, "test", "mock_sites.py"), SUBS])
time.sleep(1)
# Test copy of the extension that may also run a script in a tab (to play "you" pressing Submit).
ext = "/tmp/ap-e2e-ext"
shutil.rmtree(ext, ignore_errors=True); shutil.copytree(os.path.join(ROOT, "extension"), ext)
config_file = os.path.join(ext, "config.js")
with open(config_file) as f: config = f.read()
with open(config_file, "w") as f: f.write(config.replace(":8787", f":{PORT}"))
man = json.load(open(f"{ext}/manifest.json")); man["permissions"].append("scripting")
man["host_permissions"] = [h.replace(":8787/", f":{PORT}/") for h in man["host_permissions"]]
json.dump(man, open(f"{ext}/manifest.json", "w"))
ok = True
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context("/tmp/ap-e2e-profile", executable_path=CHROME or p.chromium.executable_path, headless=True, ignore_default_args=["--disable-extensions"],
        args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}", "--headless=new", "--no-first-run", "--no-proxy-server", "--ignore-certificate-errors", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
              "--host-resolver-rules=MAP job-boards.greenhouse.io 127.0.0.1:8443, MAP jobs.lever.co 127.0.0.1:8443, MAP jobs.ashbyhq.com 127.0.0.1:8443, MAP newassets.hcaptcha.com 127.0.0.1:8443"])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=10000)
    sw.evaluate(f"chrome.storage.local.set({{ap_token: '{TOKEN}'}})")
    sw.evaluate("start()")
    t0 = time.time()
    solved = False
    while time.time() - t0 < 150:
        js = jobs()
        st = {k: v["status"] for k, v in js.items()}
        cap = js["greenhouse-test-4"]
        if cap["status"] == "needs_you" and not solved:
            # The person "solves the captcha" and presses Submit in the Needs you window.
            tab = sw.evaluate("chrome.storage.local.get('ap_run').then(r => r.ap_run.waiting?.[0]?.tabId)")
            if tab:
                time.sleep(2)
                sw.evaluate(f"chrome.scripting.executeScript({{target: {{tabId: {tab}}}, world: 'MAIN', func: () => document.querySelector('button[type=submit]').click()}})")
                print("simulated: person solved the captcha and pressed Submit in tab", tab)
                solved = True
        if all(s in ("submitted", "failed", "skipped") for s in st.values()): break
        time.sleep(1.5)
    print("FINAL STATUSES:", json.dumps({k: v["status"] for k, v in jobs().items()}, indent=1))
    for k in jobs():
        d = detail(k)
        print(f"\n== {k}: {d['status']} | {d.get('reason','')[:200]}")
        for a in d.get("answers", []) or []: print(f"   {a['question'][:70]!r} -> {str(a['answer'])[:70]!r}")
        if d.get("log"): print("   log:", d["log"])
    print("\nRECORDED SUBMISSIONS:")
    submissions = [json.loads(l) for l in open(SUBS) if l.strip()]
    for r in submissions:
        import re
        fields = re.findall(r'name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r]+\r\n)?\r\n([^\r]*)', r["body"])
        print(" ", r["url"], {f[0]: (f[1] or f[2])[:50] for f in fields} if fields else r["body"][:300])
    final_jobs = jobs()
    for job_id in ["greenhouse-test-1", "lever-test-2", "ashby-test-3"]:
        assert final_jobs[job_id]["status"] == "submitted", f"{job_id} did not submit: {final_jobs[job_id].get('reason', '')}"
    greenhouse_post = next(r["body"] for r in submissions if "job-boards.greenhouse.io" in r["url"])
    lever_post = next(r["body"] for r in submissions if "jobs.lever.co" in r["url"])
    assert 'name="first_name"\r\n' in greenhouse_post and "Jordan" in greenhouse_post
    assert 'name="email"\r\n' in greenhouse_post and "jordan@example.com" in greenhouse_post
    assert 'name="country"\r\n' in greenhouse_post and "United States +1" in greenhouse_post
    assert 'name="phone"\r\n' in greenhouse_post and "555-201-3344" in greenhouse_post
    assert 'name="location"\r\n' in greenhouse_post and "Chicago, Illinois, United States" in greenhouse_post
    assert 'name="resume"; filename=' in greenhouse_post
    assert 'name="resume"; filename="Jordan_Rivera_Resume.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-' in greenhouse_post
    greenhouse_answers = detail("greenhouse-test-1").get("answers", [])
    assert sum(a["question"] == "First Name*" for a in greenhouse_answers) == 1
    assert 'name="name"\r\n' in lever_post and "Jordan Rivera" in lever_post
    assert 'name="email"\r\n' in lever_post and "jordan@example.com" in lever_post
    assert 'name="resume"; filename=' in lever_post
    assert 'name="cards[abc][field0]"\r\n\r\nNo\r\n' in lever_post
    run = sw.evaluate("chrome.storage.local.get('ap_run').then(r => r.ap_run)")
    print("\nRUN STATE:", json.dumps({k: run.get(k) for k in ["running", "message", "waiting"]}, default=str)[:600])
    ctx.close()
srv.terminate(); mock.terminate()
print("\nSERVER LOG:\n" + open("/tmp/ap-e2e.log").read()[-1500:])
