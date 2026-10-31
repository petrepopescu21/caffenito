// Everything /bully knows, kept in one JSON file (state.json). On Fly it lives on a
// volume (DATA_DIR=/data) so it survives deploys.
//
// profiles[userId] = {
//   name, language, summary, role, humor,
//   traits: [{ trait, evidence, confidence }], relationships: [{ with, dynamic }],
//   contradictions: [], roastAngles: [],   <- written by Claude, revised over time
//   facts: [{ text, by, at }],             <- added by staff via /intel; Claude never edits these
//   updatedAt,
// }
// recent = the last RECENT_LINES lines of chat server-wide, never consumed by learning.
//   /bully reads the ones involving its target for fresh context; nothing is saved from it.
// group = { summary, updatedAt }           <- how the friend group works as a whole
// transcripts[channelId] = { name, lines: [{ at, authorId, author, replyTo, text }] }
//   <- new chat not yet learned from; dropped once Claude has processed it
// meta = { profilesImportedAt, ... }

import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES_PER_CHANNEL = 600;
const RECENT_LINES = 300;
const MAX_FACTS = 30;
const LEARNED_FIELDS = ['summary', 'role', 'humor', 'traits', 'relationships', 'contradictions', 'roastAngles'];

let file;
let state = { profiles: {}, group: { summary: '', updatedAt: null }, transcripts: {}, recent: [], meta: {} };
let saveTimer = null;

const blankProfile = (name) => ({
  name,
  language: null,
  summary: '',
  role: '',
  humor: '',
  traits: [],
  relationships: [],
  contradictions: [],
  roastAngles: [],
  facts: [],
  updatedAt: null,
});

export function loadStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  file = path.join(dataDir, 'state.json');
  if (fs.existsSync(file)) {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } else {
    // One-time migration from the old per-person notes: keep names and staff facts.
    const old = path.join(dataDir, 'members.json');
    if (fs.existsSync(old)) {
      for (const [id, m] of Object.entries(JSON.parse(fs.readFileSync(old, 'utf8')))) {
        state.profiles[id] = { ...blankProfile(m.name), facts: m.facts ?? [], language: m.language ?? null };
      }
      console.log(`Migrated ${Object.keys(state.profiles).length} member(s) from members.json.`);
      save(true);
    }
  }
  console.log(`Loaded ${Object.keys(state.profiles).length} profile(s) from ${file}.`);
}

function save(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    // Write to a temp file and rename, so a crash mid-write can't corrupt the store.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };
  if (now) write();
  else saveTimer = setTimeout(write, 2000);
}

const profileFor = (id, name) => {
  const p = (state.profiles[id] ??= blankProfile(name));
  if (name) p.name = name;
  return p;
};

export const getProfile = (id) => state.profiles[id] ?? null;
export const allProfiles = () => Object.entries(state.profiles);
export const getGroup = () => state.group;

// --- transcripts -------------------------------------------------------------

export function appendLine(channelId, channelName, line) {
  const t = (state.transcripts[channelId] ??= { name: channelName, lines: [] });
  t.name = channelName;
  t.lines.push(line);
  if (t.lines.length > MAX_LINES_PER_CHANNEL) t.lines.splice(0, t.lines.length - MAX_LINES_PER_CHANNEL);

  profileFor(line.authorId, line.author);
  state.recent.push(line);
  if (state.recent.length > RECENT_LINES) state.recent.splice(0, state.recent.length - RECENT_LINES);
  save();
  return t.lines.length;
}

// The latest lines a person wrote or that replied to them, oldest first.
export const recentInvolving = (id, n) => state.recent.filter((l) => l.authorId === id || l.replyToId === id).slice(-n);

export const channelsWithLines = () =>
  Object.entries(state.transcripts).map(([id, t]) => ({ id, name: t.name, count: t.lines.length }));

export const peekLines = (channelId) => [...(state.transcripts[channelId]?.lines ?? [])];

// Drop the first `n` lines once they've been learned from; newer lines stay queued.
export function consumeLines(channelId, n) {
  state.transcripts[channelId]?.lines.splice(0, n);
  save();
}

// After a history import: queued lines it already covered would otherwise be learned twice.
export function dropLinesBefore(ts) {
  for (const t of Object.values(state.transcripts)) t.lines = t.lines.filter((l) => l.at > ts);
  save();
}

// --- learned profiles ------------------------------------------------------------

// Merges Claude's revised profiles in. Staff facts and recent messages are never touched.
export function applyUpdate(updatedProfiles, groupSummary) {
  const now = new Date().toISOString();
  for (const u of updatedProfiles) {
    if (!state.profiles[u.id]) continue; // only people we've actually seen
    const p = state.profiles[u.id];
    Object.assign(p, {
      summary: u.summary,
      role: u.role,
      humor: u.humor,
      language: u.language || p.language,
      traits: u.traits.slice(0, 8),
      relationships: u.relationships.slice(0, 6),
      contradictions: u.contradictions.slice(0, 4),
      roastAngles: u.roast_angles.slice(0, 5),
      updatedAt: now,
    });
  }
  if (groupSummary) state.group = { summary: groupSummary, updatedAt: now };
  save();
}

// Used before rebuilding from history: forget everything Claude concluded, keep staff facts.
export function resetLearned() {
  for (const p of Object.values(state.profiles)) {
    for (const k of LEARNED_FIELDS) p[k] = Array.isArray(p[k]) ? [] : '';
    p.updatedAt = null;
  }
  state.group = { summary: '', updatedAt: null };
  save();
}

// Registers someone seen in history (without touching their recent messages).
export const ensureProfile = (id, name) => {
  profileFor(id, name);
  save();
};

// --- staff facts -----------------------------------------------------------------

// Returns false if the member already has MAX_FACTS.
export function addFact(id, name, text, by) {
  const p = profileFor(id, name);
  if (p.facts.length >= MAX_FACTS) return false;
  p.facts.push({ text, by, at: new Date().toISOString() });
  save();
  return true;
}

// `index` is 0-based. Returns the removed fact, or null.
export function removeFact(id, index) {
  const facts = state.profiles[id]?.facts;
  if (!facts || index < 0 || index >= facts.length) return null;
  const [removed] = facts.splice(index, 1);
  save();
  return removed;
}

// Wipes a person: their profile, facts, and their queued messages.
export function forgetMember(id) {
  delete state.profiles[id];
  for (const t of Object.values(state.transcripts)) t.lines = t.lines.filter((l) => l.authorId !== id);
  state.recent = state.recent.filter((l) => l.authorId !== id);
  save();
}

// --- misc --------------------------------------------------------------------------

export const getMeta = (key) => state.meta[key];
export function setMeta(key, value) {
  state.meta[key] = value;
  save();
}
