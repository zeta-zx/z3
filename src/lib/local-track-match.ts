import type { Song } from './schema';

export function normalized(value: string | undefined): string {
    return (value ?? '')
        .normalize('NFKD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function artistNames(song: Song): Set<string> {
    return new Set(
        song.artists
            .flatMap((artist) => artist.name.split(/\s*,\s*(?:&\s*)?|\s+(?:feat\.?|ft\.?)\s+|\s+&\s+/i))
            .map(normalized)
            .filter((artist) => !!artist),
    );
}

/** Find an unambiguous downloaded library copy of a search result. */
export function findLocalTrackMatch(song: Song, libraryTracks: Iterable<Song>): Song | undefined {
    const tracks = [...libraryTracks];
    const sameId = tracks.find((track) => track.id === song.id && track.isDownloaded);
    if (sameId) return sameId;

    const title = normalized(song.title);
    const artists = artistNames(song);
    if (!title || !artists.size) return undefined;

    const album = normalized(song.album?.title);
    const matches = tracks
        .filter((track) => track.isDownloaded && track.id !== song.id && normalized(track.title) === title)
        .map((track) => {
            const sharedArtists = [...artistNames(track)].filter((artist) => artists.has(artist)).length;
            if (!sharedArtists) return undefined;

            const candidateAlbum = normalized(track.album?.title);
            const albumScore = album && candidateAlbum === album ? 2 : 0;
            const durationScore =
                song.duration > 0 && track.duration > 0
                    ? Math.max(0, 1 - Math.abs(song.duration - track.duration) / Math.max(song.duration, track.duration))
                    : 0;
            return { track, score: sharedArtists + albumScore + durationScore };
        })
        .filter((match): match is { track: Song; score: number } => !!match)
        .sort((a, b) => b.score - a.score);

    if (!matches.length || (matches[1] && matches[0].score === matches[1].score)) return undefined;
    return matches[0].track;
}
