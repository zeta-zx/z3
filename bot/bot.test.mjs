import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
    ApplicationCommandType, ApplicationIntegrationType, ComponentType, InteractionContextType,
    MessageFlags, PermissionFlagsBits, PermissionsBitField,
} from 'discord.js';
import { DISCORD_PROTOCOL, DiscordRequests, readDiscordRequest } from '../src/lib/wayship-discord.ts';
import { accounts } from './accounts.mjs';
import { commands, commandsForInstallTypes, syncZetaCommands } from './commands.mjs';
import { interactions } from './interactions.mjs';
import { scrobbling } from './scrobbling.mjs';
import { wayshipClient } from './wayship.mjs';

test('global commands support both installation types when enabled', () => {
    assert.equal(new Set(commands.map(({ name }) => name)).size, commands.length);
    for (const command of commands) {
        const voice = ['join', 'leave'].includes(command.name);
        assert.deepEqual(command.integration_types, voice ? [ApplicationIntegrationType.GuildInstall]
            : [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall]);
        assert.deepEqual(command.contexts, voice ? [InteractionContextType.Guild] : [
            InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel,
        ]);
    }
    const accountOnly = commandsForInstallTypes({ [ApplicationIntegrationType.UserInstall]: {} });
    assert.equal(accountOnly.length, commands.length - 2);
    assert.ok(accountOnly.every((command) => command.integration_types.join() === String(ApplicationIntegrationType.UserInstall)));
});

test('command sync updates changed slash commands without replacing the Activity launcher', async () => {
    const registered = new Map(commands.map((command) => [command.name, {
        name: command.name, type: ApplicationCommandType.ChatInput,
        equals: (desired) => desired.name !== 'play',
    }]));
    registered.set('Launch', { name: 'Launch', type: ApplicationCommandType.PrimaryEntryPoint });
    const updates = [];
    const result = await syncZetaCommands({
        commands: {
            fetch: async () => registered,
            create: async (command) => { updates.push(command.name); },
        },
    });
    assert.deepEqual(updates, ['play']);
    assert.deepEqual(result, { total: commands.length, updated: 1 });
});

test('playback commands reject malformed input and run once across duplicate deliveries', () => {
    const now = Date.now();
    const body = { protocol: DISCORD_PROTOCOL, requestId: randomUUID(), expiresAt: now + 1000, action: 'skip' };
    const inbox = new DiscordRequests();
    assert.equal(inbox.accept('zeta-discord-test', body, now), body);
    assert.equal(inbox.accept('zeta-discord-test', body, now), null);
    assert.equal(inbox.accept('zeta-discord-test', body, now + 1100), null);
    assert.equal(readDiscordRequest({ ...body, action: 'toggle' }, now), null);
    assert.equal(readDiscordRequest({ ...body, action: 'play', query: ' '.repeat(10) }, now), null);
    assert.equal(readDiscordRequest({ ...body, action: 'volume', value: 101 }, now), null);
    assert.equal(readDiscordRequest({ ...body, action: 'voice-start', relayId: 'a'.repeat(32) }, now), null);
    assert.equal(readDiscordRequest({ ...body, action: 'voice-start', relayId: 'a'.repeat(32), key: 'b'.repeat(64), room: 'Music' }, now)?.action, 'voice-start');
    assert.equal(readDiscordRequest({ ...body, action: 'pause' }, now)?.action, 'pause');
    assert.equal(readDiscordRequest({ ...body, action: 'unpause' }, now)?.action, 'unpause');
});

const exampleTrack = {
    title: 'Test track', artist: 'Test artist', album: 'Test release', year: '2026',
    coverUrl: 'https://i.ytimg.com/vi/abcd1234567/hqdefault.jpg',
    url: 'https://music.youtube.com/watch?v=abcd1234567', duration: 210,
};

function wayshipMock() {
    const token = 'wsa_wayship-test-app';
    const signals = [];
    const inbox = [];
    const calls = [];
    const desktop = { peer_id: 'zeta-0001', device_name: 'Desktop' };
    const phone = { peer_id: 'zeta-0002', device_name: 'Android' };
    const client = wayshipClient(async (url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        const { origin, pathname } = new URL(url);
        assert.equal(origin, 'https://wayship.link');
        calls.push(pathname);
        const json = options.body ? JSON.parse(options.body) : {};
        switch (pathname) {
            case '/api/apps/me':
                return Response.json({ app: 'zeta', handle: 'tester', account_id: '1', conn_id: 3, scopes: ['peers', 'profile'] });
            case '/api/peers/announce':
                assert.equal(json.meta.platform, 'discord');
                return Response.json({ peers: [desktop, phone, { peer_id: json.peer_id, device_name: 'Discord' }] });
            case '/api/peers/signal': {
                const command = readDiscordRequest(json.payload);
                assert.ok(command);
                signals.push({ target: json.to_peer, command: command.action,
                    ...(command.query ? { query: command.query } : {}) });
                const reply = {
                    kind: 'signal', signal_kind: 'data', to_peer: json.from_peer, from_peer: json.to_peer,
                    payload: {
                        protocol: DISCORD_PROTOCOL, requestId: command.requestId, ok: true,
                        track: exampleTrack,
                        album: { title: 'Test release', artist: 'Test artist', year: '2026',
                            coverUrl: exampleTrack.coverUrl, trackCount: 7, tracks: [exampleTrack] },
                        lyrics: 'Test line',
                        playback: {
                            // Desktop is a remote client showing the phone's playback.
                            phase: 'playing', controllable: json.to_peer === phone.peer_id, queue: [],
                            voiceAvailable: json.to_peer === phone.peer_id,
                        },
                    },
                };
                inbox.push({ ...reply, from_peer: 'zeta-wrong-device', payload: { ...reply.payload, ok: false } });
                inbox.push(reply, reply);
                return Response.json({ ok: true });
            }
            case '/api/peers/poll':
                return Response.json({ events: inbox.splice(0) });
            case '/api/peers/leave':
                return Response.json({ ok: true });
            default:
                throw new Error(`Unexpected endpoint ${pathname}`);
        }
    });
    return { client, calls, signals, token, desktop, phone };
}

test('Wayship verifies the token, chooses the playback host, and only sends one transport command', async () => {
    const { client, token, desktop, phone, signals, calls } = wayshipMock();
    assert.equal((await client.verify(token)).handle, 'tester');
    await client.run(token, { action: 'skip' });
    assert.deepEqual(signals.filter(({ command }) => command === 'skip'), [{ target: phone.peer_id, command: 'skip' }]);
    await assert.rejects(client.run(token, { action: 'pause' }, desktop.device_name), /following another player/);
    assert.equal(signals.filter(({ command }) => command === 'pause').length, 0);
    assert.equal(calls.at(-1), '/api/peers/leave');
});

test('Discord track searches and lyrics send the original query only to the Zeta playback host', async () => {
    const { client, token, phone, signals } = wayshipMock();
    const handle = interactions({ accounts: { get: () => ({ wayship: { token } }) }, wayship: client });
    for (const name of ['play', 'playnext', 'enqueue', 'lyrics', 'album']) {
        const replies = [];
        await handle({
            isButton: () => false,
            isModalSubmit: () => false,
            isChatInputCommand: () => true,
            inGuild: () => false,
            commandName: name,
            user: { id: '100' },
            options: { getString: (option) => option === 'song' ? 'Test search' : null,
                getInteger: () => null, getBoolean: () => null },
            deferReply: async () => {},
            editReply: async ({ embeds }) => replies.push(embeds[0].toJSON()),
        });
        assert.equal(replies.length, 1);
        assert.equal(replies[0].color, 0x8c79e8);
        if (name !== 'lyrics') {
            assert.equal(replies[0].thumbnail.url, exampleTrack.coverUrl);
            assert.match(replies[0].description, /Test track/);
        }
        if (name === 'album') {
            assert.equal(replies[0].title, 'Test release');
            assert.match(replies[0].description, /2026 · 7 tracks/);
        }
        assert.deepEqual(signals.at(-1), { target: phone.peer_id, command: name, query: 'Test search' });
    }
});

test('username links and Wayship credentials are stored per Discord account', (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'zeta-bot-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = accounts(directory);
    store.set('10', 'listenbrainz', 'test listener');
    store.set('10', 'wayship', { token: 'private' });
    store.set('11', 'lastfm', 'another-listener');
    const reloaded = accounts(directory);
    assert.deepEqual(reloaded.get('11'), { lastfm: 'another-listener' });
    assert.deepEqual(reloaded.get('10'), { listenbrainz: 'test listener', wayship: { token: 'private' } });
    reloaded.set('10', 'wayship', null);
    assert.deepEqual(accounts(directory).get('10'), { listenbrainz: 'test listener' });
    if (process.platform !== 'win32') assert.equal(statSync(join(directory, 'accounts.json')).mode & 0o777, 0o600);
});

test('both scrobbling backends distinguish active tracks from recent listens', async () => {
    const client = scrobbling('test-key', async (url) => {
        const target = new URL(url);
        if (target.host === 'ws.audioscrobbler.com') {
            assert.equal(target.searchParams.get('method'), 'user.getRecentTracks');
            return Response.json({ recenttracks: { track: [
                { name: 'Active', artist: { '#text': 'Artist' }, '@attr': { nowplaying: 'true' } },
                { name: 'Past', artist: { '#text': 'Artist' }, date: { uts: '400' } },
            ] } });
        }
        const playing = target.pathname.endsWith('/playing-now');
        return Response.json({ payload: { listens: [
            { track_metadata: { track_name: playing ? 'Active' : 'Past', artist_name: 'Artist' },
                ...(playing ? {} : { listened_at: 400 }) },
        ] } });
    });
    for (const service of ['lastfm', 'listenbrainz']) {
        const [active, previous] = await client.recent(service, 'test-user', 2, true);
        assert.deepEqual(active, { title: 'Active', artist: 'Artist', time: 0, playing: true });
        assert.deepEqual(previous, { title: 'Past', artist: 'Artist', time: 400, playing: false });
    }
});

test('Discord /playing uses the invoking user and falls back to their recent scrobble', async () => {
    const handle = interactions({
        accounts: { get: (id) => {
            assert.equal(id, '100');
            return { listenbrainz: 'my-account', wayship: { token: 'my-app-token' } };
        } },
        scrobbling: { recent: async (service, username) => {
            assert.equal(service, 'listenbrainz');
            assert.equal(username, 'my-account');
            return [{ title: 'My last track', artist: 'An artist', time: 123, playing: false }];
        } },
        wayship: { run: async (token) => {
            assert.equal(token, 'my-app-token');
            throw new Error('Player offline');
        } },
    });

    const replies = [];
    await handle({
        isButton: () => false,
        isModalSubmit: () => false,
        isChatInputCommand: () => true,
        inGuild: () => false,
        user: { id: '100' },
        commandName: 'playing',
        options: { getString: () => null, getBoolean: () => null },
        deferReply: async ({ flags }) => assert.equal(flags, undefined),
        editReply: async (reply) => { replies.push(reply); },
    });
    const embed = replies[0].embeds[0].toJSON();
    assert.equal(embed.title, 'Last played');
    assert.match(embed.description, /My last track.*ListenBrainz/s);
});

test('guild replies respect installation, channel permissions, and privacy', async () => {
    const { SendMessages, SendMessagesInThreads, EmbedLinks, UseExternalApps } = PermissionFlagsBits;
    const handle = interactions({ accounts: { get: () => ({}) } });

    async function run({ installed = false, perms = [], external = false, share = null, name = 'help', isThread = false }) {
        const replies = [];
        let flags;
        await handle({
            isButton: () => false,
            isModalSubmit: () => false,
            isChatInputCommand: () => true,
            inGuild: () => true,
            guildId: 'server',
            channel: { isThread: () => isThread },
            authorizingIntegrationOwners: { guildId: installed ? 'server' : null },
            appPermissions: new PermissionsBitField(perms),
            memberPermissions: new PermissionsBitField(external ? [UseExternalApps] : []),
            user: { id: '100' },
            commandName: name,
            options: { getString: () => null, getBoolean: () => share },
            deferReply: async (reply) => { flags = reply.flags; },
            editReply: async (reply) => { replies.push(reply); },
        });
        return { ...replies[0], flags };
    }

    const guild = { installed: true, perms: [SendMessages, EmbedLinks] };
    const publicEmbed = await run(guild);
    assert.equal(publicEmbed.flags, undefined);
    assert.equal(publicEmbed.embeds[0].toJSON().title, 'Zeta for Discord');
    assert.equal((await run({ ...guild, name: 'profile' })).flags, MessageFlags.Ephemeral);
    assert.equal((await run({ ...guild, share: false })).flags, MessageFlags.Ephemeral);
    assert.equal((await run({ ...guild, isThread: true })).flags, MessageFlags.Ephemeral);
    assert.equal((await run({ ...guild, isThread: true, perms: [SendMessagesInThreads, EmbedLinks] })).flags, undefined);
    const plain = await run({ installed: true, perms: [SendMessages] });
    assert.match(plain.content, /Zeta for Discord/);
    assert.equal(plain.embeds, undefined);
    assert.equal((await run({ external: true, perms: [EmbedLinks] })).flags, undefined);
    assert.equal((await run({ perms: [EmbedLinks] })).flags, MessageFlags.Ephemeral);
});

test('Wayship link modal keeps the credential out of the response and saves it for the submitting account', async () => {
    const token = 'wsa_single_purpose_test';
    const handle = interactions({
        accounts: { set: (id, service, connection) => {
            assert.equal(id, '101');
            assert.equal(service, 'wayship');
            assert.equal(connection.token, token);
        } },
        wayship: { verify: async (submitted) => {
            assert.equal(submitted, token);
            return { token, handle: 'listener' };
        } },
    });

    await handle({
        isButton: () => true,
        customId: 'zeta:wayship:open',
        showModal: async (modal) => assert.equal(modal.toJSON().components[0].type, ComponentType.Label),
    });
    await handle({
        isButton: () => false,
        isModalSubmit: () => true,
        inGuild: () => false,
        customId: 'zeta:wayship:connect',
        user: { id: '101' },
        fields: { getTextInputValue: () => token },
        deferReply: async ({ flags }) => assert.equal(flags, undefined),
        editReply: async ({ embeds }) => {
            assert.equal(embeds[0].toJSON().title, 'Connected to Wayship');
            assert.ok(!JSON.stringify(embeds).includes(token));
        },
    });
});
