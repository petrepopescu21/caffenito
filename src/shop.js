// Coffee shop open/closed status.
//
// Everything goes through setShopStatus(): /shop open|closed in Discord and
// POST /api/shop/status (src/api.js).
//
// One status change updates four places: an announcement in the shop channel (with a
// ping), the bot's own status, the shop channel's name, and the server banner.
// The status itself is saved in the store, so it survives restarts.

import fs from 'node:fs';
import { ActivityType, EmbedBuilder } from 'discord.js';
import { getMeta, setMeta } from './store.js';

// Channel names: the channel sits at the top of the list, so its name is a status sign.
export const CHANNEL_NAMES = { open: '🟢┃awake-deschis', closed: '🔴┃awake-închis' };
const BANNERS = {
  open: new URL('../assets/banner-open.png', import.meta.url),
  closed: new URL('../assets/banner-closed.png', import.meta.url),
};

// { status: 'open' | 'closed' | null, since, note, by }
export function getShopState() {
  return getMeta('shop') ?? { status: null, since: null, note: null, by: null };
}

export function statusEmbed(shopName, status, note) {
  const open = status === 'open';
  const embed = new EmbedBuilder()
    .setColor(open ? 0x2ecc71 : 0xe74c3c)
    .setTitle(open ? `🟢 ${shopName} is now OPEN` : `🔴 ${shopName} is now CLOSED`)
    .setTimestamp();
  if (note) embed.setDescription(note);
  return embed;
}

// Channel name and banner change in the background: Discord allows only 2 channel renames
// per 10 minutes, and a rate-limited rename shouldn't hold up the announcement.
// Needs Manage Channels on the shop channel and Manage Server for the banner.
function updateSigns(channel, status) {
  if (channel.name !== CHANNEL_NAMES[status]) {
    channel.setName(CHANNEL_NAMES[status], 'Shop status').catch((err) => console.error('Could not rename shop channel:', err.message));
  }
  channel.guild
    .setBanner(fs.readFileSync(BANNERS[status]), 'Shop status')
    .catch((err) => console.error('Could not change server banner:', err.message));
}

// First start with a saved status: take it from the status channel's name, so the read
// API has an answer before anyone toggles the shop.
export async function seedShopState(client, config) {
  if (getShopState().status || !config.shopChannelId) return;
  const channel = await client.channels.fetch(config.shopChannelId).catch(() => null);
  const status = Object.keys(CHANNEL_NAMES).find((s) => CHANNEL_NAMES[s] === channel?.name);
  if (status) setMeta('shop', { status, since: null, note: null, by: null });
}

// Returns false (and posts nothing) if the shop is already in that state,
// so a double press doesn't spam the channel. `by` is who changed it, for the read API.
export async function setShopStatus(client, config, status, note, by) {
  if (status !== 'open' && status !== 'closed') throw new Error(`Unknown status "${status}".`);
  if (status === getShopState().status) return false;
  if (!config.shopChannelId) throw new Error('SHOP_CHANNEL_ID is not set.');

  const channel = await client.channels.fetch(config.shopChannelId);
  await channel.send({
    content: config.shopPingRoleId ? `<@&${config.shopPingRoleId}>` : undefined,
    embeds: [statusEmbed(config.shopName, status, note)],
    allowedMentions: { roles: config.shopPingRoleId ? [config.shopPingRoleId] : [] },
  });
  setMeta('shop', { status, since: new Date().toISOString(), note: note || null, by: by ?? null });

  client.user.setActivity(status === 'open' ? '☕ Shop is open' : 'Shop is closed', { type: ActivityType.Custom });
  updateSigns(channel, status);
  return true;
}
