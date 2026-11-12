import test from 'node:test';
import assert from 'node:assert/strict';
import { ytSearchItems } from '../src/lib/youtube-search-results.ts';
import { rankYoutubeSearchSongs } from '../src/lib/music-catalog.ts';

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
