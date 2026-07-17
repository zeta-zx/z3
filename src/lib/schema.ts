export interface Song {
    title: string;
    thumbnails: Thumbnail[];
    artists: Artist[];
    album: AlbumBase | null;
    duration: number;
    year?: string;
    streams?: number;
    lyrics?: string | null; // if undefined then use another call to find them

    id: string;
    // Canonical source id:
    //   yt:<youtube_video_id>
    //   js:<jiosaavn_song_id>
    //   local:<filename>        (a file imported directly into the music dir)
    // `isDownloaded` (not the id) reflects whether the audio is stored on disk.

    isDownloaded: boolean;
}

export interface Stream {
    data: Uint8Array;
    mimetype: string;
}

export interface Thumbnail {
    url?: string;
    data?: Uint8Array;
    mimetype?: string;
    width?: number;
    height?: number;
}

export interface Artist {
    thumbnails: Thumbnail[];
    name: string;
    followers?: number;
}

export interface AlbumBase {
    thumbnails: Thumbnail[];
    title: string;
    artists: Artist[];
    year?: string;
}

export interface Album {
    songs: Song[];
}

export interface Playlist {
    id: string;
    name: string;
    tracks: Song[];
    createdAt: number;
    isProtected?: boolean;
    thumbnail?: string;
}

export interface Library {
    playlists: Playlist[];
    path: string;
}

export type MusicProvider = "yt" | "js" | "fs"