const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "applypilot-discover-test-"));
process.env.APPLYPILOT_DATA = dataDir;
const store = require("../server/lib/store");
const { buildQueries, matches, discover } = require("../server/lib/discover");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const settings = {
  platformLever: true,
  platformGreenhouse: false,
  platformAshby: false,
  keywords: "Example Engineer",
  remoteOk: true,
  remoteRegions: "United States\nRemote - US",
  locations: "",
  exclude: "",
};

test("remote search does not require an exact region phrase", () => {
  const [query] = buildQueries(settings);
  assert.match(query, /"remote"/);
  assert.doesNotMatch(query, /United States|Remote - US/);
});

test("remote posting filters still enforce the allowed region", () => {
  assert.deepEqual(
    matches({ title: "Example Engineer", remote: true, location: "Remote - US" }, settings),
    { ok: true },
  );
  assert.deepEqual(
    matches({ title: "Example Engineer", remote: true, location: "Remote - EMEA" }, settings),
    { ok: false, why: "remote region" },
  );
});

test("role search uses base titles and accepts a matching core term", () => {
  const qualified = {
    ...settings,
    keywords: "DevOps Engineer (Kubernetes / Terraform)\nCloud Infrastructure Engineer (AWS/Azure)",
  };
  const [query] = buildQueries(qualified);

  assert.match(query, /"DevOps Engineer" OR "Cloud Infrastructure Engineer"/);
  assert.doesNotMatch(query, /Kubernetes|Terraform|AWS\/Azure/);
  assert.deepEqual(matches({ title: "DevOps", remote: true, location: "Remote - US" }, qualified), { ok: true });
  assert.deepEqual(matches({ title: "Example Engineer", remote: true, location: "Remote - US" }, qualified), { ok: false, why: "title" });
});

test("fit checking lets the full posting match even when the title differs", () => {
  const withFit = { ...settings, fitCheck: true };
  assert.deepEqual(
    matches({ title: "Infrastructure Engineer", remote: true, location: "Remote - US" }, withFit),
    { ok: true },
  );
});

test("discovery reports missing profile details before searching", async () => {
  store.db.settings.keywords = "Example Engineer";
  store.db.profile.city = "";
  const result = await discover();
  assert.equal(result.results, 0);
  assert.match(result.errors[0], /Complete your profile before searching/);
  assert.match(result.errors[0], /present work location/);
});
