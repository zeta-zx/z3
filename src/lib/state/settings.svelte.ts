import { browser } from "$app/environment";
import { client } from "$lib/ephaptic";
import { libraryState } from "$lib/state/library.svelte";
import { toasts } from "$lib/state/toast.svelte";

class SettingsStore {
    musicDir = $state<string>("");
    isRemote = $state<boolean>(false);
    loading = $state<boolean>(true);
    saving = $state<boolean>(false);

    constructor() {
        if (!browser) return;
        this.load();
    }

    async load() {
        this.loading = true;
        try {
            const { musicDir, isRemote } = await client.getSettings();
            this.musicDir = musicDir;
            this.isRemote = isRemote;
        } catch (err) {
            toasts.error(err);
        } finally {
            this.loading = false;
        }
    }

    /** Open the native folder picker (local dirs only). */
    async pickDirectory(): Promise<string | null> {
        try {
            return await client.pickMusicDirectory();
        } catch (err) {
            toasts.error(err);
            return null;
        }
    }

    /** Switch the music directory (local path or sftp://, ftp:// URL). */
    async setMusicDir(value: string): Promise<boolean> {
        const trimmed = value.trim();
        if (!trimmed) return false;

        this.saving = true;
        try {
            const { playlists, path } = await client.setMusicDir(trimmed);
            libraryState.playlists = playlists;
            libraryState.path = path;
            await this.load();
            toasts.success("Music directory updated.");
            return true;
        } catch (err) {
            toasts.error(err);
            return false;
        } finally {
            this.saving = false;
        }
    }

    busyMuzza = $state<false | "export" | "import">(false);

    /** Export the whole library to a Muzza-compatible `.backup` file. */
    async exportToMuzza() {
        if (this.busyMuzza) return;
        this.busyMuzza = "export";
        try {
            const result = await client.muzzaExport();
            if (!result) return; // cancelled
            toasts.success(
                `Exported ${result.songs} songs, ${result.playlists} playlists and ${result.liked} liked songs to Muzza.`,
            );
        } catch (err) {
            toasts.error(err);
        } finally {
            this.busyMuzza = false;
        }
    }

    /** Import a Muzza `.backup` file, merging it into the library. */
    async importFromMuzza() {
        if (this.busyMuzza) return;
        this.busyMuzza = "import";
        try {
            const result = await client.muzzaImport();
            if (!result) return; // cancelled
            await libraryState.refresh();
            toasts.success(
                `Imported ${result.songs} songs, ${result.playlists} playlists and ${result.liked} liked songs from Muzza.`,
            );
        } catch (err) {
            toasts.error(err);
        } finally {
            this.busyMuzza = false;
        }
    }
}

export const settingsState = new SettingsStore();
