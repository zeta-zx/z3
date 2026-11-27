import { randomBytes } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
    AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, NoSubscriberBehavior,
    StreamType, VoiceConnectionStatus,
} from '@discordjs/voice';
import { openAudioRelay } from './audio-relay.mjs';
import { createDiscordOpusStream } from './discord-opus.mjs';
import { BotError } from './wayship.mjs';

export function discordVoice(wayship) {
    let session = null;

    function stop(current = session) {
        if (!current || session !== current) return;
        session = null;
        current.player?.stop(true);
        current.audio?.destroy();
        current.relay?.close();
        if (current.connection && current.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            current.connection.destroy();
        }
    }

    function requireActive(current) {
        if (session !== current) throw new BotError('The voice session ended before Zeta could connect.');
    }

    async function join(interaction, token, device) {
        if (!token) throw new BotError('Connect your Wayship account with /wayship first.');
        const guild = interaction.guild;
        const voice = guild?.voiceStates.cache.get(interaction.user.id);
        const channel = voice?.channel;
        if (!guild || channel?.type !== ChannelType.GuildVoice) {
            throw new BotError('Join a regular voice channel in this server first.');
        }
        const permissions = channel.permissionsFor(interaction.client.user);
        if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
            throw new BotError('Zeta needs View Channel, Connect, and Speak permissions in your voice channel.');
        }
        if (session) throw new BotError('The local Zeta player is already setting up or sharing audio to a voice channel.');

        const relayId = randomBytes(16).toString('hex');
        const key = randomBytes(32).toString('hex');
        const current = {
            guildId: guild.id, owner: interaction.user.id, channelId: channel.id, botId: interaction.client.user.id,
            connection: null, relay: null, player: null, audio: null, deviceId: null,
        };
        session = current;
        try {
            const relay = await openAudioRelay({ relayId, key }, () => stop(current));
            if (session !== current) relay.close();
            requireActive(current);
            current.relay = relay;

            const connection = joinVoiceChannel({
                guildId: guild.id, channelId: channel.id, adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: true, selfMute: false,
            });
            current.connection = connection;
            connection.on('error', (error) => {
                console.warn('Discord voice connection error', error.name);
                stop(current);
            });
            connection.on(VoiceConnectionStatus.Destroyed, () => stop(current));
            connection.on(VoiceConnectionStatus.Disconnected, () => {
                void entersState(connection, VoiceConnectionStatus.Ready, 5000).catch(() => stop(current));
            });
            await entersState(connection, VoiceConnectionStatus.Ready, 12_000);
            requireActive(current);

            const playback = await wayship.run(token, { action: 'voice-start', relayId, key, room: channel.name }, device);
            requireActive(current);
            if (!relay.connected) throw new BotError('Zeta did not open an audio connection on this computer.');

            const player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 250 },
            });
            current.player = player;
            player.on(AudioPlayerStatus.Idle, () => stop(current));
            current.deviceId = playback.id;
            player.on('error', (error) => {
                console.warn('Discord audio player error', error.name);
                stop(current);
            });
            connection.subscribe(player);
            current.audio = createDiscordOpusStream(relay.stream, (audio) => {
                if (session === current) player.play(createAudioResource(audio, { inputType: StreamType.Opus }));
            }, (error) => {
                if (session !== current) return;
                console.warn('Discord audio framing error', error.message);
                stop(current);
            });
            return { deviceName: playback.name, channelName: channel.name };
        } catch (error) {
            stop(current);
            if (error instanceof BotError) throw error;
            if (error.code === 'EADDRINUSE') throw new BotError('The local Zeta voice port is already in use.');
            console.warn('Could not start Discord voice', error.name, error.code ?? '');
            throw new BotError('Zeta could not join voice. Check the channel permissions and that the bot is installed in the server.');
        }
    }

    function leave(interaction) {
        if (!session || session.guildId !== interaction.guildId) return false;
        if (session.owner !== interaction.user.id) throw new BotError('The person who started the Zeta voice session can stop it.');
        stop();
        return true;
    }

    function deviceFor({ user, guildId }) {
        return session?.owner === user.id && session.guildId === guildId ? session.deviceId : null;
    }

    function deviceForOwner(owner) {
        return session?.owner === owner ? session.deviceId : null;
    }

    function voiceStateChanged(_oldVoice, newVoice) {
        if (newVoice.guild.id !== session?.guildId) return;
        if ((newVoice.id === session.owner || newVoice.id === session.botId) &&
            newVoice.channelId !== session.channelId) stop();
    }

    function stopFor(owner) {
        if (session?.owner === owner) stop();
    }

    return { join, leave, deviceFor, deviceForOwner, voiceStateChanged, stopFor, stop };
}
