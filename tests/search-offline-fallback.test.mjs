import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileModule } from 'svelte/compiler';
import { searchMusicSongs } from '../src/lib/music-catalog.ts';

// Runs the real search store (src/lib/state/search.svelte.ts). Only the app
// runtime around it is swapped out: the backend client and the library.
const harness = { client: {}, library: { tracks: new Map() } };
globalThis.__searchTest = harness;

const memory = new Map();
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => memory.set(key, String(value)),
        removeItem: (key) => memory.delete(key),
    },
});
const setOnline = (onLine) => Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: onLine });

const stubs = {
    '$app/environment': 'export const browser = true;',
    '$lib/ephaptic': 'export const client = globalThis.__searchTest.client;',
    '$lib/state/library.svelte': 'export const libraryState = globalThis.__searchTest.library;',
};
const root = fileURLToPath(new URL('..', import.meta.url));
const appModules = {
    name: 'app-modules',
    setup(b) {
        b.onResolve({ filter: /^\$(app|lib)\// }, (args) => {
            if (args.path in stubs) return { path: args.path, namespace: 'stub' };
            return b.resolve(`./${args.path.replace(/^\$lib\//, 'src/lib/')}`, { resolveDir: root, kind: args.kind });
        });
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
        // Compile runes ($state, $derived) the way SvelteKit does.
        b.onLoad({ filter: /\.svelte\.ts$/ }, async (args) => {
            const { code } = await transform(await readFile(args.path, 'utf8'), { loader: 'ts' });
            return { contents: compileModule(code, { filename: args.path, generate: 'client' }).js.code, loader: 'js' };
        });
    },
};
const { outputFiles } = await build({
    absWorkingDir: root,
    entryPoints: ['src/lib/state/search.svelte.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [appModules],
});
const { searchState } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));

function savedSong(id, title, artist) {
    return { id, title, artists: [{ name: artist, thumbnails: [] }], album: null, duration: 230, thumbnails: [], isDownloaded: true };
}

/** The backend as the app sees it, talking to a YouTube Music client that answers with `handler`. */
function useYoutube(handler) {
    const getYt = async () => ({ search: async (_query, options) => handler(options?.type) });
    harness.client.musicSearch = (query, provider) => searchMusicSongs(getYt, new Set(), query, provider);
    harness.client.musicSearchExtras = async () => {
        throw new Error('extras unavailable');
    };
    harness.client.musicSearchVideos = async () => [];
    // Asked for when YouTube answered with few playlists or albums.
    harness.client.musicSearchPlaylists = async () => [];
    harness.client.musicSearchAlbums = async () => [];
}

test('Wi-Fi connected but YouTube unreachable: a downloaded song still shows up', async () => {
    const starboy = savedSong('yt:starboy', 'Starboy', 'The Weeknd');
    harness.library.tracks = new Map([[starboy.id, starboy]]);
    setOnline(true);
    useYoutube(() => {
        throw new Error('getaddrinfo ENOTFOUND music.youtube.com');
    });

    searchState.clear();
    await searchState.run('Starboy');

    assert.equal(searchState.offline, true);
    assert.deepEqual(searchState.results.map((s) => s.id), ['yt:starboy']);
    assert.equal(searchState.lastQuery, 'Starboy');
    assert.match(searchState.error, /ENOTFOUND/);
});

test('a search that reaches YouTube but finds nothing stays an empty online result', async () => {
    const starboy = savedSong('yt:starboy', 'Starboy', 'The Weeknd');
    harness.library.tracks = new Map([[starboy.id, starboy]]);
    setOnline(true);
    useYoutube(() => ({ contents: [] }));

    searchState.clear();
    await searchState.run('Starboy');

    assert.equal(searchState.offline, false);
    assert.equal(searchState.error, '');
    assert.deepEqual(searchState.results.map((s) => s.id), []);
});

test('device offline: search skips the network and shows the downloaded song', async () => {
    const starboy = savedSong('yt:starboy', 'Starboy', 'The Weeknd');
    harness.library.tracks = new Map([[starboy.id, starboy]]);
    setOnline(false);
    let called = false;
    useYoutube(() => {
        called = true;
        return { contents: [] };
    });

    searchState.clear();
    await searchState.run('starboy');

    assert.equal(called, false);
    assert.equal(searchState.offline, true);
    assert.equal(searchState.error, '');
    assert.deepEqual(searchState.results.map((s) => s.id), ['yt:starboy']);
});
