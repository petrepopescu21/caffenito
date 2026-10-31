// One-off, run from your PC: creates the shop status channel at the top of the channel list.
// Only the bot can post there; #anunturi is read-only except for Robert, Admin and the bot.
//
//   node scripts/setup-status-channel.js           dry run
//   node scripts/setup-status-channel.js --apply   make the changes
//
// Needs Caffenito to have Manage Channels while it runs. The bot also gets Manage Channels
// on the new channel itself, so it can keep renaming it after you remove the server-wide one.
// Safe to re-run: an existing status channel is reused.

import { REST, Routes, ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { config } from '../src/config.js';
import { CHANNEL_NAMES } from '../src/shop.js';

const APPLY = process.argv.includes('--apply');
const rest = new REST().setToken(config.token);
const g = config.guildId;
const step = async (label, fn) => {
  console.log(`${APPLY ? '•' : '[dry run]'} ${label}`);
  return APPLY ? fn() : null;
};
const bits = (...flags) => flags.reduce((a, f) => a | f, 0n).toString();

const roles = await rest.get(Routes.guildRoles(g));
const role = (name) => roles.find((r) => r.name.toLowerCase() === name.toLowerCase());
const [robert, admin] = [role('Robert'), role('Admin')];
const channels = await rest.get(Routes.guildChannels(g));
const announcements = channels.find((c) => c.name === 'anunturi');

// Read-only for everyone; `writers` (roles) can post; the bot can always post.
const NO_WRITING = bits(P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads);
const overwrites = ({ writers = [], botExtra = [] } = {}) => [
  { id: g, type: 0, deny: NO_WRITING, allow: '0' },
  ...writers.map((r) => ({ id: r.id, type: 0, allow: bits(P.SendMessages), deny: '0' })),
  { id: config.clientId, type: 1, allow: bits(P.ViewChannel, P.SendMessages, P.EmbedLinks, ...botExtra), deny: '0' },
];
// Status channel: bot only (it also renames the channel). #anunturi: Robert and Admin too.
const STATUS = overwrites({ botExtra: [P.ManageChannels] });
const ANNOUNCEMENTS = overwrites({ writers: [robert, admin] });

// Start the name from the latest announcement, so the sign is right from the first moment.
const last = (await rest.get(Routes.channelMessages(config.shopChannelId) + '?limit=50')).find((m) => m.author.id === config.clientId && m.embeds[0]?.title);
const status = last?.embeds[0].title.includes('OPEN') ? 'open' : 'closed';

let statusChannel = channels.find((c) => Object.values(CHANNEL_NAMES).includes(c.name));
if (statusChannel) console.log(`Status channel exists: #${statusChannel.name} (${statusChannel.id})`);
else {
  statusChannel = await step(`Create #${CHANNEL_NAMES[status]} at the top of the channel list (latest announcement: ${status})`, () =>
    rest.post(Routes.guildChannels(g), {
      body: { name: CHANNEL_NAMES[status], type: ChannelType.GuildText, topic: 'Is Awake open? Updated by Caffenito with /shop.', position: 0, permission_overwrites: STATUS },
      reason: 'Shop status channel',
    }),
  );
}
if (statusChannel) {
  await step(`Lock #${statusChannel.name}: only Caffenito can post`, () =>
    rest.patch(Routes.channel(statusChannel.id), { body: { permission_overwrites: STATUS }, reason: 'Bot-only status channel' }),
  );
  await step(`Move #${statusChannel.name} to the very top`, () =>
    rest.patch(Routes.guildChannels(g), { body: [{ id: statusChannel.id, position: 0, parent_id: null }], reason: 'Status channel on top' }),
  );
}

// Keep #anunturi's existing overwrites for other roles, replace the ones we manage.
const managed = new Set([g, robert.id, admin.id, config.clientId]);
const keep = (announcements.permission_overwrites ?? []).filter((o) => !managed.has(o.id));
await step('Lock #anunturi: only Robert, Admin and Caffenito can post', () =>
  rest.patch(Routes.channel(announcements.id), { body: { permission_overwrites: [...keep, ...ANNOUNCEMENTS] }, reason: 'Read-only announcements' }),
);

if (statusChannel) console.log(`\nSHOP_CHANNEL_ID=${statusChannel.id}`);
if (!APPLY) console.log('\nNothing changed. Re-run with --apply.');
