// One-off server setup, run from your PC (not on Fly):
//
//   node scripts/setup-roles.js           dry run: shows what would change
//   node scripts/setup-roles.js --apply   makes the changes
//
// Safe to re-run. It only touches roles below the bot's own role, because
// Discord doesn't let a bot edit anything above itself.

import { REST, Routes, PermissionFlagsBits } from 'discord.js';
import { config } from '../src/config.js';

const APPLY = process.argv.includes('--apply');
const rest = new REST().setToken(config.token);
const g = config.guildId;

const BARISTA = { name: 'Barista', color: 0x8b5a2b, hoist: true, mentionable: false, permissions: '0' };

const roles = async () => (await rest.get(Routes.guildRoles(g))).sort((a, b) => b.position - a.position);
const step = async (label, fn) => {
  console.log(`${APPLY ? '•' : '[dry run]'} ${label}`);
  if (APPLY) await fn();
};

let all = await roles();
const guild = await rest.get(Routes.guild(g));
const botMember = await rest.get(Routes.guildMember(g, config.clientId));
const everyone = all.find((r) => r.id === g);
const botRoles = all.filter((r) => botMember.roles.includes(r.id));
// Positions shift when a role is created, so always read the bot's position from the latest list.
const botTopIn = (list) => Math.max(...list.filter((r) => botMember.roles.includes(r.id)).map((r) => r.position));
const botPerms = [everyone, ...botRoles].reduce((p, r) => p | BigInt(r.permissions), 0n);

console.log('Current order (top first):');
for (const r of all) console.log(`  ${r.position.toString().padStart(2)}  ${r.name}${botMember.roles.includes(r.id) ? '   <- bot' : ''}`);
console.log();

// 1. Barista role
let barista = all.find((r) => r.name.toLowerCase() === 'barista');
if (barista) console.log('Barista role already exists, leaving it as is.');
else {
  await step('Create role "Barista" (brown, shown separately, no extra permissions)', async () => {
    barista = await rest.post(Routes.guildRoles(g), { body: BARISTA, reason: 'Server setup' });
  });
  all = APPLY ? await roles() : all;
}

// 2. Order everything below the bot
const byName = (name) => all.find((r) => r.name.toLowerCase() === name.toLowerCase());
const desired = [
  byName('Admin'),
  byName('Robert'),
  barista ?? { id: 'new-barista', name: 'Barista' },
  all.find((r) => r.tags && 'premium_subscriber' in r.tags), // Server Booster
  all.find((r) => r.id === config.shopPingRoleId), // matinali
  all.find((r) => r.id === config.defaultRoleId), // cafengiu
].filter(Boolean);

const botTop = botTopIn(all);
const below = all.filter((r) => r.position < botTop && r.id !== g);
const rest_ = below.filter((r) => !desired.some((d) => d.id === r.id));
const order = [...desired.filter((d) => d.id === 'new-barista' || below.some((r) => r.id === d.id)), ...rest_];
const skipped = desired.filter((d) => d.id !== 'new-barista' && !below.some((r) => r.id === d.id));
for (const r of skipped) console.log(`Can't move "${r.name}": it's above the bot's role.`);

await step(`Reorder roles under the bot to: ${order.map((r) => r.name).join(' > ')}`, async () => {
  const positions = order.map((r, i) => ({ id: r.id, position: order.length - i }));
  await rest.patch(Routes.guildRoles(g), { body: positions, reason: 'Server setup' });
});

// 3. Admin role for the server owner
const admin = byName('Admin');
if (admin && admin.position < botTop) {
  const owner = await rest.get(Routes.guildMember(g, guild.owner_id));
  if (owner.roles.includes(admin.id)) console.log('Owner already has Admin.');
  else
    await step(`Give "Admin" to the server owner (${owner.user.username})`, () =>
      rest.put(Routes.guildMemberRole(g, guild.owner_id, admin.id), { reason: 'Server setup' }),
    );
}

// 4. Only the bot pings matinali (needs the bot to have "Mention All Roles")
const ping = all.find((r) => r.id === config.shopPingRoleId);
if (ping?.mentionable) {
  if (botPerms & PermissionFlagsBits.MentionEveryone || botPerms & PermissionFlagsBits.Administrator)
    await step(`Turn off "anyone can @mention" on "${ping.name}"`, () =>
      rest.patch(Routes.guildRole(g, ping.id), { body: { mentionable: false }, reason: 'Only the bot pings this role' }),
    );
  else
    console.log(`Leaving "${ping.name}" mentionable by everyone: the bot lacks "Mention @everyone, @here, and All Roles", so it couldn't ping the role otherwise.`);
}

if (APPLY) {
  console.log('\nNew order (top first):');
  for (const r of await roles()) console.log(`  ${r.position.toString().padStart(2)}  ${r.name}`);
} else console.log('\nNothing changed. Re-run with --apply to make these changes.');
