import { Album as SaavnAlbum, Artist as SaavnArtist, Playlist as SaavnPlaylist, Song as SaavnSong } from '@saavn-labs/sdk';
import type {
    AlbumBase,
    Artist,
    ArtistDetails,
    CollectionDetails,
    CollectionKind,
    CollectionSummary,
    MusicProvider,
    SearchExtras,
    Song,
    Thumbnail,
} from './schema.ts';
import { musicText, youtubeArtists } from './music-metadata.ts';
import { comparableText } from '../../electron/lib/lyricsfile.ts';
import { ytSearchItems } from './youtube-search-results.ts';

export { ytSearchItems } from './youtube-search-results.ts';

type YtMusicLike = {
    search(query: string, options?: { type?: 'song' | 'video' | 'album' | 'playlist' | 'artist' }): Promise<any>;
    getArtist(channelId: string): Promise<any>;
    getAlbum(browseId: string): Promise<any>;
    getPlaylist(browseId: string): Promise<any>;
};

export function saavnImages(list: { url: string; resolution?: string }[] | undefined): Thumbnail[] {
    return (list ?? []).map((i) => {
        const [w, h] = (i.resolution ?? '').split('x').map((n) => parseInt(n, 10));
        return {
            url: i.url,
            ...(Number.isFinite(w) ? { width: w } : {}),
            ...(Number.isFinite(h) ? { height: h } : Number.isFinite(w) ? { height: w } : {}),
        };
    });
}

export function saavnToSong(s: any, downloaded: Set<string>): Song {
    const id = `js:${s.id}`;
    const rawArtists = s.artists?.primary?.length ? s.artists.primary : s.artists?.all ?? [];
    const seen = new Set<string>();
    const artists: Artist[] = [];
    for (const a of rawArtists) {
        const name = musicText(a?.name || '').trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        artists.push({
            id: a.id ? `js:${a.id}` : undefined,
            name,
            thumbnails: saavnImages(a.images),
        });
        if (artists.length >= 4) break;
    }
    return {
        id,
        title: musicText(s.title || 'Untitled Song'),
        thumbnails: saavnImages(s.images),
        artists: artists.length ? artists : [{ name: 'Unknown Artist', thumbnails: [] }],
        album: s.album
            ? {
                  id: s.album.id ? `js-album:${s.album.id}` : undefined,
                  title: musicText(s.album.title || 'Untitled Album'),
                  artists: [],
                  thumbnails: [],
              }
            : null,
        duration: s.duration || 0,
        isDownloaded: downloaded.has(id),
    };
}

export function ytThumbs(raw: any): Thumbnail[] {
    const list: any[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.contents)
          ? raw.contents
          : Array.isArray(raw?.thumbnails)
            ? raw.thumbnails
            : Array.isArray(raw?.thumbnail)
              ? raw.thumbnail
              : Array.isArray(raw?.thumbnail?.contents)
                ? raw.thumbnail.contents
                : [];
    return list
        .filter((t) => typeof t?.url === 'string' && t.url)
        .map((t) => ({ url: t.url, width: t.width, height: t.height }));
}

export function ytToSong(
    item: any,
    downloaded: Set<string>,
    fallback?: { album?: AlbumBase | null; artists?: Artist[]; thumbnails?: Thumbnail[] },
): Song | null {
    const rawId = item?.id || item?.endpoint?.payload?.videoId;
    if (!rawId || typeof rawId !== 'string') return null;
    const id = `yt:${rawId}`;
    const thumbs = ytThumbs(item.thumbnails ?? item.thumbnail);
    const artists = youtubeArtists(item);
    let albumRaw = item.album;
    if (!albumRaw?.name && Array.isArray(item.flex_columns)) {
        for (const col of item.flex_columns) {
            const titleObj = col?.title;
            const browseId =
                titleObj?.endpoint?.payload?.browseId ||
                titleObj?.runs?.find((r: any) => r?.endpoint?.payload?.browseId)?.endpoint?.payload?.browseId;
            if (typeof browseId === 'string' && browseId.startsWith('MPREb_')) {
                const name = musicText(titleObj.toString?.() ?? '').trim();
                if (name) {
                    albumRaw = { id: browseId, name };
                    break;
                }
            }
        }
    }
    const albumBrowseId = albumRaw?.id || albumRaw?.endpoint?.payload?.browseId;
    const album: AlbumBase | null = albumRaw?.name
        ? {
              id: albumBrowseId ? `yt:${albumBrowseId}` : undefined,
              title: musicText(albumRaw.name),
              artists: [],
              thumbnails: [],
          }
        : (fallback?.album ?? null);
    return {
        id,
        title: musicText(item.title?.toString?.() ?? item.title ?? item.name ?? 'Untitled'),
        thumbnails: thumbs.length ? thumbs : (fallback?.thumbnails ?? []),
        artists: artists.length ? artists : (fallback?.artists?.length ? fallback.artists : [{ name: 'Unknown Artist', thumbnails: [] }]),
        album,
        duration: item.duration?.seconds || 0,
        isDownloaded: downloaded.has(id),
    };
}

function ytItemToCollection(item: any, kindHint: CollectionKind, fallbackArtists: Artist[] = []): CollectionSummary | null {
    const rawId = item?.id || item?.endpoint?.payload?.browseId;
    if (!rawId || typeof rawId !== 'string') return null;
    const title = musicText(item.title?.toString?.() ?? item.title ?? item.name ?? '').trim();
    if (!title) return null;
    const subtitle = musicText(item.subtitle?.toString?.() ?? '').trim() || undefined;
    const year = item.year ? String(item.year) : subtitle?.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
    const kind: CollectionKind =
        rawId.startsWith('VL') || rawId.startsWith('PL') || /playlist/i.test(subtitle ?? '')
            ? 'playlist'
            : /single|ep/i.test(subtitle ?? '')
              ? 'single'
              : kindHint;
    const artists = youtubeArtists(item);
    return {
        id: `yt:${rawId}`,
        kind,
        title,
        subtitle,
        year,
        thumbnails: ytThumbs(item),
        artists: artists.length ? artists : fallbackArtists,
    };
}

function saavnAlbumToCollection(a: any, kindHint: CollectionKind = 'album'): CollectionSummary {
    const rawArtists = a.artists?.primary?.length ? a.artists.primary : a.artists?.all ?? [];
    const artists: Artist[] = rawArtists.slice(0, 3).map((ar: any) => ({
        id: ar.id ? `js:${ar.id}` : undefined,
        name: musicText(ar.name || ''),
        thumbnails: saavnImages(ar.images),
    }));
    const year = a.year ? String(a.year) : undefined;
    return {
        id: `js-album:${a.id}`,
        kind: a.type === 'single' ? 'single' : kindHint,
        title: musicText(a.title || 'Untitled Album'),
        subtitle: musicText(a.subtitle || artists.map((x) => x.name).join(', ') || year || ''),
        year,
        thumbnails: saavnImages(a.images),
        artists,
    };
}

export async function searchMusicExtras(
    getYt: () => Promise<YtMusicLike>,
    query: string,
    provider: MusicProvider,
): Promise<SearchExtras> {
    if (provider === 'js') {
        const [artRes, albRes, playlistRes] = await Promise.allSettled([
            SaavnArtist.search({ query, limit: 8 }),
            SaavnAlbum.search({ query, limit: 10 }),
            SaavnPlaylist.search({ query, limit: 10 }),
        ]);
        const artists: Artist[] =
            artRes.status === 'fulfilled'
                ? (artRes.value.results ?? []).map((a: any) => ({
                      id: `js:${a.id}`,
                      name: musicText(a.name || ''),
                      thumbnails: saavnImages(a.images),
                  })).filter((a: Artist) => !!a.name)
                : [];
        const albums: CollectionSummary[] =
            albRes.status === 'fulfilled'
                ? (albRes.value.results ?? []).map((a: any) => saavnAlbumToCollection(a, 'album'))
                : [];
        const playlists: CollectionSummary[] =
            playlistRes.status === 'fulfilled'
                ? (playlistRes.value.results ?? []).map((p: any) => ({
                      id: `js-pl:${p.id}`,
                      kind: 'playlist',
                      title: musicText(p.title || 'Playlist'),
                      subtitle: [p.owner?.name, p.stats?.songCount ? `${p.stats.songCount} songs` : ''].filter(Boolean).join(' · ') || undefined,
                      thumbnails: saavnImages(p.images),
                      artists: [],
                  }))
                : [];
        return { artists, albums, playlists };
    }

    const yt = await getYt();
    const [artRes, albRes, playlistRes] = await Promise.allSettled([
        yt.search(query, { type: 'artist' }),
        yt.search(query, { type: 'album' }),
        yt.search(query, { type: 'playlist' }),
    ]);

    const artists: Artist[] = [];
    if (artRes.status === 'fulfilled') {
        for (const item of ytSearchItems(artRes.value, 'artist', 'artists')) {
            const rawId = item?.id || item?.endpoint?.payload?.browseId;
            const name = musicText(item?.name || item?.title?.toString?.() || '').trim();
            if (!rawId || !name) continue;
            artists.push({
                id: `yt:${rawId}`,
                name,
                subtitle: musicText(item?.subtitle?.toString?.() || '').replace(/^Artist\s*[•·]\s*/i, '').trim() || undefined,
                thumbnails: ytThumbs(item),
            });
        }
    }

    const albums: CollectionSummary[] = [];
    if (albRes.status === 'fulfilled') {
        for (const item of ytSearchItems(albRes.value, 'album', 'albums')) {
            const col = ytItemToCollection(item, 'album');
            if (col) albums.push(col);
        }
    }

    const playlists: CollectionSummary[] = [];
    if (playlistRes.status === 'fulfilled') {
        for (const item of ytSearchItems(playlistRes.value, 'playlist', 'playlists')) {
            const col = ytItemToCollection(item, 'playlist');
            if (col) playlists.push(col);
        }
    }

    return { artists: artists.slice(0, 8), albums: albums.slice(0, 12), playlists: playlists.slice(0, 12) };
}

export async function searchMusicPlaylists(
    getYt: () => Promise<YtMusicLike>,
    query: string,
    provider: MusicProvider,
): Promise<CollectionSummary[]> {
    if (provider === 'js') {
        const result = await SaavnPlaylist.search({ query, limit: 12 });
        return (result.results ?? []).map((playlist: any) => ({
            id: `js-pl:${playlist.id}`,
            kind: 'playlist',
            title: musicText(playlist.title || 'Playlist'),
            subtitle: [playlist.owner?.name, playlist.stats?.songCount ? `${playlist.stats.songCount} songs` : ''].filter(Boolean).join(' · ') || undefined,
            thumbnails: saavnImages(playlist.images),
            artists: [],
        }));
    }

    if (provider !== 'yt') throw new Error(`Provider '${provider}' not supported for playlist search.`);
    const yt = await getYt();
    const result = await yt.search(query, { type: 'playlist' });
    return ytSearchItems(result, 'playlist', 'playlists')
        .map((item: any) => ytItemToCollection(item, 'playlist'))
        .filter((collection: CollectionSummary | null): collection is CollectionSummary => collection !== null)
        .slice(0, 12);
}

export async function searchMusicAlbums(
    getYt: () => Promise<YtMusicLike>,
    query: string,
    provider: MusicProvider,
): Promise<CollectionSummary[]> {
    if (provider === 'js') {
        const result = await SaavnAlbum.search({ query, limit: 12 });
        return (result.results ?? []).map((album: any) => saavnAlbumToCollection(album, 'album'));
    }

    if (provider !== 'yt') throw new Error(`Provider '${provider}' not supported for album search.`);
    const yt = await getYt();
    const result = await yt.search(query, { type: 'album' });
    return ytSearchItems(result, 'album', 'albums')
        .map((item: any) => ytItemToCollection(item, 'album'))
        .filter((collection: CollectionSummary | null): collection is CollectionSummary => collection !== null)
        .slice(0, 12);
}

export async function searchMusicVideos(
    getYt: () => Promise<YtMusicLike>,
    downloaded: Set<string>,
    query: string,
): Promise<Song[]> {
    const yt = await getYt();
    const result = await yt.search(query, { type: 'video' });
    return ytSearchItems(result, 'video', 'videos')
        .map((item: any) => ytToSong(item, downloaded))
        .filter((song: Song | null): song is Song => song !== null)
        .slice(0, 12);
}

const IMITATION_RE =
    /\b(?:karaoke|tribute|originally performed by|in the style of|made famous by|backing track|instrumental version|without .* instrumental)\b/i;
const EDIT_NOISE_RE = /\b(?:slowed|sped\s*up|nightcore|8d\s*audio|reverb|432\s*hz)\b/i;
const VIDEO_CLUTTER_RE = /#\w+|\b(?:dance\s*cover|acoustic\s*cover|guitar\s*cover|drum\s*cover|piano\s*cover|reaction|tutorial|lesson)\b/i;
const VIDEO_TAG_RE =
    /\((?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|lyric\s*video|visuali[sz]er|hd|4k)\)|\[(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|lyric\s*video|visuali[sz]er|hd|4k)\]/gi;

function searchTokens(text: string): string[] {
    return text
        .normalize('NFKD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .split(/\s+/)
        .filter((tok) => tok && tok !== 'and' && tok !== 'the');
}

/**
 * Rank and merge YouTube Music song and video search results so official tracks
 * that only exist under Videos (e.g. "King" by "Years & Years") surface ahead
 * of karaoke/tribute versions or unrelated songs by the same artist.
 */
export function rankYoutubeSearchSongs(
    query: string,
    songs: Song[],
    videos: Song[] = [],
): Song[] {
    const byMatch = query.match(/^(.+?)\s+by\s+(.+)$/i);
    const effectiveQuery = byMatch ? `${byMatch[1]} ${byMatch[2]}` : query;
    const wantedTokens = [...new Set(searchTokens(effectiveQuery))];
    const wantedTitleTokens = byMatch ? searchTokens(byMatch[1]) : [];
    const wantedArtistTokens = byMatch ? searchTokens(byMatch[2]) : [];
    const wantsImitation = IMITATION_RE.test(query);
    const wantsEdit = EDIT_NOISE_RE.test(query);
    const wantsClutter = VIDEO_CLUTTER_RE.test(query);

    const entries = new Map<string, { song: Song; isSongShelf: boolean; order: number }>();
    let order = 0;
    for (const song of songs) {
        if (!entries.has(song.id)) entries.set(song.id, { song, isSongShelf: true, order: order++ });
    }
    let addedVideos = 0;
    for (const video of videos) {
        if (entries.has(video.id)) continue;
        entries.set(video.id, { song: video, isSongShelf: false, order: order++ });
        if (++addedVideos >= 10) break;
    }

    const scored = [...entries.values()].map((entry) => {
        const { song, isSongShelf } = entry;
        const cleanTitle = song.title.replace(VIDEO_TAG_RE, ' ').trim();
        const artistStr = song.artists.map((a) => a.name).join(' ');
        const combinedStr = `${cleanTitle} ${artistStr}`;
        const titleTokens = new Set(searchTokens(cleanTitle));
        const artistTokens = new Set(searchTokens(artistStr));
        const allTokens = new Set([...titleTokens, ...artistTokens]);

        let score = isSongShelf ? 32 : 0;
        score -= entry.order * 1.4;

        if (!wantsImitation && IMITATION_RE.test(combinedStr)) score -= 95;
        if (!wantsEdit && EDIT_NOISE_RE.test(combinedStr)) score -= 45;
        if (!wantsClutter && VIDEO_CLUTTER_RE.test(combinedStr)) score -= 60;

        if (wantedTokens.length) {
            const matched = wantedTokens.filter((t) => allTokens.has(t));
            const ratio = matched.length / wantedTokens.length;
            score += ratio * 55;
            if (ratio === 1) score += 30;
            // Both title and artist contribute to the match (not just artist alone).
            const titleHits = wantedTokens.filter((t) => titleTokens.has(t)).length;
            const artistHits = wantedTokens.filter((t) => artistTokens.has(t)).length;
            if (titleHits > 0 && artistHits > 0) score += 28;
            else if (titleHits === 0) score -= 25;
        }

        if (wantedTitleTokens.length && wantedArtistTokens.length) {
            const exactTitle =
                wantedTitleTokens.every((t) => titleTokens.has(t)) &&
                titleTokens.size <= wantedTitleTokens.length + 2;
            const artistMatch = wantedArtistTokens.every((t) => artistTokens.has(t));
            if (exactTitle && artistMatch) score += 45;
        }

        return { song, score, order: entry.order };
    });

    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return scored.map((s) => s.song).slice(0, 30);
}

export async function searchMusicSongs(
    getYt: () => Promise<YtMusicLike>,
    downloaded: Set<string>,
    query: string,
    provider: MusicProvider,
): Promise<Song[]> {
    if (provider === 'js') {
        const res = await SaavnSong.search({ query, limit: 30 });
        return (res.results ?? []).map((s: any) => saavnToSong(s, downloaded));
    }
    if (provider !== 'yt') throw new Error(`Provider '${provider}' not supported for searching.`);

    const yt = await getYt();
    const byMatch = query.match(/^(.+?)\s+by\s+(.+)$/i);
    const strippedQuery = byMatch ? `${byMatch[1].trim()} ${byMatch[2].trim()}` : null;

    const [songRes, strippedSongRes, videoRes] = await Promise.allSettled([
        yt.search(query, { type: 'song' }),
        strippedQuery ? yt.search(strippedQuery, { type: 'song' }) : Promise.resolve(null),
        yt.search(strippedQuery ?? query, { type: 'video' }),
    ]);

    const toSongs = (res: PromiseSettledResult<any>, section: string, legacy: string): Song[] =>
        res.status === 'fulfilled' && res.value
            ? ytSearchItems(res.value, section, legacy)
                  .map((item: any) => ytToSong(item, downloaded))
                  .filter((s: Song | null): s is Song => s !== null)
            : [];

    const songs = [
        ...toSongs(strippedSongRes, 'song', 'songs'),
        ...toSongs(songRes, 'song', 'songs'),
    ];
    const videos = toSongs(videoRes, 'video', 'videos');
    return rankYoutubeSearchSongs(query, songs, videos);
}

export async function fetchArtistDetails(
    getYt: () => Promise<YtMusicLike>,
    downloaded: Set<string>,
    idOrQuery: string,
    nameHint?: string,
): Promise<ArtistDetails> {
    if (idOrQuery.startsWith('js:') || idOrQuery.startsWith('js-name:')) {
        let artistId = idOrQuery.startsWith('js:') ? idOrQuery.slice(3) : '';
        const queryName = idOrQuery.startsWith('js-name:') ? idOrQuery.slice(8) : (nameHint ?? '');
        if (!artistId && queryName) {
            const found = await SaavnArtist.search({ query: queryName, limit: 5 });
            const target = comparableText(queryName);
            const hit =
                (found.results ?? []).find((a: any) => comparableText(a.name || '') === target) ??
                found.results?.[0];
            artistId = hit?.id ?? '';
        }
        if (artistId) {
            const data = await SaavnArtist.getById({ artistId });
            const artistRef: Artist = {
                id: `js:${data.id || artistId}`,
                name: musicText(data.name || queryName || 'Artist'),
                thumbnails: saavnImages(data.images),
            };
            const topSongs = (data.songs?.top ?? []).map((s: any) => saavnToSong(s, downloaded));
            const albums = (data.albums?.top ?? []).map((a: any) => saavnAlbumToCollection(a, 'album'));
            const singles = (data.albums?.singles ?? []).map((a: any) => saavnAlbumToCollection(a, 'single'));
            const playlists: CollectionSummary[] = [
                ...(data.playlists?.dedicated ?? []),
                ...(data.playlists?.featured ?? []),
            ].map((p: any) => ({
                id: `js-pl:${p.id}`,
                kind: 'playlist' as const,
                title: musicText(p.title || 'Playlist'),
                subtitle: musicText(p.subtitle || ''),
                thumbnails: saavnImages(p.images),
                artists: [artistRef],
            }));
            return {
                id: artistRef.id!,
                name: artistRef.name,
                subtitle: musicText(data.subtitle || '').replace(/^Artist\s*[•·]\s*/i, '').trim() || undefined,
                description: typeof data.profile?.bio === 'string' ? musicText(data.profile.bio) : undefined,
                thumbnails: artistRef.thumbnails,
                topSongs,
                albums,
                singles,
                playlists,
                similarArtists: [],
                hasMoreSongs: topSongs.length >= 10,
            };
        }
    }

    const yt = await getYt();
    let channelId = idOrQuery.startsWith('yt:') ? idOrQuery.slice(3) : '';
    let searchName = idOrQuery.startsWith('name:')
        ? idOrQuery.slice(5)
        : !idOrQuery.startsWith('yt:')
          ? idOrQuery
          : (nameHint ?? '');

    if (!channelId && searchName) {
        const searchRes = await yt.search(searchName, { type: 'artist' }).catch(() => null);
        const candidates: any[] = searchRes?.artists?.contents ?? [];
        const target = comparableText(searchName);
        const best =
            candidates.find((c) => comparableText(c?.name || c?.title?.toString?.() || '') === target) ??
            candidates.find((c) => {
                const n = comparableText(c?.name || c?.title?.toString?.() || '');
                return n && target && (n.includes(target) || target.includes(n));
            }) ??
            candidates[0];
        channelId = best?.id || best?.endpoint?.payload?.browseId || '';
        if (best?.name && !nameHint) searchName = musicText(best.name);
    }

    if (channelId) {
        try {
            const artist = await yt.getArtist(channelId);
            const name = musicText(artist.header?.title?.toString?.() || searchName || 'Artist').trim();
            const description = musicText(artist.header?.description?.toString?.() || '').trim() || undefined;
            const rawSub =
                artist.header?.subscription_button?.subscribe_accessibility_label ||
                artist.header?.subtitle?.toString?.() ||
                '';
            const subMatch = String(rawSub).match(/(\d[\d.,]*\s*(?:million|thousand|M|K|B)?\s*(?:subscribers|monthly audience)?)/i);
            const subtitle = subMatch ? subMatch[1].trim() : undefined;
            const thumbnails = ytThumbs(artist.header?.thumbnail);
            const selfArtist: Artist = { id: `yt:${channelId}`, name, thumbnails };

            const topSongs: Song[] = [];
            const albums: CollectionSummary[] = [];
            const singles: CollectionSummary[] = [];
            const playlists: CollectionSummary[] = [];
            const similarArtists: Artist[] = [];
            let hasMoreSongs = false;

            for (const sec of artist.sections ?? []) {
                const secTitle = String(sec.header?.title?.toString?.() ?? sec.title?.toString?.() ?? '').toLowerCase();
                const items: any[] = sec.contents ?? [];
                if (!items.length) continue;

                if (secTitle.includes('song') || items[0]?.item_type === 'song') {
                    if (sec.header?.more_content || sec.bottom_endpoint || items.length >= 5) hasMoreSongs = true;
                    for (const item of items) {
                        const song = ytToSong(item, downloaded, { artists: [selfArtist] });
                        if (song) topSongs.push(song);
                    }
                } else if (secTitle.includes('single') || secTitle.includes('ep')) {
                    for (const item of items) {
                        const col = ytItemToCollection(item, 'single', [selfArtist]);
                        if (col) singles.push(col);
                    }
                } else if (secTitle.includes('album') || items[0]?.item_type === 'album') {
                    for (const item of items) {
                        const col = ytItemToCollection(item, 'album', [selfArtist]);
                        if (col) {
                            if (col.kind === 'single') singles.push(col);
                            else albums.push(col);
                        }
                    }
                } else if (secTitle.includes('playlist') || secTitle.includes('featured') || items[0]?.item_type === 'playlist') {
                    for (const item of items) {
                        const col = ytItemToCollection(item, 'playlist', [selfArtist]);
                        if (col) playlists.push(col);
                    }
                } else if (secTitle.includes('like') || secTitle.includes('similar') || secTitle.includes('fan') || items[0]?.item_type === 'artist') {
                    for (const item of items) {
                        const rawId = item?.id || item?.endpoint?.payload?.browseId;
                        const aName = musicText(item?.title?.toString?.() ?? item?.name ?? '').trim();
                        if (!rawId || !aName) continue;
                        similarArtists.push({
                            id: `yt:${rawId}`,
                            name: aName,
                            subtitle: musicText(item?.subtitle?.toString?.() ?? '').trim() || undefined,
                            thumbnails: ytThumbs(item),
                        });
                    }
                }
            }

            // Smaller/indie artists on YouTube Music often have only "Singles & EPs" on their
            // channel page and no "Top songs" shelf. Populate their songs via song search.
            if (!topSongs.length) {
                const songSearch = await yt.search(name, { type: 'song' }).catch(() => null);
                const target = comparableText(name);
                for (const item of songSearch?.songs?.contents ?? []) {
                    const song = ytToSong(item, downloaded);
                    if (!song) continue;
                    const matchesArtist = song.artists.some(
                        (a) => a.id === `yt:${channelId}` || (target && comparableText(a.name).includes(target)),
                    );
                    if (matchesArtist) topSongs.push(song);
                }
            }

            return {
                id: `yt:${channelId}`,
                name,
                subtitle,
                description,
                thumbnails: thumbnails.length ? thumbnails : (topSongs[0]?.thumbnails ?? albums[0]?.thumbnails ?? singles[0]?.thumbnails ?? []),
                topSongs,
                albums,
                singles,
                playlists,
                similarArtists,
                hasMoreSongs,
            };
        } catch {
            /* fall through to song/album search by name */
        }
    }

    // Fallback when only a name is known and no channel browse page could be opened.
    const fallbackName = searchName || nameHint || idOrQuery.replace(/^(?:yt|js|name|js-name):/, '');
    const target = comparableText(fallbackName);
    const [songRes, extras] = await Promise.all([
        yt.search(fallbackName, { type: 'song' }).catch(() => null),
        searchMusicExtras(getYt, fallbackName, 'yt').catch(() => ({ artists: [], albums: [], playlists: [] })),
    ]);
    const topSongs: Song[] = [];
    for (const item of songRes?.songs?.contents ?? []) {
        const song = ytToSong(item, downloaded);
        if (!song) continue;
        if (!target || song.artists.some((a) => comparableText(a.name).includes(target) || target.includes(comparableText(a.name)))) {
            topSongs.push(song);
        }
    }
    const albums = extras.albums.filter(
        (a) => !target || a.artists.some((ar) => comparableText(ar.name).includes(target)),
    );
    return {
        id: `name:${fallbackName}`,
        name: fallbackName,
        thumbnails: extras.artists[0]?.thumbnails?.length ? extras.artists[0].thumbnails : (topSongs[0]?.thumbnails ?? []),
        topSongs,
        albums,
        singles: [],
        playlists: [],
        similarArtists: extras.artists.slice(1),
        hasMoreSongs: false,
    };
}

export async function fetchArtistAllSongs(
    getYt: () => Promise<YtMusicLike>,
    downloaded: Set<string>,
    artistId: string,
    nameHint?: string,
): Promise<Song[]> {
    if (artistId.startsWith('js:')) {
        const q = nameHint || artistId.slice(3);
        const res = await SaavnSong.search({ query: q, limit: 50 });
        return (res.results ?? []).map((s: any) => saavnToSong(s, downloaded));
    }
    const yt = await getYt();
    const channelId = artistId.startsWith('yt:') ? artistId.slice(3) : '';
    if (channelId) {
        try {
            const artist = await yt.getArtist(channelId);
            const artistName = musicText(artist.header?.title?.toString?.() || nameHint || '').trim();
            const fallbackArtists: Artist[] = artistName ? [{ id: `yt:${channelId}`, name: artistName, thumbnails: [] }] : [];
            const all = await artist.getAllSongs();
            const songs: Song[] = [];
            for (const item of all?.contents ?? []) {
                const song = ytToSong(item, downloaded, { artists: fallbackArtists });
                if (song) songs.push(song);
            }
            if (songs.length) return songs;
        } catch {
            /* fall back to search */
        }
    }
    const query = nameHint || artistId.replace(/^(?:yt|name):/, '');
    if (!query) return [];
    const res = await yt.search(query, { type: 'song' }).catch(() => null);
    const songs: Song[] = [];
    for (const item of res?.songs?.contents ?? []) {
        const song = ytToSong(item, downloaded);
        if (song) songs.push(song);
    }
    return songs;
}

export async function fetchCollectionDetails(
    getYt: () => Promise<YtMusicLike>,
    downloaded: Set<string>,
    id: string,
): Promise<CollectionDetails> {
    if (id.startsWith('js-album:') || (id.startsWith('js:') && !id.startsWith('js-pl:'))) {
        const albumId = id.replace(/^js(?:-album)?:/, '');
        const data = await SaavnAlbum.getById({ albumId });
        const summary = saavnAlbumToCollection(data, 'album');
        const tracks = (data.songs ?? []).map((s: any) => saavnToSong(s, downloaded));
        return {
            ...summary,
            id: `js-album:${data.id || albumId}`,
            description: data.description ? musicText(data.description) : undefined,
            tracks,
        };
    }

    if (id.startsWith('js-pl:')) {
        const playlistId = id.slice(6);
        const data = await SaavnPlaylist.getById({ playlistId });
        const tracks = (data.songs ?? []).map((s: any) => saavnToSong(s, downloaded));
        return {
            id: `js-pl:${data.id || playlistId}`,
            kind: 'playlist',
            title: musicText(data.title || 'Playlist'),
            subtitle: musicText(data.subtitle || ''),
            description: data.description ? musicText(data.description) : undefined,
            thumbnails: saavnImages(data.images),
            artists: [],
            tracks,
        };
    }

    const yt = await getYt();
    let browseId = id.startsWith('yt:') ? id.slice(3) : id;

    // Resolve "album:<artist>:<title>" links from tracks that only stored an album title.
    if (id.startsWith('album:')) {
        const rest = id.slice(6);
        const sep = rest.indexOf(':');
        const artistName = sep >= 0 ? rest.slice(0, sep) : '';
        const albumTitle = sep >= 0 ? rest.slice(sep + 1) : rest;
        const q = `${artistName} ${albumTitle}`.trim();
        const searchRes = await yt.search(q, { type: 'album' }).catch(() => null);
        const candidates: any[] = searchRes?.albums?.contents ?? [];
        const targetTitle = comparableText(albumTitle);
        const targetArtist = comparableText(artistName);
        const match =
            candidates.find((c) => {
                const t = comparableText(c?.title?.toString?.() ?? c?.name ?? '');
                const a = comparableText(c?.author?.name ?? '');
                return t && targetTitle && (t.includes(targetTitle) || targetTitle.includes(t)) && (!targetArtist || !a || a.includes(targetArtist) || targetArtist.includes(a));
            }) ?? candidates[0];
        browseId = match?.id || match?.endpoint?.payload?.browseId || '';
        if (!browseId) throw new Error(`Couldn't find album “${albumTitle}”.`);
    }

    if (browseId.startsWith('VL') || browseId.startsWith('PL') || browseId.startsWith('RD')) {
        const pl = await yt.getPlaylist(browseId);
        const title = musicText(pl.header?.title?.toString?.() || 'Playlist').trim();
        const subtitle = musicText(pl.header?.subtitle?.toString?.() || pl.header?.second_subtitle?.toString?.() || '').trim() || undefined;
        const description = musicText(pl.header?.description?.description?.toString?.() || pl.header?.description?.toString?.() || '').trim() || undefined;
        const thumbnails = ytThumbs(pl.header?.thumbnail);
        const tracks: Song[] = [];
        for (const item of pl.items ?? pl.contents ?? []) {
            const song = ytToSong(item, downloaded, { thumbnails });
            if (song) tracks.push(song);
        }
        return {
            id: `yt:${browseId}`,
            kind: 'playlist',
            title,
            subtitle,
            description,
            thumbnails: thumbnails.length ? thumbnails : (tracks[0]?.thumbnails ?? []),
            artists: [],
            tracks,
        };
    }

    const album = await yt.getAlbum(browseId);
    const title = musicText(album.header?.title?.toString?.() || 'Album').trim();
    const subtitle = musicText(album.header?.subtitle?.toString?.() || '').trim() || undefined;
    const year = subtitle?.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
    const description = musicText(
        album.header?.description?.description?.toString?.() || album.header?.description?.toString?.() || '',
    ).trim() || undefined;
    const thumbnails = ytThumbs(album.header?.thumbnail);
    const strap = album.header?.strapline_text_one;
    const strapName = musicText(strap?.toString?.() || '').trim();
    const strapBrowseId =
        strap?.endpoint?.payload?.browseId ||
        strap?.runs?.find((r: any) => r?.endpoint?.payload?.browseId)?.endpoint?.payload?.browseId;
    const artists: Artist[] = strapName
        ? [{
              id: strapBrowseId?.startsWith('UC') ? `yt:${strapBrowseId}` : undefined,
              name: strapName,
              thumbnails: ytThumbs(album.header?.strapline_thumbnail),
          }]
        : [];
    const albumBase: AlbumBase = {
        id: `yt:${browseId}`,
        title,
        artists,
        thumbnails,
        year,
    };
    const tracks: Song[] = [];
    for (const item of album.contents ?? []) {
        const song = ytToSong(item, downloaded, { album: albumBase, artists, thumbnails });
        if (song) tracks.push(song);
    }
    return {
        id: `yt:${browseId}`,
        kind: /single|ep/i.test(subtitle ?? '') ? 'single' : 'album',
        title,
        subtitle,
        description,
        year,
        thumbnails: thumbnails.length ? thumbnails : (tracks[0]?.thumbnails ?? []),
        artists,
        tracks,
    };
}
