import 'dotenv/config';

const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}. See .env.example.`);
  process.exit(1);
}

const optional = (key) => process.env[key]?.trim() || null;

export const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  welcomeChannelId: optional('WELCOME_CHANNEL_ID'),
  defaultRoleId: optional('DEFAULT_ROLE_ID'),
  modLogChannelId: optional('MOD_LOG_CHANNEL_ID'),
  shopChannelId: optional('SHOP_CHANNEL_ID'),
  shopPingRoleId: optional('SHOP_PING_ROLE_ID'),
  shopName: optional('SHOP_NAME') ?? 'The Coffee Shop',
  // /bully turns on when Claude credentials are present: an API key, or Workload Identity Federation.
  bullyEnabled: Boolean(optional('ANTHROPIC_API_KEY') || optional('ANTHROPIC_FEDERATION_RULE_ID')),
  // Comma-separated channel IDs to learn from; empty = every channel the bot can see.
  bullyChannelIds: (optional('BULLY_CHANNEL_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  dataDir: optional('DATA_DIR') ?? 'data',
  // HTTP API (src/api.js): changing the shop status needs this bearer token; reading is public.
  shopApiToken: optional('SHOP_API_TOKEN'),
  port: Number(process.env.PORT) || 8080,
  // Roles that count as staff for /intel (anyone with Manage Messages does too).
  staffRoleIds: (optional('STAFF_ROLE_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};
