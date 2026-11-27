import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType,
    LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle, escapeMarkdown,
} from 'discord.js';
import { transport } from './commands.mjs';
import { periods, profileUrl, services } from './scrobbling.mjs';
import { BotError, wayshipConnectUrl } from './wayship.mjs';

const CONNECT_BUTTON = 'zeta:wayship:open';
const CONNECT_MODAL = 'zeta:wayship:connect';
const PRIVATE_COMMANDS = new Set(['wayship', 'link', 'unlink', 'profile', 'devices']);
const ACCENT = 0x8c79e8;
const ERROR = 0xdb6375;
const clean = (input, limit = 150) => escapeMarkdown(String(input ?? '').replace(/\s+/g, ' ').trim().slice(0, limit));
const trackLabel = ({ title, artist }, limit = 150) => [clean(title, limit), clean(artist, limit)].filter(Boolean).join(' by ');
const card = (title, description) => ({ title, description });
const numberList = (items, format) => items.slice(0, 5).map((item, index) => `${index + 1}. ${format(item)}`).join('\n');
const clock = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function canEmbed(interaction) {
    return !interaction.inGuild() || interaction.appPermissions?.has(PermissionFlagsBits.EmbedLinks);
}

function secureUrl(value) {
    if (typeof value !== 'string' || value.length > 2000) return undefined;
    const url = URL.parse(value);
    return url?.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
}

function trackCard(title, track, context) {
    const release = [clean(track.album), clean(track.year, 16)].filter(Boolean).join(' · ');
    const url = secureUrl(track.url);
    return {
        ...card(title, [
            `**${trackLabel(track)}**`,
            release,
            context || (track.duration > 0 ? clock(track.duration) : ''),
            url && `[Open track](<${url}>)`,
        ].filter(Boolean).join('\n')),
        thumbnail: track.coverUrl,
    };
}

function replyOptions(interaction, { title, description, color = ACCENT, files, components, thumbnail }) {
    const options = { allowedMentions: { parse: [] }, files, components };
    if (canEmbed(interaction)) {
        const embed = new EmbedBuilder().setTitle(title.slice(0, 256)).setColor(color);
        if (description) embed.setDescription(description.slice(0, 4096));
        const cover = secureUrl(thumbnail);
        if (cover) embed.setThumbnail(cover);
        return { ...options, embeds: [embed] };
    }
    return { ...options, content: [`**${title}**`, description].filter(Boolean).join('\n').slice(0, 2000),
        flags: MessageFlags.SuppressEmbeds };
}

function visibility(interaction, sensitive, share = null) {
    if (share === false || (sensitive && (interaction.inGuild() || interaction.context === InteractionContextType.PrivateChannel))) {
        return { flags: MessageFlags.Ephemeral };
    }
    if (!interaction.inGuild()) return {};
    const installed = interaction.authorizingIntegrationOwners?.guildId === interaction.guildId;
    const canSend = installed
        ? interaction.appPermissions?.has(interaction.channel?.isThread?.()
            ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages)
        : interaction.memberPermissions?.has(PermissionFlagsBits.UseExternalApps);
    return canSend ? {} : { flags: MessageFlags.Ephemeral };
}

function immediateReply(interaction, response, display) {
    const options = replyOptions(interaction, response);
    const flags = (options.flags ?? 0) | (display.flags ?? 0);
    return { ...options, ...(flags ? { flags } : {}) };
}

function wayshipPrompt(handle) {
    const connected = handle ? `Connected to Wayship as **@${clean(handle)}**.\n\n` : '';
    return {
        ...card('Connect to Wayship', connected + 'Open Wayship and approve a new Discord Bot connection. Sign in with the same account you use in Zeta, then paste the new app token in the form.'),
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open Wayship').setURL(wayshipConnectUrl),
            new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel('Enter app token').setCustomId(CONNECT_BUTTON),
        )],
    };
}

function tokenModal() {
    const token = new TextInputBuilder().setCustomId('token')
        .setStyle(TextInputStyle.Short).setPlaceholder('wsa_…').setMaxLength(2004).setRequired(true);
    return new ModalBuilder().setCustomId(CONNECT_MODAL).setTitle('Connect to Wayship')
        .addLabelComponents(new LabelBuilder().setLabel('New Wayship app token').setTextInputComponent(token));
}

function playbackLabel({ name, result: { playback } }) {
    if (!playback.track) return card('Nothing playing', `No track is loaded on **${clean(name)}**.`);
    const verb = { playing: 'Now playing', paused: 'Paused', loading: 'Loading' }[playback.phase] ?? 'Current track';
    const time = playback.duration > 0 ? ` · ${clock(playback.position)} / ${clock(playback.duration)}` : '';
    return trackCard(verb, playback.track, `Zeta · ${clean(name)}${time}`);
}

function pickService(profile, requested) {
    const service = requested ?? Object.keys(services).find((key) => profile[key]);
    if (!service || !profile[service]) throw new BotError('Link a listening profile first with /link.');
    return service;
}

function help() {
    return card('Zeta for Discord', [
        '**Connect** · /wayship, /link, /unlink, /profile, /devices',
        '**Listening** · /playing, /recent, /toptracks, /topartists, /album, /lyrics',
        '**Player** · /play, /playnext, /enqueue, /queue, /skip, /previous, /pause, /unpause, /seek, /volume',
        '**Server voice** · /join, /leave',
        '',
        'Run /wayship to control a Zeta device. Use /link to look up your Last.fm or ListenBrainz profile by username. Set `share: False` on a listening command to keep its reply private.',
    ].join('\n'));
}

export function interactions({ accounts, scrobbling, wayship, voice, activity }) {
    async function playing(profile, requested, device) {
        if (requested && device) throw new BotError('Choose a listening service or a Zeta device.');
        const lookups = (requested ? [pickService(profile, requested)] : Object.keys(services).filter((key) => profile[key]))
            .map((service) => scrobbling.recent(service, profile[service], 1, true)
                .then((tracks) => tracks.map((track) => ({ ...track, service }))));
        // Settle scrobbler lookups immediately while Wayship checks connected devices.
        const scrobbles = Promise.allSettled(lookups);
        let zeta = null;
        let wayshipError;
        if (!requested && (profile.wayship || device)) {
            try {
                zeta = await wayship.run(profile.wayship?.token, { action: 'status' }, device);
            } catch (error) {
                wayshipError = error;
            }
        }
        if (device && wayshipError) throw wayshipError;
        if (zeta?.result.playback.track && (device || zeta.result.playback.phase !== 'paused')) return playbackLabel(zeta);

        const history = await scrobbles;
        const items = history.flatMap((entry) => entry.status === 'fulfilled' ? entry.value : []);
        const active = items.find(({ playing }) => playing);
        if (active) return trackCard('Now playing', active, services[active.service]);
        if (zeta?.result.playback.track) return playbackLabel(zeta);
        const latest = items.sort((a, b) => b.time - a.time)[0];
        if (latest) {
            const time = latest.time > 0 && latest.time < 10_000_000_000 ? ` · <t:${Math.floor(latest.time)}:R>` : '';
            return trackCard('Last played', latest, `${services[latest.service]}${time}`);
        }
        if (zeta) return playbackLabel(zeta);
        if (requested && history[0]?.status === 'rejected') throw history[0].reason;
        if (wayshipError) throw wayshipError;
        if (!lookups.length) throw new BotError('Connect Zeta with /wayship or link a listening profile with /link.');
        if (history.every(({ status }) => status === 'rejected')) throw history[0].reason;
        return card('No listening activity', 'Play a track to start building your listening history.');
    }

    async function handleCommand(interaction, profile) {
        const { commandName, options, user } = interaction;
        const requested = options.getString('service');
        const device = options.getString('device');
        const targetDevice = device || (!requested ? voice?.deviceFor(interaction) : undefined);
        const token = profile.wayship?.token;

        switch (commandName) {
            case 'help':
                return help();
            case 'profile': {
                const links = Object.keys(services).filter((service) => profile[service]).map((service) =>
                    `**${services[service]}** · [${clean(profile[service])}](<${profileUrl(service, profile[service])}>)`);
                if (profile.wayship) links.push(`**Wayship** · @${clean(profile.wayship.handle)}`);
                return card('Your connections', links.length ? links.join('\n') : 'Use /link or /wayship to connect an account.');
            }
            case 'link': {
                const name = options.getString('username', true).trim();
                if (!name || /[\x00-\x1f\x7f]/.test(name) || (requested === 'lastfm' && !/^[a-z\d_-]+$/i.test(name))) {
                    throw new BotError('Enter a profile username.');
                }
                const username = await scrobbling.verify(requested, name);
                accounts.set(user.id, requested, username);
                return card('Profile linked', `Linked **${services[requested]}** as **${clean(username)}**.`);
            }
            case 'unlink':
                if (!profile[requested]) return card('Already disconnected', 'There is no saved connection for this service.');
                accounts.set(user.id, requested, null);
                if (requested === 'wayship') voice?.stopFor(user.id);
                return card('Connection removed', requested === 'wayship'
                    ? 'Wayship connection removed. You can revoke the Discord Bot connection from Wayship’s Connected apps page.'
                    : `${services[requested]} profile removed.`);
            case 'playing':
                return playing(profile, requested, targetDevice);
            case 'album': {
                const song = options.getString('song')?.trim();
                const { result: { track, album } } = await wayship.run(token, {
                    action: 'album', ...(song && { query: song }),
                }, targetDevice);
                if (!track) throw new BotError('Zeta could not find a track to look up.');
                if (!album) return trackCard('Album information unavailable', track);
                const url = secureUrl(album.url);
                return {
                    ...card(clean(album.title, 120), [
                        [clean(album.artist), clean(album.year, 16), album.trackCount > 0 && `${album.trackCount} tracks`]
                            .filter(Boolean).join(' · '),
                        album.tracks?.length && numberList(album.tracks, (entry) => trackLabel(entry, 75)),
                        url && `[Open album](<${url}>)`,
                    ].filter(Boolean).join('\n\n')),
                    thumbnail: album.coverUrl,
                };
            }
            case 'join': {
                const { deviceName, channelName } = await voice.join(interaction, token, device);
                return card('Zeta is in voice', `**${clean(deviceName)}** is sharing audio in **${clean(channelName)}**. Use /play to choose a song or /leave to stop sharing.`);
            }
            case 'leave':
                return voice.leave(interaction) ? card('Left the voice channel', 'Zeta audio sharing has ended.')
                    : card('Zeta is not in voice', 'Use /join from a voice channel to start sharing.');
            case 'recent': {
                const service = pickService(profile, requested);
                const tracks = (await scrobbling.recent(service, profile[service], 5)).filter(({ playing }) => !playing);
                const lines = numberList(tracks, (track) => trackLabel(track, 75));
                return { ...card(`Recent listens · ${services[service]}`, lines || 'No recent listens found.'),
                    thumbnail: tracks.find((track) => track.coverUrl)?.coverUrl };
            }
            case 'toptracks': case 'topartists': {
                const kind = commandName === 'toptracks' ? 'tracks' : 'artists';
                const service = pickService(profile, requested);
                const period = options.getString('period') ?? 'month';
                const items = await scrobbling.top(service, profile[service], kind, period);
                const lines = numberList(items, (track) => `${trackLabel(track, 65)} · ${Number(track.count) || 0} plays`);
                return card(`Top ${kind} · ${periods[period].name} · ${services[service]}`, lines || 'No top-list data for that period yet.');
            }
            case 'devices': {
                const devices = await wayship.devices(token);
                if (!devices.length) return card('No online devices', 'Open Zeta and connect to Wayship.');
                const lines = devices.slice(0, 8).map(({ id, name, playback }) => {
                    const status = playback?.phase ?? 'no reply';
                    const role = playback && !playback.controllable ? ' · following another player' : '';
                    return `**${clean(name, 60)}** · ${status}${role}\n\`${id}\``;
                });
                if (devices.length > 8) lines.push(`…and ${devices.length - 8} more. Select by device name.`);
                return card('Your Zeta devices', lines.join('\n'));
            }
            case 'queue': {
                const { name, result } = await wayship.run(token, { action: 'status' }, targetDevice);
                const lines = numberList(result.playback.queue, (track) => trackLabel(track, 75));
                return { ...card(`Up next on ${clean(name, 60)}`, lines || 'The queue is empty.'),
                    thumbnail: result.playback.queue[0]?.coverUrl };
            }
        }

        if (!Object.hasOwn(transport, commandName)) throw new BotError('Unknown Zeta command.');
        const song = options.getString('song')?.trim();
        if (['play', 'playnext', 'enqueue'].includes(commandName) && !song) throw new BotError('Enter a song title and artist.');
        const value = options.getInteger('percent') ?? options.getInteger('seconds');
        const { name, result } = await wayship.run(token, {
            action: commandName,
            ...(song && { query: song }),
            ...(value !== null && { value }),
        }, targetDevice);
        const target = `**${clean(name, 60)}**`;

        switch (commandName) {
            case 'play': return trackCard('Playing on Zeta', result.track, `Selected for playback on ${target}.`);
            case 'playnext': return trackCard('Playing next', result.track, `Player · ${target}`);
            case 'enqueue': return trackCard('Added to queue', result.track, `Player · ${target}`);
            case 'skip': return card('Skipped track', `Player · ${target}`);
            case 'previous': return card('Previous track', `Player · ${target}`);
            case 'pause': return card('Paused', `Player · ${target}`);
            case 'unpause': return card('Resumed', `Player · ${target}`);
            case 'seek': return card('Seek', `Sent to ${target} at **${clock(value)}**.`);
            case 'volume': return card('Volume changed', `Volume set to **${value}%** on ${target}.`);
            case 'lyrics': {
                const title = `Lyrics · ${trackLabel(result.track, 95)}`;
                const text = escapeMarkdown(result.lyrics);
                const limit = canEmbed(interaction) ? 4096 : 1980 - title.length;
                if (text.length <= limit) return card(title, text);
                if (!interaction.inGuild() || interaction.appPermissions?.has(PermissionFlagsBits.AttachFiles)) {
                    return { ...card(title, 'Full lyrics attached.'), files: [new AttachmentBuilder(Buffer.from(result.lyrics), { name: 'lyrics.txt' })] };
                }
                return card(title, `${text.slice(0, limit - 36)}…\n\nRun /lyrics in a DM for the full text.`);
            }
        }
    }

    return async function onInteraction(interaction) {
        try {
            if (interaction.isButton() && interaction.customId === CONNECT_BUTTON) {
                await interaction.showModal(tokenModal());
                return;
            }
            if (interaction.isModalSubmit() && interaction.customId === CONNECT_MODAL) {
                await interaction.deferReply(visibility(interaction, true));
                const connection = await wayship.verify(interaction.fields.getTextInputValue('token').trim());
                accounts.set(interaction.user.id, 'wayship', connection);
                await interaction.editReply(replyOptions(interaction,
                    card('Connected to Wayship', `Signed in as **@${clean(connection.handle)}**. Try /devices or /playing.`)));
                return;
            }
            if (!interaction.isChatInputCommand()) return;

            const profile = accounts.get(interaction.user.id);
            const display = visibility(interaction, PRIVATE_COMMANDS.has(interaction.commandName), interaction.options.getBoolean('share'));
            if (interaction.commandName === 'wayship') {
                const code = interaction.options.getString('activity-code');
                if (code) {
                    if (!activity) throw new BotError('This bot is not serving a Zeta Activity.');
                    activity.link(code, interaction.user.id);
                    await interaction.reply(immediateReply(interaction,
                        card('Activity linked', 'Return to the Zeta Activity to control your player.'), display));
                    return;
                }
                await interaction.reply(immediateReply(interaction, wayshipPrompt(profile.wayship?.handle), display));
                return;
            }

            await interaction.deferReply(display);
            const result = await handleCommand(interaction, profile);
            await interaction.editReply(replyOptions(interaction, result));
        } catch (error) {
            // Avoid logging HTTP bodies or modal input that could contain a token.
            if (!(error instanceof BotError)) console.error('Discord interaction failed', error.name, error.code ?? '');
            const message = error instanceof BotError ? clean(error.message, 450) : 'Zeta could not finish that command. Try again.';
            const response = { ...card('Zeta couldn’t complete that', message), color: ERROR };
            await (interaction.deferred
                ? interaction.editReply(replyOptions(interaction, response))
                : interaction.reply(immediateReply(interaction, response, visibility(interaction, true)))).catch(() => {});
        }
    };
}
