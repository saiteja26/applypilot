const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { __error: chrome.runtime.lastError?.message })));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LABEL = { submitted: "sent", needs_you: "needs you", failed: "failed", skipped: "skipped", abandoned: "stopped" };

async function render() {
  const s = await send({ type: "AP_STATUS" });
  const app = $("#app");
  if (s.__error) { app.innerHTML = `<div class="card warn">${esc(s.__error)}</div>`; return; }
  const dash = () => chrome.tabs.create({ url: s.server + "/" });
  if (!s.hasToken || !s.me) {
    $("#who").textContent = "";
    app.innerHTML = `<div class="card">
      ${s.error ? `<p class="small" style="color:#a3231c">${esc(s.error)}</p>` : ""}
      <p><b>Connect to your ApplyPilot server.</b> Start it (<code>node server/server.js</code>), open the dashboard's Settings and copy the extension token.</p>
      <input id="tok" placeholder="ap_..." autocomplete="off"><div class="row"><button id="save">Connect</button><a href="#" id="dash" class="small">Open dashboard</a></div></div>`;
    $("#save").onclick = async () => { const r = await send({ type: "AP_SET_TOKEN", token: $("#tok").value }); if (r.__error) alert(r.__error); render(); };
    $("#dash").onclick = dash;
    return;
  }
  const { me, run } = s;
  $("#who").textContent = me.name || me.email || "";
  const waiting = (run.waiting || []).length;
  const blockers = [...(me.missing?.length ? [`Finish your profile (missing: ${me.missing.join(", ")}).`] : []), ...(!me.hasKey ? ["Add your Claude API key in Settings."] : [])];
  const hist = (run.history || []).slice(0, 8).map((h) => `<li><span class="st st-${esc(h.status)}">${esc(LABEL[h.status] || h.status)}</span> · ${esc(h.company)}<div class="small muted">${esc(h.title)}${h.reason ? " · " + esc(h.reason.slice(0, 90)) : ""}</div></li>`).join("");
  app.innerHTML = `
    ${blockers.map((b) => `<div class="card warn small">${esc(b)} <a href="#" class="dash">Open dashboard</a></div>`).join("")}
    ${waiting ? `<div class="card warn row"><span><b>${waiting} waiting on you</b><br><span class="small muted">In the Needs you window: a captcha, a code or a question only you can answer.</span></span><button id="showw">Show</button></div>` : ""}
    <div class="card">
      <div class="row"><span><span class="big">${me.submittedToday}</span> <span class="muted">sent today</span></span><span class="small muted">${me.today}/${me.limit || "∞"} tried · ${me.queued} in line</span></div>
      <p class="small muted" style="margin:6px 0 8px">${esc(run.message || "Press Start. Keep Chrome open while it works.")}</p>
      <div class="row">${run.running ? `<button class="ghost" id="pause">Pause</button><button class="ghost" id="focus">Show window</button>` : `<button id="start" ${blockers.length ? "disabled" : ""}>Start</button>`}</div>
    </div>
    ${hist ? `<div class="card"><b>Recent</b><ul>${hist}</ul></div>` : ""}
    <div class="row small"><a href="#" class="dash">Open dashboard</a><a href="#" id="disc" class="muted">Disconnect</a></div>`;
  document.querySelectorAll(".dash").forEach((a) => (a.onclick = dash));
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on("#start", async () => { $("#start").disabled = true; const r = await send({ type: "AP_START" }); if (r.__error) alert(r.__error); render(); });
  on("#pause", async () => { await send({ type: "AP_PAUSE" }); render(); });
  on("#focus", () => send({ type: "AP_FOCUS" }));
  on("#showw", () => send({ type: "AP_FOCUS_WAITING" }));
  on("#disc", async () => { if (confirm("Disconnect this browser from your ApplyPilot server?")) { await send({ type: "AP_DISCONNECT" }); render(); } });
}
render();
setInterval(render, 4000);
