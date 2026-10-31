// Registers the slash commands with your server. Run once, and again whenever commands change.
import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';

const rest = new REST().setToken(config.token);
const body = commands.map((c) => c.data.toJSON());

await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
console.log(`Registered ${body.length} commands: ${body.map((c) => '/' + c.name).join(', ')}`);
