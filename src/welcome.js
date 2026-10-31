export async function onMemberJoin(member, config) {
  if (config.defaultRoleId) {
    try {
      await member.roles.add(config.defaultRoleId, 'Auto-role on join');
    } catch (err) {
      console.error(`Could not give default role to ${member.user.tag}:`, err.message);
    }
  }

  if (config.welcomeChannelId) {
    try {
      const channel = await member.guild.channels.fetch(config.welcomeChannelId);
      await channel.send(`☕ Welcome to **${member.guild.name}**, ${member}! Grab a seat and say hi.`);
    } catch (err) {
      console.error('Could not send welcome message:', err.message);
    }
  }
}
