import { BotError } from './wayship.mjs';

export const services = {
    lastfm: 'Last.fm',
    listenbrainz: 'ListenBrainz',
};
export const periods = {
    week: { name: 'last week', lastfm: '7day', listenbrainz: 'week' },
    month: { name: 'last month', lastfm: '1month', listenbrainz: 'month' },
    year: { name: 'last year', lastfm: '12month', listenbrainz: 'year' },
    all: { name: 'all time', lastfm: 'overall', listenbrainz: 'all_time' },
};

export function profileUrl(service, username) {
    const name = encodeURIComponent(username);
    return service === 'lastfm' ? `https://www.last.fm/user/${name}` : `https://listenbrainz.org/user/${name}/`;
}

const appAgent = 'ZetaDiscord/0.1 (https://github.com/zeta-zx/z3)';
const list = (items) => Array.isArray(items) ? items : items ? [items] : [];

export function scrobbling(apiKey, fetcher = fetch) {
    async function fetchService(service, url) {
        const name = services[service];
        const response = await fetcher(url, {
            signal: AbortSignal.timeout(6500),
            headers: { 'User-Agent': appAgent },
        }).catch(() => { throw new BotError(`Could not reach ${name}. Try again in a moment.`); });

        if (response.status === 204) return {};
        const data = await response.json().catch(() => ({}));
        if (response.status === 404 || response.status === 403 || [6, 17].includes(data.error) ||
            (response.ok && data.error === 'User not found')) {
            throw new BotError(`That ${name} profile could not be read. Check the username and profile privacy.`);
        }
        if (!response.ok || data.error) throw new BotError(`${name} could not complete this request.`);
        return data;
    }

    function lastfm(method, username, params = {}) {
        if (!apiKey) throw new BotError('Last.fm lookups need LASTFM_API_KEY in the bot configuration.');
        const query = new URLSearchParams({ method, user: username, api_key: apiKey, format: 'json', ...params });
        return fetchService('lastfm', `https://ws.audioscrobbler.com/2.0/?${query}`);
    }

    function listenbrainz(route) {
        return fetchService('listenbrainz', `https://api.listenbrainz.org/1${route}`);
    }

    async function verify(service, username) {
        if (service === 'lastfm') {
            const data = await lastfm('user.getInfo', username);
            if (!data.user?.name) throw new BotError('That Last.fm profile could not be read.');
            return data.user.name;
        }
        const data = await listenbrainz(`/user/${encodeURIComponent(username)}/listen-count`);
        if (typeof data.payload?.count !== 'number') throw new BotError('That ListenBrainz profile could not be read.');
        return username;
    }

    async function recent(service, username, limit = 5, includeLive = false) {
        if (service === 'lastfm') {
            const data = await lastfm('user.getRecentTracks', username, { limit: String(limit) });
            return list(data.recenttracks?.track).map((track) => {
                const coverUrl = list(track.image).findLast((size) => size?.['#text'])?.['#text'];
                const album = track.album?.['#text'];
                return {
                    title: track.name,
                    artist: track.artist?.['#text'],
                    playing: track['@attr']?.nowplaying === 'true',
                    time: Number(track.date?.uts) || 0,
                    ...(album && { album }),
                    ...(track.url && { url: track.url }),
                    ...(coverUrl && { coverUrl }),
                };
            }).filter((track) => track.title);
        }

        const path = `/user/${encodeURIComponent(username)}`;
        const [history, active] = await Promise.all([
            listenbrainz(`${path}/listens?count=${limit}`),
            includeLive ? listenbrainz(`${path}/playing-now`).catch(() => null) : null,
        ]);
        const playing = list(active?.payload?.listens);
        const result = [
            ...playing.map((track) => listenBrainzTrack(track, true)),
            ...list(history.payload?.listens).map((track) => listenBrainzTrack(track, false)),
        ];
        return result.filter((track) => track.title);
    }

    async function top(service, username, kind, period, limit = 5) {
        if (service === 'lastfm') {
            const method = kind === 'tracks' ? 'user.getTopTracks' : 'user.getTopArtists';
            const data = await lastfm(method, username, { period: periods[period].lastfm, limit: String(limit) });
            const items = kind === 'tracks' ? data.toptracks?.track : data.topartists?.artist;
            return list(items).map((item) => ({
                title: item.name, artist: item.artist?.name, count: Number(item.playcount),
            }));
        }

        const endpoint = kind === 'tracks' ? 'recordings' : 'artists';
        const path = `/stats/user/${encodeURIComponent(username)}/${endpoint}`;
        const data = await listenbrainz(`${path}?count=${limit}&range=${periods[period].listenbrainz}`);
        return list(data.payload?.[endpoint]).map((item) => ({
            title: kind === 'tracks' ? item.track_name : item.artist_name,
            artist: kind === 'tracks' ? item.artist_name : undefined,
            count: item.listen_count,
        }));
    }

    return { verify, recent, top };
}

function listenBrainzTrack(track, playing) {
    const metadata = track.track_metadata;
    const album = metadata?.release_name;
    const cover = metadata?.mbid_mapping;
    const coverUrl = Number.isSafeInteger(cover?.caa_id) && cover.caa_id > 0 &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(cover.caa_release_mbid ?? '')
        ? `https://coverartarchive.org/release/${cover.caa_release_mbid}/${cover.caa_id}-250.jpg` : undefined;
    return {
        title: metadata?.track_name,
        artist: metadata?.artist_name,
        time: track.listened_at ?? 0,
        playing,
        ...(album && { album }),
        ...(coverUrl && { coverUrl }),
    };
}
