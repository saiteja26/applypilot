
const store = require("./store");
const ai = require("./ai");

const decodeEntities = (s) => String(s || "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");
const htmlToText = (html) => decodeEntities(decodeEntities(String(html || ""))
  .replace(/<(br|\/p|\/li|\/h\d|\/div)>/gi, "\n").replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, " "))
  .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();

const lines = (s) => String(s || "").split(/\n/).map((x) => x.trim()).filter(Boolean);
const baseRole = (role) => role.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
const words = (text) => String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const GENERIC_ROLE_WORDS = new Set(["senior", "junior", "mid", "staff", "principal", "lead", "engineer", "engineering", "developer", "architect", "specialist", "manager"]);
const pretty = (slug) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const quote = (t) => `"${t.replace(/"/g, "")}"`;
const anyOf = (arr) => (arr.length === 1 ? quote(arr[0]) : `(${arr.map(quote).join(" OR ")})`);
const DAY = 24 * 3600 * 1000;

const PLATFORM_SITES = {
  lever: ["jobs.lever.co"],
  greenhouse: ["job-boards.greenhouse.io", "boards.greenhouse.io"],
  ashby: ["jobs.ashbyhq.com"],
};

function platforms(s) {
  return Object.keys(PLATFORM_SITES).filter((p) => s[`platform${p[0].toUpperCase()}${p.slice(1)}`]);
}

/**
 * The search queries for your settings. Roles are split across several queries when there are
 * many, so each stays short enough for the search engine (Brave allows 400 characters).
 */
function buildQueries(s) {
  const sites = platforms(s).flatMap((p) => PLATFORM_SITES[p]).map((d) => `site:${d}`);
  // Parenthetical details are profile-fit hints, not required words in a job title.
  const roles = [...new Set(lines(s.keywords).map(baseRole).filter(Boolean))];
  if (!sites.length || !roles.length) return [];
  const siteClause = sites.length > 1 ? `(${sites.join(" OR ")})` : sites[0];
  const tail = [...lines(s.exclude).slice(0, 5).map((x) => `-${quote(x)}`), "-inurl:apply"].join(" ");
  const places = [];
  // Use "remote" for discovery, then enforce the user's allowed regions against posting data.
  if (s.remoteOk) places.push('"remote"');
  if (lines(s.locations).length) places.push(anyOf(lines(s.locations)));
  if (!places.length) places.push("");
  const queries = [];
  for (const place of places) {
    let chunk = [];
    const make = (c) => [siteClause, anyOf(c), place, tail].filter(Boolean).join(" ");
    for (const r of roles) {
      if (chunk.length && (chunk.length >= 5 || make([...chunk, r]).length > 390)) { queries.push(make(chunk)); chunk = []; }
      chunk.push(r);
    }
    if (chunk.length) queries.push(make(chunk));
  }
  return queries;
}

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { accept: "application/json", "user-agent": "ApplyPilot (personal job search)", ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw Object.assign(new Error(`${new URL(url).hostname} HTTP ${r.status}${body ? ": " + body.slice(0, 160) : ""}`), { status: r.status });
  }
  return r.json();
}

// ---------------- search providers ----------------
async function searchSerper(q, key, fresh) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const d = await getJSON("https://google.serper.dev/search", {
      method: "POST", headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ q, num: 20, page, gl: "us", hl: "en", ...(fresh ? { tbs: fresh === "day" ? "qdr:d" : "qdr:w" } : {}) }),
    });
    const items = (d.organic || []).map((x) => ({ url: x.link, title: x.title || "" }));
    out.push(...items);
    if (items.length < 10) break;
  }
  return out;
}

async function searchBrave(q, key, fresh) {
  const out = [];
  for (let offset = 0; offset <= 4; offset++) {
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.search = new URLSearchParams({ q, count: "20", offset: String(offset), country: "US", search_lang: "en", ...(fresh ? { freshness: fresh === "day" ? "pd" : "pw" } : {}) });
    const d = await getJSON(u, { headers: { "x-subscription-token": key } });
    const items = (d.web?.results || []).map((x) => ({ url: x.url, title: x.title || "" }));
    out.push(...items);
    if (items.length < 20 || !d.query?.more_results_available) break;
  }
  return out;
}

const PROVIDERS = { serper: searchSerper, brave: searchBrave };

// ---------------- turning a result into a posting ----------------
/** A posting address -> { ats, slug, id, region } or null. */
function parsePostingUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const h = u.hostname.toLowerCase();
  let m;
  if (/(^|\.)greenhouse\.io$/.test(h)) {
    if (u.searchParams.get("for") && u.searchParams.get("token")) return { ats: "greenhouse", slug: u.searchParams.get("for"), id: u.searchParams.get("token") };
    if ((m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/))) return { ats: "greenhouse", slug: m[1], id: m[2], region: /\.eu\./.test(h) ? "eu" : "" };
    return null;
  }
  if ((h === "jobs.lever.co" || h === "jobs.eu.lever.co") && (m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i))) return { ats: "lever", slug: m[1], id: m[2], region: h.includes(".eu.") ? "eu" : "" };
  if (h === "jobs.ashbyhq.com" && (m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i))) return { ats: "ashby", slug: decodeURIComponent(m[1]), id: m[2] };
  return null;
}

/** "Software Engineer - Acme" / "Job Application for X at Acme" / "X @ Acme" -> "Acme" */
function companyFromTitle(title, ats) {
  const t = decodeEntities(title).replace(/\s+/g, " ").trim();
  let m;
  if ((m = t.match(/ at ([^|–-]+?)(?:\s*[|–-].*)?$/i))) return m[1].trim();
  if (ats === "lever" && (m = t.match(/^([^-–|]+?)\s+[-–]\s+/))) return m[1].trim();
  if ((m = t.match(/ @ ([^|–-]+)/))) return m[1].trim();
  return null;
}

const cache = { boards: new Map(), ashby: new Map() };

async function fetchPosting(p, hint = {}) {
  if (p.ats === "greenhouse") {
    const api = `https://boards-api${p.region === "eu" ? ".eu" : ""}.greenhouse.io/v1/boards/${p.slug}`;
    if (!cache.boards.has(api)) cache.boards.set(api, getJSON(api).then((b) => b.name).catch(() => null));
    const [name, j] = await Promise.all([cache.boards.get(api), getJSON(`${api}/jobs/${p.id}`)]);
    return {
      ats: "greenhouse", slug: p.slug, externalId: String(j.id), company: name || hint.company || pretty(p.slug), title: j.title,
      location: j.location?.name || "", url: `https://job-boards${p.region === "eu" ? ".eu" : ""}.greenhouse.io/${p.slug}/jobs/${j.id}`,
      description: htmlToText(j.content), compensation: j.compensation || j.salary || j.pay_transparency || null, postedAt: j.first_published || j.updated_at || null,
    };
  }
  if (p.ats === "lever") {
    const j = await getJSON(`https://api${p.region === "eu" ? ".eu" : ""}.lever.co/v0/postings/${p.slug}/${p.id}?mode=json`);
    return {
      ats: "lever", slug: p.slug, externalId: j.id, company: hint.company || pretty(p.slug), title: j.text,
      location: [j.categories?.location, ...(j.categories?.allLocations || [])].filter((v, i, a) => v && a.indexOf(v) === i).join("; ") || (j.workplaceType === "remote" ? "Remote" : ""),
      remote: j.workplaceType === "remote",
      compensation: j.compensation || j.salaryRange || j.salary || null,
      url: j.applyUrl || `https://jobs.lever.co/${p.slug}/${j.id}/apply`,
      description: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain].filter(Boolean).join("\n\n"),
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    };
  }
  if (p.ats === "ashby") {
    const key = p.slug.toLowerCase();
    if (!cache.ashby.has(key)) cache.ashby.set(key, getJSON(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(p.slug)}?includeCompensation=true`));
    const board = await cache.ashby.get(key);
    const j = (board.jobs || []).find((x) => x.id === p.id);
    if (!j) throw Object.assign(new Error("Posting is closed or unlisted"), { closed: true });
    return {
      ats: "ashby", slug: p.slug, externalId: j.id, company: hint.company || board.organizationName || pretty(p.slug), title: j.title,
      location: [j.location, ...(j.secondaryLocations || []).map((x) => x.location)].filter(Boolean).join("; "),
      remote: !!j.isRemote,
      compensation: j.compensationTierSummary || j.compensation || null,
      url: j.applyUrl || `https://jobs.ashbyhq.com/${p.slug}/${j.id}/application`,
      description: j.descriptionPlain || htmlToText(j.descriptionHtml), postedAt: j.publishedAt || null,
    };
  }
  throw new Error("Unsupported platform");
}

// ---------------- filtering ----------------
/** Apply pre-fit filters for title (when needed), excluded words and location. */
function matches(job, s) {
  const title = String(job.title || "").toLowerCase();
  const titleWords = new Set(words(title));
  const configuredRoles = lines(s.keywords);
  const roleTerms = configuredRoles.map((role) => {
    const terms = words(baseRole(role));
    const specific = terms.filter((term) => !GENERIC_ROLE_WORDS.has(term));
    return specific.length ? specific : terms;
  }).filter((terms) => terms.length);
  if (!s.fitCheck && configuredRoles.length && (!roleTerms.length || !roleTerms.some((terms) => terms.some((term) => titleWords.has(term))))) return { ok: false, why: "title" };
  if (lines(s.exclude).some((x) => title.includes(x.toLowerCase()))) return { ok: false, why: "excluded word" };
  const where = (job.location || "").toLowerCase();
  const cities = lines(s.locations).map((l) => l.toLowerCase());
  if (cities.some((c) => where.includes(c))) return { ok: true };
  if (s.remoteOk && (job.remote || /remote|anywhere|distributed/.test(where))) {
    const regions = lines(s.remoteRegions).map((r) => r.toLowerCase());
    const us = regions.some((r) => /united states|\bus\b|usa/.test(r));
    const regionOk = !regions.length || regions.some((r) => where.includes(r)) || (us && /\b(us|usa|u\.s\.|united states|north america|americas)\b/.test(where)) || /^\s*remote\s*$/.test(where) || !where.replace(/remote|[-,;()\s]/g, "");
    if (regionOk) return { ok: true };
    return { ok: false, why: "remote region" };
  }
  if (!cities.length && !s.remoteOk) return { ok: true };
  return { ok: false, why: "location" };
}

function fresh(job, s) {
  if (!job.postedAt) return true; // the search already limited the date
  const age = Date.now() - new Date(job.postedAt).getTime();
  return age <= (s.postedToday ? 1.25 * DAY : 7.5 * DAY);
}

function jobId(j) { return `${j.ats}-${j.slug}-${j.externalId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"); }

function addJob(j, source) {
  const db = store.db;
  const id = jobId(j);
  if (db.jobs[id]) return null;
  db.jobs[id] = { id, ...j, status: "queued", source, attempts: 0, createdAt: Date.now(), updatedAt: Date.now() };
  return db.jobs[id];
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => ({ error: e })); } }));
  return out;
}

let running = null;
/** One search pass (only one at a time). */
function discover() {
  if (running) return running;
  running = (async () => {
    const db = store.db;
    const s = db.settings;
    cache.boards.clear(); cache.ashby.clear();
    const queries = buildQueries(s);
    const errors = [];
    const stats = { at: Date.now(), queries: queries.length, results: 0, postings: 0, added: 0, seen: 0, skipped: {}, errors };
    const done = () => { db.meta.lastDiscovery = stats; store.save(); return stats; };
    const missing = ai.profileReady(db.profile);
    if (missing.length) { errors.push(`Complete your profile before searching (missing: ${missing.join(", ")}).`); return done(); }
    if (!queries.length) { errors.push("Add at least one role (Preferences page) and turn on at least one platform."); return done(); }
    const key = process.env.APPLYPILOT_SEARCH_KEY;
    const search = PROVIDERS[s.searchProvider] || PROVIDERS.serper;
    if (!key) { errors.push("No search API key. Set APPLYPILOT_SEARCH_KEY in the server environment, then restart the server."); return done(); }

    const found = new Map(); // canonical posting -> search title
    for (const q of queries) {
      try {
        for (const r of await search(q, key, s.postedToday ? "day" : "week")) {
          stats.results++;
          const p = parsePostingUrl(r.url);
          if (!p) continue;
          const k = `${p.ats}:${p.slug.toLowerCase()}:${p.id.toLowerCase()}`;
          if (!found.has(k)) found.set(k, { p, title: r.title });
        }
      } catch (e) {
        errors.push(`Search failed: ${e.message}`);
        if (e.status === 401 || e.status === 403) break;
      }
    }
    // Skip postings already in your list before reading them.
    const known = new Set(Object.values(db.jobs).map((j) => `${j.ats}:${String(j.slug).toLowerCase()}:${String(j.externalId).toLowerCase()}`));
    const todo = [...found.entries()].filter(([k]) => !known.has(k)).map(([, v]) => v);
    stats.postings = found.size;
    const skip = (why) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; };
    const matched = [];
    await pool(todo, 4, async ({ p, title }) => {
      let job;
      try { job = await fetchPosting(p, { company: companyFromTitle(title, p.ats) }); }
      catch (e) { skip(e.closed || e.status === 404 ? "closed" : "couldn't read"); return; }
      if (!fresh(job, s)) return skip(s.postedToday ? "not posted today" : "older than a week");
      const m = matches(job, s);
      if (!m.ok) return skip(m.why);
      stats.seen++;
      matched.push(job);
    });
    // How well each posting fits you, so weak matches are set aside rather than applied to.
    const fits = new Map();
    if (s.fitCheck && matched.length && (process.env.ANTHROPIC_API_KEY || process.env.APPLYPILOT_MOCK_AI === "1")) {
      try {
        const withIds = matched.map((j) => ({ ...j, id: jobId(j) }));
        for (const r of await ai.rateFit(db.profile, withIds)) fits.set(r.id, { score: Math.max(1, Math.min(5, Math.round(+r.score || 0))), why: String(r.why || "").slice(0, 200) });
      } catch (e) { errors.push(`Fit rating failed (jobs queued without it): ${e.message}`); }
    }
    for (const job of matched) {
      const fit = fits.get(jobId(job));
      const added = addJob({ ...job, ...(fit ? { fit } : {}) }, "search");
      if (!added) continue;
      if (fit && fit.score < (+s.minFit || 0)) { Object.assign(added, { status: "skipped", reason: `Weak fit (${fit.score}/5): ${fit.why}` }); skip("weak fit"); }
      else stats.added++;
    }
    if (errors.length) store.event("discover", errors.join("; "));
    return done();
  })().finally(() => { running = null; });
  return running;
}

/** Add one job from its link (Lever, Greenhouse or Ashby posting or application page). */
async function addByUrl(url) {
  const p = parsePostingUrl(url);
  if (!p) throw new Error("Paste a Lever, Greenhouse or Ashby job link (jobs.lever.co/..., job-boards.greenhouse.io/..., jobs.ashbyhq.com/...).");
  const job = await fetchPosting(p).catch((e) => { throw new Error(e.closed ? "That posting is closed or unlisted." : `Couldn't read that posting: ${e.message}`); });
  return addJob(job, "manual");
}

module.exports = { discover, addByUrl, buildQueries, parsePostingUrl, companyFromTitle, matches, fresh, htmlToText, platforms };
