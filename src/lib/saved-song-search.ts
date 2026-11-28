import type { Song } from './schema';
import { normalized } from './local-track-match.ts';

/**
 * Search the songs saved on this device (downloads and imported files) by
 * title, artist and album, for when search can't reach the network. Every
 * word of the query has to start a word in the song's title, artists or album.
 * Best matches come first: exact title, then exact artist, then titles that
 * start with the query, then titles that contain every word.
 */
export function searchSavedSongs(query: string, tracks: Iterable<Song>, limit = 100): Song[] {
    const q = normalized(query);
    const terms = q.split(' ').filter(Boolean);
    if (!terms.length) return [];

    const matches: { song: Song; score: number; order: number }[] = [];
    let order = 0;
    for (const song of tracks) {
        order++;
        if (!song.isDownloaded) continue;
        const title = normalized(song.title);
        const artists = song.artists.map((artist) => normalized(artist.name));
        const album = normalized(song.album?.title);
        const words = [title, ...artists, album].join(' ').split(' ').filter(Boolean);
        if (!terms.every((term) => words.some((word) => word.startsWith(term)))) continue;

        const titleWords = title.split(' ');
        let score = 0;
        if (title === q) score = 4;
        else if (artists.includes(q)) score = 3;
        else if (title.startsWith(q)) score = 2;
        else if (terms.every((term) => titleWords.some((word) => word.startsWith(term)))) score = 1;
        matches.push({ song, score, order });
    }

    return matches
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, limit)
        .map((match) => match.song);
}
