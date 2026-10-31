// Learns who people are from conversations.
//
// Every message goes into its channel's transcript (with who it replies to). Every 6 hours,
// or once a channel has LEARN_EVERY new messages, Claude reads that stretch of chat together
// with the current profiles of the people in it and revises them. Processed messages are then
// dropped, so Claude only ever sees new chat plus compact profiles, never the whole history.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  allProfiles,
  appendLine,
  channelsWithLines,
  consumeLines,
  dropLinesBefore,
  ensureProfile,
  getGroup,
  getMeta,
  peekLines,
  applyUpdate,
  resetLearned,
  setMeta,
} from './store.js';
import { updateProfiles } from './claude.js';

const LEARN_EVERY = 60; // learn from a channel once it has this many new messages...
const SWEEP_MS = 6 * 60 * 60 * 1000; // ...or every 6 hours if it has at least SWEEP_MIN
const SWEEP_MIN = 5;
const CHUNK = 150; // messages per Claude call
const MAX_TEXT = 500;

// History import limits
const IMPORT_PER_CHANNEL = 3000;
// Bump when the import learns from more sources, so it re-runs once on the next start.
export const IMPORT_VERSION = 2; // 2: threads and forum posts

// Threads (including forum posts) follow their parent channel's setting in BULLY_CHANNEL_IDS.
const learnsFrom = (channel, config) =>
  !config.bullyChannelIds.length || [channel.id, channel.parentId].some((id) => config.bullyChannelIds.includes(id));

const channelLabel = (channel) => (channel.isThread() ? `${channel.parent?.name ?? '?'} › ${channel.name}` : channel.name);

const displayName = (guild, user) => guild?.members.cache.get(user.id)?.displayName ?? user.globalName ?? user.username;

// Turns a Discord message into a transcript line, or null if there's nothing to learn from.
function toLine(msg) {
  if (msg.author.bot || msg.system) return null;
  const text = msg.cleanContent.trim() || (msg.attachments.size ? '[sent an attachment]' : '');
  if (!text) return null;
  const replied = msg.mentions?.repliedUser;
  return {
    at: msg.createdTimestamp,
    channel: channelLabel(msg.channel),
    authorId: msg.author.id,
    author: msg.member?.displayName ?? displayName(msg.guild, msg.author),
    replyTo: replied ? displayName(msg.guild, replied) : null,
    replyToId: replied?.id ?? null,
    text: text.slice(0, MAX_TEXT),
  };
}

// Claude calls run one at a time: they share the group summary and overlapping people.
let queue = Promise.resolve();
const exclusive = (fn) => (queue = queue.then(fn, fn));

async function learnFrom(lines) {
  const speakers = [...new Set(lines.map((l) => l.authorId))];
  const profiles = Object.fromEntries(allProfiles());
  const people = speakers.filter((id) => profiles[id]).map((id) => [id, profiles[id]]);
  const others = Object.entries(profiles)
    .filter(([id]) => !speakers.includes(id))
    .map(([, p]) => p.name);
  const result = await updateProfiles({ people, groupSummary: getGroup().summary, others, lines });
  applyUpdate(result.profiles, result.group_summary);
  return people.length;
}

function learnChannel(channelId) {
  return exclusive(async () => {
    const lines = peekLines(channelId);
    if (!lines.length) return;
    try {
      // Large backlogs are learned in order, chunk by chunk.
      for (let i = 0; i < lines.length; i += CHUNK) {
        const chunk = lines.slice(i, i + CHUNK);
        const n = await learnFrom(chunk);
        consumeLines(channelId, chunk.length);
        console.log(`Learned from ${chunk.length} messages in #${chunk[0].channel} (${n} people updated).`);
      }
    } catch (err) {
      // Unprocessed lines stay queued; the next trigger retries.
      console.error('Learning failed:', err.message);
    }
  });
}

const pending = new Set();

export function onMessage(message, config) {
  if (!message.inGuild() || message.guildId !== config.guildId || !learnsFrom(message.channel, config)) return;
  const line = toLine(message);
  if (!line) return;
  const count = appendLine(message.channelId, line.channel, line);
  if (count >= LEARN_EVERY && !pending.has(message.channelId)) {
    pending.add(message.channelId);
    learnChannel(message.channelId).finally(() => pending.delete(message.channelId));
  }
}

// The schedule is saved, so restarts and deploys don't keep pushing the next sweep back.
export function startSweep() {
  const sweep = () => {
    setMeta('lastSweepAt', Date.now());
    for (const c of channelsWithLines()) if (c.count >= SWEEP_MIN) learnChannel(c.id);
  };
  const last = getMeta('lastSweepAt') ?? (setMeta('lastSweepAt', Date.now()), Date.now());
  const wait = Math.max(0, last + SWEEP_MS - Date.now());
  console.log(`Next learning sweep in ${Math.round(wait / 60000)} min.`);
  setTimeout(() => {
    sweep();
    setInterval(sweep, SWEEP_MS);
  }, wait);
}

// Rebuilds every profile from past chat: reads the channels the bot learns from, then
// replays the history to Claude in chronological chunks. Staff facts are kept.
// `report` gets progress lines (for a slash command reply or the log).
export function importHistory(guild, config, { days = 30, report = () => {} } = {}) {
  return exclusive(async () => {
    const startedAt = Date.now();
    const since = startedAt - days * 86_400_000;
    await guild.members.fetch().catch(() => {}); // for display names; needs the Server Members intent
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const readable = (c) =>
      learnsFrom(c, config) && c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);

    // Text and announcement channels, plus threads: active ones server-wide, and archived
    // public ones under each channel. Forum posts are threads of a forum channel.
    const all = [...(await guild.channels.fetch()).values()].filter(Boolean);
    const parents = all.filter((c) => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(c.type));
    const threads = new Map((await guild.channels.fetchActiveThreads()).threads);
    for (const parent of parents) {
      const archived = await parent.threads.fetchArchived({ type: 'public', limit: 100 }).catch(() => null);
      for (const [id, t] of archived?.threads ?? []) threads.set(id, t);
    }
    const channels = [...parents.filter((c) => c.type !== ChannelType.GuildForum), ...threads.values()].filter(readable);

    const lines = [];
    for (const channel of channels) {
      let before;
      let read = 0;
      while (read < IMPORT_PER_CHANNEL) {
        const page = await channel.messages.fetch({ limit: 100, before });
        if (page.size === 0) break;
        for (const msg of page.values()) {
          if (msg.createdTimestamp < since) continue;
          const line = toLine(msg);
          if (line) lines.push(line);
        }
        read += page.size;
        before = page.last().id;
        if (page.last().createdTimestamp < since) break;
      }
      report(`Read #${channelLabel(channel)} (${read} messages).`);
    }
    lines.sort((a, b) => a.at - b.at);
    for (const l of lines) ensureProfile(l.authorId, l.author);

    resetLearned();
    const chunks = Math.ceil(lines.length / CHUNK);
    report(`Learning from ${lines.length} messages by ${new Set(lines.map((l) => l.authorId)).size} people in ${chunks} step(s)...`);
    for (let i = 0; i < lines.length; i += CHUNK) {
      const n = await learnFrom(lines.slice(i, i + CHUNK));
      report(`Step ${i / CHUNK + 1}/${chunks}: ${n} profiles updated.`);
    }
    dropLinesBefore(startedAt); // queued live messages the import already learned from
    setMeta('profilesImportedAt', new Date().toISOString());
    setMeta('importVersion', IMPORT_VERSION);
    return { channels: channels.length, messages: lines.length, people: new Set(lines.map((l) => l.authorId)).size };
  });
}
