// ApplyPilot page toolkit: reads every question on an application form (full label, type,
// options, required) and fills answers so that React/Vue forms register them.
(() => {
  if (self.AP) return;
  const AP = (self.AP = {});

  AP.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  AP.norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  AP.low = (s) => AP.norm(s).toLowerCase();
  AP.text = (el) => AP.norm(el ? el.innerText || el.textContent || "" : "");
  AP.pageText = () => AP.norm(document.body ? document.body.innerText : "");
  AP.visible = (el) => {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  AP.waitFor = async (fn, timeout = 15000, every = 250) => {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = fn(); } catch {}
      if (v) return v;
      if (Date.now() - t0 > timeout) return null;
      await AP.sleep(every);
    }
  };

  // ---------- talking to the background worker ----------
  AP.bg = (msg) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res && res.__error) return reject(Object.assign(new Error(res.__error), { status: res.status }));
      resolve(res);
    });
  });
  AP.api = (path, body) => AP.bg({ type: "AP_API", path, method: body ? "POST" : "GET", body });
  AP.event = (kind, message, data, application_id) => AP.api("/api/ext/event", { kind, message: String(message).slice(0, 1900), data, application_id }).catch(() => {});

  // ---------- labels ----------
  const byId = (id) => document.getElementById(id);
  AP.ownLabel = (el) => {
    let t = "";
    const lb = el.getAttribute("aria-labelledby");
    if (lb) t = lb.split(/\s+/).map((id) => AP.text(byId(id))).filter(Boolean).join(" ");
    if (!t && el.labels?.length) t = [...el.labels].map(AP.text).join(" ");
    if (!t && el.id) t = AP.text(document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    if (!t && el.closest("label")) t = AP.text(el.closest("label"));
    if (!t) t = el.getAttribute("aria-label") || "";
    return AP.norm(t);
  };
  const controlsIn = (c) => {
    const names = new Set();
    c.querySelectorAll("input:not([type=hidden]), select, textarea").forEach((x, i) => names.add(x.name || x.id || "i" + i));
    return names.size;
  };
  /** The smallest box around a control that still holds only this one question. */
  AP.box = (el, stop) => {
    let c = el.parentElement, best = c;
    for (let i = 0; i < 6 && c && c !== stop && c !== document.body; i++) {
      if (controlsIn(c) > 1) break;
      best = c;
      c = c.parentElement;
    }
    return best;
  };
  const GENERIC = /^(type (here|your (response|answer))|your answer|answer|select\.*|choose\.*|start typing\.*|search\.*|please select|-+)$/i;
  AP.questionLabel = (el, box) => {
    let lab = AP.ownLabel(el);
    if (!lab || GENERIC.test(lab)) {
      const head = box && [...box.querySelectorAll("label, legend, [class*=label], [class*=Label], [class*=heading], [class*=title], h3, h4, p")]
        .find((x) => !x.contains(el) && AP.text(x) && !GENERIC.test(AP.text(x)));
      lab = head ? AP.text(head) : lab || el.getAttribute("placeholder") || "";
    }
    const help = (el.getAttribute("aria-describedby") || "").split(/\s+/).map((id) => AP.text(byId(id))).filter(Boolean).join(" ");
    return AP.norm(help && !lab.includes(help) ? `${lab} ${help}` : lab);
  };
  AP.isRequired = (el, label, box) =>
    el.required || el.getAttribute("aria-required") === "true" || /\*\s*$|\*\s|\(required\)|✱/.test(label || "") ||
    !!(box && box.querySelector("[class*=required], [class*=Required], abbr[title=required]") && controlsIn(box) <= 1);

  // ---------- question extraction ----------
  let seq = 0;
  const keyFor = (el) => (el.dataset.apKey ||= "q" + ++seq);
  const SKIP_TYPES = /^(hidden|submit|button|image|reset|password|search)$/;

  /**
   * Reads the form. Returns { questions, fields }: questions go to the server; fields hold
   * what's needed to fill each one. `site` may add custom questions (site.extraFields) and
   * hide controls (site.ignore).
   */
  AP.extract = async (root, site = {}) => {
    const questions = [];
    const fields = new Map();
    const push = (q, h) => {
      q.label = AP.norm(q.label).slice(0, 3000);
      if (!q.label || fields.has(q.key)) return;
      fields.set(q.key, { ...h, q });
      questions.push(q);
    };
    const ignored = (el) => el.closest("[data-ap-ignore]") || (site.ignore && site.ignore(el));
    const seen = new Set();

    for (const inp of root.querySelectorAll("input[type=radio], input[type=checkbox]")) {
      if (ignored(inp)) continue;
      const shown = AP.visible(inp) || AP.visible(inp.closest("label")) || (inp.id && AP.visible(document.querySelector(`label[for="${CSS.escape(inp.id)}"]`)));
      if (!shown) continue;
      const gid = inp.name ? `${inp.type}:${inp.name}` : null;
      if (gid && seen.has(gid)) continue;
      if (gid) seen.add(gid);
      const members = inp.name ? [...root.querySelectorAll(`input[type=${inp.type}]`)].filter((x) => x.name === inp.name) : [inp];
      const group = inp.closest("fieldset, [role=radiogroup], [role=group]") || AP.box(members.length > 1 ? members[0].closest("label")?.parentElement || members[0] : inp, root);
      const legend = group.querySelector("legend, [class*=legend], [class*=question], [class*=label]:not(label), [class*=heading], [class*=title]");
      if (inp.type === "checkbox" && members.length === 1) {
        const own = AP.ownLabel(inp);
        const head = legend && !legend.contains(inp) && AP.text(legend) !== own ? AP.text(legend) : "";
        const label = head ? `${head} ${own}` : own || AP.text(group);
        push({ key: keyFor(inp), label, type: "checkbox", required: AP.isRequired(inp, label, null) || /\*/.test(head), current: inp.checked ? "checked" : "" }, { kind: "checkbox", el: inp });
        continue;
      }
      const opts = members.map((m) => ({ el: m, text: AP.ownLabel(m) || m.value }));
      let qtext = legend && !opts.some((o) => AP.text(legend) === o.text) ? AP.text(legend) : "";
      if (!qtext) { qtext = AP.text(group); for (const o of opts) qtext = qtext.replace(o.text, " "); qtext = AP.norm(qtext); }
      if (!qtext && site.groupLabel) qtext = site.groupLabel(inp, group);
      const required = members.some((m) => m.required || m.getAttribute("aria-required") === "true") || AP.isRequired(inp, qtext, null) || group.getAttribute("aria-required") === "true";
      push({ key: keyFor(members[0]), label: qtext, type: inp.type === "radio" ? "radio" : "checkbox_group", required, options: opts.map((o) => o.text), current: opts.filter((o) => o.el.checked).map((o) => o.text).join(", ") },
        { kind: inp.type === "radio" ? "radio" : "checkbox_group", options: opts });
    }

    for (const s of root.querySelectorAll("select")) {
      if (ignored(s) || !AP.visible(s)) continue;
      const box = AP.box(s, root);
      const label = AP.questionLabel(s, box);
      const options = [...s.options].filter((o) => o.value !== "" || !/^(select|choose|please|--)/i.test(o.text)).map((o) => AP.norm(o.text)).filter(Boolean);
      push({ key: keyFor(s), label, type: "select", required: AP.isRequired(s, label, box), options, current: s.value ? AP.norm(s.options[s.selectedIndex]?.text) : "" }, { kind: "select", el: s });
    }

    for (const el of root.querySelectorAll("input, textarea")) {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (el.tagName === "INPUT" && (SKIP_TYPES.test(type) || type === "radio" || type === "checkbox")) continue;
      if (ignored(el)) continue;
      const box = AP.box(el, root);
      if (type === "file") {
        // File inputs are usually hidden behind an "Upload" button: label from the box around it.
        const lab = AP.ownLabel(el);
        const head = [...box.querySelectorAll("label, legend, [class*=label], [class*=Label], [class*=heading], h3, h4")].map(AP.text).find((t) => t && t.length < 120 && !/^(attach|upload|browse|choose file|drop|or|enter manually|dropbox|google drive)/i.test(t));
        const own = lab && lab !== head && !/^(attach|upload)/i.test(lab) ? lab : "";
        const label = AP.norm([head, own].filter(Boolean).join(" ")) || AP.norm(`${el.name || el.id || ""}`.replace(/[_-]+/g, " ")) || "File upload";
        push({ key: keyFor(el), label, type: "file", required: AP.isRequired(el, label, box), current: el.files?.length ? el.files[0].name : "" }, { kind: "file", el });
        continue;
      }
      if (!AP.visible(el) || el.readOnly || el.disabled) continue;
      const label = AP.questionLabel(el, box);
      const combo = el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list" || (site.isCombo && site.isCombo(el));
      const qtype = el.tagName === "TEXTAREA" ? "textarea" : combo ? "combobox" : ["email", "tel", "url", "number", "date"].includes(type) ? type : "text";
      const q = { key: keyFor(el), label, type: qtype, required: AP.isRequired(el, label, box), current: combo ? AP.comboShown(el) : el.value || "" };
      if (el.maxLength > 0 && el.maxLength < 100000) q.maxLength = el.maxLength;
      if (combo) {
        // A short fixed list (Yes/No, a country list...) is sent as options so the answer matches exactly.
        const opts = await AP.comboOptions(el, site);
        if (opts.length && opts.length <= 250) { q.type = "select"; q.options = opts; push(q, { kind: "combo-select", el }); continue; }
      }
      push(q, { kind: combo ? "combobox" : "text", el });
    }
    if (site.extraFields) site.extraFields(root, push, keyFor);
    return { questions, fields };
  };

  // ---------- setting values ----------
  const setter = (el) => Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value").set;
  AP.setValue = (el, v) => {
    setter(el).call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  AP.press = (el, key) => {
    const code = { Enter: 13, Escape: 27, ArrowDown: 40, Tab: 9 }[key];
    el.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, keyCode: code, which: code, bubbles: true }));
  };
  /** A click that also sends the mousedown/up some widgets (react-select) listen for. */
  AP.click = (el) => {
    el.scrollIntoView({ block: "center" });
    const o = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.click();
  };
  AP.fillText = async (el, value) => {
    el.scrollIntoView({ block: "center" });
    el.focus();
    AP.setValue(el, value);
    el.dispatchEvent(new FocusEvent("blur"));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await AP.sleep(100);
    if (el.value === value) return true;
    if (el.type !== "tel") return false;
    const digits = (s) => String(s || "").replace(/\D/g, "");
    const expected = digits(value), actual = digits(el.value);
    return expected.length >= 7 && actual.endsWith(expected) && actual.length - expected.length <= 3;
  };

  // ---------- comboboxes (react-select, typeaheads) ----------
  const listFor = (el) => {
    const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    return id ? document.getElementById(id) : null;
  };
  AP.visibleOptions = (el, site) => {
    const list = listFor(el);
    const sel = (site && site.optionSelector) || "[role=option]";
    const scope = list || el.closest("[class*=select], [class*=Select], [class*=combobox], [class*=dropdown], [class*=Dropdown]")?.parentElement || document;
    let opts = [...scope.querySelectorAll(sel)].filter(AP.visible);
    if (!opts.length && scope !== document) opts = [...document.querySelectorAll(sel)].filter(AP.visible);
    return opts;
  };
  AP.comboShown = (el) => {
    const box = el.closest("[class*=select__control], [class*=control]");
    const single = box?.querySelector("[class*=single-value], [class*=singleValue]");
    return AP.text(single) || el.value || "";
  };
  const closeMenu = async (el) => { AP.press(el, "Escape"); el.blur(); await AP.sleep(80); };
  const openMenu = async (el) => {
    el.scrollIntoView({ block: "center" });
    el.focus();
    const control = el.closest("[class*=select__control], [class*=control]");
    if (control) control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    AP.press(el, "ArrowDown");
    await AP.sleep(250);
  };
  /** The options of a dropdown that shows a fixed list when opened (empty for search-as-you-type boxes). */
  AP.comboOptions = async (el, site) => {
    if (el.dataset.apOptions) return JSON.parse(el.dataset.apOptions);
    await openMenu(el);
    const opts = AP.visibleOptions(el, site).map(AP.text).filter((t) => t && !/^(no options|loading|type to search)/i.test(t));
    await closeMenu(el);
    el.dataset.apOptions = JSON.stringify(opts);
    return opts;
  };
  const pickOption = (opts, value) => {
    const v = AP.low(value);
    const city = v.split(",")[0].trim();
    const rest = v.split(",").slice(1).join(",").trim();
    return opts.find((o) => AP.low(AP.text(o)) === v) ||
      (rest && opts.find((o) => AP.low(AP.text(o)).startsWith(city) && AP.low(AP.text(o)).includes(rest))) ||
      opts.find((o) => AP.low(AP.text(o)).startsWith(v)) ||
      opts.find((o) => AP.low(AP.text(o)).startsWith(city)) || null;
  };
  /** Pick from a fixed list by exact text. */
  AP.chooseCombo = async (el, want, site) => {
    await openMenu(el);
    let opts = AP.visibleOptions(el, site);
    let o = pickOption(opts, want);
    if (!o) {
      // Long lists may only render a window of options: type to filter, then pick.
      AP.setValue(el, want);
      await AP.sleep(400);
      opts = AP.visibleOptions(el, site);
      o = pickOption(opts, want);
    }
    if (!o) { await closeMenu(el); return { ok: false, shown: "" }; }
    AP.click(o);
    await AP.sleep(250);
    const shown = AP.comboShown(el) || AP.text(o);
    return { ok: AP.low(shown) === AP.low(want) || AP.low(AP.comboShown(el)).includes(AP.low(want)), shown };
  };
  /** Type into a search-as-you-type box and click the best match ("Chicago, IL" -> "Chicago, Illinois, United States"). */
  AP.typeCombo = async (el, value, site) => {
    const city = value.split(",")[0].trim();
    el.scrollIntoView({ block: "center" });
    el.focus();
    await openMenu(el);
    const opened = AP.visibleOptions(el, site);
    const existing = pickOption(opened, value);
    if (existing) {
      AP.click(existing);
      await AP.sleep(400);
      const control = el.closest("[class*=select__control], [class*=control]");
      const single = control?.querySelector("[class*=single-value], [class*=singleValue]");
      const selected = AP.comboShown(el);
      if (single && !selected) return { ok: false, shown: el.value };
      return { ok: true, shown: selected || el.value || AP.text(existing) };
    }
    AP.setValue(el, "");
    let typed = "";
    for (const ch of city) {
      const code = /^[a-z]$/i.test(ch) ? `Key${ch.toUpperCase()}` : /^\d$/.test(ch) ? `Digit${ch}` : ch === " " ? "Space" : "";
      const event = { key: ch, code, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", event));
      typed += ch;
      AP.setValue(el, typed);
      el.dispatchEvent(new KeyboardEvent("keyup", event));
      await AP.sleep(40);
    }
    const opts = await AP.waitFor(() => { const o = AP.visibleOptions(el, site); return o.length ? o : null; }, 5000);
    if (!opts) return { ok: false, shown: el.value };
    const pick = pickOption(opts, value);
    if (!pick) return { ok: false, shown: el.value };
    AP.click(pick);
    await AP.sleep(400);
    const control = el.closest("[class*=select__control], [class*=control]");
    const single = control?.querySelector("[class*=single-value], [class*=singleValue]");
    const selected = AP.text(single);
    if (single && !selected) return { ok: false, shown: el.value };
    return { ok: true, shown: selected || el.value || AP.text(pick) };
  };

  // ---------- files ----------
  const fileCache = new Map();
  AP.getFile = async (appId, kind) => {
    const k = `${appId}:${kind}`;
    if (!fileCache.has(k)) {
      const t0 = Date.now();
      for (;;) {
        try { fileCache.set(k, await AP.bg({ type: "AP_FILE", appId, kind })); break; }
        catch (e) {
          // 425: the tailored resume and cover letter are still being written.
          if (e.status !== 425 || Date.now() - t0 > 180000) throw e;
          AP.overlay("Almost ready", "Finishing your tailored resume and cover letter for this job...");
          await AP.sleep(2000);
        }
      }
    }
    const f = fileCache.get(k);
    const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
    return new File([bytes], f.name, { type: "application/pdf", lastModified: Date.now() });
  };
  AP.attach = async (input, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await AP.waitFor(() => AP.pageText().includes(file.name.slice(0, 20)), 4000, 200);
    return input.files?.[0]?.name === file.name;
  };

  // ---------- applying answers ----------
  AP.applyOne = async (h, a, ctx) => {
    const q = h.q;
    if (a.action === "leave") return { ok: true, shown: q.current || "" };
    if (a.action === "upload") {
      const file = await AP.getFile(ctx.appId, a.file === "cover" ? "cover" : "resume");
      const ok = await AP.attach(h.el, file);
      return { ok, shown: ok ? file.name : "" };
    }
    const want = a.options?.[0] ?? a.value ?? "";
    switch (h.kind) {
      case "text": { const ok = await AP.fillText(h.el, String(a.value ?? "")); return { ok, shown: h.el.value }; }
      case "combobox": return AP.typeCombo(h.el, String(want), ctx.site);
      case "combo-select": return AP.chooseCombo(h.el, String(want), ctx.site);
      case "select": {
        const opt = [...h.el.options].find((o) => AP.low(o.text) === AP.low(want));
        if (!opt) return { ok: false, shown: "" };
        h.el.focus();
        AP.setValue(h.el, opt.value);
        await AP.sleep(60);
        const shown = AP.norm(h.el.options[h.el.selectedIndex]?.text);
        return { ok: AP.low(shown) === AP.low(want), shown };
      }
      case "radio": {
        const o = h.options.find((x) => AP.low(x.text) === AP.low(want));
        if (!o) return { ok: false, shown: "" };
        if (!o.el.checked) { AP.click(o.el.labels?.[0] && AP.visible(o.el.labels[0]) ? o.el.labels[0] : o.el); await AP.sleep(80); }
        if (!o.el.checked) { o.el.click(); await AP.sleep(80); }
        const on = h.options.filter((x) => x.el.checked).map((x) => x.text);
        return { ok: on.length === 1 && AP.low(on[0]) === AP.low(want), shown: on.join(", ") };
      }
      case "checkbox_group": {
        const set = new Set((a.options || []).map(AP.low));
        for (const o of h.options) {
          const should = set.has(AP.low(o.text));
          if (o.el.checked !== should) { o.el.click(); await AP.sleep(80); }
        }
        const on = h.options.filter((x) => x.el.checked).map((x) => x.text);
        return { ok: on.length === set.size && on.every((t) => set.has(AP.low(t))), shown: on.join(", ") };
      }
      case "checkbox": {
        const should = a.action === "check";
        if (h.el.checked !== should) { h.el.click(); await AP.sleep(80); }
        return { ok: h.el.checked === should, shown: h.el.checked ? "checked" : "" };
      }
      case "custom": return h.apply(a);
    }
    return { ok: false, shown: "" };
  };

  /** Applies a set of answers. Files first: an upload can re-render the form or autofill it. */
  AP.applyAll = async (fields, answers, ctx) => {
    const problems = [];
    const record = [];
    const identity = (h) => {
      const el = h.el || h.options?.find((option) => option.el)?.el;
      if (el?.id) return `id:${el.id}`;
      if (el?.name) return `name:${el.name}`;
      return `${h.kind}:${h.q.type}:${AP.low(h.q.label)}`;
    };
    const find = (item, liveFields) => {
      const entry = liveFields.has(item.key) && identity(liveFields.get(item.key)) === item.identity
        ? [item.key, liveFields.get(item.key)]
        : null;
      if (entry) return entry;
      const matches = [...liveFields].filter(([, h]) => identity(h) === item.identity);
      return matches.length === 1 ? matches[0] : null;
    };
    const items = answers.flatMap((answer) => {
      const h = fields.get(answer.key);
      return h ? [{ answer, key: answer.key, identity: identity(h), initial: h }] : [];
    });
    const apply = async (item, liveFields) => {
      if (ctx.stopped()) throw new Error("Stopped");
      const entry = find(item, liveFields);
      if (!entry) {
        const h = item.initial;
        problems.push({ key: item.key, label: h.q.label, required: h.q.required, reason: "form changed after file upload; field could not be found" });
        record.push({ question: h.q.label, answer: "", type: h.q.type, source: item.answer.source || "ai" });
        return { ok: false, h, shown: "" };
      }
      const [key, h] = entry;
      const a = item.answer;
      let r;
      try {
        r = await AP.applyOne(h, a, ctx);
        if (!r.ok && h.kind !== "file") { await AP.sleep(300); r = await AP.applyOne(h, a, ctx); }
      } catch (e) { r = { ok: false, shown: "", err: e.message }; }
      if (!r.ok && a.action !== "leave") problems.push({ key, label: h.q.label, required: h.q.required, reason: `couldn't set "${String(a.value ?? (a.options || []).join(", ") ?? a.file).slice(0, 80)}"${r.err ? ": " + r.err : ""}` });
      record.push({ question: h.q.label, answer: a.action === "leave" ? "" : r.shown || a.value || (a.options || []).join(", "), type: h.q.type, source: a.source || "ai" });
      if (h.kind === "file" && r.ok) await AP.sleep(1500); // let the site read the file (and any autofill finish)
      return { ok: r.ok, h, shown: r.shown };
    };
    let liveFields = fields;
    const files = items.filter((item) => item.initial.kind === "file");
    const rest = items.filter((item) => item.initial.kind !== "file");
    for (const item of files) {
      const first = await apply(item, liveFields);
      const recordIndex = record.length - 1;
      const root = typeof ctx.root === "function" ? ctx.root() : document.body;
      liveFields = (await AP.extract(root, ctx.site)).fields;
      if (first.ok) {
        const current = find(item, liveFields);
        if (!current) {
          problems.push({ key: item.key, label: item.initial.q.label, required: item.initial.q.required, reason: "file field disappeared after the form refreshed" });
          record[recordIndex] = { ...record[recordIndex], answer: "" };
        } else if (current[1].el !== first.h.el && !current[1].q.current) {
          const retried = await apply(item, liveFields);
          const retryRecord = record.pop();
          const refreshedRoot = typeof ctx.root === "function" ? ctx.root() : document.body;
          liveFields = (await AP.extract(refreshedRoot, ctx.site)).fields;
          const afterRetry = find(item, liveFields);
          if (retried.ok && afterRetry?.[1].q.current) {
            record[recordIndex] = retryRecord;
          } else {
            record[recordIndex] = { ...record[recordIndex], answer: "" };
            if (!problems.some((problem) => problem.key === item.key)) {
              problems.push({ key: item.key, label: item.initial.q.label, required: item.initial.q.required, reason: "site did not retain the uploaded file after the form refreshed" });
            }
          }
        }
      }
    }
    for (const item of rest) await apply(item, liveFields);
    return { problems, record };
  };

  // ---------- on-page status box ----------
  AP.overlay = (title, body, { tone = "info", buttons = [] } = {}) => {
    let host = document.getElementById("applypilot-overlay");
    if (!host) {
      host = document.createElement("div");
      host.id = "applypilot-overlay";
      host.attachShadow({ mode: "open" });
      document.documentElement.appendChild(host);
    }
    const color = { warn: "#a2580b", good: "#17703a", bad: "#a3231c" }[tone] || "#124f73";
    host.shadowRoot.innerHTML = `<style>
      .b{position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:380px;background:#fff;color:#1d1d1b;border:2px solid ${color};border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);font:13.5px/1.45 system-ui,sans-serif;padding:11px 14px}
      .t{font-weight:700;color:${color};display:flex;justify-content:space-between;gap:10px;margin-bottom:3px}
      .x{border:0;background:none;cursor:pointer;color:#888;font-size:15px}.m{white-space:pre-wrap}
      .btn{margin:8px 6px 0 0;border:0;border-radius:7px;padding:5px 10px;font-weight:600;cursor:pointer;background:#efeee9;color:#1d1d1b}
    </style><div class="b"><div class="t"><span>ApplyPilot: <span class="tt"></span></span><button class="x" title="Hide">×</button></div><div class="m"></div><div class="bs"></div></div>`;
    host.shadowRoot.querySelector(".tt").textContent = title;
    host.shadowRoot.querySelector(".m").textContent = body || "";
    host.shadowRoot.querySelector(".x").onclick = () => host.remove();
    for (const b of buttons) {
      const el = document.createElement("button");
      el.className = "btn";
      el.textContent = b.label;
      el.onclick = b.onClick;
      host.shadowRoot.querySelector(".bs").appendChild(el);
    }
  };

  // ---------- page states ----------
  /** A captcha challenge the person has to solve (invisible reCAPTCHA badges don't count). */
  AP.hasCaptcha = () => [...document.querySelectorAll("iframe")].some((f) => {
    if (!/recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha/i.test(f.src || "") || /size=invisible/i.test(f.src || "")) return false;
    const r = f.getBoundingClientRect();
    return r.width > 60 && r.height > 60 && AP.visible(f);
  });
  AP.codeBoxes = () => [...document.querySelectorAll("input")].filter((i) => AP.visible(i) && /^(text|tel|number|)$/.test(i.type) &&
    (i.autocomplete === "one-time-code" || /security|code|otp|verif|passcode/i.test([i.name, i.id, i.placeholder, i.getAttribute("aria-label")].join(" "))));
  AP.EMAIL_CODE = /verification code|security code|enter the code|code (was|has been) sent|check your email|one-time code|sent (you )?a code/i;
  AP.THANKS = /thank you for (applying|your application|your interest|submitting)|thanks for applying|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully submitted|you('ve| have) (successfully )?applied/i;
  AP.ALREADY = /you('ve| have) already applied|already (submitted|received) (an|your) application|already applied (for|to) this/i;
  AP.CLOSED = /(job|position|posting) (is )?(no longer|not) (available|open|accepting)|no longer accepting applications|this job (has been )?(closed|filled)|page (you're looking for )?(was )?not found/i;
})();
