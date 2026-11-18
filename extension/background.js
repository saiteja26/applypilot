// ApplyPilot background worker: takes jobs from your local server one at a time, opens each in
// ApplyPilot's own window, runs the filler, and reports what happened. Jobs that need you (a
// captcha, an emailed code, a question it can't answer) move to a "Needs you" window and wait
// there while the run carries on.
importScripts("config.js");
const SERVER = self.AP_CONFIG.SERVER.replace(/\/$/, "");
const SITES = /^https:\/\/(job-boards\.greenhouse\.io|boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com)\//;
const GAP_S = 3;                       // pause between applications
const QUIET_MS = 4 * 60 * 1000;        // the page stopped reporting in
const WAIT_MAX_MS = 65 * 60 * 1000;    // a job left for you
const MAX_WAITING = 5;                 // pause the run when this many wait on you
const WAITING_PAGE = chrome.runtime.getURL("waiting.html");

// ---------------- storage ----------------
const get = async (k, d) => (await chrome.storage.local.get(k))[k] ?? d;
const put = (o) => chrome.storage.local.set(o);
const getRun = () => get("ap_run", { running: false, waiting: [], history: [] });
let lock = Promise.resolve();
/** All run-state changes go through one queue so they never overwrite each other. */
const locked = (fn) => { const p = lock.then(fn); lock = p.catch((e) => console.warn(e)); return p; };
async function setRun(patch) {
  const r = { ...(await getRun()), ...patch };
  await put({ ap_run: r });
  const needs = (r.waiting || []).length;
  chrome.action.setBadgeText({ text: needs ? String(needs) : r.running ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: needs ? "#a2580b" : "#124f73" });
  return r;
}
const remember = (r, job, result) => [{ at: Date.now(), company: job.company, title: job.title, status: result.status, reason: result.reason || "" }, ...(r.history || [])].slice(0, 30);

// ---------------- server ----------------
async function api(path, { method = "GET", body } = {}) {
  const token = await get("ap_token", null);
  if (!token) throw Object.assign(new Error("Not connected: paste your token from the ApplyPilot dashboard."), { status: 401 });
  if (!path.startsWith("/api/ext/")) throw new Error("Refusing that path");
  let r;
  try {
    r = await fetch(SERVER + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error(`Can't reach the ApplyPilot server at ${SERVER}. Is it running?`), { status: 0 });
  }
  const data = (r.headers.get("content-type") || "").includes("json") ? await r.json() : null;
  if (!r.ok) throw Object.assign(new Error(data?.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}
async function fileB64(appId, kind) {
  const token = await get("ap_token", null);
  const r = await fetch(`${SERVER}/api/ext/file?app=${encodeURIComponent(appId)}&kind=${kind}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw Object.assign(new Error(b.error || `HTTP ${r.status}`), { status: r.status }); }
  const name = (r.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || `${kind}.pdf`;
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { name, base64: btoa(bin) };
}
const notify = (title, message) => chrome.notifications.create("ap-" + Date.now(), { type: "basic", iconUrl: "icons/icon128.png", title, message: String(message).slice(0, 250), priority: 2 });

// Reports wait in an outbox until the server has them, so an outcome is never lost.
async function report(appId, result) {
  const box = await get("ap_outbox", {});
  box[appId] = { at: Date.now(), body: { application_id: appId, status: result.status, reason: result.reason, answers: result.answers || [], confirmation_text: result.confirmation_text, confirmation_url: result.confirmation_url, log: result.log } };
  await put({ ap_outbox: box });
  return flushOutbox();
}
async function flushOutbox() {
  const box = await get("ap_outbox", {});
  for (const [id, { body, at }] of Object.entries(box).sort((a, b) => a[1].at - b[1].at)) {
    try { await api("/api/ext/report", { method: "POST", body }); }
    catch (e) { if (e.status !== 400 && e.status !== 404) { chrome.alarms.create("ap_outbox", { delayInMinutes: 1 }); return; } }
    const now = await get("ap_outbox", {});
    if (now[id]?.at === at) { delete now[id]; await put({ ap_outbox: now }); }
  }
}

// ---------------- the run ----------------
function schedule(seconds) {
  if (seconds < 30) setTimeout(tick, seconds * 1000);
  chrome.alarms.create("ap_tick", { when: Date.now() + Math.max(30, seconds) * 1000 });
}

async function workTab(url) {
  const r = await getRun();
  if (r.windowId) {
    try {
      await chrome.windows.get(r.windowId);
      if (r.tabId) { await chrome.tabs.update(r.tabId, { url }); return; }
      const t = await chrome.tabs.create({ windowId: r.windowId, url, active: true });
      await setRun({ tabId: t.id });
      return;
    } catch { /* window was closed */ }
  }
  // Opens on ApplyPilot's own page first, then goes to the job.
  const w = await chrome.windows.create({ url: WAITING_PAGE, focused: false, width: 1280, height: 900 });
  await setRun({ windowId: w.id, tabId: w.tabs[0].id });
  await new Promise((res) => setTimeout(res, 500));
  await chrome.tabs.update(w.tabs[0].id, { url });
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const r = await getRun();
    if (!r.running || r.current) return;
    await flushOutbox();
    let next;
    try { next = await api("/api/ext/next", { method: "POST" }); }
    catch (e) {
      if (e.status === 401) return stop(e.message);
      await setRun({ message: `${e.message} Trying again in a minute.` });
      return schedule(60);
    }
    if (next.none) {
      if (next.stop) return stop(next.reason);
      await setRun({ message: next.reason });
      const rr = await getRun();
      if (rr.tabId) chrome.tabs.update(rr.tabId, { url: WAITING_PAGE }).catch(() => {});
      return schedule(next.retryIn || 120);
    }
    const job = next.application;
    if (!SITES.test(job.url)) { await report(job.id, { status: "skipped", reason: "Not a Greenhouse, Lever or Ashby form." }); return schedule(1); }
    if (!(await getRun()).running) return report(job.id, { status: "abandoned", reason: "Paused" });
    await setRun({ current: { job, startedAt: Date.now(), lastBeat: Date.now(), injected: false, pending: null, restarts: 0 }, message: `Applying: ${job.company}, ${job.title}` });
    await workTab(job.url);
  } finally {
    ticking = false;
  }
}

async function finish(result) {
  const r = await getRun();
  if (!r.current) return;
  const job = r.current.job;
  if (!result.answers?.length && r.current.pending?.record) result.answers = r.current.pending.record;
  await setRun({ current: null, history: remember(r, job, result), message: `${job.company}: ${result.status.replace("_", " ")}` });
  await report(job.id, result);
  if (result.status === "needs_you") notify("ApplyPilot needs you", `${job.company}: ${result.reason || "check the window"}`);
  if (result.stop) return stop(result.reason);
  if ((await getRun()).running) schedule(GAP_S);
}

/** The job in progress stopped without an outcome (paused, tab closed, Chrome restarted). */
async function dropCurrent(reason) {
  const r = await getRun();
  if (!r.current) return;
  const job = r.current.job;
  const result = r.current.pending?.mode === "submit"
    ? { status: "needs_you", reason: `${reason} right after Submit was pressed. Check your email to see if it went through.`, answers: r.current.pending.record }
    : { status: "abandoned", reason };
  await setRun({ current: null, history: remember(r, job, result) });
  await report(job.id, result);
}

async function start() {
  const me = await api("/api/ext/me");
  if (me.missing?.length) throw new Error(`Finish your profile first (missing: ${me.missing.join(", ")}).`);
  if (!me.hasKey) throw new Error("Add your Claude API key in the dashboard's Settings first.");
  await dropCurrent("Restarted");
  await setRun({ running: true, current: null, message: "Starting..." });
  chrome.alarms.create("ap_watchdog", { periodInMinutes: 1 });
  tick();
}

async function stop(message) {
  const r = await getRun();
  await setRun({ running: false });
  if (r.current && r.tabId) chrome.tabs.sendMessage(r.tabId, { type: "AP_STOP" }).catch(() => {});
  await dropCurrent("Paused before it finished");
  chrome.alarms.clear("ap_tick");
  await setRun({ running: false, current: null, message: message || "Paused." });
  if (message && !/^Paused/.test(message)) notify("ApplyPilot stopped", message);
}

/** A job that needs the person moves to the "Needs you" window; the run takes the next one. */
async function handOff(tabId, msg) {
  const r = await getRun();
  if (!r.current || r.current.job.id !== msg.appId || tabId !== r.tabId) {
    // Already waiting: just keep its latest details.
    const waiting = (r.waiting || []).map((w) => (w.tabId === tabId ? { ...w, pending: msg.pending } : w));
    return setRun({ waiting });
  }
  const job = r.current.job;
  const fresh = await chrome.tabs.create({ windowId: r.windowId, url: WAITING_PAGE, active: true }).catch(() => null);
  const waiting = [...(r.waiting || []), { tabId, job, pending: msg.pending, since: Date.now() }];
  await setRun({ current: null, tabId: fresh?.id ?? null, waiting, message: `${job.company} needs you (in the Needs you window). Moving on.` });
  let needsWin = r.needsWindowId;
  try { if (needsWin) { await chrome.windows.get(needsWin); await chrome.tabs.move(tabId, { windowId: needsWin, index: -1 }); await chrome.tabs.update(tabId, { active: true }); } else throw 0; }
  catch { const w = await chrome.windows.create({ tabId, focused: true, width: 1150, height: 880 }).catch(() => null); needsWin = w?.id; }
  await setRun({ needsWindowId: needsWin });
  await report(job.id, { status: "needs_you", reason: msg.reason, answers: msg.pending?.record || [] });
  notify("ApplyPilot needs you", `${job.company}: ${msg.reason}`);
  if (waiting.length >= MAX_WAITING) return stop(`${MAX_WAITING} applications are waiting on you in the Needs you window. Finish or skip them, then press Start.`);
  if ((await getRun()).running) schedule(GAP_S);
}

async function doneWaiting(tabId, appId, result) {
  const r = await getRun();
  const w = (r.waiting || []).find((x) => x.job.id === appId);
  if (!w) { if (result.status === "submitted") await report(appId, result); return; }
  if (!result.answers?.length && w.pending?.record) result.answers = w.pending.record;
  await setRun({ waiting: r.waiting.filter((x) => x.job.id !== appId), history: remember(r, w.job, result) });
  await report(appId, result);
  if (result.status === "submitted" || result.status === "skipped") setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 3000);
}

// ---------------- events ----------------
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "ap_tick") return tick();
  if (a.name === "ap_outbox") return flushOutbox();
  if (a.name !== "ap_watchdog") return;
  const r = await getRun();
  for (const w of r.waiting || []) if (Date.now() - w.since > WAIT_MAX_MS) await locked(() => doneWaiting(-1, w.job.id, { status: "needs_you", reason: "Waited an hour. The tab is still open if you want to finish it." }));
  if (r.running && r.current && Date.now() - r.current.lastBeat > QUIET_MS) await locked(() => finish({ status: "failed", reason: "The page stopped responding." }));
  if (r.running && !r.current) tick();
});

/** A job page finished loading and asks what to do (the filler is loaded on these sites). */
async function hello(tabId) {
  const r = await getRun();
  const w = (r.waiting || []).find((x) => x.tabId === tabId);
  if (w) return { action: "check", job: w.job, pending: w.pending || {} };
  if (!r.running || !r.current || tabId !== r.tabId) return null;
  const cur = r.current;
  if (cur.pending) return { action: "check", job: cur.job, pending: cur.pending };
  // Loaded again without Submit (a redirect, or the site moving to its form page): start over, twice at most.
  if (cur.injected && cur.restarts >= 2) { await finish({ status: "failed", reason: "The page kept reloading." }); return null; }
  await setRun({ current: { ...cur, injected: true, restarts: cur.injected ? cur.restarts + 1 : 0, lastBeat: Date.now() } });
  return { action: "run", job: cur.job };
}

// After Submit, a page on a site ApplyPilot can't read (Chrome hides its address): it can't confirm.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  locked(async () => {
    const r = await getRun();
    if (!r.running || !r.current?.pending || tabId !== r.tabId) return;
    if (!tab.url) await finish({ status: "needs_you", reason: "After Submit the page went to a site ApplyPilot can't read. Check your email to see if it went through." });
  });
});

chrome.tabs.onRemoved.addListener((tabId, info) => locked(async () => {
  const r = await getRun();
  if ((r.waiting || []).some((w) => w.tabId === tabId)) await setRun({ waiting: r.waiting.filter((w) => w.tabId !== tabId) });
  if (tabId === r.tabId && !info.isWindowClosing) {
    await setRun({ tabId: null });
    if (r.current) { await dropCurrent("Its tab was closed"); if (r.running) schedule(GAP_S); }
  }
}));

chrome.windows.onRemoved.addListener((windowId) => locked(async () => {
  const r = await getRun();
  if (windowId === r.needsWindowId) await setRun({ needsWindowId: null });
  if (windowId === r.windowId) { await setRun({ windowId: null, tabId: null }); if (r.running || r.current) await stop("Stopped because the ApplyPilot window was closed."); }
}));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;
  (async () => {
    switch (msg.type) {
      case "AP_HELLO": return locked(() => hello(tabId));
      case "AP_API": return api(msg.path, { method: msg.method, body: msg.body });
      case "AP_FILE": return fileB64(msg.appId, msg.kind);
      case "AP_BEAT": return locked(async () => { const r = await getRun(); if (r.current && tabId === r.tabId) await setRun({ current: { ...r.current, lastBeat: Date.now() } }); return { ok: true }; });
      case "AP_PENDING": return locked(async () => { const r = await getRun(); if (r.current && tabId === r.tabId) await setRun({ current: { ...r.current, pending: msg.pending, lastBeat: Date.now() } }); return { ok: true }; });
      case "AP_HANDOFF": return locked(() => handOff(tabId, msg)).then(() => ({ ok: true }));
      case "AP_DONE": return locked(async () => {
        const r = await getRun();
        if (r.current && r.current.job.id === msg.appId && tabId === r.tabId) await finish(msg.result);
        else await doneWaiting(tabId, msg.appId, msg.result);
        return { ok: true };
      });
      // ---- popup ----
      case "AP_STATUS": {
        const [run, token] = await Promise.all([getRun(), get("ap_token", null)]);
        let me = null, error = null;
        if (token) { try { me = await api("/api/ext/me"); } catch (e) { error = e.message; } }
        return { run, hasToken: !!token, me, error, server: SERVER };
      }
      case "AP_SET_TOKEN": {
        const token = String(msg.token || "").trim();
        if (!/^ap_[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("That doesn't look like an ApplyPilot token.");
        await put({ ap_token: token });
        try { return await api("/api/ext/me"); } catch (e) { await chrome.storage.local.remove("ap_token"); throw e; }
      }
      case "AP_START": await locked(start); return { ok: true };
      case "AP_PAUSE": await locked(() => stop("Paused.")); return { ok: true };
      case "AP_FOCUS": { const r = await getRun(); if (r.windowId) await chrome.windows.update(r.windowId, { focused: true }).catch(() => {}); return { ok: true }; }
      case "AP_FOCUS_WAITING": { const r = await getRun(); const w = r.waiting?.[0]; if (w) { const t = await chrome.tabs.get(w.tabId).catch(() => null); if (t) { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); } } return { ok: true }; }
      case "AP_DISCONNECT": await locked(() => stop("Disconnected.")); await chrome.storage.local.remove(["ap_token", "ap_run"]); return { ok: true };
    }
    return null;
  })()
    .then(reply)
    .catch((e) => reply({ __error: e.message, status: e.status }));
  return true;
});

chrome.runtime.onStartup.addListener(() => locked(async () => {
  const r = await getRun();
  for (const w of r.waiting || []) await report(w.job.id, { status: "needs_you", reason: "Chrome restarted before you finished it.", answers: w.pending?.record || [] });
  await setRun({ waiting: [], windowId: null, tabId: null, needsWindowId: null });
  await dropCurrent("Chrome restarted");
  await setRun({ running: false, message: "Chrome restarted. Press Start to continue." });
  flushOutbox();
}));
chrome.runtime.onInstalled.addListener((d) => locked(async () => {
  if (d.reason === "install") chrome.tabs.create({ url: SERVER + "/#settings" });
  const r = await getRun();
  if (d.reason === "update" && (r.running || r.current)) { await dropCurrent("ApplyPilot updated"); await setRun({ running: false, message: "Updated. Press Start to continue." }); }
}));
