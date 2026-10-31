import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { setShopStatus } from './shop.js';
import { addFact, forgetMember, getGroup, getProfile, recentInvolving, removeFact } from './store.js';
import { writeRoast } from './claude.js';
import { importHistory } from './learning.js';

const BULLY_COOLDOWN_MS = 60_000; // per target
const RECENT_FOR_ROAST = 15; // latest lines by or replying to the target
const lastBullied = new Map();

const FACT_MAX_LENGTH = 200;
const FACTS_PER_HOUR = 10; // per staff member
const factLog = new Map(); // staff user id -> timestamps of recent additions

const isStaff = (interaction, config) =>
  interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages) ||
  config.staffRoleIds.some((id) => interaction.member.roles.cache.has(id));

// Shared by /intel add and the "Add to dossier" message menu. Replies to the interaction.
async function saveFact(interaction, config, target, text) {
  if (!isStaff(interaction, config)) return interaction.reply(ephemeral('Only staff can add to dossiers.'));
  if (target.bot) return interaction.reply(ephemeral('Bots don\'t get dossiers.'));
  text = text.trim().slice(0, FACT_MAX_LENGTH);
  if (!text) return interaction.reply(ephemeral('That fact is empty.'));

  const recent = (factLog.get(interaction.user.id) ?? []).filter((t) => t > Date.now() - 3_600_000);
  if (recent.length >= FACTS_PER_HOUR) return interaction.reply(ephemeral(`Easy, detective: max ${FACTS_PER_HOUR} facts an hour.`));

  const name = interaction.guild.members.cache.get(target.id)?.displayName ?? target.globalName ?? target.username;
  const by = interaction.member?.displayName ?? interaction.user.username;
  if (!addFact(target.id, name, text, by)) return interaction.reply(ephemeral(`${name}'s dossier is full (30 facts). Remove some with /intel remove.`));
  factLog.set(interaction.user.id, [...recent, Date.now()]);
  await interaction.reply(ephemeral(`🗂️ Added to ${name}'s dossier: "${text}"`));
}

const MAX_TIMEOUT_MINUTES = 28 * 24 * 60; // Discord's limit

async function modLog(interaction, config, action, target, reason) {
  if (!config.modLogChannelId) return;
  try {
    const channel = await interaction.client.channels.fetch(config.modLogChannelId);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xf39c12)
          .setTitle(action)
          .addFields(
            { name: 'Target', value: target, inline: true },
            { name: 'Moderator', value: `${interaction.user}`, inline: true },
            { name: 'Reason', value: reason || 'No reason given' },
          )
          .setTimestamp(),
      ],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('Could not write to mod log:', err.message);
  }
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a member from the server')
      .addUserOption((o) => o.setName('user').setDescription('Who to kick').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why'))
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    async execute(interaction, config) {
      const member = interaction.options.getMember('user');
      const reason = interaction.options.getString('reason');
      if (!member) return interaction.reply(ephemeral('That user is not in this server.'));
      if (!member.kickable) return interaction.reply(ephemeral("I can't kick that member (their role is above mine?)."));
      await member.kick(reason ?? undefined);
      await interaction.reply(ephemeral(`Kicked ${member.user.tag}.`));
      await modLog(interaction, config, '👢 Kick', member.user.tag, reason);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a user from the server')
      .addUserOption((o) => o.setName('user').setDescription('Who to ban').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why'))
      .addIntegerOption((o) =>
        o.setName('delete_days').setDescription('Delete their messages from the last N days (0-7)').setMinValue(0).setMaxValue(7),
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    async execute(interaction, config) {
      const user = interaction.options.getUser('user');
      const member = interaction.options.getMember('user');
      const reason = interaction.options.getString('reason');
      const days = interaction.options.getInteger('delete_days') ?? 0;
      if (member && !member.bannable) return interaction.reply(ephemeral("I can't ban that member (their role is above mine?)."));
      await interaction.guild.members.ban(user, { reason: reason ?? undefined, deleteMessageSeconds: days * 86400 });
      await interaction.reply(ephemeral(`Banned ${user.tag}.`));
      await modLog(interaction, config, '🔨 Ban', user.tag, reason);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Time out a member (they cannot chat or join voice)')
      .addUserOption((o) => o.setName('user').setDescription('Who to time out').setRequired(true))
      .addIntegerOption((o) =>
        o.setName('minutes').setDescription('How long, in minutes (0 removes the timeout)').setRequired(true).setMinValue(0).setMaxValue(MAX_TIMEOUT_MINUTES),
      )
      .addStringOption((o) => o.setName('reason').setDescription('Why'))
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    async execute(interaction, config) {
      const member = interaction.options.getMember('user');
      const minutes = interaction.options.getInteger('minutes');
      const reason = interaction.options.getString('reason');
      if (!member) return interaction.reply(ephemeral('That user is not in this server.'));
      if (!member.moderatable) return interaction.reply(ephemeral("I can't time out that member (their role is above mine?)."));
      await member.timeout(minutes ? minutes * 60_000 : null, reason ?? undefined);
      const action = minutes ? `Timed out ${member.user.tag} for ${minutes} min.` : `Removed timeout for ${member.user.tag}.`;
      await interaction.reply(ephemeral(action));
      await modLog(interaction, config, minutes ? `⏳ Timeout (${minutes} min)` : '⏳ Timeout removed', member.user.tag, reason);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Delete recent messages in this channel')
      .addIntegerOption((o) => o.setName('amount').setDescription('How many (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction, config) {
      const amount = interaction.options.getInteger('amount');
      // Discord can't bulk-delete messages older than 14 days; `true` skips them.
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.reply(ephemeral(`Deleted ${deleted.size} message(s).`));
      await modLog(interaction, config, '🧹 Purge', `${deleted.size} message(s) in ${interaction.channel}`, null);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('shop')
      .setDescription('Announce that the coffee shop is open or closed')
      .addSubcommand((s) =>
        s
          .setName('open')
          .setDescription('Announce that the shop is open')
          .addStringOption((o) => o.setName('note').setDescription('Optional note, e.g. "fresh croissants today"')),
      )
      .addSubcommand((s) =>
        s
          .setName('closed')
          .setDescription('Announce that the shop is closed')
          .addStringOption((o) => o.setName('note').setDescription('Optional note, e.g. "closed early for a private event"')),
      ),
    // Visible to everyone; staff (STAFF_ROLE_IDS or Manage Messages) is checked here rather
    // than with Discord's command permissions, so baristas need no Integrations setup.
    async execute(interaction, config) {
      if (!isStaff(interaction, config)) return interaction.reply(ephemeral('Only staff can announce shop status.'));
      const sub = interaction.options.getSubcommand();
      // Acknowledge first: posting can take longer than Discord's 3-second reply window.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const by = interaction.member?.displayName ?? interaction.user.username;
      const posted = await setShopStatus(interaction.client, config, sub, interaction.options.getString('note'), by);
      await interaction.editReply(posted ? `Posted: shop is ${sub}.` : `The shop is already marked ${sub}; nothing posted.`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('bully')
      .setDescription('Have Caffenito roast someone, based on what it has learned about them')
      .addUserOption((o) => o.setName('user').setDescription('Who gets it').setRequired(true)),
    async execute(interaction, config) {
      if (!config.bullyEnabled) return interaction.reply(ephemeral('/bully is not set up yet (no Anthropic API key).'));
      const target = interaction.options.getUser('user');
      if (target.id === interaction.client.user.id) {
        return interaction.reply("Nice try. I'm the one holding the espresso machine here. ☕");
      }
      if (target.bot) return interaction.reply(ephemeral("Bots have no feelings to hurt. Pick a human."));

      const wait = (lastBullied.get(target.id) ?? 0) + BULLY_COOLDOWN_MS - Date.now();
      if (wait > 0) return interaction.reply(ephemeral(`Let ${target.username} recover first. Try again in ${Math.ceil(wait / 1000)}s.`));
      lastBullied.set(target.id, Date.now());

      await interaction.deferReply(); // Claude takes a few seconds
      const member = interaction.options.getMember('user');
      const name = member?.displayName ?? target.username;
      try {
        const roast = await writeRoast({
          name,
          profile: getProfile(target.id),
          groupSummary: getGroup().summary,
          recentLines: recentInvolving(target.id, RECENT_FOR_ROAST), // fresh context, not saved
          requestedBy: interaction.member?.displayName ?? interaction.user.username,
        });
        await interaction.editReply({ content: `${target} ${roast}`, allowedMentions: { users: [target.id] } });
      } catch (err) {
        lastBullied.delete(target.id);
        throw err;
      }
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('dossier')
      .setDescription('See what Caffenito has learned about someone (only you see it)')
      .addUserOption((o) => o.setName('user').setDescription('Whose file to open').setRequired(true))
      .addBooleanOption((o) => o.setName('forget').setDescription('Staff only: wipe everything it knows about them')),
    async execute(interaction) {
      const target = interaction.options.getUser('user');
      if (interaction.options.getBoolean('forget')) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
          return interaction.reply(ephemeral('Only staff can wipe a dossier.'));
        }
        forgetMember(target.id);
        return interaction.reply(ephemeral(`Wiped everything Caffenito knew about ${target.username}.`));
      }

      const p = getProfile(target.id);
      if (!p || (!p.summary && !p.facts.length)) {
        return interaction.reply(ephemeral(`Caffenito knows nothing about ${target.username} yet. Suspicious.`));
      }
      const CONF = { high: '●●●', medium: '●●○', low: '●○○' };
      const section = (title, items) => (items.length ? `**${title}**\n${items.join('\n')}\n\n` : '');
      const body =
        (p.summary ? `_${p.summary}_\n\n` : '_Not learned from chat yet._\n\n') +
        (p.role ? `**Role:** ${p.role}\n\n` : '') +
        section('🧠 Traits', p.traits.map((t) => `${CONF[t.confidence] ?? ''} **${t.trait}**: ${t.evidence}`)) +
        section('🤝 Relationships', p.relationships.map((r) => `• **${r.with}**: ${r.dynamic}`)) +
        (p.humor ? `**😏 Humor:** ${p.humor}\n\n` : '') +
        section('🙃 Contradictions', p.contradictions.map((c) => `• ${c}`)) +
        section('🎯 Roast angles', p.roastAngles.map((a) => `• ${a}`)) +
        section('📌 From staff', p.facts.map((f, i) => `${i + 1}. ${f.text} _(${f.by})_`));
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x8b5a2b)
            .setTitle(`🗂️ Dossier: ${p.name}`)
            .setDescription(body.slice(0, 4000))
            .setFooter({ text: p.updatedAt ? `Last updated ${p.updatedAt.slice(0, 16).replace('T', ' ')} UTC · ●●● = high confidence` : 'Not learned from chat yet' }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('backfill')
      .setDescription('Re-read past chat and rebuild everyone\'s dossier (takes a few minutes)')
      .addIntegerOption((o) => o.setName('days').setDescription('How far back to read (default 30)').setMinValue(1).setMaxValue(365))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction, config) {
      if (!config.bullyEnabled) return interaction.reply(ephemeral('/bully is not set up yet (no Claude credentials).'));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const lines = [];
      const report = (line) => {
        lines.push(line);
        interaction.editReply(lines.slice(-20).join('\n')).catch(() => {});
      };
      const days = interaction.options.getInteger('days') ?? 30;
      report(`Reading the last ${days} days of chat...`);
      const { channels, messages, people } = await importHistory(interaction.guild, config, { days, report });
      report(`**Done:** learned from ${messages} messages in ${channels} channel(s); ${people} profile(s) rebuilt.`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('intel')
      .setDescription('Staff: add or remove facts in someone\'s dossier')
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Tell Caffenito a fact about someone')
          .addUserOption((o) => o.setName('user').setDescription('Who it\'s about').setRequired(true))
          .addStringOption((o) => o.setName('fact').setDescription('e.g. "once ordered a decaf and denied it for a week"').setRequired(true).setMaxLength(FACT_MAX_LENGTH)),
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove a fact (numbers are shown in /dossier)')
          .addUserOption((o) => o.setName('user').setDescription('Whose dossier').setRequired(true))
          .addIntegerOption((o) => o.setName('number').setDescription('Fact number from /dossier').setRequired(true).setMinValue(1)),
      ),
    async execute(interaction, config) {
      const target = interaction.options.getUser('user');
      if (interaction.options.getSubcommand() === 'add') {
        return saveFact(interaction, config, target, interaction.options.getString('fact'));
      }
      if (!isStaff(interaction, config)) return interaction.reply(ephemeral('Only staff can remove facts.'));
      const removed = removeFact(target.id, interaction.options.getInteger('number') - 1);
      await interaction.reply(ephemeral(removed ? `Removed: "${removed.text}"` : 'No fact with that number. Check /dossier.'));
    },
  },
  {
    data: new ContextMenuCommandBuilder().setName('Add to dossier').setType(ApplicationCommandType.Message),
    async execute(interaction, config) {
      const msg = interaction.targetMessage;
      const text = msg.cleanContent.trim();
      if (!text) return interaction.reply(ephemeral('That message has no text to save.'));
      await saveFact(interaction, config, msg.author, `Said: "${text.slice(0, FACT_MAX_LENGTH - 8)}"`);
    },
  },
];
