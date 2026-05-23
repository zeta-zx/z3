import { Innertube, Platform, type Types } from 'youtubei.js';
import { Song as Saavn } from '@saavn-labs/sdk';

import { Readable } from 'node:stream';
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import NodeID3 from 'node-id3';

import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

const ffmpegPath = ffmpegStatic!.replace('app.asar', 'app.asar.unpacked');
ffmpeg.setFfmpegPath(ffmpegPath);

import type { Playlist, Song, Stream, Library, Thumbnail, MusicProvider } from '../../src/lib/schema';
import { updateThumbnailUrl } from '../../src/lib/utils';

const musicDir = join(homedir(), 'Music', 'Zeta');
if (!existsSync(musicDir)) mkdirSync(musicDir, { recursive: true });

let yt: Innertube;

async function init() {
    if (!yt) yt = await Innertube.create({});
}

function log(...args: any[]) {
    if (true) console.log(...args);
}

Platform.shim.eval = async (data: Types.BuildScriptResult) => { return new Function(data.output)();; };

interface ReadStream {
    data: ReadableStream<Uint8Array>;
    mimetype: string;
}

async function downloadAsMp3(stream: ReadableStream<Uint8Array>, mp3Path: string): Promise<void> {
    await init();

    log(`    - - - Let's download this stream to ${mp3Path}, using a promise.`);

    return new Promise((resolve, reject) => {
        ffmpeg(Readable.fromWeb(stream as any))
            .audioCodec('libmp3lame')
            .audioBitrate(192)
            .format('mp3')
            .save(mp3Path)
            .on('end', () => resolve())
            .on('error', (err: any) => reject(err));
    });
}

function getSongFromMp3(filePath: string): Song | null {
    if (!existsSync(filePath)) return null;

    const filename = basename(filePath);
    const tags = NodeID3.read(filePath);

    const durationObj = tags.userDefinedText?.find(t => t.description === 'duration');
    
    const duration = durationObj ? parseFloat(durationObj.value) : 0;

    const artistNames = tags.artist ? tags.artist.split(/,\s*|\s*\/\s*/) : ['Unknown Artist'];
    const artists = artistNames.map(name => ({
        name,
        thumbnails: []
    }));

    const thumbnails: Thumbnail[] = [];
    if (tags.image && typeof tags.image === 'object') {
        const img = tags.image as any;
        thumbnails.push({
            data: new Uint8Array(img.imageBuffer),
            mimetype: img.mime || 'image/jpeg'
        });
    }

    const thumbnailUrlObj = tags.userDefinedText?.find(t => t.description === 'thumbnailURL');
    if (thumbnailUrlObj) {
        thumbnails.push({
            url: thumbnailUrlObj.value,
        })
    }

    return {
        id: `fs:${filename}`,
        title: tags.title || filename.replace('.mp3', '').replace(/_/g, ' '),
        thumbnails,
        artists,
        album: tags.album ? {
            title: tags.album,
            artists: artists,
            thumbnails: thumbnails,
            year: tags.year
        } : null,
        duration,
        lyrics: tags.unsynchronisedLyrics?.text || null,
        year: tags.year,
        isDownloaded: true,
    };
}

function readPlaylistFile(filename: string): Playlist {
    const filePath = join(musicDir, filename);
    const stat = statSync(filePath);
    const content = readFileSync(filePath, 'utf-8');
    
    let displayName = filename.replace('.m3u8', '');
    let isProtected = filename === 'favourites.m3u8';
    let thumbnail = '';
    
    const tracks: Song[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
        if (line.startsWith('#EXTZETA:')) {
            try {
                const meta = JSON.parse(line.substring(9));
                displayName = meta.name || displayName;
                isProtected = meta.isProtected !== undefined ? meta.isProtected : isProtected;
                thumbnail = meta.thumbnail || '';
            } catch (e) { /* ignore */ }
        } else if (line.trim() && !line.startsWith('#')) {
            const songPath = line.trim().startsWith('.') 
                ? join(musicDir, line.trim()) 
                : line.trim();
                
            const song = getSongFromMp3(songPath);
            if (song) tracks.push(song);
        }
    }

    return {
        id: filename,
        name: displayName,
        tracks: tracks,
        createdAt: stat.birthtimeMs || stat.mtimeMs,
        isProtected,
        thumbnail: thumbnail || (tracks.length > 0 ? tracks[0].thumbnails?.at(0)?.url : undefined)
    };
}

export const routes = {
    async musicLyrics(track: Song): Promise<string | null> {
        log(`Looks like someone wants some lyrics! ${track.title}`);
        try {
            const res = await fetch(
                `https://lrclib.net/api/get?artist_name=${encodeURIComponent(track.artists.map(a=>a.name).join(', '))}&track_name=${encodeURIComponent(track.title)}&duration=${Math.round(track.duration)}`,
                { headers: { 'User-Agent': 'Zeta Music (https://github.com/zeta-zx/z3)' }, },
            );

            if (!res.ok) return null;
            
            const data = await res.json() as any;
            log(`We have lyrics! Let's return them. ${res} ${data}`);
            return data.syncedLyrics || data.plainLyrics || null;
        } catch (err) {
            console.error("LrcLib fetch failed:", err);
            return null;
        }
    },

    async musicSearchSuggestions(query: string): Promise<string[]> {
        await init();

        return (await yt.music.getSearchSuggestions(query))[0].contents.map((suggestion: any) => suggestion.suggestion.text);
    },

    async musicSearch(query: string, provider: MusicProvider): Promise<Song[]> {
        await init();

        const files = readdirSync(musicDir).filter(f => f.endsWith('.mp3'));
       
        switch (provider) {
            case 'yt': {
                const res = await yt.music.search(query, { type: 'song' });

                return (res.songs?.contents || []).map(song => {
                    const match = files.find(f => f.endsWith(`[yt_${song.id}].mp3`));
                    return {
                        id: match ? `fs:${match}` : `yt:${song.id}`,
                        title: song.title || 'Untitled',
                        thumbnails: song.thumbnails.map(t => ({
                            url: t.url,
                            width: t.width,
                            height: t.height,
                        })),
                        artists: (song.artists || []).map(a => ({
                            name: a.name,
                            thumbnails: [], // no thumbnails! unless we fetch from channel ID
                        })),
                        album: song.album ? {
                            title: song.album.name,
                            artists: [], // no artists either!
                            thumbnails: [], // or thumbnails
                        } : null,
                        duration: song.duration?.seconds || 0,
                        isDownloaded: !!match,
                    }
                });
            }

            case 'js': {
                const res = await Saavn.search({ query, limit: 30 });

                return (res.results.map(s => {
                    const match = files.find(f => f.endsWith(`[js_${s.id}].mp3`));
                    return {
                        id: match ? `fs:${match}` : `js:${s.id}`,
                        title: s.title || 'Untitled Song',
                        thumbnails: s.images.map(i => ({
                            url: i.url,
                            width: parseInt(i.resolution.split('x')[0]),
                            height: parseInt(i.resolution.split('x')[1]),
                        })),
                        artists: (s.artists && s.artists.all) ? s.artists.all.slice(0, 3).map(a => ({
                            name: a.name,
                            thumbnails: a.images.map(i => ({
                                url: i.url,
                                width: parseInt(i.resolution.split('x')[0]),
                                height: parseInt(i.resolution.split('x')[1]),
                            })),
                        })) : [],
                        album: s.album ? {
                            title: s.album.title || 'Untitled Album',
                            artists: [],
                            thumbnails: [],
                        } : null,
                        duration: s.duration || 0,
                        isDownloaded: !!match,
                    }
                }))
            }
        }

        throw new Error(`Provider '${provider}' not supported for searching.`)
    },

    async musicStream(id: string, encryptedJioSaavnUrl?: string): Promise<Stream> {
        await init();
        const [ protocol, ...rest ] = id.split(':');
        const cleanId = rest.join('');

        log(`Requested stream for ${id}`);
        log(` - That's '${protocol}' and ID '${cleanId}'.`);

        switch (protocol) {
            case 'fs': {
                const songPath = join(musicDir, cleanId);
                log(` - That's a filesystem path - ${songPath}`);

                if (!existsSync(songPath)) {
                    throw new Error(`Track ${cleanId} not found on disk`);
                }

                log(` - This file exists. Reading and returning...`);

                const buffer = readFileSync(songPath);
                return {
                    data: new Uint8Array(buffer),
                    mimetype: "audio/mp3"
                };
            }
            case 'yt': {
                log(` - That's a YouTube ID. Downloading audio with quality best...`);
                const stream = await yt.download(cleanId, {
                    type: 'audio',
                    quality: 'best',
                    client: 'ANDROID_VR',
                });

                log(` - We've got the stream.`);


                const streamObj: ReadStream = {
                    data: stream,
                    mimetype: 'audio/mp4',
                }

                log(` - Feeding this stream back to the downloadSong function.`);

                const fsSong = await routes.musicDownloadSong(undefined, id, streamObj)

                log(` - Download Song finished. Returning Stream object.`);
                log(` - Wait... I don't know how to do that.`);
                log(` - Eh... I'll just recurse and hope for the best LOL.`);
                log(` - Pretty sure musicDownloadSong returns an object with 'fs:' anyway. If it's not then we're doomed to recurse forever :P`)

                return routes.musicStream(fsSong.id);
            }
            case 'js': {
                log(` - That's a JioSaavn ID. Let's download it.`);

                if (!encryptedJioSaavnUrl) {
                    log(` - We weren't given the encrypted JioSaavn URL; let's go ahead and find it now.`);
                    const song = (await Saavn.getById({ songIds: cleanId })).songs?.[0];
                    if (!song) throw new Error(`JioSaavn Song not found for ID ${cleanId}.`);
                    encryptedJioSaavnUrl = song.media?.encryptedUrl;
                    if (!encryptedJioSaavnUrl) throw new Error(`No encrypted media URL found for the song!`);
                }

                log(` - Here's the encrypted URL: '${encryptedJioSaavnUrl}'`);

                const url = (await Saavn.experimental.fetchStreamUrls(encryptedJioSaavnUrl, 'edge', true)).toSorted(
                    (a, b) => (parseInt(a.bitrate) - parseInt(b.bitrate))
                ).at(-1);
                // seriously who the fuck vibecoded this library :(

                if (!url) throw new Error(`Failed to decrypt the media URL. And no, I don't know why.`);

                const res = await fetch(url.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
                const fsSong = await routes.musicDownloadSong(undefined, id, { mimetype: res.headers.get('Content-Type') || 'audio/mp4', data: res.body! });;

                return routes.musicStream(fsSong.id);
            }
        }

        throw new Error(`Track protocol for ID ${id} not supported by Zeta. Are you using a wrong version?`);
    },

    async musicLoadLibrary(): Promise<Library> {
        await init();
        const favPath = join(musicDir, 'favourites.m3u8');
        if (!existsSync(favPath)) {
            const header = `#EXTM3U\n#EXTZETA:${JSON.stringify({ name: 'Favourites', isProtected: true, thumbnail: '' })}\n`;
            writeFileSync(favPath, header, 'utf-8');
        }

        const files = readdirSync(musicDir, { withFileTypes: true });
        const playlists: Playlist[] = [];

        for (const file of files) {
            if (file.isFile() && file.name.endsWith('.m3u8')) {
                playlists.push(readPlaylistFile(file.name));
            }
        }

        return { playlists, path: musicDir };
    },

    async musicPlaylistCreate(name: string): Promise<Playlist> {
        await init();
        const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const filename = `${safeName}_${Date.now()}.m3u8`;
        const filePath = join(musicDir, filename);
        
        const header = `#EXTM3U\n#EXTZETA:${JSON.stringify({ name, isProtected: false, thumbnail: '' })}\n`;
        writeFileSync(filePath, header, 'utf-8');
        
        return readPlaylistFile(filename);
    },

    async musicDownloadSong(track?: Song, trackId?: string, stream?: ReadStream): Promise<Song> {
        await init();

        if (!track && !trackId) throw new Error("At least one of `track` or `trackId` must be given.");

        const id = track ? track.id : trackId!;

        const [ protocol, ...rest ] = id.split(':');
        const cleanId = rest.join('');

        log(`  -  - Downloading song: '${protocol}', '${cleanId}'`);

        let mp3Path: string;
        let ytMetadata: Awaited<ReturnType<Innertube["music"]["getInfo"]>> | undefined = undefined; // cuz i can't find TrackInfo type :P
        let jsMetadata: Awaited<ReturnType<typeof Saavn["search"]>>["results"][number] | undefined = undefined;

        let newTrack: Song;

        if (track) newTrack = track;
        else newTrack = {
            title: 'Untitled',
            thumbnails: [],
            artists: [],
            album: null,
            duration: 0,
            id,
            isDownloaded: true,
        };

        if (protocol === 'fs') {
            mp3Path = join(musicDir, cleanId);
        } else if (protocol === 'yt') {
            ytMetadata = await yt.music.getInfo(cleanId);
            newTrack.id = 'fs:' + (ytMetadata.basic_info ? `${ytMetadata.basic_info.title} | ${ytMetadata.basic_info.author ?? ytMetadata.basic_info.channel?.name}` : cleanId).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '') + `[${id.replaceAll(':', '_')}]` + '.mp3';
            mp3Path = join(musicDir, newTrack.id.replace('fs:', ''));
        } else if (protocol === 'js') {
            jsMetadata = (await Saavn.getById({ songIds: cleanId })).songs[0];
            newTrack.id = 'fs:' + (jsMetadata ? `${jsMetadata.title} ${jsMetadata.subtitle} | ${jsMetadata.artists?.primary?.[0].name}` : cleanId).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '') + `[${id.replaceAll(':', '_')}]` + '.mp3';
            mp3Path = join(musicDir, newTrack.id.replace('fs:', ''));
        } else {
            throw new Error("Unsupported ID protocol. Maybe you are using a wrong version.");
        }

        log(`  - - Okay, so the file path will be '${mp3Path}'.`);
        
        if (!existsSync(mp3Path)) {
            log(`  - - This file doesn't exist yet. Let's fetch the data. Are we already provided with a stream? ${!!stream ? 'Yes' : 'No'}.`);
            const data = stream ?? await routes.musicStream(id);
            log(`  - - Perfect, we've got the stream now. Let's check the mimetype... ${data.mimetype}`);
            if (data.mimetype === 'audio/mp4') {
                if (!(data.data instanceof ReadableStream)) throw new Error("We got an audio/mp4 for a stream that isn't a ReadableStream."); // We can fix this if we want. But I don't want to. I want to see if this even appears in the wild first.
                log(`  - - Alright, let's download this as mp3 from the stream data.`);
                await downloadAsMp3(data.data, mp3Path);
            } else {
                log(`  - - Amazing! It's already an mp3. Let's just write this to ${mp3Path} now, and that'll be that.`);
                if (data.data instanceof ReadableStream) throw new Error("It's the opposite! We got a (presumably) audio/mp3 stream for a ReadableStream! Shocking... anyway.."); // We can easily solve this too. But again, I'm a bit curious so I'll just leave it to fail loudly.
                writeFileSync(mp3Path, data.data);
            }
        }

        log(`  - - All done! Now let's just set some metadata...`);

        let tags: any;

        if (track) {
            tags = {
                title: track.title,
                artist: track.artists.map(a => a.name).join(', '),
                album: track.album?.title || '',
                year: track.year || '',
                userDefinedText: [
                    { description: "duration", value: track.duration.toString() }, // do we even need this? can we not just get duration by mp3 data? or that would be toooo slow
                ]
            };
        } else if (ytMetadata) {
            newTrack.title = ytMetadata.basic_info.title || 'Untitled';
            newTrack.artists = [{ name: ytMetadata.basic_info.author ?? ytMetadata.basic_info.channel?.name ?? "Unknown Artist", thumbnails: [] }];
            newTrack.duration = ytMetadata.basic_info.duration ?? 0;
            tags = {
                title: newTrack.title,
                artist: newTrack.artists[0].name,
                album: null,
                year: undefined,
                userDefinedText: [
                    { description: "duration", value: newTrack.duration.toString() },
                ]
            }
        } else if (jsMetadata) {
            newTrack.title = jsMetadata.title;
            newTrack.artists = jsMetadata.artists?.all?.splice(0, 3).map(a => ({
                name: a.name,
                thumbnails: a.images.map(i => ({
                    url: i.url,
                    width: parseInt(i.resolution.split('x')[0]),
                    height: parseInt(i.resolution.split('x')[1]),
                })),
            })) || [];
            newTrack.duration = jsMetadata.duration ?? 0;
            newTrack.album = jsMetadata.album ? {
                title: jsMetadata.album.title || 'Untitled Album',
                artists: [],
                thumbnails: [],
            } : null;
        }


        if (track?.lyrics) {
            tags.unsynchronisedLyrics = { language: 'eng', text: track.lyrics };
        }

        const possibleLyrics = ytMetadata ? (await ytMetadata?.getLyrics())?.description.text : jsMetadata?.lyrics?.snippet;
        if (possibleLyrics) {
            tags.unsynchronisedLyrics = { language: 'eng', text: possibleLyrics };
        }

        const firstThumb = track?.thumbnails?.at(0) ?? ytMetadata?.basic_info.thumbnail?.at(0) ?? jsMetadata?.images.at(-1);
        if (firstThumb) {
            if ('data' in firstThumb && firstThumb.data) {
                tags.image = {
                    mime: firstThumb.mimetype || 'image/jpeg',
                    type: { id: 3, name: 'front cover' },
                    imageBuffer: Buffer.from(firstThumb.data)
                };
                newTrack.thumbnails.push({
                    mimetype: firstThumb.mimetype,
                    data: firstThumb.data,
                })
            } else if (firstThumb.url) {
                try {
                    const res = await fetch(updateThumbnailUrl(firstThumb.url), { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
                    const data = await res.bytes();
                    const buffer = Buffer.from(data);

                    tags.image = {
                        mime: res.headers.get('Content-Type') || 'image/jpeg',
                        type: { id: 3, name: 'front cover' },
                        imageBuffer: buffer,
                    }
                    tags.userDefinedText.push({ description: 'thumbnailURL', value: updateThumbnailUrl(firstThumb.url) }); // for future use e.g. discord rpc
                    newTrack.thumbnails.push({
                        url: updateThumbnailUrl(firstThumb.url),
                        mimetype: res.headers.get('Content-Type') || 'image/jpeg',
                        data: buffer,
                    })
                } catch (err) { /* ignore invalid URLs */ }
            }
        }

        NodeID3.write(tags, mp3Path);

        log(`  - - Metadata set! It's been nice knowing you, bye!`);

        return newTrack;
    },

    async musicPlaylistAddTrack(playlistId: string, track?: Song, trackId?: string): Promise<void> {
        const song = await routes.musicDownloadSong(track, trackId);

        const playlistPath = join(musicDir, playlistId);
        if (!existsSync(playlistPath)) throw new Error("Playlist not found");
        
        const lines = readFileSync(playlistPath, 'utf-8').split('\n');
        const songLine = `./${song.id.replace('fs:', '')}`;
        
        if (!lines.some(l => l.trim() === songLine)) {
            appendFileSync(playlistPath, `${songLine}\n`, 'utf-8');
        }
    },

    async musicPlaylistRemoveTrack(playlistId: string, trackId: string): Promise<void> {
        await init();
        const filePath = join(musicDir, playlistId);
        if (!existsSync(filePath)) return;

        const playlist = readPlaylistFile(playlistId);
        playlist.tracks = playlist.tracks.filter(t => t.id !== trackId);

        const originalContent = readFileSync(filePath, 'utf-8');
        const headerLine = originalContent.split('\n').find(l => l.startsWith('#EXTZETA:')) || '';

        let content = `#EXTM3U\n${headerLine}\n`;
        for (const t of playlist.tracks) {
            content += `./${t.id.replace('fs:', '')}.mp3\n`; // songue :P i don't know if this is right
        }
        writeFileSync(filePath, content, 'utf-8');
    }
}