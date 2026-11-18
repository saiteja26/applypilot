// ApplyPilot local server. Run: node server/server.js   (Node 20+; no npm install needed)
// Dashboard: http://localhost:8787  -  the extension talks to /api/ext/* with your token.
const http = require("http");
const fs = require("fs");
const path = require("path");
const store = require("./lib/store");
const ai = require("./lib/ai");
const { discover, addByUrl, buildQueries } = require("./lib/discover");

const PORT = +(process.env.PORT || 8787);
const HOST = "127.0.0.1";
const PUBLIC = path.join(__dirname, "public");
const STALE_MS = 30 * 60 * 1000;
const DISCOVER_EVERY_MS = 60 * 60 * 1000;

const db = store.load();
const tailoring = new Map(); // jobId -> promise

// ---------------- helpers ----------------
const send = (res, code, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, { "content-type": isBuf ? "application/octet-stream" : "application/json", "cache-control": "no-store", ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
};
const fail = (res, code, error) => send(res, code, { error });
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) { size += c.length; if (size > 15e6) throw Object.assign(new Error("Too large"), { status: 413 }); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("Bad JSON"), { status: 400 }); }
}
const dayKey = (t) => new Date(t).toLocaleDateString("en-CA");
const today = () => dayKey(Date.now());
const jobs = () => Object.values(db.jobs);
const summary = (j) => ({ id: j.id, ats: j.ats, company: j.company, title: j.title, location: j.location, url: j.url, status: j.status, reason: j.reason, source: j.source, fit: j.fit || null, createdAt: j.createdAt, updatedAt: j.updatedAt, finishedAt: j.finishedAt, hasFiles: j.files?.status === "ready" });

function stats() {
  const all = jobs();
  const by = {};
  for (const j of all) by[j.status] = (by[j.status] || 0) + 1;
  const t = today();
  return { byStatus: by, total: all.length, attemptsToday: all.filter((j) => j.claimedAt && dayKey(j.claimedAt) === t).length, submittedToday: all.filter((j) => j.status === "submitted" && j.finishedAt && dayKey(j.finishedAt) === t).length };
}

function update(job, patch) { Object.assign(job, patch, { updatedAt: Date.now() }); store.saveSoon(); }

/** Jobs stuck in "applying" (Chrome closed, crash) go back in line, or fail after 3 tries. */
function cleanupStale() {
  for (const j of jobs()) {
    if (j.status === "applying" && Date.now() - (j.claimedAt || 0) > STALE_MS) {
      update(j, j.attempts >= 3 ? { status: "failed", reason: "Stopped mid-way three times." } : { status: "queued", reason: "Put back in line: it stopped mid-way." });
    }
  }
}

function startTailoring(job) {
  update(job, { files: { status: "pending" } });
  const p = ai.tailor(job)
    .then((f) => update(job, { files: { status: "ready", ...f } }))
    .catch((e) => { update(job, { files: { status: "failed", error: e.message } }); store.event("tailor", e.message, {}, job.id); })
    .finally(() => tailoring.delete(job.id));
  tailoring.set(job.id, p);
  return p;
}

// ---------------- extension API ----------------
async function extApi(req, res, url, body) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case "GET /api/ext/me": {
      const p = db.profile;
      const s = stats();
      return send(res, 200, { ok: true, name: `${p.firstName} ${p.lastName}`.trim(), email: p.email, missing: ai.profileReady(p), hasKey: !!process.env.ANTHROPIC_API_KEY || process.env.APPLYPILOT_MOCK_AI === "1", today: s.attemptsToday, submittedToday: s.submittedToday, limit: +db.settings.dailyLimit || 0, queued: s.byStatus.queued || 0, lastDiscovery: db.meta.lastDiscovery || null });
    }
    case "POST /api/ext/next": {
      cleanupStale();
      const missing = ai.profileReady(db.profile);
      if (missing.length) return send(res, 200, { none: true, stop: true, reason: `Finish your profile first (missing: ${missing.join(", ")}).` });
      if (!process.env.ANTHROPIC_API_KEY && process.env.APPLYPILOT_MOCK_AI !== "1") return send(res, 200, { none: true, stop: true, reason: "Set ANTHROPIC_API_KEY in the server environment and restart the server." });
      const limit = +db.settings.dailyLimit || 0;
      if (limit && stats().attemptsToday >= limit) return send(res, 200, { none: true, stop: true, reason: `Reached today's limit of ${limit} applications. Raise it in Settings or start again tomorrow.` });
      const queue = jobs().filter((j) => j.status === "queued").sort((a, b) => (b.source === "manual") - (a.source === "manual") || (b.fit?.score || 0) - (a.fit?.score || 0) || String(b.postedAt || "").localeCompare(String(a.postedAt || "")) || a.createdAt - b.createdAt);
      const job = queue[0];
      if (!job) {
        const last = db.meta.lastDiscovery?.at || 0;
        if (db.settings.autoDiscover && Date.now() - last > DISCOVER_EVERY_MS) {
          discover().catch((e) => store.event("discover", e.message));
          return send(res, 200, { none: true, reason: "Queue is empty. Searching your job boards now...", retryIn: 45 });
        }
        const mins = Math.max(1, Math.ceil((last + DISCOVER_EVERY_MS - Date.now()) / 60000));
        return send(res, 200, { none: true, reason: db.settings.autoDiscover ? `No matching jobs right now. Next search in about ${mins} min.` : "No jobs in the queue. Run a search on the dashboard.", retryIn: db.settings.autoDiscover ? Math.min(mins * 60, 900) : 300 });
      }
      update(job, { status: "applying", claimedAt: Date.now(), attempts: (job.attempts || 0) + 1, reason: "" });
      startTailoring(job);
      return send(res, 200, { application: { id: job.id, ats: job.ats, url: job.url, company: job.company, title: job.title } });
    }
    case "POST /api/ext/answers": {
      const job = db.jobs[body.application_id];
      if (!job) return fail(res, 404, "Unknown application");
      const qs = Array.isArray(body.questions) ? body.questions.slice(0, 120) : [];
      // A "cover letter" text box needs the finished letter: wait for it (briefly).
      if (qs.some((q) => q.type === "textarea" && /^cover letter/i.test(q.label || "")) && tailoring.has(job.id)) {
        await Promise.race([tailoring.get(job.id), new Promise((r) => setTimeout(r, 120000))]);
      }
      try {
        const out = await ai.answerQuestions(job, qs);
        return send(res, 200, out);
      } catch (e) {
        store.event("answers", e.message, {}, job.id);
        return fail(res, e.status || 502, e.message);
      }
    }
    case "GET /api/ext/file": {
      const job = db.jobs[url.searchParams.get("app")];
      const kind = url.searchParams.get("kind") === "cover" ? "cover" : "resume";
      if (!job) return fail(res, 404, "Unknown application");
      if (!job.files || job.files.status === "pending") return fail(res, 425, "Still writing your documents");
      if (job.files.status === "failed") return fail(res, 410, `Couldn't write the documents: ${job.files.error}`);
      const file = store.filePath(job.id, kind);
      if (!fs.existsSync(file)) return fail(res, 410, "File missing");
      return send(res, 200, fs.readFileSync(file), { "content-type": "application/pdf", "content-disposition": `attachment; filename="${job.files[kind]}"` });
    }
    case "POST /api/ext/report": {
      const job = db.jobs[body.application_id];
      if (!job) return fail(res, 404, "Unknown application");
      const status = String(body.status || "");
      if (!["submitted", "skipped", "failed", "needs_you", "abandoned"].includes(status)) return fail(res, 400, "Bad status");
      // A submitted job never goes back to anything else.
      if (job.status === "submitted" && status !== "submitted") return send(res, 200, { ok: true, ignored: true });
      const patch = { reason: String(body.reason || "").slice(0, 2000) };
      if (Array.isArray(body.answers) && body.answers.length) patch.answers = body.answers.slice(0, 200);
      if (body.confirmation_text) patch.confirmation = { text: String(body.confirmation_text).slice(0, 3000), url: String(body.confirmation_url || "") };
      if (Array.isArray(body.log)) patch.log = body.log.slice(0, 100);
      if (status === "abandoned") Object.assign(patch, job.attempts >= 3 ? { status: "failed", reason: `${patch.reason} (third try)` } : { status: "queued" });
      else Object.assign(patch, { status, finishedAt: Date.now() });
      update(job, patch);
      return send(res, 200, { ok: true });
    }
    case "POST /api/ext/event": {
      store.event(String(body.kind || "ext"), body.message || "", body.data || {}, body.application_id || null);
      return send(res, 200, { ok: true });
    }
  }
  return fail(res, 404, "Not found");
}

// ---------------- dashboard API ----------------
async function aiRoute(res, fn) {
  try { return send(res, 200, await fn()); }
  catch (e) { store.event("ai", e.message); return fail(res, e.status || 502, e.message); }
}

async function dashApi(req, res, url, body) {
  const route = `${req.method} ${url.pathname}`;
  let m;
  if (route === "GET /api/state") {
    const settings = { ...db.settings, hasKey: !!process.env.ANTHROPIC_API_KEY || process.env.APPLYPILOT_MOCK_AI === "1", envKey: !!process.env.ANTHROPIC_API_KEY, hasSearchKey: !!process.env.APPLYPILOT_SEARCH_KEY };
    return send(res, 200, { profile: db.profile, settings, queries: buildQueries(db.settings), token: db.token, stats: stats(), lastDiscovery: db.meta.lastDiscovery || null, tokens: db.meta.tokens || null, missing: ai.profileReady(db.profile), events: db.events.slice(0, 30) });
  }
  if (route === "PUT /api/profile") {
    // Each page sends only its own fields; everything else is kept.
    const p = { ...store.EMPTY_PROFILE, ...db.profile };
    for (const k of Object.keys(store.EMPTY_PROFILE)) if (body[k] !== undefined && !Array.isArray(store.EMPTY_PROFILE[k])) p[k] = String(body[k] ?? "");
    if (Array.isArray(body.experience)) p.experience = body.experience.slice(0, 20);
    if (Array.isArray(body.education)) p.education = body.education.slice(0, 10);
    if (Array.isArray(body.prefQA)) p.prefQA = body.prefQA.slice(0, 40).map((x) => ({ q: String(x.q || "").slice(0, 500), why: String(x.why || "").slice(0, 300), a: String(x.a || "").slice(0, 3000) })).filter((x) => x.q);
    if (Array.isArray(body.stories)) p.stories = body.stories.slice(0, 80).map((x, i) => ({ id: String(x.id || `s${Date.now().toString(36)}${i}`), roleIndex: Number.isInteger(+x.roleIndex) ? +x.roleIndex : -1, prompt: String(x.prompt || "").slice(0, 600), answer: String(x.answer || "").slice(0, 6000), tags: String(x.tags || "").slice(0, 300) })).filter((x) => x.prompt || x.answer);
    db.profile = p;
    store.save();
    return send(res, 200, { ok: true, missing: ai.profileReady(p) });
  }
  if (route === "PUT /api/settings") {
    if (["apiKey", "searchKey", "clearKey"].some((key) => Object.hasOwn(body, key))) {
      return fail(res, 400, "API keys are not accepted by dashboard settings. Configure them as environment variables and restart the server.");
    }
    const s = db.settings;
    for (const k of Object.keys(store.DEFAULT_SETTINGS)) {
      if (body[k] !== undefined) s[k] = typeof store.DEFAULT_SETTINGS[k] === "number" ? Math.max(0, +body[k] || 0) : typeof store.DEFAULT_SETTINGS[k] === "boolean" ? !!body[k] : String(body[k]);
    }
    store.save();
    return send(res, 200, { ok: true });
  }
  if (route === "POST /api/discover") return send(res, 200, await discover());
  if (route === "POST /api/search/preview") return send(res, 200, { queries: buildQueries({ ...db.settings, ...body }) });
  // ---- AI helpers for the profile pages (results come back for you to review before saving) ----
  if (route === "POST /api/ai/import-resume") return aiRoute(res, () => ai.importResume(body));
  if (route === "POST /api/ai/suggest-preferences") return aiRoute(res, () => ai.suggestPreferences(body.profile || db.profile));
  if (route === "POST /api/ai/fit-roles") return aiRoute(res, () => ai.fitRoles(body.profile || db.profile));
  if (route === "POST /api/ai/story-prompts") return aiRoute(res, () => ai.storyPrompts(body.profile || db.profile));
  if (route === "POST /api/jobs") {
    try {
      const j = await addByUrl(String(body.url || "").trim());
      store.save();
      return j ? send(res, 200, { ok: true, job: summary(j) }) : fail(res, 409, "That job is already in your list.");
    } catch (e) { return fail(res, 400, e.message); }
  }
  if (route === "GET /api/jobs") {
    const st = url.searchParams.get("status");
    return send(res, 200, jobs().filter((j) => !st || j.status === st).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500).map(summary));
  }
  if ((m = route.match(/^GET \/api\/jobs\/([\w-]+)$/))) {
    const j = db.jobs[m[1]];
    return j ? send(res, 200, j) : fail(res, 404, "Not found");
  }
  if ((m = route.match(/^POST \/api\/jobs\/([\w-]+)\/status$/))) {
    const j = db.jobs[m[1]];
    if (!j) return fail(res, 404, "Not found");
    if (!["queued", "skipped", "submitted"].includes(body.status)) return fail(res, 400, "Bad status");
    update(j, { status: body.status, reason: body.status === "queued" ? "Put back in line by you" : body.status === "submitted" ? "Marked as sent by you" : "Skipped by you" });
    return send(res, 200, { ok: true });
  }
  if (route === "POST /api/jobs/skip-queued") {
    let n = 0;
    for (const j of jobs()) if (j.status === "queued") { update(j, { status: "skipped", reason: "Cleared from the queue" }); n++; }
    return send(res, 200, { ok: true, skipped: n });
  }
  return fail(res, 404, "Not found");
}

// ---------------- server ----------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  try {
    // Only answer requests addressed to this computer (blocks DNS-rebinding tricks from websites).
    const host = (req.headers.host || "").toLowerCase();
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return fail(res, 403, "Wrong host");
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname.startsWith("/api/ext/")) {
      if ((req.headers.authorization || "") !== `Bearer ${db.token}`) return fail(res, 401, "Wrong or missing token. Copy it from the dashboard into the extension.");
      const body = req.method === "POST" ? await readBody(req) : {};
      return await extApi(req, res, url, body);
    }
    if (url.pathname.startsWith("/api/")) {
      // The dashboard sends the token in a header; other websites can't read it or send it.
      if (req.headers["x-applypilot-token"] !== db.token) return fail(res, 401, "Unauthorized");
      const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
      return await dashApi(req, res, url, body);
    }
    let m;
    if ((m = url.pathname.match(/^\/files\/([\w-]+)\/(resume|cover)\.pdf$/))) {
      if (url.searchParams.get("t") !== db.token) return fail(res, 401, "Unauthorized");
      const f = store.filePath(m[1], m[2]);
      if (!fs.existsSync(f)) return fail(res, 404, "Not found");
      return send(res, 200, fs.readFileSync(f), { "content-type": "application/pdf" });
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    // Static dashboard. The token goes into the page; other sites can't read pages from here.
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return fail(res, 404, "Not found");
    let content = fs.readFileSync(full);
    if (file === "index.html") content = Buffer.from(content.toString("utf8").replace("__TOKEN__", db.token));
    return send(res, 200, content, { "content-type": TYPES[path.extname(full)] || "application/octet-stream", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
  } catch (e) {
    console.error(e);
    return fail(res, e.status || 500, e.message);
  }
});

// Jobs left "applying" by a previous run are put back in line.
for (const j of jobs()) if (j.status === "applying") update(j, { status: "queued", reason: "Put back in line after a restart" });

server.listen(PORT, HOST, () => {
  console.log(`\nApplyPilot is running: http://localhost:${PORT}`);
  console.log(`Extension token: ${db.token}\n`);
  if (process.env.APPLYPILOT_MOCK_AI === "1") console.log("(mock AI mode: no Claude calls)\n");
});

process.on("SIGINT", () => { store.save(); process.exit(0); });
