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
    /** Android serves audio from native files without copying it over the bridge. */
    url?: string;
    /** Original native file URI for Android's background player. */
    nativeUri?: string;
    mimetype: string;
    /** True when the bytes are backed by a file on disk (served or just saved). */
    savedToDisk?: boolean;
}

export interface Thumbnail {
    url?: string;
    data?: Uint8Array;
    mimetype?: string;
    width?: number;
    height?: number;
}

export interface Artist {
    id?: string;
    thumbnails: Thumbnail[];
    name: string;
    followers?: number;
    subtitle?: string;
}

export interface AlbumBase {
    id?: string;
    thumbnails: Thumbnail[];
    title: string;
    artists: Artist[];
    year?: string;
    subtitle?: string;
}

export interface Album {
    songs: Song[];
}

export type CollectionKind = "album" | "single" | "playlist";

export interface CollectionSummary {
    id: string;
    kind: CollectionKind;
    title: string;
    subtitle?: string;
    year?: string;
    thumbnails: Thumbnail[];
    artists: Artist[];
}

export interface CollectionDetails extends CollectionSummary {
    description?: string;
    tracks: Song[];
}

export interface ArtistDetails {
    id: string;
    name: string;
    subtitle?: string;
    description?: string;
    thumbnails: Thumbnail[];
    topSongs: Song[];
    albums: CollectionSummary[];
    singles: CollectionSummary[];
    playlists: CollectionSummary[];
    similarArtists: Artist[];
    hasMoreSongs?: boolean;
}

export interface SearchExtras {
    artists: Artist[];
    albums: CollectionSummary[];
    playlists: CollectionSummary[];
}

export interface VideoStreamInfo {
    videoId: string;
    videoUrl: string;
    audioUrl?: string;
    width: number;
    height: number;
    duration: number;
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
