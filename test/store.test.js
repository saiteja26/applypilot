const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "applypilot-store-test-"));
const previous = {
  data: process.env.APPLYPILOT_DATA,
  claude: process.env.ANTHROPIC_API_KEY,
  search: process.env.APPLYPILOT_SEARCH_KEY,
};
process.env.APPLYPILOT_DATA = dataDir;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.APPLYPILOT_SEARCH_KEY;
fs.writeFileSync(path.join(dataDir, "db.json"), JSON.stringify({
  settings: {
    apiKey: "legacy-claude-test-key",
    searchKey: "legacy-search-test-key",
    model: "test-model",
  },
}));

const store = require("../server/lib/store");

test.after(() => {
  if (previous.data === undefined) delete process.env.APPLYPILOT_DATA;
  else process.env.APPLYPILOT_DATA = previous.data;
  if (previous.claude === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previous.claude;
  if (previous.search === undefined) delete process.env.APPLYPILOT_SEARCH_KEY;
  else process.env.APPLYPILOT_SEARCH_KEY = previous.search;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("legacy API keys are migrated to process environment and removed from the JSON store", () => {
  const { db } = store;
  assert.equal(process.env.ANTHROPIC_API_KEY, "legacy-claude-test-key");
  assert.equal(process.env.APPLYPILOT_SEARCH_KEY, "legacy-search-test-key");
  assert.equal(Object.hasOwn(db.settings, "apiKey"), false);
  assert.equal(Object.hasOwn(db.settings, "searchKey"), false);

  db.settings.apiKey = "temporary-secret";
  store.save();
  const saved = fs.readFileSync(path.join(dataDir, "db.json"), "utf8");
  assert.equal(saved.includes("legacy-claude-test-key"), false);
  assert.equal(saved.includes("legacy-search-test-key"), false);
  assert.equal(saved.includes("temporary-secret"), false);
});
