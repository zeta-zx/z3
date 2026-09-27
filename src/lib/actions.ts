import { goto } from "$app/navigation";
import type { Playlist, Song } from "$lib/schema";
import { libraryState, FAVOURITES_ID } from "$lib/state/library.svelte";
import { addToQueue, playNext, playTrack, startRadio } from "$lib/state/player.svelte";
import { toasts } from "$lib/state/toast.svelte";
import { ui, type MenuItem } from "$lib/state/ui.svelte";

export function songUrl(track: Song): string | null {
    if (track.id.startsWith("yt:")) return `https://music.youtube.com/watch?v=${track.id.slice(3)}`;
    return null;
}

export async function createPlaylistWith(track?: Song) {
    const name = await ui.prompt("New playlist", { placeholder: "Give it a name", confirmLabel: "Create" });
    if (!name) return null;
    const playlist = await libraryState.createPlaylist(name);
    if (playlist && track) await libraryState.addToPlaylist(playlist.id, track);
    return playlist;
}

export async function radioFrom(track: Song) {
    const id = toasts.info(`Tuning in to “${track.title}” radio…`, 0);
    try {
        await startRadio(track);
    } catch (err) {
        toasts.error(err);
    } finally {
        toasts.dismiss(id);
    }
}

export function playlistSubmenu(track: Song): MenuItem[] {
    return [
        { label: "New playlist…", icon: "plus", action: () => createPlaylistWith(track) },
        { separator: true },
        ...libraryState.playlists.map((p) => ({
            label: p.name,
            icon: p.id === FAVOURITES_ID ? "heart" : "list-music",
            checked: libraryState.isInPlaylist(p.id, track.id),
            action: () => libraryState.toggleFromPlaylist(p.id, track),
        })),
    ];
}

/** The standard right-click menu for a track. */
export function trackMenu(track: Song, opts: { playlist?: Playlist | null; extra?: MenuItem[] } = {}): MenuItem[] {
    const fav = libraryState.isFavourite(track.id);
    const url = songUrl(track);
    const editable = opts.playlist && libraryState.playlists.some((p) => p.id === opts.playlist!.id);

    return [
        { label: "Play", icon: "play", action: () => playTrack(track) },
        { label: "Play next", icon: "list-start", action: () => { playNext(track); toasts.success("Playing next"); } },
        { label: "Add to queue", icon: "list-end", action: () => { addToQueue(track); toasts.success("Added to queue"); } },
        { label: "Start song radio", icon: "radio", action: () => radioFrom(track) },
        { separator: true },
        { label: fav ? "Remove from Favourites" : "Add to Favourites", icon: fav ? "heart-off" : "heart", action: () => libraryState.toggleFavourite(track) },
        { label: "Add to playlist", icon: "list-plus", submenu: playlistSubmenu(track) },
        ...(editable
            ? [{ label: "Remove from this playlist", icon: "trash-2", danger: true, action: () => libraryState.removeFromPlaylist(opts.playlist!.id, track.id) }]
            : []),
        ...(!track.isDownloaded ? [{ label: "Download", icon: "download", action: () => libraryState.download(track) }] : []),
        ...(url
            ? [
                  { separator: true },
                  { label: "Copy link", icon: "link", action: () => { navigator.clipboard.writeText(url); toasts.success("Link copied"); } },
              ]
            : []),
        ...(opts.extra?.length ? [{ separator: true }, ...opts.extra] : []),
    ];
}

export function openPlaylist(playlist: Playlist) {
    goto(`/music/playlist/${encodeURIComponent(playlist.id)}`);
}
