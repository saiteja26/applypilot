const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "applypilot-ai-test-"));
process.env.APPLYPILOT_DATA = dataDir;
delete process.env.APPLYPILOT_MOCK_AI;
const store = require("../server/lib/store");
const ai = require("../server/lib/ai");
const claude = require("../server/lib/claude");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("profile basics are direct and other questions go to Claude with experience", async () => {
  const { db } = store;
  Object.assign(db.profile, {
    firstName: "Jordan",
    lastName: "Rivera",
    email: "jordan@example.com",
    experience: [{
      title: "Platform Engineer",
      company: "Example Co",
      bullets: "Built and operated a Kubernetes platform with Terraform and AWS.",
    }],
  });

  const originalAskJSON = claude.askJSON;
  let request;
  claude.askJSON = async (input) => {
    request = input;
    return { answers: [{ key: "experience", action: "fill", value: "I built and operated a Kubernetes platform with Terraform and AWS." }] };
  };

  try {
    const result = await ai.answerQuestions(
      { title: "Platform Engineer", company: "Example", description: "Operate a reliable platform." },
      [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "resume", label: "Resume", type: "file", required: true },
        { key: "experience", label: "Describe your relevant experience", type: "textarea", required: true },
      ],
    );

    assert.deepEqual(result.answers.find((a) => a.key === "name"), {
      key: "name", action: "fill", value: "Jordan Rivera", source: "profile",
    });
    assert.deepEqual(result.answers.find((a) => a.key === "email"), {
      key: "email", action: "fill", value: "jordan@example.com", source: "profile",
    });
    assert.equal(result.answers.find((a) => a.key === "resume").action, "upload");
    assert.equal(result.answers.find((a) => a.key === "experience").value, "I built and operated a Kubernetes platform with Terraform and AWS.");
    assert.match(request.prompt, /Built and operated a Kubernetes platform with Terraform and AWS\./);
    assert.match(request.system, /otherwise use documented experience bullets/);
  } finally {
    claude.askJSON = originalAskJSON;
  }
});

test("work location follows remote and relocation settings; notice defaults to two weeks", () => {
  const profile = {
    city: "Austin",
    state: "Texas",
    country: "United States",
    willingToRelocate: "yes",
  };
  const question = { key: "location", label: "Which city & country do you intend to work from?", type: "text" };

  assert.deepEqual(ai.direct(question, profile, { remote: true, location: "London, UK" }), {
    key: "location", action: "fill", value: "Austin, Texas, United States", source: "profile",
  });
  assert.deepEqual(ai.direct(question, { ...profile, willingToRelocate: "no" }, { location: "London, UK" }), {
    key: "location", action: "fill", value: "Austin, Texas, United States", source: "profile",
  });
  assert.deepEqual(ai.direct(question, profile, { location: "London, UK" }), {
    key: "location", action: "fill", value: "London, UK", source: "job posting",
  });
  assert.equal(ai.direct(question, { ...profile, willingToRelocate: "depends" }, { location: "London, UK" }), null);
  assert.deepEqual(
    ai.direct({ key: "notice", label: "What is your notice period?", type: "text" }, profile),
    { key: "notice", action: "fill", value: "2 weeks", source: "rule" },
  );
  assert.ok(ai.profileReady({ city: "", country: "United States" }).includes("present work location (city and country)"));
});

test("Greenhouse country and city choices use the saved work location", () => {
  const profile = { city: "Austin", state: "Texas", country: "United States", willingToRelocate: "no" };
  assert.deepEqual(ai.direct(
    { key: "country", label: "Country*", type: "select", options: ["United States +1", "Canada +1"] },
    profile,
  ), { key: "country", action: "fill", options: ["United States +1"], source: "profile" });
  assert.deepEqual(ai.direct(
    { key: "city", label: "Location (City)*", type: "combobox" },
    profile,
  ), { key: "city", action: "fill", value: "Austin, Texas, United States", source: "profile" });
});

test("required agreement and consent choices are used only when saved", () => {
  const options = ["Yes", "No", "Ask me each time"];
  const profile = {
    noncompeteStatus: "no",
    recruiterSmsConsent: "no",
    recruitmentMarketingConsent: "yes",
  };
  const questions = [
    { key: "agreement", label: "Are you subject to any noncompete nondisclosure/confidentiality agreement?", type: "select", options },
    { key: "sms", label: "I would like to receive updates from a recruiter about this job via SMS.", type: "select", options },
    { key: "marketing", label: "You can choose to receive recruitment marketing communications from us.", type: "select", options },
  ];

  assert.deepEqual(questions.map((q) => ai.direct(q, profile)), [
    { key: "agreement", action: "fill", options: ["No"], source: "profile" },
    { key: "sms", action: "fill", options: ["No"], source: "profile" },
    { key: "marketing", action: "fill", options: ["Yes"], source: "profile" },
  ]);
  assert.equal(ai.direct(questions[0], { noncompeteStatus: "ask" }), null);
  const missing = ai.profileReady({});
  assert.ok(missing.includes("noncompete/confidentiality agreement choice"));
  assert.ok(missing.includes("recruiter SMS choice"));
  assert.ok(missing.includes("recruitment marketing email choice"));
  assert.ok(ai.profileReady({
    noncompeteStatus: "ask",
    recruiterSmsConsent: "ask",
    recruitmentMarketingConsent: "ask",
  }).includes("noncompete/confidentiality agreement choice"));
});

test("salary expectation is required and accepts Flexible or a currency-coded amount", () => {
  const profile = {
    firstName: "Jordan",
    lastName: "Rivera",
    email: "jordan@example.com",
    phone: "555-0100",
    experience: [{}],
    workAuthorized: "yes",
    sponsorNow: "no",
    city: "Austin",
    country: "United States",
    noncompeteStatus: "no",
    recruiterSmsConsent: "ask",
    recruitmentMarketingConsent: "ask",
  };
  assert.ok(ai.profileReady(profile).some((item) => item.includes("salary expectation")));
  profile.salaryExpectation = "Flexible";
  assert.equal(ai.profileReady(profile).length, 0);
  assert.deepEqual(ai.direct(
    { key: "salary", label: "Please indicate your annual salary expectations for this role in your local currency and include the currency code.", type: "text" },
    profile,
  ), { key: "salary", action: "fill", value: "Flexible", source: "profile" });
  profile.salaryExpectation = "150,000-175,000";
  assert.ok(ai.profileReady(profile).some((item) => item.includes("currency code")));
  profile.salaryExpectation = "USD 150,000-175,000";
  assert.equal(ai.profileReady(profile).length, 0);
});

test("unsupported required behavioral questions are left blank for the form to handle", async () => {
  const originalAskJSON = claude.askJSON;
  claude.askJSON = async () => ({ answers: [{ key: "leadership", action: "leave" }] });
  try {
    const result = await ai.answerQuestions(
      { title: "Engineer", company: "Example", description: "" },
      [{ key: "leadership", label: "Tell us about your experience leading a team", type: "textarea", required: true }],
    );
    assert.deepEqual(result.answers, [{ key: "leadership", action: "leave", skipRequired: true }]);
    assert.deepEqual(result.needs_you, []);
  } finally {
    claude.askJSON = originalAskJSON;
  }
});
