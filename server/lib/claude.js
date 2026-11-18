// Thin client for the Claude Messages API. The key comes only from the server environment and is
// never sent to the extension or persisted in the JSON store.
const store = require("./store");

async function ask({ system, prompt, maxTokens = 4000 }) {
  const s = store.db.settings;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error("No Claude API key. Set ANTHROPIC_API_KEY in the server environment, then restart the server."); e.status = 412; throw e; }
  if (!/^[\x21-\x7E]+$/.test(key)) {
    const e = new Error("ANTHROPIC_API_KEY must be the plain ASCII key from Anthropic Console, without spaces or extra characters. Set it again in the server environment, then restart the server.");
    e.status = 412;
    throw e;
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: s.model || "claude-sonnet-5-5", max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] /* prompt: text, or content blocks (e.g. a PDF + text) */ }),
    signal: AbortSignal.timeout(180000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = data?.error?.message || "request failed";
    const plain = /credit balance/i.test(m) ? "Your Claude API key has no credits. Add API credits at console.anthropic.com (Settings, Billing). Credits bought in the Claude chat app don't count."
      : r.status === 401 ? "Your Claude API key isn't valid. Create a new one at console.anthropic.com and paste it in Settings."
      : r.status === 404 && /model/i.test(m) ? `The model "${s.model}" isn't available to your key. Change it in Settings.`
      : r.status === 429 ? "Claude's rate limit was hit. Wait a minute and try again."
      : `Claude API ${r.status}: ${m}`;
    throw Object.assign(new Error(plain), { status: r.status === 401 || /credit/i.test(m) ? 412 : 502 });
  }
  const usage = data.usage || {};
  store.db.meta.tokens = { input: (store.db.meta.tokens?.input || 0) + (usage.input_tokens || 0), output: (store.db.meta.tokens?.output || 0) + (usage.output_tokens || 0) };
  return (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

/** Asks for JSON and parses the first JSON object in the reply (tolerates ```json fences). */
async function askJSON(opts) {
  const text = await ask(opts);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Claude didn't return JSON");
  return JSON.parse(text.slice(start, end + 1));
}

module.exports = { ask, askJSON };
