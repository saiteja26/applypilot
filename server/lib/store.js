// Everything lives in one JSON file (data/db.json) plus generated PDFs in data/files/.
// Writes go to a temp file first, then replace the old one, so a crash never leaves half a file.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.APPLYPILOT_DATA || path.join(__dirname, "..", "..", "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const FILES_DIR = path.join(DATA_DIR, "files");

const DEFAULT_SETTINGS = {
  model: "claude-sonnet-5-5",
  // Job search: a web search finds postings on these platforms; no company list needed.
  searchProvider: "serper",  // "serper" (Google results) or "brave"
  platformLever: true,
  platformGreenhouse: true,
  platformAshby: true,
  postedToday: true,          // only postings from the last 24 hours (otherwise the last 7 days)
  keywords: "",               // roles to apply for, one per line
  remoteOk: true,
  remoteRegions: "United States\nRemote - US\nUS Remote\nRemote USA\nRemote (US)",
  locations: "",              // on-site / hybrid cities, one per line
  exclude: "intern\nprincipal",
  fitCheck: true,             // rate each found posting against your profile (1-5)
  minFit: 3,                  // postings rated below this are set aside, not applied to
  dailyLimit: 25,
  autoDiscover: true,
  autoAcknowledge: false, // tick plain "I confirm this information is accurate / I've read the privacy notice" boxes
};

const EMPTY_PROFILE = {
  firstName: "", lastName: "", preferredName: "", email: "", phone: "",
  city: "", state: "", country: "United States", address: "", zip: "",
  linkedin: "", github: "", portfolio: "", otherLinks: "",
  headline: "", summary: "", skills: "",
  experience: [],   // {company, title, location, start, end, current, bullets}
  education: [],    // {school, degree, field, start, end, details}
  certifications: "",
  // Work authorization & visa: what postings ask ("authorized to work?", "sponsorship now or in the future?", "visa type?", "U.S. person (export control)?", "clearance?")
  visaStatus: "", visaExpiry: "", workAuthorized: "", sponsorNow: "", sponsorFuture: "", h1bTransfer: "",
  citizenship: "", usPerson: "", clearance: "", willingToRelocate: "no",
  remotePreference: "any", salaryExpectation: "", noticePeriod: "", earliestStart: "",
  noncompeteStatus: "", recruiterSmsConsent: "", recruitmentMarketingConsent: "",
  yearsExperience: "", currentCompany: "", currentTitle: "",
  gender: "", race: "", hispanic: "", veteran: "", disability: "", pronouns: "",
  otherFacts: "",     // free text, one fact per line
  commonAnswers: "",  // "Q: ... A: ..." pairs the person wants reused
  writingSample: "",
  resumeText: "",     // the resume you pasted, kept so it isn't lost  // optional: a paragraph in the person's own voice for the cover letter tone
  // Preferences (some suggested from your experience)
  seniority: "", industries: "", companySize: "", employmentType: "Full-time", dealBreakers: "",
  prefQA: [],         // {q, a}: follow-up questions suggested from your experience
  // Stories: real situations from your work, used to tailor resumes and answer custom questions
  stories: [],        // {id, roleIndex (-1 = general), prompt, answer, tags}
};

let db = null;

function load() {
  if (db) return db;
  fs.mkdirSync(FILES_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  else db = {};
  db.token ||= "ap_" + crypto.randomBytes(24).toString("base64url");
  db.profile = { ...EMPTY_PROFILE, ...(db.profile || {}) };
  if (db.profile.needsSponsorship && !db.profile.sponsorFuture) db.profile.sponsorFuture = db.profile.needsSponsorship;
  delete db.profile.needsSponsorship;
  delete db.settings?.boards;
  const savedSettings = db.settings || {};
  const legacyApiKey = savedSettings.apiKey;
  const legacySearchKey = savedSettings.searchKey;
  if (legacyApiKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = String(legacyApiKey);
  if (legacySearchKey && !process.env.APPLYPILOT_SEARCH_KEY) process.env.APPLYPILOT_SEARCH_KEY = String(legacySearchKey);
  delete savedSettings.apiKey;
  delete savedSettings.searchKey;
  db.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
  db.jobs ||= {};
  db.events ||= [];
  db.meta ||= {};
  if (legacyApiKey || legacySearchKey) {
    console.warn("Removed legacy plaintext API keys from data/db.json. Configure ANTHROPIC_API_KEY and APPLYPILOT_SEARCH_KEY in the server environment for future starts.");
  }
  save();
  return db;
}

let saveTimer = null;
function save() {
  if (db?.settings) {
    delete db.settings.apiKey;
    delete db.settings.searchKey;
  }
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_PATH);
}
/** Batch quick successive writes. */
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 200); }

function filePath(jobId, kind) { return path.join(FILES_DIR, `${jobId.replace(/[^a-z0-9_-]/gi, "")}-${kind}.pdf`); }

function event(kind, message, data = {}, jobId = null) {
  db.events.unshift({ at: Date.now(), kind, message: String(message).slice(0, 2000), data, jobId });
  db.events = db.events.slice(0, 500);
  saveSoon();
}

module.exports = { load, save, saveSoon, filePath, event, DATA_DIR, EMPTY_PROFILE, DEFAULT_SETTINGS, get db() { return load(); } };
