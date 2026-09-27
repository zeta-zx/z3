<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { settingsState } from "$lib/state/settings.svelte";
    import { playerState, setAutoplay } from "$lib/state/player.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { VISUALIZER_PACKS } from "$lib/visualizer/packs";

    let draft = $state("");
    let initialised = $state(false);

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

<div class="page narrow">
    <header class="head">
        <h1 class="page-title">Settings</h1>
    </header>

    <section class="group">
        <h2><Icon name="play" /> Playback</h2>
        <div class="card rows">
            <div class="row">
                <div>
                    <strong>Autoplay</strong>
                    <p>When your music ends, keep playing similar songs.</p>
                </div>
                <button class="switch" role="switch" aria-label="Autoplay" aria-checked={playerState.autoplay} onclick={() => setAutoplay(!playerState.autoplay)}></button>
            </div>
        </div>
    </section>

    <section class="group">
        <h2><Icon name="sparkles" /> Appearance</h2>
        <div class="card rows">
            <div class="row">
                <div>
                    <strong>Living background</strong>
                    <p>Let the current album art flow behind the whole app. Turn off to save battery.</p>
                </div>
                <button
                    class="switch"
                    role="switch"
                    aria-label="Living background"
                    aria-checked={ui.ambient}
                    onclick={() => {
                        ui.ambient = !ui.ambient;
                        ui.save();
                    }}
                ></button>
            </div>
            <div class="row">
                <div>
                    <strong>Visualizer</strong>
                    <p>Which visualizer opens in the full-screen player.</p>
                </div>
                <div class="segmented">
                    {#each VISUALIZER_PACKS as p}
                        <button
                            aria-pressed={ui.visualizerPack === p.id}
                            onclick={() => {
                                ui.visualizerPack = p.id;
                                ui.save();
                            }}>{p.name}</button
                        >
                    {/each}
                </div>
            </div>
            <div class="row">
                <div>
                    <strong>Keyboard shortcuts</strong>
                    <p>Control everything without the mouse. Press <kbd>?</kbd> anywhere.</p>
                </div>
                <button class="btn" onclick={() => (ui.shortcutsOpen = true)}><Icon name="keyboard" /> Show</button>
            </div>
        </div>
    </section>

    <section class="group">
        <h2><Icon name="folder" /> Music folder</h2>
        <div class="card block">
            <p class="muted">
                Where Zeta stores your songs and playlists — plain <code>.m4a</code> files and <code>.m3u8</code> playlists that
                any player can open. Local folders and remote storage are supported:
                <code>sftp://user:pass@host:port/path</code>, <code>ftp://…</code> or <code>ftps://…</code>.
            </p>
            <div class="dir-row">
                <input
                    class="input"
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    bind:value={draft}
                    placeholder="/home/you/Music/Zeta or sftp://…"
                    disabled={settingsState.loading || settingsState.saving}
                />
                <button class="btn" onclick={pick} disabled={settingsState.saving} title="Browse for a local folder">
                    <Icon name="folder-open" /> Browse
                </button>
                <button class="btn btn-primary" onclick={save} disabled={!isDirty || settingsState.saving}>
                    {#if settingsState.saving}<span class="spin"><Icon name="loader-circle" /></span>{:else}<Icon name="check" />{/if}
                    Apply
                </button>
            </div>
            <small class="subtle current">
                Using <code>{settingsState.musicDir || "…"}</code>
                {#if settingsState.isRemote}<span class="badge"><Icon name="cloud" /> Remote</span>{/if}
            </small>
        </div>
    </section>

    <section class="group">
        <h2><Icon name="arrow-right-left" /> Muzza</h2>
        <div class="card block">
            <p class="muted">
                Move your library to and from <a href="https://github.com/Maloy-Android/Muzza" target="_blank" rel="noreferrer">Muzza</a>
                using its <code>.backup</code> format. Favourites become liked songs and playlists carry over. Imported songs stream
                on demand and download the first time you play them.
            </p>
            <div class="btn-row">
                <button class="btn" onclick={() => settingsState.exportToMuzza()} disabled={settingsState.busyMuzza !== false}>
                    {#if settingsState.busyMuzza === "export"}<span class="spin"><Icon name="loader-circle" /></span>{:else}<Icon name="upload" />{/if}
                    Export to Muzza
                </button>
                <button class="btn" onclick={() => settingsState.importFromMuzza()} disabled={settingsState.busyMuzza !== false}>
                    {#if settingsState.busyMuzza === "import"}<span class="spin"><Icon name="loader-circle" /></span>{:else}<Icon name="download" />{/if}
                    Import from Muzza
                </button>
            </div>
        </div>
    </section>
</div>

<style>
    .narrow {
        max-width: 860px;
    }
    .head {
        padding: 20px 0 10px;
    }
    .group {
        margin-top: 26px;
    }
    .group h2 {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 15px;
        font-weight: 700;
        color: var(--text-2);
        margin: 0 0 10px 4px;
    }
    .group h2 :global(svg) {
        width: 17px;
        height: 17px;
    }
    .rows {
        padding: 4px 0;
    }
    .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 24px;
        padding: 14px 20px;
    }
    .row + .row {
        border-top: 1px solid var(--border);
    }
    .row strong {
        font-weight: 650;
    }
    .row p {
        color: var(--text-3);
        font-size: 13px;
        margin-top: 2px;
    }
    .block {
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 14px;
    }
    .block p {
        line-height: 1.6;
    }
    .block a {
        color: var(--accent);
    }
    .dir-row {
        display: flex;
        gap: 8px;
    }
    .dir-row .input {
        flex: 1;
    }
    .dir-row .btn {
        height: 42px;
    }
    .current {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .btn-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
    }
    .spin {
        display: inline-grid;
    }
    kbd {
        padding: 1px 6px;
        border-radius: 5px;
        background: var(--surface-3);
        border: 1px solid var(--border-strong);
        font: 600 11.5px var(--font);
    }
</style>
