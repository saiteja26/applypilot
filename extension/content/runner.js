// Runs one application in the page. Loaded on Greenhouse, Lever and Ashby pages; it asks the
// background whether this tab is an ApplyPilot job: "run" (fresh form) or "check" (a page
// that loaded after Submit, or one you're finishing).
(() => {
  if (self.__apRunner) return;
  self.__apRunner = true;
  const AP = self.AP;
  const A = AP.site;
  let stopped = false;
  let active = false;

  const beat = setInterval(() => chrome.runtime.sendMessage({ type: "AP_BEAT" }).catch?.(() => {}), 20000);
  const confirmation = () => ({ confirmation_url: location.href, confirmation_text: AP.pageText().slice(0, 3000) });
  const alreadyApplied = () => AP.ALREADY.test(AP.pageText().slice(0, 6000));

  const CAPTCHA = "This site wants a captcha. Solve it, then press Submit. ApplyPilot records it when the confirmation shows.";
  const CODE = "The site emailed you a code. Enter it and finish submitting. ApplyPilot records it when the confirmation shows.";
  const SENT_UNSURE = "ApplyPilot pressed Submit and the form went away, but no confirmation showed. Check your email to make sure it went through.";

  /**
   * Hand the tab to the person: it moves to the "Needs you" window and the run goes on with the
   * next job. Here we keep watching for the confirmation (or the Skip button) for up to an hour.
   */
  async function handOff(job, reason, pending) {
    await AP.bg({ type: "AP_HANDOFF", appId: job.id, reason, pending: { ...pending, mode: "handoff", reason } }).catch(() => {});
    let skip = false;
    AP.overlay("Needs you", `${reason}\n\nWhen you've submitted it, ApplyPilot notices the confirmation and records it.`, {
      tone: "warn",
      buttons: [{ label: "Skip this job", onClick: () => { skip = true; } }, { label: "I submitted it", onClick: () => { skip = "sent"; } }],
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 60 * 60000) {
      if (alreadyApplied()) return { status: "skipped", reason: "You'd already applied to this job." };
      if (A.confirmed()) { AP.overlay("Sent", "Recorded. Thanks!", { tone: "good" }); return { status: "submitted", ...confirmation() }; }
      if (skip === "sent") return { status: "submitted", reason: "You said you submitted it.", ...confirmation() };
      if (skip || stopped) return { status: "skipped", reason: "Skipped by you." };
      await AP.sleep(2000);
    }
    return { status: "needs_you", reason: `${reason}\n\n(Waited an hour.)` };
  }

  /** After Submit: watch for success, a captcha, an emailed code or error messages. */
  async function afterSubmit(job, pending, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (alreadyApplied()) return { status: "skipped", reason: "You'd already applied to this job." };
      if (A.confirmed()) return { status: "submitted", ...confirmation() };
      if (AP.hasCaptcha()) return handOff(job, CAPTCHA, pending);
      if (A.codeStep()) return handOff(job, CODE, pending);
      await AP.sleep(500);
    }
    const err = A.errors();
    if (!A.submitButton() && !err) return { status: "needs_you", reason: SENT_UNSURE };
    return handOff(job, err ? `The site didn't accept the form:\n${err.slice(0, 500)}\n\nFix it and press Submit.` : "ApplyPilot pressed Submit but nothing happened. Check the form and press Submit.", pending);
  }

  async function run(job) {
    const log = [];
    const record = [];
    const root = () => A.form() || document.body;
    const ctx = { appId: job.id, site: A, root, stopped: () => stopped };
    const done = (r) => ({ ...r, answers: r.answers || record, log });
    const identity = (q, fields) => {
      const h = fields.get(q.key);
      const el = h?.el || h?.options?.find((option) => option.el)?.el;
      return el?.id ? `id:${el.id}` : el?.name ? `name:${el.name}` : `key:${q.key}`;
    };
    AP.overlay("Working", `Applying to ${job.company}: ${job.title}`);

    if (!(await A.ready())) {
      if (A.prepare) await A.prepare();
      if (!(await A.ready())) {
        if (AP.CLOSED.test(AP.pageText())) return done({ status: "skipped", reason: "The posting is closed." });
        return done({ status: "failed", reason: "The application form never loaded." });
      }
    } else if (A.prepare) await A.prepare();
    if (alreadyApplied()) return done({ status: "skipped", reason: "You'd already applied to this job." });

    const answered = new Set();
    const intentionalLeaves = new Set();
    const problems = [];
    const needs = [];
    // A few passes: answering one question can reveal follow-ups.
    for (let pass = 1; pass <= 4; pass++) {
      const { questions, fields } = await AP.extract(root(), A);
      if (!questions.length) {
        const why = "ApplyPilot couldn't detect any application fields. No submission was attempted; please review the form and submit it yourself.";
        log.push(why);
        return done(await handOff(job, why, { record }));
      }
      const fresh = questions.filter((q) => !answered.has(identity(q, fields)));
      if (!fresh.length) break;
      log.push(`pass ${pass}: ${fresh.length} questions`);
      AP.overlay("Working", `Answering ${fresh.length} question${fresh.length > 1 ? "s" : ""} for ${job.company}...`);
      let res;
      try { res = await AP.api("/api/ext/answers", { application_id: job.id, page_url: location.href, questions: fresh }); }
      catch (e) { return done({ status: "failed", reason: `Couldn't get answers: ${e.message}`, stop: e.status === 412 }); }
      needs.push(...res.needs_you);
      res.answers.filter((a) => a.skipRequired).forEach((a) => intentionalLeaves.add(a.key));
      const r = await AP.applyAll(fields, res.answers, ctx);
      record.push(...r.record);
      problems.push(...r.problems);
      fresh.forEach((q) => answered.add(identity(q, fields)));
      if (stopped) return done({ status: "abandoned", reason: "Paused" });
      await AP.sleep(500);
    }

    // Anything required that's still empty goes to the person, with the reason for each.
    const { questions: after } = await AP.extract(root(), A);
    const needKeys = new Set(needs.map((n) => n.key));
    const empty = after.filter((q) => q.required && !String(q.current || "").trim() && q.type !== "checkbox_group" && !needKeys.has(q.key) && !intentionalLeaves.has(q.key));
    const items = [
      ...needs.map((n) => `${n.label.slice(0, 120)} (${n.reason})`),
      ...problems.filter((p) => p.required).map((p) => `${p.label.slice(0, 120)} (${p.reason})`),
      ...empty.filter((q) => !problems.some((p) => p.key === q.key)).map((q) => `${q.label.slice(0, 120)} (still empty)`),
    ];
    const pending = { record };
    if (items.length) {
      const why = "Please fill these in yourself, then press Submit:\n- " + [...new Set(items)].join("\n- ");
      log.push(why);
      return done(await handOff(job, why, pending));
    }

    if (stopped) return done({ status: "abandoned", reason: "Paused" });
    // If Submit loads a new page this script ends; the background checks the new page (AP_CHECK).
    await AP.bg({ type: "AP_PENDING", pending: { ...pending, mode: "submit" } }).catch(() => {});
    AP.overlay("Submitting", `Submitting your application to ${job.company}...`, { tone: "good" });
    A.submit();
    log.push("pressed submit");
    return done(await afterSubmit(job, pending, 45000));
  }

  /** A page that loaded after Submit, or while the person was finishing it. */
  async function check(job, pending) {
    await AP.waitFor(() => A.confirmed() || alreadyApplied(), 4000, 250);
    const base = { answers: pending.record || [] };
    if (alreadyApplied()) return { ...base, status: "skipped", reason: "You'd already applied to this job." };
    if (A.confirmed()) return { ...base, status: "submitted", ...confirmation() };
    if (pending.mode === "submit") return { ...base, ...(await afterSubmit(job, pending, 15000)) };
    return { ...base, ...(await handOff(job, pending.reason || "Please finish this application.", pending)) };
  }

  function begin(action, job, pending) {
    if (active || !A) return;
    active = true;
    (action === "run" ? run(job) : check(job, pending || {}))
      .catch((e) => ({ status: "failed", reason: `Extension error: ${e.message}`, log: [String(e.stack || e).slice(0, 500)] }))
      .then((result) => { clearInterval(beat); chrome.runtime.sendMessage({ type: "AP_DONE", appId: job.id, result }); });
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === "AP_PING") reply({ alive: true });
    if (msg.type === "AP_STOP") { stopped = true; reply({ ok: true }); }
  });

  // Ask the background whether this page is one of ApplyPilot's jobs. Usually it isn't (you're
  // just browsing a job site), and nothing happens.
  AP.bg({ type: "AP_HELLO" }).then((t) => { if (t) begin(t.action, t.job, t.pending); else clearInterval(beat); }).catch(() => clearInterval(beat));
})();
