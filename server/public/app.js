// ApplyPilot dashboard (plain JS, no build step).
const TOKEN = document.querySelector('meta[name="applypilot-token"]').content;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { "x-applypilot-token": TOKEN, ...(opts.body ? { "content-type": "application/json" } : {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body) });
const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); };
const ago = (t) => { if (!t) return ""; const s = (Date.now() - t) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
const STATUS_LABEL = { queued: "In line", applying: "Applying", submitted: "Sent", needs_you: "Needs you", skipped: "Skipped", failed: "Failed" };
/** Runs an async button action with a busy label. */
const busy = async (btn, label, fn) => { const old = btn.textContent; btn.disabled = true; btn.textContent = label; try { await fn(); } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = old; } };

let state = null;
let tab = location.hash.slice(1) || "applications";

async function refresh() {
  state = await api("/api/state");
  const s = state.stats;
  $("#hdr-stats").textContent = `${s.submittedToday} sent today · ${s.attemptsToday}/${state.settings.dailyLimit || "∞"} tried · ${s.byStatus.queued || 0} in line`;
  const b = [];
  if (state.missing.length) b.push(`<div class="banner">Your profile is missing: <b>${esc(state.missing.join(", "))}</b>. <a href="#profile">Fill it in</a> (or paste your resume there and press "Fill in my profile from it") before starting.</div>`);
  if (!state.settings.hasKey && !state.settings.envKey) b.push(`<div class="banner">Set ANTHROPIC_API_KEY in the server environment, then restart it. See <a href="#settings">Settings</a>.</div>`);
  $("#banner").innerHTML = b.join("");
}

const PAGES = {};
function show(name) {
  if (!PAGES[name]) name = "applications";
  tab = name;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $$("main > section").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  document.querySelector(".detail")?.remove();
  PAGES[name]();
}
window.addEventListener("hashchange", () => show(location.hash.slice(1)));
$$("#tabs button").forEach((b) => (b.onclick = () => (location.hash = b.dataset.tab)));

// ---------------- form helpers ----------------
function field(f, value) {
  const v = value ?? "";
  const required = f.required ? " required" : "";
  if (f.type === "check") return `<label class="f check ${f.wide ? "wide" : ""}"><input type="checkbox" name="${f.k}" ${v ? "checked" : ""}> ${esc(f.label)}</label>`;
  let input;
  if (f.type === "textarea") input = `<textarea name="${f.k}" rows="${f.rows || 3}" placeholder="${esc(f.ph || "")}"${required}>${esc(v)}</textarea>`;
  else if (f.type === "select") input = `<select name="${f.k}"${required}>${f.options.map(([val, lab]) => `<option value="${esc(val)}" ${String(v) === val ? "selected" : ""}>${esc(lab ?? val)}</option>`).join("")}</select>`;
  else input = `<input name="${f.k}" type="${f.type || "text"}" value="${esc(v)}" placeholder="${esc(f.ph || "")}" autocomplete="off"${required}>`;
  return `<label class="f ${f.wide ? "wide" : ""}">${esc(f.label)}${input}${f.hint ? `<span class="small muted">${esc(f.hint)}</span>` : ""}</label>`;
}
function read(root, fields) {
  const out = {};
  for (const f of fields) {
    const el = root.querySelector(`[name="${f.k}"]`);
    if (el) out[f.k] = f.type === "check" ? el.checked : f.type === "number" ? +el.value : el.value;
  }
  return out;
}
const card = (title, inner, note = "") => `<div class="card"><h3>${title}</h3>${note}${inner}</div>`;
const grid = (fields, values) => `<div class="grid">${fields.map((f) => field(f, values[f.k])).join("")}</div>`;

// ---------------- jobs that fit your resume ----------------
const FIT_LABEL = { strong: "Strong fit", good: "Good fit", stretch: "Stretch" };
/** Shows suggested job types with checkboxes; "Use these" adds the ticked ones to the job search. */
function showFitRoles(box, roles) {
  const current = new Set(lines(state.settings.keywords).map((x) => x.toLowerCase()));
  box.innerHTML = `<div class="card" style="border-color:#c9dde9"><h3>Jobs that fit your resume</h3>
    <p class="small muted" style="margin-top:-6px">Based only on what's in your resume. Tick the ones to search for.</p>
    ${roles.map((r, i) => `<label class="fitrow"><input type="checkbox" data-fit="${i}" ${r.fit !== "stretch" || current.has(r.title.toLowerCase()) ? "checked" : ""}>
      <span><b>${esc(r.title)}</b> <span class="st fit-${esc(r.fit)}">${esc(FIT_LABEL[r.fit] || r.fit)}</span>${current.has(r.title.toLowerCase()) ? ' <span class="small muted">already searching</span>' : ""}<br><span class="small muted">${esc(r.why || "")}</span></span></label>`).join("")}
    <div class="row" style="margin-top:10px"><button class="btn" data-use>Search for these jobs</button><span class="small muted">Adds them to your roles; you can edit the list in Preferences.</span></div></div>`;
  $("[data-use]", box).onclick = (e) => busy(e.target, "Saving...", async () => {
    const picked = roles.filter((_, i) => $(`[data-fit="${i}"]`, box).checked).map((r) => r.title);
    const merged = [...lines(state.settings.keywords)];
    for (const t of picked) if (!merged.some((x) => x.toLowerCase() === t.toLowerCase())) merged.push(t);
    await put("/api/settings", { keywords: merged.join("\n") });
    await refresh();
    toast(`${picked.length} job types in your search`);
    location.hash = "search";
  });
}

// ---------------- profile ----------------
const YESNO = [["", "Choose..."], ["yes", "Yes"], ["no", "No"]];
// Visa types and what they usually mean for the questions postings ask. You can change any of them.
// [label, authorized to work, sponsorship now, sponsorship in future, U.S. person (export control), H-1B transfer]
const VISAS = [
  ["U.S. citizen", "yes", "no", "no", "yes", ""],
  ["Green card / permanent resident", "yes", "no", "no", "yes", ""],
  ["Asylee or refugee", "yes", "no", "no", "yes", ""],
  ["EAD (pending green card)", "yes", "no", "no", "no", ""],
  ["H-1B", "yes", "yes", "yes", "no", "yes"],
  ["F-1 OPT", "yes", "no", "yes", "no", ""],
  ["F-1 STEM OPT", "yes", "no", "yes", "no", ""],
  ["F-1 CPT / student", "", "no", "yes", "no", ""],
  ["H-4 EAD", "yes", "no", "yes", "no", ""],
  ["L-2 EAD", "yes", "no", "yes", "no", ""],
  ["L-1", "yes", "yes", "yes", "no", ""],
  ["TN (USMCA)", "yes", "yes", "yes", "no", ""],
  ["E-3", "yes", "yes", "yes", "no", ""],
  ["O-1", "yes", "yes", "yes", "no", ""],
  ["Other EAD", "yes", "", "", "no", ""],
  ["Not currently authorized (need sponsorship)", "no", "yes", "yes", "no", ""],
  ["Other", "", "", "", "", ""],
];
const P = {
  basics: [
    { k: "firstName", label: "First name" }, { k: "lastName", label: "Last name" }, { k: "preferredName", label: "Preferred name (optional)" },
    { k: "email", label: "Email", type: "email" }, { k: "phone", label: "Phone", type: "tel" },
    { k: "city", label: "City" }, { k: "state", label: "State / province" }, { k: "zip", label: "ZIP / postal code" }, { k: "country", label: "Country" },
    { k: "address", label: "Street address (only used if a form requires it)", wide: true },
  ],
  links: [{ k: "linkedin", label: "LinkedIn URL" }, { k: "github", label: "GitHub URL" }, { k: "portfolio", label: "Portfolio / website" }, { k: "otherLinks", label: "Other links (one per line)", type: "textarea", rows: 2 }],
  about: [
    { k: "headline", label: "Headline", ph: "Platform engineer focused on reliability", wide: true },
    { k: "summary", label: "Professional summary", type: "textarea", wide: true, rows: 4 },
    { k: "skills", label: "Skills (comma or one per line)", type: "textarea", wide: true, hint: "Tailored resumes only ever list skills from here." },
    { k: "certifications", label: "Certifications (one per line)", type: "textarea", wide: true, rows: 2 },
    { k: "currentTitle", label: "Current / most recent title" }, { k: "currentCompany", label: "Current / most recent company" }, { k: "yearsExperience", label: "Years of experience" },
  ],
  visa: [
    { k: "visaStatus", label: "Visa / citizenship status", type: "select", options: [["", "Choose..."], ...VISAS.map((v) => [v[0]])] },
    { k: "visaExpiry", label: "Work authorization expires (if it does)", ph: "e.g. Jun 2027" },
    { k: "citizenship", label: "Country of citizenship", ph: "Only used if a form asks" },
    { k: "workAuthorized", label: "Legally authorized to work in the U.S.?", type: "select", options: YESNO },
    { k: "sponsorNow", label: "Need visa sponsorship now?", type: "select", options: YESNO },
    { k: "sponsorFuture", label: "Will need sponsorship in the future (e.g. H-1B)?", type: "select", options: YESNO },
    { k: "h1bTransfer", label: "Need an H-1B transfer?", type: "select", options: [["", "Not applicable"], ["yes", "Yes"], ["no", "No"]] },
    { k: "usPerson", label: 'U.S. person for export control (ITAR/EAR)?', type: "select", options: YESNO, hint: "U.S. citizens, green card holders, asylees and refugees" },
    { k: "clearance", label: "Security clearance", ph: "None, Secret, TS/SCI..." },
  ],
  eeo: [
    { k: "gender", label: "Gender", type: "select", options: [["", "Choose..."], ["Female"], ["Male"], ["Non-binary"], ["Self-describe"], ["I don't wish to answer"]] },
    { k: "pronouns", label: "Pronouns", type: "select", options: [["", "Choose..."], ["She/her"], ["He/him"], ["They/them"], ["Use my name only"], ["Self-describe"], ["I don't wish to answer"]] },
    { k: "race", label: "Race / ethnicity", type: "select", options: [["", "Choose..."], ["American Indian or Alaska Native"], ["Asian"], ["Black or African American"], ["Native Hawaiian or Other Pacific Islander"], ["White"], ["Two or more races"], ["Other"], ["I don't wish to answer"]] },
    { k: "hispanic", label: "Hispanic or Latino?", type: "select", options: [["", "Choose..."], ["Yes"], ["No"], ["I don't wish to answer"]] },
    { k: "veteran", label: "Veteran status", type: "select", options: [["", "Choose..."], ["Protected veteran"], ["Not a protected veteran"], ["I don't wish to answer"]] },
    { k: "disability", label: "Disability status", type: "select", options: [["", "Choose..."], ["Yes, I have (or previously had) a disability"], ["No, I don't have a disability"], ["I don't wish to answer"]] },
  ],
  applicationChoices: [
    { k: "noncompeteStatus", label: "Subject to any noncompete, nondisclosure, or confidentiality agreement?", type: "select", required: true, options: [["", "Choose..."], ["yes", "Yes"], ["no", "No"]] },
    { k: "recruiterSmsConsent", label: "Receive job-specific recruiter updates by SMS?", type: "select", required: true, options: [["", "Choose..."], ["yes", "Yes"], ["no", "No"], ["ask", "Ask me each time"]] },
    { k: "recruitmentMarketingConsent", label: "Receive recruitment marketing emails?", type: "select", required: true, options: [["", "Choose..."], ["yes", "Yes"], ["no", "No"], ["ask", "Ask me each time"]] },
  ],
  more: [
    { k: "otherFacts", label: "Other true facts the AI may use (one per line)", type: "textarea", wide: true, rows: 4, ph: "Fluent in Spanish\nOn-call rotation lead for 2 years" },
    { k: "commonAnswers", label: "Your own answers to common questions", type: "textarea", wide: true, rows: 4, ph: "Q: Why are you looking for a new role?\nA: ..." },
    { k: "writingSample", label: "Writing sample (optional): a paragraph you wrote, so cover letters sound like you", type: "textarea", wide: true, rows: 3 },
  ],
};
const EXP = [{ k: "title", label: "Title" }, { k: "company", label: "Company" }, { k: "location", label: "Location" }, { k: "start", label: "Start", ph: "Jan 2022" }, { k: "end", label: "End", ph: "Mar 2024" }, { k: "current", label: "I work here now", type: "check" }, { k: "bullets", label: "What you did and achieved (one per line, with real numbers)", type: "textarea", wide: true, rows: 5 }];
const EDU = [{ k: "school", label: "School" }, { k: "degree", label: "Degree", ph: "B.S." }, { k: "field", label: "Field of study" }, { k: "start", label: "Start" }, { k: "end", label: "End / expected" }, { k: "details", label: "Details (honors, GPA, coursework)", wide: true }];
const PROFILE_FIELDS = [...P.basics, ...P.links, ...P.about, ...P.visa, ...P.eeo, ...P.applicationChoices, ...P.more];

const repeatBlock = (kind, fields, item, i) => `<div class="repeat" data-kind="${kind}">${grid(fields, item)}<div class="row" style="margin-top:8px"><button class="btn ghost small" data-remove="${kind}" data-i="${i}">Remove</button></div></div>`;

PAGES.profile = function renderProfile() {
  const p = state.profile;
  const eeoFields = P.eeo.map((f) => {
    const current = String(p[f.k] || "").trim();
    return current && !f.options.some(([value]) => value === current)
      ? { ...f, options: [f.options[0], [current, `Keep existing: ${current}`], ...f.options.slice(1)] }
      : f;
  });
  const COMMON_Q = ["Are you legally authorized to work in the United States?", "Will you now or in the future require sponsorship for employment visa status (e.g. H-1B)?", "Do you currently require sponsorship?", "What is your current visa status? When does your work authorization expire?", "Are you a U.S. person under export control (ITAR/EAR) regulations?", "Do you hold an active security clearance?"];
  $("#tab-profile").innerHTML = `
    <div class="row spread"><div><h2>Your profile</h2><div class="muted">The only facts ApplyPilot puts on applications, resumes and cover letters. Anything not here, it asks you.</div></div><button class="btn" data-save>Save profile</button></div>
    ${card("Start from your resume", `<div class="row"><input type="file" id="cv-file" accept="application/pdf" style="max-width:260px"><span class="muted small">or paste it:</span></div>
      <textarea id="cv-text" rows="3" placeholder="Paste your resume text here" style="margin-top:8px">${esc(p.resumeText || "")}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn ghost" id="cv-import">Fill in my profile from it</button><button class="btn ghost" id="fit-btn">Show jobs that fit my resume</button><span class="small muted">Fills empty fields, adds your roles and education, and saves.</span></div>
      <p class="small" id="cv-status" hidden style="margin:8px 0 0"></p>`)}
    <div id="fit-box"></div>
    ${card("Basics", grid(P.basics, p))}${card("Links", grid(P.links, p))}${card("About you", grid(P.about, p))}
    ${card("Experience", `<div id="exp">${(p.experience || []).map((e, i) => repeatBlock("exp", EXP, e, i)).join("")}</div><button class="btn ghost small" id="add-exp">+ Add a role</button>`)}
    ${card("Education", `<div id="edu">${(p.education || []).map((e, i) => repeatBlock("edu", EDU, e, i)).join("")}</div><button class="btn ghost small" id="add-edu">+ Add education</button>`)}
    ${card("Work authorization &amp; visa", grid(P.visa, p), `<p class="small muted" style="margin-top:-4px">Almost every application asks some of these. ApplyPilot answers them exactly from here and never guesses:</p><ul class="small muted" style="margin:0 0 12px 18px;padding:0">${COMMON_Q.map((q) => `<li>${esc(q)}</li>`).join("")}</ul><p class="small" id="visa-note" style="color:var(--accent)" hidden>Filled in from your visa type. Change anything that's different for you.</p>`)}
    ${card("Voluntary self-identification", grid(eeoFields, p), '<p class="small muted" style="margin-top:-6px">Optional. Choose an answer from each list, or leave it at "Choose..." and ApplyPilot will select the form\'s decline option when available.</p>')}
    ${card("Application choices", grid(P.applicationChoices, p), '<p class="small muted" style="margin-top:-6px">Choose Yes or No for the agreement question. For SMS and marketing email, choose Yes, No, or “Ask me each time.” These choices are required before searching; asking each time does not opt you in or out.</p>')}
    ${card("More about you", grid(P.more, p))}
    <div class="row"><button class="btn" data-save>Save profile</button><span class="small muted">Next: <a href="#preferences">Preferences</a> and <a href="#stories">Stories</a>.</span></div>`;
  const root = $("#tab-profile");
  const collect = () => ({ ...read(root, PROFILE_FIELDS), experience: $$('.repeat[data-kind="exp"]', root).map((b) => read(b, EXP)), education: $$('.repeat[data-kind="edu"]', root).map((b) => read(b, EDU)) });
  const keep = () => { state.profile = { ...state.profile, ...collect() }; };
  $$("[data-save]", root).forEach((b) => (b.onclick = () => busy(b, "Saving...", async () => {
    // A resume waiting in the box gets read first, so pasting it is enough.
    if (pendingResume() && !$$('.repeat[data-kind="exp"]', root).length) { const r = await importResume(); toast(r.missing.length ? `Saved. Still missing: ${r.missing.join(", ")}` : "Profile saved"); return; }
    const r = await put("/api/profile", collect()); await refresh(); toast(r.missing.length ? `Saved. Still missing: ${r.missing.join(", ")}` : "Profile saved");
  })));
  $("#add-exp").onclick = () => { keep(); state.profile.experience.push({}); renderProfile(); };
  $("#add-edu").onclick = () => { keep(); state.profile.education.push({}); renderProfile(); };
  $$("[data-remove]", root).forEach((b) => (b.onclick = () => { keep(); (b.dataset.remove === "exp" ? state.profile.experience : state.profile.education).splice(+b.dataset.i, 1); renderProfile(); }));
  // Picking a visa type fills the usual answers for it.
  $('[name="visaStatus"]', root).onchange = (e) => {
    const v = VISAS.find((x) => x[0] === e.target.value);
    if (!v) return;
    ["workAuthorized", "sponsorNow", "sponsorFuture", "usPerson", "h1bTransfer"].forEach((k, i) => { $(`[name="${k}"]`, root).value = v[i + 1]; });
    $("#visa-note").hidden = false;
  };
  // Reading the resume: fills the profile and saves it right away. Errors show on the card.
  const cvStatus = (msg, bad) => { const el = $("#cv-status"); el.textContent = msg; el.style.color = bad ? "var(--bad)" : "var(--accent)"; el.hidden = !msg; };
  const pendingResume = () => $("#cv-file").files[0] || $("#cv-text").value.trim();
  async function importResume() {
    const file = $("#cv-file").files[0];
    const text = $("#cv-text").value.trim();
    if (!file && !text) throw new Error("Choose a PDF or paste your resume text first.");
    cvStatus("Reading your resume...");
    const body = file ? { pdfBase64: await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(file); }) } : { text };
    let got;
    try { ({ profile: got = {} } = await post("/api/ai/import-resume", body)); }
    catch (err) {
      cvStatus(`Couldn't read your resume: ${err.message}`, true);
      if (text) await put("/api/profile", { resumeText: text }).catch(() => {}); // keep what you pasted
      throw err;
    }
    keep();
    const p = state.profile;
    let filled = 0;
    const asText = (v) => (Array.isArray(v) ? v.join("\n") : v == null ? "" : String(v));
    for (const [k, v] of Object.entries(got)) {
      if (k === "experience" || k === "education" || v === null || (typeof v === "object" && !Array.isArray(v))) continue;
      const val = k === "skills" && Array.isArray(v) ? v.join(", ") : asText(v);
      if (val.trim() && !String(p[k] || "").trim()) { p[k] = val; filled++; }
    }
    const clean = (it) => Object.fromEntries(Object.entries(it || {}).map(([k, v]) => [k, k === "current" ? !!v : asText(v)]));
    const addAll = (list, items, keyOf) => { const have = new Set(list.map(keyOf)); for (const it of (items || []).map(clean)) if (!have.has(keyOf(it))) { list.push(it); filled++; } };
    addAll(p.experience, got.experience, (x) => `${x.company}|${x.title}`.toLowerCase());
    addAll(p.education, got.education, (x) => `${x.school}|${x.degree}`.toLowerCase());
    if (text) p.resumeText = text;
    const { experience, education } = p;
    const saved = await put("/api/profile", { ...p, experience, education });
    state.profile = { ...p };
    await refresh();
    renderProfile();
    cvStatus(`Saved ${filled} item${filled === 1 ? "" : "s"} from your resume (${experience.length} role${experience.length === 1 ? "" : "s"}, ${education.length} education). Check them below.${saved.missing.length ? " Still needed: " + saved.missing.join(", ") + "." : ""}`);
    return saved;
  }
  $("#cv-import").onclick = (e) => busy(e.target, "Reading your resume...", async () => {
    await importResume();
    try { const r = await post("/api/ai/fit-roles", { profile: state.profile }); showFitRoles($("#fit-box"), r.roles || []); } catch (err) { toast(`Couldn't suggest jobs: ${err.message}`); }
  });
  $("#fit-btn").onclick = (e) => busy(e.target, "Matching jobs to your resume...", async () => {
    keep();
    if (!(state.profile.experience || []).length && !state.profile.summary) throw new Error("Import or fill in your resume first.");
    const r = await post("/api/ai/fit-roles", { profile: state.profile });
    showFitRoles($("#fit-box"), r.roles || []);
  });
};

// ---------------- preferences ----------------
const PREF = [
  { k: "seniority", label: "Seniority", ph: "Mid-level, Senior..." },
  { k: "employmentType", label: "Employment type", type: "select", options: [["Full-time"], ["Contract"], ["Part-time"], ["Full-time or contract"]] },
  { k: "remotePreference", label: "Work setting", type: "select", options: [["any", "Any"], ["remote", "Remote"], ["hybrid", "Hybrid"], ["onsite", "On-site"]] },
  { k: "willingToRelocate", label: "Willing to relocate?", type: "select", options: [["no", "No"], ["yes", "Yes"], ["depends", "Depends on the role"]] },
  { k: "salaryExpectation", label: "Salary expectation", ph: "e.g. USD 150,000-175,000", hint: "Required before searching or applying. Enter an amount with currency code, or choose Flexible.", required: true },
  { k: "earliestStart", label: "Earliest start date" }, { k: "noticePeriod", label: "Notice period", ph: "2 weeks" },
  { k: "companySize", label: "Company size", ph: "Startup, mid-size, enterprise..." },
  { k: "industries", label: "Industries you want (or want to avoid)", type: "textarea", rows: 2, wide: true },
  { k: "dealBreakers", label: "Deal-breakers", type: "textarea", rows: 2, wide: true, ph: "No 24/7 on-call, no more than 25% travel..." },
];
PAGES.preferences = function renderPrefs() {
  const p = state.profile;
  const qa = p.prefQA || [];
  const salaryField = PREF.find((f) => f.k === "salaryExpectation");
  const otherPrefFields = PREF.filter((f) => f.k !== "salaryExpectation");
  $("#tab-preferences").innerHTML = `
    <div class="row spread"><div><h2>Preferences</h2><div class="muted">What you're looking for. ApplyPilot uses this to pick jobs and to answer "what are you looking for" questions.</div></div><button class="btn" data-save>Save</button></div>
    ${card("Roles to apply for", `<textarea name="keywords" rows="5" placeholder="Your target role\nDevOps Engineer\nPlatform Engineer">${esc(state.settings.keywords)}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn ghost" id="suggest">Suggest roles and questions from my experience</button><span class="small muted">One title per line. The job search looks for these.</span></div><div id="role-chips" class="chips"></div>`)}
    ${card("The basics", `${grid(otherPrefFields, p)}<div class="grid" style="align-items:end">${field(salaryField, p.salaryExpectation)}<div class="f"><span>Salary option</span><button type="button" class="btn ghost" id="salary-flexible">Set to Flexible</button></div></div>`)}
    ${card("Questions about your experience", `<div id="qa">${qa.length ? qa.map((x, i) => `<div class="repeat" data-qa="${i}"><div class="row spread"><b style="font-size:13.5px">${esc(x.q)}</b><button class="btn ghost small" data-del="${i}">Remove</button></div>${x.why ? `<div class="small muted">${esc(x.why)}</div>` : ""}<textarea rows="2" data-a="${i}" style="margin-top:6px" placeholder="Your answer">${esc(x.a)}</textarea></div>`).join("") : '<p class="muted small">Press "Suggest roles and questions" and ApplyPilot will ask about the choices your experience raises (IC or manager, which domains to stay in, on-call, and so on).</p>'}</div>`)}
    <div class="row"><button class="btn" data-save>Save</button></div>`;
  const root = $("#tab-preferences");
  $("#salary-flexible").onclick = () => { $('[name="salaryExpectation"]', root).value = "Flexible"; };
  const collect = () => {
    const prefQA = (state.profile.prefQA || []).map((x, i) => ({ ...x, a: $(`[data-a="${i}"]`, root)?.value ?? x.a }));
    return { profile: { ...read(root, PREF), prefQA }, keywords: $('[name="keywords"]', root).value };
  };
  const keep = () => { const c = collect(); Object.assign(state.profile, c.profile); state.settings.keywords = c.keywords; };
  $$("[data-save]", root).forEach((b) => (b.onclick = () => busy(b, "Saving...", async () => { const c = collect(); await put("/api/profile", c.profile); await put("/api/settings", { keywords: c.keywords }); await refresh(); toast("Preferences saved"); })));
  $$("[data-del]", root).forEach((b) => (b.onclick = () => { keep(); state.profile.prefQA.splice(+b.dataset.del, 1); renderPrefs(); }));
  $("#suggest").onclick = (e) => busy(e.target, "Thinking about your experience...", async () => {
    keep();
    const [r, fit] = await Promise.all([post("/api/ai/suggest-preferences", { profile: state.profile }), post("/api/ai/fit-roles", { profile: state.profile })]);
    r.roles = (fit.roles || []).map((x) => x.title).concat(r.roles || []).filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
    const why = new Map((fit.roles || []).map((x) => [x.title, `${FIT_LABEL[x.fit] || ""}: ${x.why}`]));
    const have = new Set(state.profile.prefQA.map((x) => x.q.toLowerCase()));
    for (const q of r.questions || []) if (q.q && !have.has(q.q.toLowerCase())) state.profile.prefQA.push({ q: q.q, why: q.why || "", a: "" });
    if (r.seniority && !state.profile.seniority) state.profile.seniority = r.seniority;
    renderPrefs();
    const current = new Set(lines(state.settings.keywords).map((x) => x.toLowerCase()));
    $("#role-chips").innerHTML = (r.roles || []).filter((x) => !current.has(x.toLowerCase())).map((x) => `<button class="chip" data-role="${esc(x)}" title="${esc(why.get(x) || "")}">+ ${esc(x)}</button>`).join("") || '<span class="small muted">Your roles already cover the suggestions.</span>';
    $$("[data-role]").forEach((c) => (c.onclick = () => { const t = $('[name="keywords"]'); t.value = [...lines(t.value), c.dataset.role].join("\n"); c.remove(); }));
    toast("Answer the new questions, add any roles you like, then Save.");
  });
};

// ---------------- stories ----------------
PAGES.stories = function renderStories() {
  const p = state.profile;
  const stories = p.stories || [];
  const roles = [[-1, "General (not tied to one role)"], ...(p.experience || []).map((e, i) => [i, `${e.title || "Role"} at ${e.company || "?"}`])];
  const done = stories.filter((s) => s.answer.trim()).length;
  $("#tab-stories").innerHTML = `
    <div class="row spread"><div><h2>Your stories</h2><div class="muted">Real situations from your work. ApplyPilot uses them to sharpen your resume for each job and to answer custom questions like "Tell us about a time...".</div></div><button class="btn" data-save>Save stories</button></div>
    <div class="card row spread"><span><b>${done}</b> answered${stories.length > done ? ` · ${stories.length - done} waiting for an answer` : ""}</span>
      <span class="row"><button class="btn ghost" id="prompts">Ask me questions based on my experience</button><button class="btn ghost" id="add-story">+ Write my own</button></span></div>
    ${stories.length ? "" : '<div class="card empty">No stories yet. Press "Ask me questions" and ApplyPilot will ask about specific things in your experience. Answer in a few sentences: the situation, what you did, and what changed (with numbers).</div>'}
    <div id="stories">${stories.map((s, i) => `<div class="card story" data-i="${i}">
      <div class="grid"><label class="f wide">The question or topic<input data-k="prompt" value="${esc(s.prompt)}"></label>
      <label class="f">Which role<select data-k="roleIndex">${roles.map(([v, l]) => `<option value="${v}" ${+s.roleIndex === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <label class="f">Tags (optional)<input data-k="tags" value="${esc(s.tags)}" placeholder="leadership, incident response"></label>
      <label class="f wide">Your story<textarea data-k="answer" rows="5" placeholder="Situation: ...\nWhat I did: ...\nResult: ... (numbers if you have them)">${esc(s.answer)}</textarea></label></div>
      <div class="row" style="margin-top:6px"><button class="btn ghost small" data-del="${i}">Remove</button></div></div>`).join("")}</div>
    ${stories.length ? '<div class="row"><button class="btn" data-save>Save stories</button></div>' : ""}`;
  const root = $("#tab-stories");
  const collect = () => $$(".story", root).map((el) => {
    const s = { ...stories[+el.dataset.i] };
    $$("[data-k]", el).forEach((f) => (s[f.dataset.k] = f.dataset.k === "roleIndex" ? +f.value : f.value));
    return s;
  });
  const keep = () => { state.profile.stories = collect(); };
  $$("[data-save]", root).forEach((b) => (b.onclick = () => busy(b, "Saving...", async () => { await put("/api/profile", { stories: collect() }); await refresh(); toast("Stories saved"); renderStories(); })));
  $$("[data-del]", root).forEach((b) => (b.onclick = () => { keep(); state.profile.stories.splice(+b.dataset.del, 1); renderStories(); }));
  $("#add-story").onclick = () => { keep(); state.profile.stories.unshift({ id: "", roleIndex: -1, prompt: "", answer: "", tags: "" }); renderStories(); };
  $("#prompts").onclick = (e) => busy(e.target, "Reading your experience...", async () => {
    keep();
    if (!(state.profile.experience || []).length) throw new Error("Add your experience on the Profile page first.");
    const r = await post("/api/ai/story-prompts", { profile: state.profile });
    const have = new Set(state.profile.stories.map((s) => s.prompt.toLowerCase()));
    const add = (r.prompts || []).filter((x) => x.prompt && !have.has(x.prompt.toLowerCase())).map((x) => ({ id: "", roleIndex: Number.isInteger(x.roleIndex) ? x.roleIndex : -1, prompt: x.prompt, answer: "", tags: "" }));
    state.profile.stories = [...state.profile.stories, ...add];
    renderStories();
    toast(`${add.length} new questions. Answer the ones you have a good story for, then Save.`);
  });
};

// ---------------- job search ----------------
const S = [
  { k: "platformLever", label: "Lever", type: "check" },
  { k: "platformGreenhouse", label: "Greenhouse", type: "check" },
  { k: "platformAshby", label: "Ashby", type: "check" },
  { k: "postedToday", label: "Only jobs posted today (last 24 hours). Off: the last 7 days.", type: "check", wide: true },
  { k: "remoteOk", label: "Remote jobs", type: "check", wide: true },
  { k: "remoteRegions", label: "Remote within (one per line)", type: "textarea", rows: 5, hint: "How postings write the region, e.g. \"Remote - US\"." },
  { k: "locations", label: "On-site or hybrid cities (one per line)", type: "textarea", rows: 5, ph: "Chicago\nAustin" },
  { k: "exclude", label: "Skip titles containing (one per line)", type: "textarea", rows: 5 },
  { k: "autoDiscover", label: "Search again every hour while the extension runs", type: "check", wide: true },
  { k: "fitCheck", label: "Rate each posting against my resume and skip weak fits", type: "check", wide: true },
  { k: "minFit", label: "Apply only to postings rated at least", type: "select", options: [["2", "2 of 5 (almost anything)"], ["3", "3 of 5 (reasonable match)"], ["4", "4 of 5 (strong match)"], ["5", "5 of 5 (near-perfect)"]] },
  { k: "searchProvider", label: "Search engine", type: "select", options: [["serper", "Serper (Google results)"], ["brave", "Brave Search"]] },
];
PAGES.search = function renderSearch() {
  const s = state.settings;
  const ld = state.lastDiscovery;
  const roles = lines(s.keywords);
  const missing = state.missing || [];
  const skipped = ld?.skipped ? Object.entries(ld.skipped).map(([k, v]) => `${v} ${k}`).join(", ") : "";
  const f = (k) => S.find((x) => x.k === k);
  $("#tab-search").innerHTML = `
    <h2>Job search</h2><div class="muted">ApplyPilot searches the web for new postings on these job platforms, then reads each posting to check the role, location and date.</div>
    ${card("Roles", roles.length ? `<div class="chips" style="margin:0">${roles.map((r) => `<span class="chip">${esc(r)}</span>`).join("")}</div><p class="small muted">Change them in <a href="#preferences">Preferences</a>.</p>` : '<p>No roles yet. Add them in <a href="#preferences">Preferences</a> (ApplyPilot can suggest them from your experience).</p>')}
    ${card("Where to look", `<div class="row" style="gap:22px">${["platformLever", "platformGreenhouse", "platformAshby"].map((k) => field(f(k), s[k])).join("")}</div><div style="margin-top:10px">${field(f("postedToday"), s.postedToday)}</div>`)}
    ${card("Location", `${field(f("remoteOk"), s.remoteOk)}<div class="grid" style="margin-top:10px">${["remoteRegions", "locations", "exclude"].map((k) => field(f(k), s[k])).join("")}</div>`)}
    ${card("Fit", `${field(f("fitCheck"), s.fitCheck)}<div class="grid" style="margin-top:10px">${field(f("minFit"), String(s.minFit))}</div><p class="small muted">Weak fits show under Applications as Skipped, with the reason, so you can still send one.</p>`)}
    ${card("Search engine", `<div class="grid">${field(f("searchProvider"), s.searchProvider)}</div><p class="small muted">${s.hasSearchKey ? "APPLYPILOT_SEARCH_KEY is configured in the server environment." : "Set APPLYPILOT_SEARCH_KEY in the server environment, then restart the server. Serper (serper.dev) or Brave Search (api.search.brave.com) keys are supported."}</p>${field(f("autoDiscover"), s.autoDiscover)}`)}
    ${card("What it will search", `<pre id="qprev" style="margin:0">${esc((state.queries || []).join("\n\n") || "Add roles and turn on a platform to see the search.")}</pre>`)}
    ${missing.length ? `<div class="banner" role="alert">Fix these profile items before starting a job search: <b>${esc(missing.join(", "))}</b>. Complete your details under <a href="#profile">Profile</a> or set salary under <a href="#preferences">Preferences</a>. Notice defaults to two weeks, and stories are optional.</div>` : ""}
    <div class="row"><button class="btn" id="save-search">Save</button><button class="btn ghost" id="run-search"${missing.length ? " disabled" : ""}>Save and search now</button></div>
    <p class="small muted" id="ld">${ld ? `Last search ${ago(ld.at)}: ${ld.queries} queries, ${ld.postings ?? 0} postings found, ${ld.seen} matched, ${ld.added} new.${skipped ? ` Left out: ${esc(skipped)}.` : ""}${ld.errors?.length ? ` <span style="color:var(--bad)">${esc(ld.errors.join("; "))}</span>` : ""}` : "Not searched yet."}</p>
    ${card("Add one job by link", `<div class="row"><input id="job-url" placeholder="A jobs.lever.co, job-boards.greenhouse.io or jobs.ashbyhq.com link" style="flex:1"><button class="btn" id="add-job">Add to the front of the line</button></div>`)}`;
  const root = $("#tab-search");
  const collect = () => read(root, S);
  let t;
  root.oninput = root.onchange = () => { clearTimeout(t); t = setTimeout(async () => { const r = await post("/api/search/preview", collect()).catch(() => null); if (r) $("#qprev").textContent = r.queries.join("\n\n") || "Add roles and turn on a platform to see the search."; }, 250); };
  const save = () => put("/api/settings", collect());
  $("#save-search").onclick = (e) => busy(e.target, "Saving...", async () => { await save(); await refresh(); toast("Saved"); });
  $("#run-search").onclick = (e) => busy(e.target, "Searching...", async () => { await save(); const r = await post("/api/discover"); await refresh(); renderSearch(); toast(r.errors?.length ? r.errors[0] : `${r.added} new jobs queued (${r.seen} matched)`); });
  $("#add-job").onclick = (e) => busy(e.target, "Adding...", async () => { const r = await post("/api/jobs", { url: $("#job-url").value }); toast(`Added: ${r.job.company}, ${r.job.title}`); $("#job-url").value = ""; refresh(); });
};

// ---------------- applications ----------------
let filter = "";
PAGES.applications = async function renderApps() {
  const list = await api("/api/jobs" + (filter ? `?status=${filter}` : ""));
  const by = state.stats.byStatus;
  const chips = [["", `All ${state.stats.total}`], ...["needs_you", "submitted", "applying", "queued", "skipped", "failed"].map((k) => [k, `${STATUS_LABEL[k]} ${by[k] || 0}`])];
  $("#tab-applications").innerHTML = `
    <div class="row spread"><div><h2>Applications</h2><div class="muted">Everything ApplyPilot found, sent or needs your help with.</div></div>
    ${by.queued ? '<button class="btn ghost small" id="clear-q">Clear the line</button>' : ""}</div>
    <div class="chips">${chips.map(([k, l]) => `<button class="chip ${filter === k ? "on" : ""}" data-f="${k}">${esc(l)}</button>`).join("")}</div>
    ${list.length ? `<table><thead><tr><th>Company</th><th>Role</th><th>Fit</th><th>Status</th><th>Updated</th></tr></thead><tbody>
      ${list.map((j) => `<tr class="click" data-id="${esc(j.id)}"><td><b>${esc(j.company)}</b><div class="small muted">${esc(j.ats)}</div></td><td>${esc(j.title)}<div class="small muted">${esc(j.location || "")}</div></td>
      <td>${j.fit ? `<span class="st fitn fitn-${j.fit.score}" title="${esc(j.fit.why)}">${j.fit.score}/5</span>` : '<span class="small muted">-</span>'}</td>
      <td><span class="st st-${esc(j.status)}">${esc(STATUS_LABEL[j.status] || j.status)}</span>${j.reason ? `<div class="small muted">${esc(j.reason.slice(0, 120))}</div>` : ""}</td><td class="small muted">${ago(j.updatedAt)}</td></tr>`).join("")}
    </tbody></table>` : `<div class="card empty">Nothing here yet. Set up your <a href="#preferences">roles</a> and <a href="#search">job search</a>, then press Start in the extension.</div>`}`;
  $$("[data-f]").forEach((c) => (c.onclick = () => { filter = c.dataset.f; renderApps(); }));
  $$("tr[data-id]").forEach((r) => (r.onclick = () => openJob(r.dataset.id)));
  const cq = $("#clear-q");
  if (cq) cq.onclick = async () => { if (!confirm("Skip every job still in line?")) return; await post("/api/jobs/skip-queued"); await refresh(); renderApps(); };
};

async function openJob(id) {
  const j = await api(`/api/jobs/${encodeURIComponent(id)}`);
  document.querySelector(".detail")?.remove();
  const d = document.createElement("div");
  d.className = "detail";
  const file = (kind, label) => `<a href="/files/${encodeURIComponent(j.id)}/${kind}.pdf?t=${encodeURIComponent(TOKEN)}" target="_blank">${label}</a>`;
  d.innerHTML = `
    <div class="row spread"><span class="st st-${esc(j.status)}">${esc(STATUS_LABEL[j.status] || j.status)}</span><button class="btn ghost small" id="close">Close</button></div>
    <h2 style="margin-top:10px">${esc(j.title)}</h2><div class="muted">${esc(j.company)} · ${esc(j.location || "")}${j.postedAt ? ` · posted ${esc(new Date(j.postedAt).toLocaleDateString())}` : ""} · <a href="${esc(j.url)}" target="_blank" rel="noopener">open posting</a></div>
    ${j.reason ? `<div class="banner ${j.status === "submitted" ? "info" : ""}" style="margin-top:12px;white-space:pre-wrap">${esc(j.reason)}</div>` : ""}
    <div class="row" style="margin:12px 0">
      ${j.status !== "queued" && j.status !== "submitted" ? '<button class="btn small" data-set="queued">Put back in line</button>' : ""}
      ${j.status === "queued" ? '<button class="btn ghost small" data-set="skipped">Skip</button>' : ""}
      ${j.status === "needs_you" ? '<button class="btn ghost small" data-set="submitted">I sent it myself</button>' : ""}
      ${j.files?.status === "ready" ? `${file("resume", "Tailored resume")} · ${file("cover", "Cover letter")}` : j.files?.status === "failed" ? `<span class="small muted">Documents failed: ${esc(j.files.error)}</span>` : ""}
    </div>
    ${j.fit ? `<p><span class="st fitn fitn-${j.fit.score}">Fit ${j.fit.score}/5</span> <span class="small muted">${esc(j.fit.why)}</span></p>` : ""}
    ${j.files?.requirements?.length ? `<h3>Job requirements vs. your profile and stories</h3><ul class="small" style="padding-left:18px">${j.files.requirements.map((r) => r.supported ? `<li>✓ ${esc(r.requirement)}</li>` : `<li class="muted">✗ ${esc(r.requirement)}: not in your profile or stories, so left out</li>`).join("")}</ul>` : ""}
    ${j.files?.storiesUsed?.length ? `<p class="small"><b>Stories used:</b> ${j.files.storiesUsed.map(esc).join(" · ")}</p>` : ""}
    ${j.files?.removed?.length ? `<details><summary class="small"><b>${j.files.removed.length}</b> line${j.files.removed.length > 1 ? "s" : ""} removed: numbers not in your profile or stories</summary><ul class="small">${j.files.removed.map((r) => `<li><span class="muted">${esc(r.where)}:</span> ${esc(r.text)} <span class="muted">(${esc(r.numbers.join(", "))})</span></li>`).join("")}</ul></details>` : ""}
    ${j.confirmation ? `<h3 style="margin-top:14px">Confirmation</h3><pre>${esc(j.confirmation.text.slice(0, 1200))}</pre>` : ""}
    ${j.answers?.length ? `<h3>What went on the form</h3>${j.answers.map((a) => `<div class="qa"><div class="q">${esc(a.question)}${a.source === "visa" ? " · from your visa section" : ""}</div><div class="a">${esc(a.answer || "(left empty)")}</div></div>`).join("")}` : ""}
    <details style="margin-top:14px"><summary class="muted small">Job description</summary><pre>${esc((j.description || "").slice(0, 8000))}</pre></details>
    ${j.log?.length ? `<details><summary class="muted small">Log</summary><pre>${esc(j.log.join("\n"))}</pre></details>` : ""}`;
  document.body.appendChild(d);
  $("#close", d).onclick = () => d.remove();
  $$("[data-set]", d).forEach((b) => (b.onclick = async () => { await post(`/api/jobs/${encodeURIComponent(j.id)}/status`, { status: b.dataset.set }); d.remove(); await refresh(); PAGES.applications(); }));
}

// ---------------- settings ----------------
const SET = [
  { k: "model", label: "Model", hint: "Any Claude model id your key can use." },
  { k: "dailyLimit", label: "Max applications per day (0 = no limit)", type: "number" },
  { k: "autoAcknowledge", label: 'Tick plain "the information I gave is accurate" / "I read the privacy notice" boxes for me', type: "check", wide: true, hint: "Legal signatures, background-check authorizations and agreements always come to you." },
];
PAGES.settings = function renderSettings() {
  const s = state.settings;
  const t = state.tokens;
  $("#tab-settings").innerHTML = `
    <h2>Settings</h2>
    <div class="card">${grid(SET, s)}
      <p class="small muted">${s.envKey ? "ANTHROPIC_API_KEY is configured in the server environment." : "Claude features require ANTHROPIC_API_KEY in the server environment. Restart the server after setting it."}${t ? ` Tokens used so far: ${t.input.toLocaleString()} in / ${t.output.toLocaleString()} out.` : ""}</p>
      <div class="row"><button class="btn" id="save-set">Save</button></div></div>
    <div class="card"><h3>Connect the extension</h3>
      <p class="muted">Open the ApplyPilot extension's popup and paste this token. Keep it private: it lets the extension use your profile and your API key.</p>
      <code class="token">${esc(state.token)}</code><div class="row" style="margin-top:8px"><button class="btn ghost small" id="copy">Copy token</button></div></div>
    ${state.events.length ? `<div class="card"><h3>Recent problems</h3>${state.events.map((e) => `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--line)"><span class="muted">${ago(e.at)} · ${esc(e.kind)}</span> ${esc(e.message.slice(0, 300))}</div>`).join("")}</div>` : ""}`;
  $("#save-set").onclick = (e) => busy(e.target, "Saving...", async () => { await put("/api/settings", read($("#tab-settings"), SET)); await refresh(); renderSettings(); toast("Saved"); });
  $("#copy").onclick = async () => { await navigator.clipboard.writeText(state.token); toast("Copied"); };
};

(async () => {
  await refresh();
  show(tab);
  setInterval(async () => { await refresh(); if (tab === "applications" && !document.querySelector(".detail")) PAGES.applications(); }, 10000);
})();
