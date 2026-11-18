// The thinking: answering application questions and tailoring the resume and cover letter.
// Rule everywhere: only facts from your profile. Anything it can't answer from them goes to
// you ("needs you") instead of being guessed.
const store = require("./store");
const claude = require("./claude");
const { renderResume, renderCoverLetter } = require("./pdf");
const fs = require("fs");

const MOCK = process.env.APPLYPILOT_MOCK_AI === "1";
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const low = (s) => norm(s).toLowerCase();
const list = (s) => String(s || "").split(/\n|,(?![^(]*\))/).map(norm).filter(Boolean);

/** The profile with empty fields dropped: what Claude is allowed to use. Stories carry the role they belong to. */
function facts(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "stories" || k === "prefQA" || k === "resumeText") continue;
    if (Array.isArray(v) ? v.length : String(v ?? "").trim()) out[k] = v;
  }
  const roleName = (i) => { const e = p.experience?.[i]; return e ? `${e.title} at ${e.company}` : "general"; };
  const stories = (p.stories || []).filter((x) => norm(x.answer)).map((x) => ({ role: roleName(x.roleIndex), roleIndex: x.roleIndex, about: x.prompt, story: x.answer, tags: x.tags || undefined }));
  if (stories.length) out.stories = stories;
  const qa = (p.prefQA || []).filter((x) => norm(x.a));
  if (qa.length) out.preferenceAnswers = qa;
  return out;
}

function profileReady(p) {
  const missing = [];
  if (!p.firstName || !p.lastName) missing.push("name");
  if (!p.email) missing.push("email");
  if (!p.phone) missing.push("phone");
  if (!p.experience?.length && !p.education?.length) missing.push("experience or education");
  if (!p.workAuthorized || (!p.sponsorNow && !p.sponsorFuture)) missing.push("work authorization & visa");
  if (!norm(p.city) || !norm(p.country)) missing.push("present work location (city and country)");
  const salary = norm(p.salaryExpectation);
  if (!salary) missing.push("salary expectation (amount with currency code, or Flexible)");
  else if (!/^flexible$/i.test(salary) && !/\b(?:USD|EUR|GBP|CHF|DKK|SEK|NOK|PLN|CZK|HUF|RON|AED|SAR|ZAR|CAD|AUD|NZD|INR|JPY|SGD|HKD|MXN|BRL)\b/i.test(salary)) {
    missing.push("salary currency code (or choose Flexible)");
  }
  for (const [key, label, allowed] of [
    ["noncompeteStatus", "noncompete/confidentiality agreement choice", ["yes", "no"]],
    ["recruiterSmsConsent", "recruiter SMS choice", ["yes", "no", "ask"]],
    ["recruitmentMarketingConsent", "recruitment marketing email choice", ["yes", "no", "ask"]],
  ]) {
    if (!allowed.includes(low(p[key]))) missing.push(label);
  }
  return missing;
}

const fullName = (p) => norm(`${p.firstName} ${p.lastName}`);
const cityState = (p) => [p.city, p.state].filter(Boolean).join(", ");
const presentWorkLocation = (p) => p.city && p.country ? [p.city, p.state, p.country].filter(Boolean).join(", ") : "";
function applicationWorkLocation(p, job) {
  const isRemote = job.remote === true || /\bremote\b/i.test(`${job.location || ""} ${job.workplaceType || ""}`);
  if (isRemote || p.willingToRelocate === "no") return presentWorkLocation(p);
  if (p.willingToRelocate === "yes") return job.location || "";
  return "";
}

// ---------------- answers ----------------
// The obvious contact fields are filled straight from the profile: faster, cheaper and exact.
const DIRECT = [
  [/\b(preferred|nick) ?name\b/, (p) => p.preferredName || p.firstName],
  [/^(legal )?first name|given name|^first\b/, (p) => p.firstName],
  [/^(legal )?last name|surname|family name|^last\b/, (p) => p.lastName],
  [/^(full |legal )?name\b|^your name\b/, fullName],
  [/e-?mail/, (p) => p.email],
  [/phone|mobile number|cell/, (p) => p.phone],
  [/linkedin/, (p) => p.linkedin],
  [/github/, (p) => p.github],
  [/portfolio|personal (web)?site|^website\b/, (p) => p.portfolio],
  [/^(current )?(company|employer)\b|current (company|employer)/, (p) => p.currentCompany],
  [/^(current )?location\b|^city\b|where are you (currently )?(located|based)/, cityState],
  [/\b(salary|compensation) expectations?\b|\bexpected (annual )?(salary|compensation)\b/, (p) => p.salaryExpectation],
];

// Work-authorization questions, answered straight from the visa section when it's filled in.
const yesNo = (q, yes) => q.options?.find((o) => (yes ? /^\s*yes\b/i : /^\s*no\b/i).test(o));
function visaAnswer(q, p) {
  if (!q.options?.length || !["select", "radio", "combobox"].includes(q.type)) return null;
  const l = low(q.label);
  const isYes = (v) => v === "yes";
  let want = null;
  if (/sponsor/.test(l)) {
    if (!p.sponsorNow && !p.sponsorFuture) return null;
    want = /future|ever|will you (now|require)|now or/.test(l) ? isYes(p.sponsorNow) || isYes(p.sponsorFuture) : /current|right now|today|at this time/.test(l) ? isYes(p.sponsorNow) : isYes(p.sponsorNow) || isYes(p.sponsorFuture);
  } else if (/(legally )?(authori[sz]ed|eligible|permitted) to work|right to work|work authori[sz]ation/.test(l)) {
    if (!p.workAuthorized) return null;
    want = isYes(p.workAuthorized);
  } else if (/u\.?s\.? person|itar|export (control|regulation)|\bear\b/.test(l)) {
    if (!p.usPerson) return null;
    want = isYes(p.usPerson);
  } else if (/security clearance/.test(l) && /(have|hold|possess|active|current)/.test(l)) {
    if (!p.clearance) return null;
    want = !/^(none|no|n\/a)$/i.test(norm(p.clearance));
  } else if (/h-?1b/.test(l) && /transfer/.test(l)) {
    if (!p.h1bTransfer) return null;
    want = isYes(p.h1bTransfer);
  } else return null;
  const opt = yesNo(q, want);
  return opt ? { key: q.key, action: "fill", options: [opt], source: "visa" } : null;
}

function savedApplicationChoice(q, p) {
  if (!q.options?.length || !["select", "radio", "combobox"].includes(q.type)) return null;
  const label = low(q.label);
  const choice = /non.?compete|non.?disclosure|nondisclosure|confidentiality agreement/.test(label) ? p.noncompeteStatus
    : /\bsms\b/.test(label) ? p.recruiterSmsConsent
    : /recruitment marketing|marketing communications|marketing emails?/.test(label) ? p.recruitmentMarketingConsent
    : "";
  const desired = low(choice);
  if (!["yes", "no"].includes(desired)) return null;
  const option = q.options.find((item) => low(item) === desired) || q.options.find((item) => new RegExp(`^${desired}\\b`).test(low(item)));
  return option ? { key: q.key, action: "fill", options: [option], source: "profile" } : null;
}

function countryAnswer(q, p) {
  const label = low(q.label);
  if (!/^country\b/.test(label) || /citizenship/.test(label) || !norm(p.country)) return null;
  const countryName = (value) => low(value).replace(/\s*\(\s*\+\s*\d+\s*\)\s*$/, "").replace(/\s*\+\s*\d+\s*$/, "").trim();
  const option = q.options?.find((item) => countryName(item) === countryName(p.country));
  if (option) return { key: q.key, action: "fill", options: [option], source: "profile" };
  if (["text", "combobox"].includes(q.type)) return { key: q.key, action: "fill", value: p.country, source: "profile" };
  return null;
}

function direct(q, p, job = {}) {
  const v = visaAnswer(q, p);
  if (v) return v;
  const savedChoice = savedApplicationChoice(q, p);
  if (savedChoice) return savedChoice;
  const label = low(q.label);
  const country = countryAnswer(q, p);
  if (country) return country;
  if (q.type === "file") {
    if (/cover/.test(label)) return { key: q.key, action: "upload", file: "cover", source: "rule" };
    if (/resume|cv\b|curriculum/.test(label)) return { key: q.key, action: "upload", file: "resume", source: "rule" };
    return null;
  }
  if (!["text", "email", "tel", "url", "combobox"].includes(q.type)) return null;
  if (label.length > 90 && !/\b(salary|compensation|notice period|availability to start|earliest start)\b/.test(label)) return null;
  if (/^(which )?(city|location)\b.*\b(work|country)\b|where .*work from/.test(label)) {
    const value = applicationWorkLocation(p, job);
    if (!value) return null;
    const isRemote = job.remote === true || /\bremote\b/i.test(`${job.location || ""} ${job.workplaceType || ""}`);
    return { key: q.key, action: "fill", value, source: isRemote || p.willingToRelocate === "no" ? "profile" : "job posting" };
  }
  if (/^location\s*\(city\)|^city\b/.test(label)) {
    const value = applicationWorkLocation(p, job);
    if (!value) return null;
    const city = low(value.split(",")[0]);
    const isRemote = job.remote === true || /\bremote\b/i.test(`${job.location || ""} ${job.workplaceType || ""}`);
    const source = isRemote || p.willingToRelocate === "no" ? "profile" : "job posting";
    const option = q.options?.find((item) => low(item) === low(value))
      || q.options?.find((item) => low(item).startsWith(`${city},`) && (!p.country || low(item).includes(low(p.country))))
      || q.options?.find((item) => low(item).startsWith(city));
    if (option) return { key: q.key, action: "fill", options: [option], source };
    return {
      key: q.key,
      action: "fill",
      value: ["combobox"].includes(q.type) ? value : value.split(",")[0],
      source,
    };
  }
  if (/\bnotice period\b|\bavailability to start\b|\bearliest start\b/.test(label)) {
    const value = p.noticePeriod || p.earliestStart;
    return { key: q.key, action: "fill", value: value || "2 weeks", source: value ? "profile" : "rule" };
  }
  for (const [rx, get] of DIRECT) {
    if (rx.test(label)) {
      const v = get(p, job);
      if (v) return { key: q.key, action: "fill", value: v, source: "profile" };
      return null;
    }
  }
  return null;
}

const SYSTEM = `You fill out job applications for one person, using ONLY the facts in their profile.
Hard rules:
- Never invent facts: no employers, titles, dates, degrees, numbers, skills, certifications or legal statuses that aren't in the profile. For salary, use the profile's required salaryExpectation exactly, including "Flexible". If it is missing, put the question in "needs_you"; do not substitute a market rate or posting range.
- For select, radio and checkbox_group questions, answer with option text copied EXACTLY from the options list.
- Demographic / EEO questions (gender, race, ethnicity, Hispanic/Latino, veteran, disability, pronouns): use the profile's answer if it has one; otherwise choose the option that declines to answer ("I don't wish to answer", "Decline to self-identify" or similar). If there is no decline option and no profile answer, use needs_you.
- Work authorization and visa: use the profile's visaStatus, visaExpiry, workAuthorized, sponsorNow, sponsorFuture, h1bTransfer, citizenship, usPerson and clearance. "Now or in the future" sponsorship = yes if either sponsorNow or sponsorFuture is yes. A question about visa type gets visaStatus. If the needed field is empty, use needs_you; never guess immigration status.
- For work-location questions, remote roles use the profile's present city/state/country. For other roles, use that present location if willingToRelocate is "no", and the posting location if it is "yes"; if relocation is "depends" or unknown, use needs_you.
- Custom and behavioral questions ("Tell us about a time...", "Describe a project...", "How have you handled..."): use relevant profile stories when available; otherwise use documented experience bullets, summary, skills and other profile facts. Synthesize a concise first-person answer only from those sources. For multi-part questions, answer the parts supported by the profile and omit unsupported details; never claim unrecorded leadership, tools, processes or outcomes. If no story or profile fact supports a required behavioral textarea, return action "leave" and continue without inventing an answer. Use preferenceAnswers for questions about what the person wants.
- Questions about existing noncompete, nondisclosure or confidentiality agreements: use only the saved profile choice; if it's missing or "Ask me each time", use needs_you. This status question is different from agreeing to new terms.
- Legal signatures, background-check / FCRA authorizations, drug-test consents, arbitration agreements, and anything asking the person to sign or accept legal terms: always needs_you.
- SMS and recruitment-marketing consent: use only the saved profile choice; if it's missing or "Ask me each time", use needs_you. Never infer consent or opt the person in.
- Plain acknowledgements ("I confirm the information is accurate", "I have read the privacy notice", data-processing consent for this application): ${"{ACK}"}
- Open questions ("Why do you want to work here?", "Tell us about a project"): write a short, specific, first-person answer (2-5 sentences unless a length is given) that connects real profile facts to this job. Plain language, no buzzwords, no exaggeration. Respect maxLength.
- "How did you hear about us": pick a neutral option such as "Company website" / "Job board" if present, or write "Company careers page".
- Optional questions you can't answer from the profile: action "leave".
Reply with JSON only:
{"answers":[{"key":"...","action":"fill","value":"text"} | {"key":"...","action":"fill","options":["Exact option"]} | {"key":"...","action":"check"} | {"key":"...","action":"leave"} | {"key":"...","action":"upload","file":"resume"|"cover"}],
 "needs_you":[{"key":"...","reason":"..."}]}`;

function mockAnswer(q) {
  if (q.options?.length) {
    const decline = q.options.find((o) => /decline|don.t wish|prefer not/i.test(o));
    return { key: q.key, action: "fill", options: [decline || q.options.find((o) => /^yes$/i.test(o)) || q.options[0]] };
  }
  if (q.type === "checkbox") return { key: q.key, action: "check" };
  if (q.type === "file") return { key: q.key, action: "leave" };
  return { key: q.key, action: "fill", value: q.type === "textarea" ? "I'm excited about this role because it matches my experience." : "Mock answer" };
}

/** Make sure every answer fits its question; anything that doesn't becomes needs_you or leave. */
function validate(questions, raw) {
  const byKey = new Map(questions.map((q) => [q.key, q]));
  const answers = [];
  const needs = [...(raw.needs_you || [])].filter((n) => byKey.has(n.key)).map((n) => ({ key: n.key, label: byKey.get(n.key).label, reason: norm(n.reason).slice(0, 200) || "Not in your profile" }));
  const needKeys = new Set(needs.map((n) => n.key));
  for (const a of raw.answers || []) {
    const q = byKey.get(a.key);
    if (!q || needKeys.has(a.key) || answers.some((x) => x.key === a.key)) continue;
    const bad = (reason) => { if (q.required) { needs.push({ key: q.key, label: q.label, reason }); needKeys.add(q.key); } else answers.push({ key: q.key, action: "leave" }); };
    if (a.action === "leave") {
      const skipRequired = q.required && q.type === "textarea" && /\b(tell us about|describe|how have you|what have you|experience leading|project|example)\b/i.test(q.label);
      answers.push({ key: q.key, action: "leave", ...(skipRequired ? { skipRequired: true } : {}) });
      continue;
    }
    if (a.action === "upload") { answers.push({ key: q.key, action: "upload", file: a.file === "cover" ? "cover" : "resume", source: a.source || "ai" }); continue; }
    if (q.type === "checkbox") { answers.push({ key: q.key, action: a.action === "check" || a.value === true || /^(yes|true|checked)$/i.test(a.value || "") ? "check" : "leave", source: "ai" }); continue; }
    if (["select", "radio", "checkbox_group"].includes(q.type) || (q.options?.length && q.type !== "combobox")) {
      const wanted = (a.options?.length ? a.options : [a.value]).filter(Boolean);
      const exact = wanted.map((w) => q.options.find((o) => low(o) === low(w))).filter(Boolean);
      if (!exact.length || (q.type !== "checkbox_group" && exact.length > 1)) { bad(`Answer "${wanted.join(", ").slice(0, 80)}" isn't one of the options`); continue; }
      answers.push({ key: q.key, action: "fill", options: q.type === "checkbox_group" ? exact : [exact[0]], source: "ai" });
      continue;
    }
    let value = norm(a.value ?? a.options?.[0] ?? "");
    if (q.type === "textarea") value = String(a.value ?? "").trim();
    if (!value) { bad("No answer in your profile"); continue; }
    if (q.maxLength && value.length > q.maxLength) value = value.slice(0, q.maxLength).replace(/\s+\S*$/, "");
    answers.push({ key: q.key, action: "fill", value, source: "ai" });
  }
  // Questions the model skipped: required ones need the person, optional ones stay empty.
  for (const q of questions) {
    if (answers.some((a) => a.key === q.key) || needKeys.has(q.key)) continue;
    if (q.required && !String(q.current || "").trim()) needs.push({ key: q.key, label: q.label, reason: "No answer in your profile" });
  }
  return { answers, needs_you: needs };
}

async function answerQuestions(job, questions) {
  const p = store.db.profile;
  const s = store.db.settings;
  const pre = [];
  const rest = [];
  for (const q of questions) {
    // A text box that asks for the cover letter gets this job's tailored letter.
    if (q.type === "textarea" && /^cover letter\b/i.test(norm(q.label)) && job.files?.coverText) {
      pre.push({ key: q.key, action: "fill", value: q.maxLength ? job.files.coverText.slice(0, q.maxLength) : job.files.coverText, source: "cover letter" });
      continue;
    }
    const d = direct(q, p, job);
    if (d) pre.push(d);
    else rest.push(q);
  }
  if (!rest.length) return { answers: pre, needs_you: [] };
  let raw;
  if (MOCK) raw = { answers: rest.map(mockAnswer), needs_you: [] };
  else {
    const ack = s.autoAcknowledge ? 'tick them ("check").' : "needs_you (the person prefers to tick these themselves).";
    raw = await claude.askJSON({
      system: SYSTEM.replace("{ACK}", ack),
      maxTokens: 6000,
      prompt: `PROFILE (the only facts you may use):\n${JSON.stringify(facts(p), null, 1)}\n\nJOB: ${job.title} at ${job.company} (${job.location || "location not listed"})\nPOSTED COMPENSATION: ${JSON.stringify(job.compensation ?? null)}\n${String(job.description || "").slice(0, 7000)}\n\nQUESTIONS (key, label, type, required, options, maxLength):\n${JSON.stringify(rest.map(({ key, label, type, required, options, maxLength }) => ({ key, label, type, required, options, maxLength })), null, 1)}`,
    });
  }
  const v = validate(rest, raw);
  return { answers: [...pre, ...v.answers], needs_you: v.needs_you };
}

// ---------------- tailored documents ----------------
const TAILOR_SYSTEM = `You tailor one person's resume and write their cover letter for one specific job.

YOUR ONLY SOURCES are (1) PROFILE and (2) STORIES, both written by the person. Nothing else is true about them: not the job description, not what's typical for the role, not your assumptions.

How to work:
1. Read the job description and list its key requirements.
2. For each requirement, look for supporting facts in the profile and stories. Use only the facts that match a requirement. Leave out stories that don't match any requirement.
3. A requirement with no supporting fact is left out. Never imply experience the person didn't describe.

Never invent or inflate:
- No numbers, percentages, money, team sizes, user counts, durations or dates that aren't written in the sources.
- No tools, technologies, skills, certifications, employers, titles, projects or outcomes that aren't written in the sources.
- Keep meaning and scope: don't turn "helped with" into "led", "contributed to" into "owned", or one project into "multiple".
- You may reword for clarity, reorder, merge two true bullets, drop bullets, and borrow the job's vocabulary only where it describes the same thing the person did.

Where facts go:
- A story's facts become bullets only under the role it belongs to (its roleIndex). General stories (roleIndex -1) may inform only the summary and the cover letter.
- Skills: choose and order from the profile's skills list only.

Output:
- Resume: a 1-2 line summary aimed at this job; then 3-6 bullets per role (more for recent, relevant roles) that lead with what the job needs. Strong verbs, concrete, no fluff.
- Cover letter: 3-4 short paragraphs, 220-330 words, first person, plain and direct, specific to this company and role. It may mention things from the job description as what the company needs, but every claim about the person must come from the sources. No clichés ("I am writing to express my interest", "passionate", "synergy"), no em dashes. If there's a writing sample, match its voice.
- requirements: each key requirement you found, with whether the sources support it.
- stories_used: ids of the stories you drew on.

Reply with JSON only:
{"requirements":[{"requirement":"...","supported":true}],
 "headline":"...","summary":"...","skills":["..."],
 "experience":[{"index":0,"bullets":["..."]}],
 "cover_letter":{"greeting":"Dear ...,","paragraphs":["...","..."]},
 "stories_used":["story id"]}`;

function fmtDates(e) {
  const end = e.current ? "Present" : e.end;
  return [e.start, end].filter(Boolean).join(" – ");
}
function contactLine(p) {
  return [cityState(p), p.phone, p.email, p.linkedin?.replace(/^https?:\/\/(www\.)?/, ""), p.portfolio?.replace(/^https?:\/\//, ""), p.github?.replace(/^https?:\/\/(www\.)?/, "")].filter(Boolean);
}

// ----- the code check: any number in generated text must appear in the person's own words -----
// An amount is compared whole: "$2M" must appear as "$2M" (or "$2 million"), not just any "2".
const SUFFIX = { "%": "%", percent: "%", k: "k", thousand: "k", m: "m", mm: "m", million: "m", b: "b", bn: "b", billion: "b", x: "x" };
const numTokens = (text) => {
  const t = String(text || "").toLowerCase().replace(/(\d),(?=\d{3})/g, "$1");
  return [...t.matchAll(/(\$)?(\d+(?:\.\d+)?)(?:\s?(%|percent\b|k\b|thousand\b|mm\b|m\b|million\b|bn\b|b\b|billion\b|x\b))?/g)]
    .map((m) => `${m[1] || ""}${parseFloat(m[2])}${m[3] ? SUFFIX[m[3]] : ""}`);
};
/** Numbers in `text` that don't appear anywhere in `source`. */
function unsupportedNumbers(text, source) {
  const have = new Set(numTokens(source));
  return [...new Set(numTokens(text))].filter((n) => !have.has(n));
}
/** Splits text into sentences and drops any with an unsupported number; returns kept text and what was dropped. */
function keepSupportedSentences(text, source, removed, where) {
  const parts = String(text || "").match(/[^.!?]+[.!?]*(\s+|$)/g) || [];
  const kept = parts.filter((sn) => { const bad = unsupportedNumbers(sn, source); if (bad.length) removed.push({ where, text: norm(sn), numbers: bad }); return !bad.length; });
  return norm(kept.join(""));
}

function sourcesFor(p) {
  const stories = (p.stories || []).filter((x) => norm(x.answer));
  const role = (i) => [p.experience[i]?.bullets, p.experience[i]?.title, p.experience[i]?.company, p.experience[i]?.start, p.experience[i]?.end, p.experience[i]?.location, ...stories.filter((x) => x.roleIndex === i).map((x) => x.answer)].join("\n");
  const all = JSON.stringify({ ...p, stories: stories.map((x) => x.answer) });
  return { role, all, stories };
}

async function tailor(job) {
  const p = store.db.profile;
  const profSkills = list(p.skills);
  const src = sourcesFor(p);
  let t;
  if (MOCK) {
    t = { headline: p.headline, summary: p.summary, skills: profSkills, experience: p.experience.map((e, index) => ({ index, bullets: String(e.bullets || "").split("\n").map(norm).filter(Boolean) })),
      cover_letter: { greeting: `Dear ${job.company} Hiring Team,`, paragraphs: [`I'd like to be considered for the ${job.title} role at ${job.company}.`, "My experience lines up with what you describe.", "Thank you for your time."] }, requirements: [], stories_used: [] };
  } else {
    const stories = src.stories.map((x) => ({ id: x.id, roleIndex: x.roleIndex, role: p.experience[x.roleIndex] ? `${p.experience[x.roleIndex].title} at ${p.experience[x.roleIndex].company}` : "general", about: x.prompt, story: x.answer }));
    const profile = facts({ ...p, experience: p.experience.map((e, index) => ({ index, ...e })) });
    delete profile.stories;
    t = await claude.askJSON({
      system: TAILOR_SYSTEM,
      maxTokens: 6000,
      prompt: `PROFILE (source 1):\n${JSON.stringify(profile, null, 1)}\n\nSTORIES (source 2, written by the person):\n${stories.length ? JSON.stringify(stories, null, 1) : "(none yet)"}\n\nJOB (for requirements only; not facts about the person): ${job.title} at ${job.company} (${job.location || ""})\n${String(job.description || "").slice(0, 9000)}`,
    });
  }
  const removed = [];
  // Employers, titles and dates always come from the profile itself; only wording comes back from the model.
  const skillOk = new Map(profSkills.map((s) => [low(s), s]));
  const skills = (t.skills || []).map((s) => skillOk.get(low(s))).filter(Boolean);
  const exp = (t.experience?.length ? t.experience : p.experience.map((_, index) => ({ index })))
    .filter((x) => p.experience[x.index])
    .map((x) => {
      const e = p.experience[x.index];
      const own = String(e.bullets || "").split("\n").map(norm).filter(Boolean);
      // A bullet with a number that isn't in this role's own bullets or stories is dropped.
      let bullets = (x.bullets || []).map(norm).filter(Boolean).filter((b) => {
        const bad = unsupportedNumbers(b, src.role(x.index));
        if (bad.length) removed.push({ where: `${e.title} at ${e.company}`, text: b, numbers: bad });
        return !bad.length;
      });
      if (!bullets.length) bullets = own;
      return { title: e.title, company: e.company, location: e.location, dates: fmtDates(e), bullets };
    });
  const summary = keepSupportedSentences(norm(t.summary) || p.summary, src.all, removed, "summary") || p.summary;
  const headline = unsupportedNumbers(t.headline, src.all).length ? p.headline : norm(t.headline) || p.headline;
  const resume = {
    name: fullName(p), contact: contactLine(p), headline, summary,
    skills: skills.length ? skills : profSkills, experience: exp,
    education: (p.education || []).map((e) => ({ school: e.school, degree: [e.degree, e.field].filter(Boolean).join(", "), dates: [e.start, e.end].filter(Boolean).join(" – "), details: e.details })),
    extras: [{ heading: "Certifications", items: list(p.certifications) }],
  };
  // The cover letter may name numbers from the job posting (e.g. "your 200-person team"), but not new ones about the person.
  const letterSource = src.all + "\n" + (job.description || "") + "\n" + job.title + " " + job.company;
  const paragraphs = (t.cover_letter?.paragraphs || []).map((x) => keepSupportedSentences(x, letterSource, removed, "cover letter")).filter(Boolean);
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const letter = { name: fullName(p), contact: contactLine(p), date: today, greeting: norm(t.cover_letter?.greeting) || `Dear ${job.company} Hiring Team,`, paragraphs, closing: "Sincerely," };
  const base = `${p.firstName}_${p.lastName}`.replace(/[^A-Za-z0-9_-]/g, "");
  const company = job.company.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  fs.writeFileSync(store.filePath(job.id, "resume"), renderResume(resume));
  fs.writeFileSync(store.filePath(job.id, "cover"), renderCoverLetter(letter));
  const storyIds = new Set(t.stories_used || []);
  return {
    resume: `${base}_Resume.pdf`, cover: `${base}_Cover_Letter_${company}.pdf`, coverText: letter.paragraphs.join("\n\n"),
    requirements: (t.requirements || []).slice(0, 20).map((r) => ({ requirement: norm(r.requirement).slice(0, 200), supported: !!r.supported })),
    storiesUsed: src.stories.filter((x) => storyIds.has(x.id)).map((x) => x.prompt || x.answer.slice(0, 80)),
    removed,
  };
}

// ---------------- fit ----------------
/** Job types the person fits, from their resume/profile: what the job search should look for. */
async function fitRoles(p) {
  if (MOCK) {
    const t = p.currentTitle || p.experience?.[0]?.title || "Specialist";
    return { roles: [{ title: t, fit: "strong", why: "Your current role" }, { title: `Senior ${t}`, fit: "good", why: "Next step up from your experience" }] };
  }
  return claude.askJSON({
    system: `From this person's resume, list the job titles they are a real fit for right now, as job postings phrase them (so they work as search terms).
Give 6-12 titles: the closest matches first, then adjacent roles their experience supports, then at most 2 reasonable stretch roles.
For each: "fit" = "strong" | "good" | "stretch", and a one-line "why" that points to specific experience from the resume. Base it only on what's in the resume.
Reply with JSON only: {"roles":[{"title":"","fit":"strong","why":""}]}`,
    prompt: `RESUME / PROFILE:\n${JSON.stringify(facts(p), null, 1)}`,
    maxTokens: 2000,
  });
}

/** Rates found postings against the person (1-5) in batches; returns [{id, score, why}]. */
async function rateFit(p, jobs) {
  if (!jobs.length) return [];
  if (MOCK) return jobs.map((j) => ({ id: j.id, score: 4, why: "Matches your experience" }));
  const out = [];
  const profile = facts(p);
  delete profile.stories;
  const brief = { headline: profile.headline, summary: profile.summary, skills: profile.skills, yearsExperience: profile.yearsExperience, seniority: profile.seniority, experience: (p.experience || []).map((e) => ({ title: e.title, company: e.company, start: e.start, end: e.current ? "now" : e.end, bullets: e.bullets })), education: p.education, certifications: p.certifications, preferences: { workSetting: p.remotePreference, industries: p.industries, dealBreakers: p.dealBreakers, sponsorship: p.sponsorFuture === "yes" || p.sponsorNow === "yes" ? "needs sponsorship" : "no sponsorship needed" } };
  for (let i = 0; i < jobs.length; i += 12) {
    const batch = jobs.slice(i, i + 12);
    const r = await claude.askJSON({
      system: `Rate how well each job fits this candidate, 1-5: 5 = they meet nearly every requirement; 4 = most requirements, a strong application; 3 = a reasonable match with gaps; 2 = weak (wrong level, missing core skills or domain); 1 = not a fit, or it hits a deal-breaker (e.g. the posting says no sponsorship and the candidate needs it).
Judge only from the candidate data given. "why": one short line naming the deciding requirement(s).
Reply with JSON only: {"ratings":[{"id":"","score":1,"why":""}]}`,
      prompt: `CANDIDATE:\n${JSON.stringify(brief, null, 1)}\n\nJOBS:\n${JSON.stringify(batch.map((j) => ({ id: j.id, title: j.title, company: j.company, location: j.location, description: String(j.description || "").slice(0, 2500) })), null, 1)}`,
      maxTokens: 2500,
    });
    out.push(...(r.ratings || []));
  }
  return out;
}

// ---------------- profile helpers ----------------
const PROFILE_SHAPE = `{"firstName":"","lastName":"","email":"","phone":"","city":"","state":"","country":"","linkedin":"","github":"","portfolio":"","headline":"","summary":"","skills":"comma, separated",
 "experience":[{"company":"","title":"","location":"","start":"Mon YYYY","end":"Mon YYYY","current":false,"bullets":"one achievement per line"}],
 "education":[{"school":"","degree":"","field":"","start":"","end":"","details":""}],"certifications":"one per line","currentTitle":"","currentCompany":"","yearsExperience":""}`;

/** Reads a resume (PDF or pasted text) into profile fields for you to review. */
async function importResume({ pdfBase64, text }) {
  if (!pdfBase64 && !norm(text)) throw Object.assign(new Error("Attach a PDF resume or paste its text."), { status: 400 });
  if (MOCK) {
    const first = norm(String(text || "").split("\n")[0]).split(" ");
    const ln = String(text || "").split("\n").map(norm).filter(Boolean);
    const role = ln[1]?.match(/^(.+?) at (.+?)(?: (\d{4}).*)?$/);
    return { profile: { firstName: first[0] || "", lastName: first.slice(1).join(" "), summary: norm(text).slice(0, 300), skills: ["Testing", "Mocking"],
      experience: role ? [{ title: role[1], company: role[2], start: role[3] || "", current: true, bullets: ln.slice(2) }] : [], education: [] } };
  }
  const instructions = `Extract this resume into JSON exactly in this shape (leave a field empty if it isn't in the resume; copy facts, never invent; keep every achievement and number):\n${PROFILE_SHAPE}\nReply with JSON only: {"profile": {...}}`;
  const content = pdfBase64
    ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } }, { type: "text", text: instructions }]
    : `${instructions}\n\nRESUME:\n${String(text).slice(0, 30000)}`;
  return claude.askJSON({ system: "You turn resumes into structured data. Accuracy over completeness.", prompt: content, maxTokens: 6000 });
}

/** Roles to target and follow-up preference questions, based on the experience in the profile. */
async function suggestPreferences(p) {
  if (MOCK) return { roles: [p.currentTitle || p.experience?.[0]?.title].filter(Boolean), seniority: "Mid-level", questions: [{ q: "Do you want to keep doing the same kind of work, or move toward something new?", why: "Shapes which roles to apply for" }] };
  return claude.askJSON({
    system: `You are a career coach setting up a job search. From the person's experience, suggest:
- roles: 4-8 job titles they're a strong fit for now (as postings phrase them), most likely first;
- seniority: the level that fits their experience;
- questions: 5-8 short, specific follow-up questions about their preferences that their experience raises and that change which jobs to apply to or how to answer applications (e.g. IC vs. manager, which of their domains/industries to stay in, tech stack to lean into or avoid, travel, on-call, company stage, relocation). Each with a one-line "why". Don't ask what the profile already answers.
Reply with JSON only: {"roles":[""],"seniority":"","questions":[{"q":"","why":""}]}`,
    prompt: `PROFILE:\n${JSON.stringify(facts(p), null, 1)}`,
    maxTokens: 2000,
  });
}

/** Prompts for stories, tied to the person's roles and to what applications commonly ask. */
async function storyPrompts(p) {
  const have = (p.stories || []).map((x) => x.prompt);
  if (MOCK) return { prompts: (p.experience || []).slice(0, 3).map((e, i) => ({ roleIndex: i, prompt: `At ${e.company}, what's the project you're proudest of? What was the problem, what did you do, and what changed (with numbers)?`, why: "Becomes resume bullets and answers to 'tell us about a project'" })).concat([{ roleIndex: -1, prompt: "Tell me about a time you disagreed with a teammate or manager. What happened?", why: "Common application question" }]) };
  return claude.askJSON({
    system: `You interview a job seeker to collect true stories from their work. These stories will (1) sharpen resume bullets for a specific job and (2) answer custom application questions ("Tell us about a time...", "Describe a project...").
Write 8-12 prompts:
- 2-3 per recent role, specific to that role's work, asking for situation, what they did, and the measurable result (refer to things in their bullets, e.g. "Your bullet says you cut deploy time 40%. Walk me through how.");
- 3-4 general ones covering what applications commonly ask: a hard problem solved, a conflict or disagreement, a failure and what they learned, leading or influencing without authority, why this field.
Skip anything already asked: ${JSON.stringify(have).slice(0, 2000)}
Reply with JSON only: {"prompts":[{"roleIndex":0,"prompt":"","why":""}]}  (roleIndex = position in the experience list, -1 for general)`,
    prompt: `PROFILE:\n${JSON.stringify(facts({ ...p, experience: (p.experience || []).map((e, index) => ({ index, ...e })) }), null, 1)}`,
    maxTokens: 2500,
  });
}

module.exports = { answerQuestions, tailor, fitRoles, rateFit, unsupportedNumbers, keepSupportedSentences, profileReady, validate, direct, visaAnswer, importResume, suggestPreferences, storyPrompts };
