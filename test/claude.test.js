const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "applypilot-claude-test-"));
const previous = {
  data: process.env.APPLYPILOT_DATA,
  key: process.env.ANTHROPIC_API_KEY,
};
process.env.APPLYPILOT_DATA = dataDir;
const claude = require("../server/lib/claude");

test.after(() => {
  if (previous.data === undefined) delete process.env.APPLYPILOT_DATA;
  else process.env.APPLYPILOT_DATA = previous.data;
  if (previous.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previous.key;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Claude API key rejects non-ASCII characters before making a request", async () => {
  const originalFetch = global.fetch;
  let called = false;
  process.env.ANTHROPIC_API_KEY = "√invalid";
  global.fetch = async () => {
    called = true;
    throw new Error("fetch should not be called");
  };

  try {
    await assert.rejects(
      claude.ask({ system: "test", prompt: "test" }),
      {
        message: "ANTHROPIC_API_KEY must be the plain ASCII key from Anthropic Console, without spaces or extra characters. Set it again in the server environment, then restart the server.",
        status: 412,
      },
    );
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});
