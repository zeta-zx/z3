<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { settingsState } from "$lib/state/settings.svelte";

    let draft = $state("");
    let initialised = $state(false);

    // Seed the input once settings have loaded.
    $effect(() => {
        if (!initialised && !settingsState.loading) {
            draft = settingsState.musicDir;
            initialised = true;
        }
    });

    async function pick() {
        const dir = await settingsState.pickDirectory();
        if (dir) draft = dir;
    }

    async function save() {
        const ok = await settingsState.setMusicDir(draft);
        if (ok) draft = settingsState.musicDir;
    }

    const isDirty = $derived(draft.trim() !== settingsState.musicDir);
</script>

<section class="settings">
    <h2><Icon name="settings" /> Settings</h2>

    <article>
        <h4><Icon name="folder" /> Music directory</h4>
        <p>
            Where Zeta stores your downloaded songs and playlists. This can be a local folder or a
            remote location. Supported remotes:
        </p>
        <ul>
            <li><code>sftp://user:password@host:port/path</code></li>
            <li><code>ftp://user:password@host:port/path</code> (or <code>ftps://</code> for TLS)</li>
        </ul>

        <div class="dir-row">
            <input
                type="text"
                spellcheck="false"
                autocomplete="off"
                bind:value={draft}
                placeholder="/home/you/Music/Zeta or sftp://…"
                disabled={settingsState.loading || settingsState.saving}
            />
            <button class="secondary" onclick={pick} disabled={settingsState.saving} title="Browse for a local folder">
                <Icon name="folder-open" />
            </button>
            <button
                class="primary"
                onclick={save}
                disabled={!isDirty || settingsState.saving}
                aria-busy={settingsState.saving ? "true" : undefined}
            >
                <Icon name="save" /> Apply
            </button>
        </div>

        <small>
            Currently using
            <code>{settingsState.musicDir || "…"}</code>
            {#if settingsState.isRemote}<Icon name="cloud" /> remote{/if}
        </small>
    </article>

    <article>
        <h4><Icon name="arrow-right-left" /> Muzza interoperability</h4>
        <p>
            Transfer your library to and from
            <a href="https://github.com/Maloy-Android/Muzza" target="_blank" rel="noreferrer">Muzza</a>
            using its <code>.backup</code> format. Favourites map to Muzza's liked songs, and playlists
            are preserved. Imported songs are added without downloading — they stream on demand.
        </p>

        <div class="muzza-row">
            <button
                class="secondary"
                onclick={() => settingsState.exportToMuzza()}
                disabled={settingsState.busyMuzza !== false}
                aria-busy={settingsState.busyMuzza === "export" ? "true" : undefined}
            >
                <Icon name="upload" /> Export to Muzza
            </button>
            <button
                class="secondary"
                onclick={() => settingsState.importFromMuzza()}
                disabled={settingsState.busyMuzza !== false}
                aria-busy={settingsState.busyMuzza === "import" ? "true" : undefined}
            >
                <Icon name="download" /> Import from Muzza
            </button>
        </div>
    </article>
</section>

<style>
    .settings article {
        margin-top: 1rem;
    }
    .dir-row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        margin-bottom: 0.5rem;
    }
    .dir-row input {
        flex: 1;
        margin-bottom: 0;
    }
    .dir-row button {
        width: auto;
        margin-bottom: 0;
        white-space: nowrap;
    }
    .muzza-row {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
    }
    .muzza-row button {
        width: auto;
        margin-bottom: 0;
        white-space: nowrap;
    }
</style>
