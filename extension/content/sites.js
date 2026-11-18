// What's different about each job site: where the form is, how to submit, what success looks like.
(() => {
  const AP = self.AP;
  if (AP.site) return;
  const visibleBtn = (rx, root = document) => [...root.querySelectorAll("button, input[type=submit]")].filter(AP.visible).find((b) => rx.test(AP.text(b) || b.value || ""));
  const errorText = (root = document) => [...root.querySelectorAll("[role=alert], [aria-live=assertive], [class*=error], [class*=Error], [class*=invalid]")]
    .filter((e) => AP.visible(e) && AP.text(e).length > 2 && AP.text(e).length < 400).map(AP.text).filter((t, i, a) => a.indexOf(t) === i).slice(0, 8).join(" | ");

  const greenhouse = {
    name: "Greenhouse",
    form: () => document.querySelector("form#application-form, form#application_form, form[action*='/applications']") || document.querySelector("#first_name")?.closest("form"),
    submitButton() { const f = this.form(); return f && (visibleBtn(/submit/i, f) || f.querySelector("#submit_app, button[type=submit]")); },
    async ready() { return !!(await AP.waitFor(() => this.form() && this.submitButton(), 25000)); },
    async prepare() {
      // Newer boards show the description with an "Apply" button that reveals or scrolls to the form.
      if (!AP.visible(this.form())) { const b = visibleBtn(/^apply/i); if (b) { AP.click(b); await AP.sleep(800); } }
    },
    isCombo: (el) => el.id === "country" || el.id === "candidate-location",
    optionSelector: "[role=option], .select__option",
    confirmed() { return /\/confirmation/.test(location.pathname) || (!this.submitButton() && AP.THANKS.test(AP.pageText().slice(0, 4000))); },
    codeStep: () => !!document.querySelector("input[id^=security-input], input[name^=security_code]") || (AP.EMAIL_CODE.test(AP.pageText()) && AP.codeBoxes().length > 0),
    errors() { return errorText(this.form() || document); },
    submit() { AP.click(this.submitButton()); },
  };

  const lever = {
    name: "Lever",
    form: () => document.querySelector("form#application-form, form.application-form, form[action$='/apply']") || document.querySelector("#btn-submit")?.closest("form"),
    submitButton: () => document.querySelector("#btn-submit") || visibleBtn(/submit application/i),
    async ready() { return !!(await AP.waitFor(() => this.form() && this.submitButton(), 25000)); },
    async prepare() {
      // On the posting page rather than /apply: go to the form.
      if (!this.form()) { const a = [...document.querySelectorAll("a")].find((x) => /\/apply$/.test(x.pathname) && AP.visible(x)); if (a) location.href = a.href; }
    },
    // Lever's location box is a typeahead with its own result list.
    isCombo: (el) => el.id === "location-input" || el.name === "location",
    optionSelector: "[role=option], .dropdown-location, .dropdown-results > div",
    // The hidden field Lever keeps the chosen location in, and its resume-parsing box, aren't questions.
    ignore: (el) => el.name === "selectedLocation",
    groupLabel: (el) => AP.text(el.closest(".application-question")?.querySelector(".application-label")),
    confirmed() { return /\/thanks\/?$/.test(location.pathname) || (!this.submitButton() && AP.THANKS.test(AP.pageText().slice(0, 4000))); },
    codeStep: () => AP.EMAIL_CODE.test(AP.pageText()) && AP.codeBoxes().length > 0,
    errors() { return errorText(this.form() || document); },
    submit() { AP.click(this.submitButton()); },
  };

  const ashby = {
    name: "Ashby",
    form: () => document.querySelector(".ashby-application-form-container") || document.querySelector("#form") || document.querySelector("form"),
    submitButton: () => visibleBtn(/submit application/i),
    async ready() { return !!(await AP.waitFor(() => this.form() && this.submitButton(), 25000)); },
    async prepare() {
      // Cookie notice: keep only the necessary cookies.
      const c = visibleBtn(/necessary only|reject (all|non)/i);
      if (c) { AP.click(c); await AP.sleep(300); }
      // On the Overview tab: open the Application tab.
      if (!this.submitButton()) {
        const tab = [...document.querySelectorAll("a, button, [role=tab]")].find((x) => AP.visible(x) && /^application$/i.test(AP.text(x)));
        if (tab) { AP.click(tab); await AP.waitFor(() => this.submitButton(), 10000); }
      }
    },
    // "Autofill from resume" isn't a question: the real Resume field comes later.
    ignore: (el) => !!el.closest("[class*=autofill], [class*=Autofill]") || (el.type === "file" && /autofill/i.test(AP.text(AP.box(el)).slice(0, 200))),
    /** Ashby's Yes/No questions are two buttons, not radio inputs. */
    extraFields(root, push, keyFor) {
      for (const pair of root.querySelectorAll("[class*=yesno], [class*=YesNo]")) {
        const btns = [...pair.querySelectorAll("button")].filter(AP.visible);
        if (btns.length !== 2) continue;
        const box = pair.closest("[class*=fieldEntry], [class*=field-entry], fieldset") || pair.parentElement;
        const label = AP.text(box.querySelector("label, legend, [class*=heading], [class*=label]")) || AP.text(box).replace(/\bYes\b|\bNo\b/g, "");
        const options = btns.map(AP.text);
        const isOn = (b) => b.getAttribute("aria-pressed") === "true" || /active|selected/i.test(b.className);
        const q = { key: keyFor(pair), label, type: "radio", required: /\*/.test(label) || !!box.querySelector("[class*=required]"), options, current: btns.filter(isOn).map(AP.text).join("") };
        push(q, { kind: "custom", apply: async (a) => {
          if (a.action === "leave") return { ok: true, shown: q.current };
          const want = a.options?.[0] ?? a.value;
          const b = btns.find((x) => AP.low(AP.text(x)) === AP.low(want));
          if (!b) return { ok: false, shown: "" };
          AP.click(b);
          await AP.sleep(150);
          return { ok: true, shown: AP.text(b) };
        } });
      }
    },
    confirmed() {
      return !!document.querySelector("[class*=successContainer], [class*=success-container]") || (!this.submitButton() && AP.THANKS.test(AP.pageText().slice(0, 4000)));
    },
    codeStep: () => AP.EMAIL_CODE.test(AP.pageText()) && AP.codeBoxes().length > 0,
    errors() {
      const m = AP.pageText().match(/[^.\n]*(missing entry|is required|flagged as spam|invalid|couldn.t submit|problem (verifying|submitting))[^.\n]*/gi) || [];
      return [...new Set(m.map(AP.norm))].slice(0, 6).join(" | ") || errorText();
    },
    submit() { AP.click(this.submitButton()); },
  };

  const h = location.hostname;
  AP.site = /greenhouse\.io$/.test(h) ? greenhouse : h === "jobs.lever.co" ? lever : h === "jobs.ashbyhq.com" ? ashby : null;
})();
