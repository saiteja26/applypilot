// Minimal PDF writer (no dependencies): Helvetica text, wrapping, rules, multiple pages.
// Enough for a clean one- or two-page resume and a cover letter.
const { WINANSI, WIDTHS } = require("./fontmetrics");

const FONTS = { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique" };
const FONT_KEYS = { regular: "F1", bold: "F2", italic: "F3" };

// Characters outside WinAnsi get a close stand-in instead of disappearing.
const FALLBACK = { "‐": "-", "‑": "-", "‒": "-", "−": "-", " ": " ", " ": " ", "​": "", "→": "->", "←": "<-", "✓": "x", "●": "•", "▪": "•", "‣": "•" };

function clean(text) {
  let out = "";
  for (const ch of String(text ?? "").normalize("NFC")) {
    const cp = ch.codePointAt(0);
    if (ch === "\n" || ch === "\t") { out += " "; continue; }
    if (WINANSI[cp]) { out += ch; continue; }
    if (FALLBACK[ch] !== undefined) { out += FALLBACK[ch]; continue; }
    const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    out += base && WINANSI[base.codePointAt(0)] ? base : "?";
  }
  return out;
}

function width(text, font, size) {
  const w = WIDTHS[FONTS[font]];
  let total = 0;
  for (const ch of text) {
    const code = WINANSI[ch.codePointAt(0)] || 63;
    total += w[code - 32] || 500;
  }
  return (total * size) / 1000;
}

function encode(text) {
  let s = "";
  for (const ch of text) {
    const code = WINANSI[ch.codePointAt(0)] || 63;
    if (ch === "(" || ch === ")" || ch === "\\") s += "\\" + ch;
    else if (code < 128) s += ch;
    else s += "\\" + code.toString(8).padStart(3, "0");
  }
  return s;
}

function wrap(text, font, size, maxWidth) {
  const words = clean(text).split(/ +/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const tryLine = line ? line + " " + word : word;
    if (width(tryLine, font, size) <= maxWidth || !line) line = tryLine;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

class Doc {
  constructor({ margin = 54, pageWidth = 612, pageHeight = 792 } = {}) {
    Object.assign(this, { margin, pageWidth, pageHeight });
    this.pages = [];
    this.newPage();
  }
  get contentWidth() { return this.pageWidth - this.margin * 2; }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = this.pageHeight - this.margin; }
  ensure(h) { if (this.y - h < this.margin) this.newPage(); }
  text(str, x, y, { font = "regular", size = 10, color = [0.1, 0.1, 0.1] } = {}) {
    this.ops.push(`BT ${color.join(" ")} rg /${FONT_KEYS[font]} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${encode(clean(str))}) Tj ET`);
  }
  rule(y, { thickness = 0.6, color = [0.6, 0.6, 0.6] } = {}) {
    this.ops.push(`${color.join(" ")} RG ${thickness} w ${this.margin} ${y.toFixed(2)} m ${(this.pageWidth - this.margin).toFixed(2)} ${y.toFixed(2)} l S`);
  }
  /** Paragraph with wrapping. Returns nothing; moves the cursor down. */
  para(str, { font = "regular", size = 10, leading = 1.32, indent = 0, after = 4, color, bullet = false } = {}) {
    const x = this.margin + indent + (bullet ? 11 : 0);
    const lines = wrap(str, font, size, this.contentWidth - indent - (bullet ? 11 : 0));
    const lh = size * leading;
    lines.forEach((line, i) => {
      this.ensure(lh);
      this.y -= lh;
      if (bullet && i === 0) this.text("•", this.margin + indent + 1, this.y, { font, size, color });
      this.text(line, x, this.y, { font, size, color });
    });
    this.y -= after;
  }
  /** One line with text on the left and text flush right (title + dates). */
  leftRight(left, right, { font = "bold", size = 10.5, rightFont = "regular", rightSize = 9.5, after = 1, color } = {}) {
    const lh = size * 1.3;
    this.ensure(lh);
    this.y -= lh;
    const rw = right ? width(clean(right), rightFont, rightSize) : 0;
    const maxLeft = this.contentWidth - rw - 12;
    let l = clean(left);
    while (l.length > 3 && width(l, font, size) > maxLeft) l = l.slice(0, -2);
    if (l !== clean(left)) l = l.replace(/\s*\S{0,2}$/, "") + "...";
    this.text(l, this.margin, this.y, { font, size, color });
    if (right) this.text(right, this.pageWidth - this.margin - rw, this.y, { font: rightFont, size: rightSize, color: [0.35, 0.35, 0.35] });
    this.y -= after;
  }
  centered(str, { font = "regular", size = 10, after = 2, color } = {}) {
    const lh = size * 1.25;
    this.ensure(lh);
    this.y -= lh;
    const s = clean(str);
    this.text(s, (this.pageWidth - width(s, font, size)) / 2, this.y, { font, size, color });
    this.y -= after;
  }
  space(h) { this.y -= h; }

  toBuffer(title = "Document") {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const catalogId = add(null);
    const pagesId = add(null);
    const fontIds = Object.entries(FONTS).map(([k, name]) => [FONT_KEYS[k], add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`)]);
    const fontRes = fontIds.map(([k, id]) => `/${k} ${id} 0 R`).join(" ");
    const pageIds = [];
    for (const ops of this.pages) {
      const stream = ops.join("\n");
      const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.pageWidth} ${this.pageHeight}] /Resources << /Font << ${fontRes} >> >> /Contents ${contentId} 0 R >>`));
    }
    objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    const infoId = add(`<< /Title (${encode(clean(title))}) /Producer (ApplyPilot) >>`);
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}

const ACCENT = [0.07, 0.31, 0.45];

/** resume: { name, contact: [..], headline, summary, skills: [..], experience: [{title, company, location, dates, bullets}], education: [{school, degree, dates, details}], extras: [{heading, items}] } */
function renderResume(r) {
  const d = new Doc({ margin: 48 });
  d.centered(r.name || "", { font: "bold", size: 20, after: 2, color: ACCENT });
  if (r.headline) d.centered(r.headline, { size: 10.5, after: 1, color: [0.3, 0.3, 0.3] });
  if (r.contact?.length) d.centered(r.contact.filter(Boolean).join("  |  "), { size: 9, after: 6, color: [0.3, 0.3, 0.3] });
  const section = (title) => {
    d.ensure(40);
    d.space(6);
    d.para(title.toUpperCase(), { font: "bold", size: 10.5, after: 1, color: ACCENT });
    d.rule(d.y);
    d.space(3);
  };
  if (r.summary) { section("Summary"); d.para(r.summary, { size: 10, after: 2 }); }
  if (r.skills?.length) { section("Skills"); d.para(r.skills.join("  •  "), { size: 9.8, after: 2 }); }
  if (r.experience?.length) {
    section("Experience");
    for (const e of r.experience) {
      d.ensure(50);
      d.leftRight([e.title, e.company].filter(Boolean).join(" — "), e.dates || "");
      if (e.location) d.para(e.location, { font: "italic", size: 9, after: 1, color: [0.35, 0.35, 0.35] });
      for (const b of e.bullets || []) d.para(b, { bullet: true, size: 9.8, after: 1, indent: 2 });
      d.space(4);
    }
  }
  if (r.education?.length) {
    section("Education");
    for (const e of r.education) {
      d.leftRight([e.degree, e.school].filter(Boolean).join(" — "), e.dates || "", { size: 10 });
      if (e.details) d.para(e.details, { size: 9.5, after: 2 });
    }
  }
  for (const x of r.extras || []) {
    if (!x.items?.length) continue;
    section(x.heading);
    for (const it of x.items) d.para(it, { bullet: true, size: 9.8, after: 1, indent: 2 });
  }
  return d.toBuffer(`${r.name} - Resume`);
}

/** letter: { name, contact: [..], date, greeting, paragraphs: [..], closing } */
function renderCoverLetter(l) {
  const d = new Doc({ margin: 64 });
  d.para(l.name || "", { font: "bold", size: 16, after: 1, color: ACCENT });
  if (l.contact?.length) d.para(l.contact.filter(Boolean).join("  |  "), { size: 9, after: 4, color: [0.3, 0.3, 0.3] });
  d.rule(d.y);
  d.space(18);
  if (l.date) d.para(l.date, { size: 10.5, after: 12 });
  d.para(l.greeting || "Dear Hiring Team,", { size: 10.5, after: 10 });
  for (const p of l.paragraphs || []) d.para(p, { size: 10.5, leading: 1.45, after: 10 });
  d.space(4);
  d.para(l.closing || "Sincerely,", { size: 10.5, after: 2 });
  d.para(l.name || "", { size: 10.5 });
  return d.toBuffer(`${l.name} - Cover Letter`);
}

module.exports = { Doc, renderResume, renderCoverLetter, wrap, width, clean };
