import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchSavedSongs } from '../src/lib/saved-song-search.ts';

function song(id, title, artists, album, isDownloaded = true) {
    return {
        id,
        title,
        artists: artists.map((name) => ({ name, thumbnails: [] })),
        album: album ? { title: album, artists: [], thumbnails: [] } : null,
        duration: 200,
        thumbnails: [],
        isDownloaded,
    };
}

const library = [
    song('yt:1', 'Starboy', ['The Weeknd', 'Daft Punk'], 'Starboy'),
    song('yt:2', 'Blinding Lights', ['The Weeknd'], 'After Hours'),
    song('yt:3', 'Save Your Tears', ['The Weeknd'], 'After Hours'),
    song('yt:4', 'Lights Up', ['Harry Styles'], 'Fine Line'),
    song('yt:5', 'Lights', ['Ellie Goulding'], 'Bright Lights', false),
    song('local:track.mp3', 'Café del Mar', ['Energy 52'], null),
];
const ids = (songs) => songs.map((s) => s.id);

test('only returns songs saved on the device', () => {
    assert.deepEqual(ids(searchSavedSongs('lights', library)), ['yt:4', 'yt:2']);
});

test('matches by artist and album as well as title', () => {
    assert.deepEqual(ids(searchSavedSongs('weeknd', library)), ['yt:1', 'yt:2', 'yt:3']);
    assert.deepEqual(ids(searchSavedSongs('after hours', library)), ['yt:2', 'yt:3']);
});

test('every word has to match, across fields', () => {
    assert.deepEqual(ids(searchSavedSongs('weeknd tears', library)), ['yt:3']);
    assert.deepEqual(ids(searchSavedSongs('weeknd styles', library)), []);
});

test('matches word prefixes, ignoring case, accents and punctuation', () => {
    assert.deepEqual(ids(searchSavedSongs('BLIND', library)), ['yt:2']);
    assert.deepEqual(ids(searchSavedSongs('cafe', library)), ['local:track.mp3']);
    assert.deepEqual(ids(searchSavedSongs('  save, your  ', library)), ['yt:3']);
    assert.deepEqual(ids(searchSavedSongs('ights', library)), []);
});

test('ranks exact title, then exact artist, then title prefix', () => {
    assert.deepEqual(ids(searchSavedSongs('starboy', library)), ['yt:1']);
    assert.deepEqual(ids(searchSavedSongs('daft punk', library)), ['yt:1']);
    const lib = [
        song('a', 'Something Else', ['Lights'], null),
        song('b', 'Lights Out', ['Someone'], null),
        song('c', 'Lights', ['Someone'], null),
    ];
    assert.deepEqual(ids(searchSavedSongs('lights', lib)), ['c', 'a', 'b']);
});

test('empty query and limit', () => {
    assert.deepEqual(searchSavedSongs('   ', library), []);
    assert.deepEqual(ids(searchSavedSongs('the weeknd', library, 2)), ['yt:1', 'yt:2']);
});
