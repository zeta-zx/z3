import test from 'node:test';
import assert from 'node:assert/strict';
import { ytSearchItems } from '../src/lib/youtube-search-results.ts';
import { rankYoutubeSearchSongs, searchMusicSongs } from '../src/lib/music-catalog.ts';

const shelf = (title, contents) => ({ title, contents });
const song = (id, title, artist) => ({
    id,
    title,
    artists: [{ name: artist, thumbnails: [] }],
    album: null,
    thumbnails: [],
    duration: 215,
    isDownloaded: false,
});

test('reads new YouTube Music titled sections', () => {
    const result = { contents: [shelf('Community playlists', [{ id: 'VLplaylist' }])] };
    assert.deepEqual(ytSearchItems(result, 'playlist', 'playlists'), [{ id: 'VLplaylist' }]);
});

test('supports the legacy YouTube Music result shape', () => {
    const result = { albums: { contents: [{ id: 'MPREb_album' }] } };
    assert.deepEqual(ytSearchItems(result, 'album', 'albums'), [{ id: 'MPREb_album' }]);
});

test('returns no matches when the requested section is absent', () => {
    const result = { contents: [shelf('Videos', [{ id: 'video-id' }])] };
    assert.deepEqual(ytSearchItems(result, 'album', 'albums'), []);
});

test('ranks the official video above karaoke tributes and other songs when missing from the song shelf', () => {
    const songs = [
        song('yt:real', 'Real', 'Olly Alexander (Years & Years)'),
        song('yt:tribute', 'King Originally Performed By Years & Years (Tribute Version)', 'New Tribute Kings'),
        song('yt:desire', 'Desire', 'Olly Alexander (Years & Years)'),
    ];
    const videos = [
        song('yt:g_uoH6hJilc', 'King (Official Video)', 'Years & Years'),
        song('yt:clutter', 'King - Years & Years #acousticcover', 'Random Channel'),
    ];
    const ranked = rankYoutubeSearchSongs('king by years and years', songs, videos);
    assert.equal(ranked[0].id, 'yt:g_uoH6hJilc');
    assert.equal(ranked.some((s) => s.id === 'yt:tribute'), true);
    assert.equal(ranked.some((s) => s.id === 'yt:clutter'), true);
    assert.ok(ranked.findIndex((s) => s.id === 'yt:g_uoH6hJilc') < ranked.findIndex((s) => s.id === 'yt:tribute'));
});

/** A fake YouTube Music client whose search() is answered by `handler(type)`. */
const fakeYt = (handler) => async () => ({ search: async (_query, options) => handler(options?.type) });
const unreachable = () => {
    throw new Error('getaddrinfo ENOTFOUND music.youtube.com');
};
const ytItem = (id, title) => ({ id, title, artists: [{ name: 'The Weeknd' }] });

test('song search throws when every request it sends fails', async () => {
    const sent = [];
    const getYt = fakeYt((type) => {
        sent.push(type);
        unreachable();
    });
    await assert.rejects(searchMusicSongs(getYt, new Set(), 'Starboy', 'yt'), /ENOTFOUND/);
    // A plain query skips the "title by artist" lookup, and that skip isn't a success.
    assert.deepEqual(sent.sort(), ['song', 'video']);
});

test('song search throws for a "title by artist" query when all three requests fail', async () => {
    const sent = [];
    const getYt = fakeYt((type) => {
        sent.push(type);
        unreachable();
    });
    await assert.rejects(searchMusicSongs(getYt, new Set(), 'Starboy by The Weeknd', 'yt'), /ENOTFOUND/);
    assert.deepEqual(sent.sort(), ['song', 'song', 'video']);
});

test('song search keeps the results of any request that succeeds', async () => {
    const getYt = fakeYt((type) => {
        if (type === 'video') return { videos: { contents: [ytItem('vid1', 'Starboy (Official Video)')] } };
        unreachable();
    });
    const songs = await searchMusicSongs(getYt, new Set(), 'Starboy', 'yt');
    assert.deepEqual(songs.map((s) => s.id), ['yt:vid1']);
});

test('song search that reaches YouTube but matches nothing returns an empty result', async () => {
    const getYt = fakeYt(() => ({ contents: [] }));
    assert.deepEqual(await searchMusicSongs(getYt, new Set(), 'zzzz no such song', 'yt'), []);
});
