import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';
import { onMemberJoin } from './welcome.js';
import { getMeta, loadStore } from './store.js';
import { IMPORT_VERSION, importHistory, onMessage, startSweep } from './learning.js';
import { startApi } from './api.js';
import { seedShopState } from './shop.js';

loadStore(config.dataDir);

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers];
// GuildMembers and MessageContent are privileged intents: enable "Server Members Intent"
// and "Message Content Intent" in the Developer Portal. MessageContent is only requested
// once /bully is configured, so the bot still starts without it.
if (config.bullyEnabled) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);

const client = new Client({ intents });

const byName = new Map(commands.map((c) => [c.data.name, c]));

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  await seedShopState(client, config);
  if (config.bullyEnabled) {
    startSweep();
    console.log('/bully enabled: learning from chat.');
    // Build profiles from past chat once (and again whenever the import learns from more
    // sources, i.e. IMPORT_VERSION goes up). Re-run any time with /backfill.
    if ((getMeta('importVersion') ?? 0) < IMPORT_VERSION) {
      console.log('Building profiles from chat history (one-time)...');
      const guild = await c.guilds.fetch(config.guildId);
      importHistory(guild, config, { report: (line) => console.log(`[import] ${line}`) })
        .then((r) => console.log(`[import] Done: ${r.messages} messages, ${r.channels} channels, ${r.people} people.`))
        .catch((err) => console.error('[import] Failed:', err));
    }
  } else {
    console.log('/bully disabled (no Claude credentials: set the federation variables or ANTHROPIC_API_KEY).');
  }
});

client.on(Events.GuildMemberAdd, (member) => onMemberJoin(member, config));

if (config.bullyEnabled) client.on(Events.MessageCreate, (message) => onMessage(message, config));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;
  const command = byName.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction, config);
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err);
    const content = `Something went wrong: ${err.message}`;
    if (interaction.deferred && !interaction.replied) await interaction.editReply({ content }).catch(() => {});
    else if (interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

startApi(client, config);
client.login(config.token);
