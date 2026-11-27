import { fileURLToPath } from 'node:url';
import { ApplicationIntegrationType, Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { accounts } from './accounts.mjs';
import { zetaActivity } from './activity-server.mjs';
import { syncZetaCommands } from './commands.mjs';
import { interactions } from './interactions.mjs';
import { scrobbling } from './scrobbling.mjs';
import { wayshipClient } from './wayship.mjs';
import { discordVoice } from './voice.mjs';

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
    console.error('Set DISCORD_TOKEN in bot/.env or in the environment before starting Zeta Discord.');
    process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const wayship = wayshipClient();
const voice = discordVoice(wayship);
let activityServer;
try {
    const store = accounts(process.env.ZETA_BOT_DATA_DIR || fileURLToPath(new URL('./.data/', import.meta.url)));
    const activity = process.env.ZETA_ACTIVITY_PORT ? zetaActivity({ accounts: store, wayship, voice }) : null;
    client.on(Events.InteractionCreate, interactions({
        accounts: store,
        scrobbling: scrobbling(process.env.LASTFM_API_KEY?.trim()),
        wayship, voice, activity,
    }));
    client.on(Events.VoiceStateUpdate, voice.voiceStateChanged);
    client.on(Events.Error, (error) => console.error('Discord Gateway error', error.name, error.code ?? ''));
    client.once(Events.ClientReady, async ({ application, user }) => {
        try {
            await application.fetch();
            const { total, updated } = await syncZetaCommands(application);
            console.log(`Connected as ${user.tag}. ${total} global Zeta commands available, ${updated} updated.`);
            if (activity) {
                const port = Number(process.env.ZETA_ACTIVITY_PORT);
                try {
                    activityServer = await activity.start(application.id, port);
                    console.log(`Zeta Activity is listening at http://127.0.0.1:${port}`);
                } catch (error) {
                    console.error('Could not start the Zeta Activity. Check its build and port.', error.code ?? error.name);
                }
            }
            const install = new URL('https://discord.com/oauth2/authorize');
            install.search = new URLSearchParams({
                client_id: application.id, integration_type: '1', scope: 'applications.commands',
            });
            console.log(`Add Zeta to your Discord account → ${install}`);
            if (application.integrationTypesConfig?.[ApplicationIntegrationType.GuildInstall]) {
                install.search = new URLSearchParams({
                    client_id: application.id, integration_type: '0', scope: 'bot applications.commands',
                    permissions: String(PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks |
                        PermissionFlagsBits.AttachFiles | PermissionFlagsBits.SendMessagesInThreads |
                        PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak),
                });
                console.log(`Add Zeta to your Discord server → ${install}`);
            }
        } catch (error) {
            console.error('Could not register Zeta commands. Check the application’s installation settings.', error.name, error.code ?? '');
            client.destroy();
            process.exitCode = 1;
        }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        voice.stop();
        activityServer?.closeAllConnections();
        activityServer?.close();
        client.destroy();
    });
    await client.login(token);
} catch (error) {
    console.error('Could not start Zeta Discord.', error.name, error.code ?? '');
    client.destroy();
    process.exitCode = 1;
}
