<script lang="ts">
    import { onMount } from "svelte";
    import { client } from "$lib/ephaptic";
    import { updates } from "$lib/state/updates.svelte";
    import AudioEffects from "$lib/components/AudioEffects.svelte";
    import PeerSettings from "$lib/components/PeerSettings.svelte";
    import LibraryMaintenance from "$lib/components/LibraryMaintenance.svelte";
    import Icon from "$lib/components/Icon.svelte";
    import { settingsState } from "$lib/state/settings.svelte";
    import { playerState, setAutoplay } from "$lib/state/player.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { VISUALIZER_PACKS } from "$lib/visualizer/packs";
    import { isAndroid } from '$lib/platform';
    import { libraryState } from '$lib/state/library.svelte';
    import { toasts } from '$lib/state/toast.svelte';
    import { androidPreferences } from '$lib/state/android.svelte';
    import ScrobblingSettings from '$lib/components/ScrobblingSettings.svelte';
    import AudioQualityPicker from '$lib/components/AudioQualityPicker.svelte';

    let browserProfiles = $state<Awaited<ReturnType<typeof client.listYoutubeBrowserProfiles>>>([]);
    let loadingBrowserProfiles = $state(true);

    const activeBrowserProfile = $derived(browserProfiles.find(({ id }) => id === settingsState.youtubeBrowserProfileId));

    async function refreshBrowserProfiles() {
        loadingBrowserProfiles = true;
        try {
            browserProfiles = await client.listYoutubeBrowserProfiles();
        } catch (error) {
            toasts.error(error);
        } finally {
            loadingBrowserProfiles = false;
        }
    }

    onMount(() => {
        if (!isAndroid) void refreshBrowserProfiles();
    });

    let includeBackupAudio = $state(true);
    let showDuplicates = $state(false);
    let importing = $state(false);
    async function importMusic() {
        importing = true;
        try {
            await (await import('$lib/android/client')).importAudio();
            await libraryState.refresh();
        } catch (error) { toasts.error(error); }
        finally { importing = false; }
    }

    let draft = $state("");
    let youtubePlaylistUrl = $state("");
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
        <h2><Icon name="download" /> Updates</h2>
        <div class="card block">
            <p class="muted" role="status">
                {#if updates.checking}Checking GitHub for updates…
                {:else if updates.status.message}{updates.status.message}
                {:else if updates.status.phase === 'downloading'}
                    Downloading Zeta {updates.status.version}{updates.status.progress == null ? '…' : ` · ${updates.status.progress}%`}
                {:else if updates.status.phase === 'ready'}Zeta {updates.status.version} is ready to install.
                {:else if updates.status.version}Zeta {updates.status.version} is available.
                {:else if updates.status.phase === 'current'}Zeta {updates.status.current} is up to date.
                {:else}Check GitHub for a newer version of Zeta.
                {/if}
            </p>
            <div class="btn-row">
                <button class="btn" disabled={updates.checking || updates.applying || updates.status.phase === 'downloading'}
                    onclick={() => updates.check()}>Check for updates</button>
                {#if ['available', 'ready', 'manual'].includes(updates.status.phase)}
                    <button class="btn btn-primary" onclick={() => updates.apply()} disabled={updates.checking || updates.applying}>
                        {updates.status.phase === 'ready' ? 'Restart and install'
                            : updates.status.phase === 'manual' ? 'Open GitHub release'
                            : isAndroid ? 'Install update' : 'Download update'}
                    </button>
                {/if}
            </div>
        </div>
    </section>

    {#if isAndroid}
    <section class="group">
        <h2><Icon name="smartphone" /> On this device</h2>
        <div class="card block">
            <p class="muted">Downloads and songs played from your playlists are saved on this phone for offline listening. Import your own audio files to add them to Downloads in your library.</p>
            <button class="btn" onclick={importMusic} disabled={importing}>
                <Icon name="folder-open" /> {importing ? 'Importing…' : 'Import audio files'}
            </button>
            <small class="subtle">App storage is removed when you uninstall Zeta.</small>
        </div>
    </section>
    <section class="group">
        <h2><Icon name="smartphone" /> Android</h2>
        <div class="card rows">
            <div class="row">
                <div><strong>Haptic feedback</strong><p>A subtle vibration when you tap controls.</p></div>
                <button class="switch" role="switch" aria-label="Haptic feedback" aria-checked={androidPreferences.haptics}
                    onclick={() => { androidPreferences.haptics = !androidPreferences.haptics; androidPreferences.save(); }}></button>
            </div>
            <div class="row">
                <div><strong>Keep screen awake</strong><p>Keep the display on while music plays. Uses more battery.</p></div>
                <button class="switch" role="switch" aria-label="Keep screen awake" aria-checked={androidPreferences.keepAwake}
                    onclick={() => { androidPreferences.keepAwake = !androidPreferences.keepAwake; androidPreferences.save(); }}></button>
            </div>
            <div class="row">
                <div><strong>Home-screen widget theme</strong><p>Color the widget from the current track’s artwork or your Android Material You wallpaper palette.</p></div>
                <div class="segmented">
                    <button
                        aria-pressed={androidPreferences.widgetTheme === 'artwork'}
                        onclick={() => { androidPreferences.widgetTheme = 'artwork'; androidPreferences.save(); }}
                    >Track artwork</button>
                    <button
                        aria-pressed={androidPreferences.widgetTheme === 'material'}
                        onclick={() => { androidPreferences.widgetTheme = 'material'; androidPreferences.save(); }}
                    >Material You</button>
                </div>
            </div>
        </div>
    </section>
    {/if}

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
            <div class="row">
                <div>
                    <strong>Prefer local search results</strong>
                    <p>Play a matching song from your downloaded library when you select a search result.</p>
                </div>
                <button
                    class="switch"
                    role="switch"
                    aria-label="Prefer local search results"
                    aria-checked={settingsState.preferLocalSearchResults}
                    onclick={() => settingsState.setPreferLocalSearchResults(!settingsState.preferLocalSearchResults)}
                ></button>
            </div>
            {#if !isAndroid}
            <div class="row">
                <div>
                    <strong>Discord Rich Presence</strong>
                    <p>Show the song and artist you’re playing in your Discord profile.</p>
                </div>
                <button
                    class="switch"
                    role="switch"
                    aria-label="Discord Rich Presence"
                    aria-checked={settingsState.discordRpcEnabled}
                    disabled={settingsState.loading}
                    onclick={() => settingsState.setDiscordRpcEnabled(!settingsState.discordRpcEnabled)}
                ></button>
            </div>
            {/if}
        </div>
    </section>

    {#if !isAndroid}
    <section class="group">
        <h2><Icon name="play" /> YouTube</h2>
        <div class="card block">
            <div class="yt-head">
                <p class="muted">Import YouTube cookies from a detected browser profile or choose a Netscape <code>cookies.txt</code> file for playback and downloads.</p>
                <button class="btn" disabled={loadingBrowserProfiles} onclick={refreshBrowserProfiles}>
                    <Icon name="refresh-cw" /> Refresh browsers
                </button>
            </div>

            {#if loadingBrowserProfiles}
                <p class="subtle" role="status">Scanning installed browsers for YouTube sessions…</p>
            {:else if !browserProfiles.length}
                <p class="subtle" role="status">No browser profiles with cookies were detected on this computer.</p>
            {:else}
                <div class="browser-list" role="list" aria-label="Detected browser profiles">
                    {#each browserProfiles as profile (profile.id)}
                        {@const isActive = settingsState.youtubeBrowserProfileId === profile.id}
                        <div class="browser-item" class:disabled={!profile.youtubeLoggedIn} class:active={isActive} role="listitem">
                            <div class="browser-meta">
                                <span class="browser-eyebrow">
                                    {#if profile.youtubeLoggedIn}
                                        {profile.email ?? 'Signed in to YouTube'}
                                    {:else}
                                        Cookies found · YouTube not logged in
                                    {/if}
                                </span>
                                <strong>{profile.browser} · {profile.name}</strong>
                            </div>
                            <button
                                class="btn"
                                class:btn-primary={profile.youtubeLoggedIn && !isActive}
                                disabled={!profile.youtubeLoggedIn || isActive || settingsState.loading || settingsState.updatingYoutubeCookies}
                                onclick={() => settingsState.useYoutubeBrowserProfile(profile.id)}
                            >
                                {#if isActive}
                                    <Icon name="check" /> Imported
                                {:else if profile.youtubeLoggedIn}
                                    Import cookies
                                {:else}
                                    Not signed in
                                {/if}
                            </button>
                        </div>
                    {/each}
                </div>
            {/if}

            {#if settingsState.youtubeBrowserProfileId}
                <small class="subtle" role="status">
                    {activeBrowserProfile
                        ? `Active browser cookies: ${activeBrowserProfile.browser} · ${activeBrowserProfile.name}${activeBrowserProfile.email ? ` (${activeBrowserProfile.email})` : ''}`
                        : loadingBrowserProfiles ? 'Checking saved browser profile…' : 'Saved browser profile is unavailable.'}
                </small>
            {:else if settingsState.youtubeCookiesConfigured}
                <small class="subtle" role="status">Using a manual Netscape cookies.txt file.</small>
            {/if}

            <div class="yt-manual">
                <div>
                    <strong>Manual Netscape cookies.txt</strong>
                    <p class="subtle">Alternatively, import an exported Netscape-format <code>cookies.txt</code> file.</p>
                </div>
                <div class="btn-row">
                    <button class="btn" disabled={settingsState.loading || settingsState.updatingYoutubeCookies}
                        onclick={() => settingsState.updateYoutubeCookies()}>
                        <Icon name="folder-open" /> Import cookies.txt
                    </button>
                    {#if settingsState.youtubeCookiesConfigured}
                        <button class="btn" disabled={settingsState.loading || settingsState.updatingYoutubeCookies}
                            onclick={() => settingsState.updateYoutubeCookies(true)}>Clear cookie source</button>
                    {/if}
                </div>
            </div>
        </div>
    </section>
    {/if}

    <section class="group">
        <h2><Icon name="download" /> Audio quality</h2>
        <div class="card rows">
            <div class="row">
                <div>
                    <strong>Streaming quality</strong>
                    <p>Quality used when playing music from online providers.</p>
                </div>
                <AudioQualityPicker
                    label="Streaming quality"
                    value={settingsState.streamingQuality}
                    onchange={(quality) => settingsState.setStreamingQuality(quality)}
                />
            </div>
            <div class="row">
                <div>
                    <strong>Download quality</strong>
                    <p>Quality used when saving music for offline listening.</p>
                </div>
                <AudioQualityPicker
                    label="Download quality"
                    value={settingsState.downloadQuality}
                    onchange={(quality) => settingsState.setDownloadQuality(quality)}
                />
            </div>
        </div>
    </section>

    <section class="group">
        <h2><Icon name="sparkles" /> Appearance</h2>
        <div class="card rows">
            <div class="row">
                <div>
                    <strong>Lite mode</strong>
                    <p>For slower PCs. Turns off the living background, liquid glass, visualizers and animations.</p>
                </div>
                <button
                    class="switch"
                    role="switch"
                    aria-label="Lite mode"
                    aria-checked={ui.lite}
                    onclick={() => {
                        ui.lite = !ui.lite;
                        ui.save();
                    }}
                ></button>
            </div>
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
                    <strong>Liquid glass</strong>
                    <p>Refracting glass for the dock, player and panels. Turn off for plain frosted glass.</p>
                </div>
                <button
                    class="switch"
                    role="switch"
                    aria-label="Liquid glass"
                    aria-checked={ui.liquidGlass}
                    onclick={() => {
                        ui.liquidGlass = !ui.liquidGlass;
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

    <ScrobblingSettings />

    {#if !isAndroid}
    <section class="group">
        <h2><Icon name="folder" /> Music folder</h2>
        <div class="card block">
            <p class="muted">
                Where Zeta stores your songs and playlists — plain <code>.m4a</code> files and <code>.m3u8</code> playlists that
                any player can open. Local folders and remote storage are supported:
                <code>sftp://user:pass@host:port/path</code>, <code>ftp://…</code> or <code>ftps://…</code>.
            </p>
            <p class="muted">Import an <code>.m3u</code> or <code>.m3u8</code> playlist. Referenced local audio is copied into this music folder when it is not already there.</p>
            <div class="btn-row">
                <button class="btn" onclick={() => settingsState.importM3uPlaylist()} disabled={settingsState.busyM3u}>
                    {#if settingsState.busyM3u}<span class="spin"><Icon name="loader-circle" /></span>{:else}<Icon name="list-music" />{/if}
                    Import M3U playlist
                </button>
                <button
                    class="btn"
                    onclick={() => settingsState.importSpotifyPlaylist()}
                    disabled={settingsState.busyOnlinePlaylist !== false}
                >
                    {#if settingsState.busyOnlinePlaylist === "spotify"}<span class="spin"><Icon name="loader-circle" /></span>{:else}<Icon name="list-music" />{/if}
                    Import Spotify CSV
                </button>
            </div>
            <p class="muted">
                Export a playlist CSV from <a href="https://exportify.net/" target="_blank" rel="noreferrer">Exportify</a>.
                Spotify tracks are matched to playable YouTube Music versions. You can also import a public YouTube playlist:
            </p>
            <div class="dir-row">
                <input
                    class="input"
                    type="url"
                    spellcheck="false"
                    autocomplete="off"
                    bind:value={youtubePlaylistUrl}
                    placeholder="https://www.youtube.com/playlist?list=..."
                />
                <button
                    class="btn"
                    onclick={() => settingsState.importYoutubePlaylist(youtubePlaylistUrl)}
                    disabled={!youtubePlaylistUrl.trim() || settingsState.busyOnlinePlaylist !== false}
                >
                    {#if settingsState.busyOnlinePlaylist === "youtube"}<span class="spin"><Icon name="loader-circle" /></span>{:else}<Icon name="list-music" />{/if}
                    Import YouTube playlist
                </button>
            </div>
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

    {/if}

    <section class="group">
        <h2><Icon name="sliders-horizontal" /> Sound</h2>
        <AudioEffects />
    </section>
    <section class="group">
        <h2><Icon name="library" /> Library maintenance</h2>
        <LibraryMaintenance bind:showDuplicates />
    </section>
    <section class="group"><PeerSettings includeAudio={includeBackupAudio} /></section>

    <section class="group">
        <h2><Icon name="folder" /> Zeta backup</h2>
        <div class="card block">
            <p class="muted">Transfer your library, playlists, favourites, and listening history between desktop and Android. Import adds to your library.</p>
            <label class="muted">
                <input type="checkbox" bind:checked={includeBackupAudio} disabled={settingsState.busyZetaBackup} />
                Include downloaded audio (512 MiB backup limit)
            </label>
            <div class="btn-row">
                <button class="btn" disabled={settingsState.busyZetaBackup || settingsState.busyMuzza !== false}
                    onclick={() => settingsState.transferZetaBackup('export', includeBackupAudio)}>
                    <Icon name="upload" /> Save Zeta backup
                </button>
                <button class="btn" disabled={settingsState.busyZetaBackup || settingsState.busyMuzza !== false}
                    onclick={() => settingsState.transferZetaBackup('import')}>
                    <Icon name="download" /> Import Zeta backup
                </button>
                {#if settingsState.backupDuplicateCount}
                    <button class="btn" onclick={() => {
                        showDuplicates = true;
                        document.getElementById('duplicate-review')?.scrollIntoView();
                    }}>Review possible duplicates ({settingsState.backupDuplicateCount})</button>
                {/if}
            </div>
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
                <button class="btn" onclick={() => settingsState.exportToMuzza()} disabled={settingsState.busyMuzza !== false || settingsState.busyZetaBackup}>
                    {#if settingsState.busyMuzza === "export"}<span class="spin"><Icon name="loader-circle" /></span>{:else}<Icon name="upload" />{/if}
                    Export to Muzza
                </button>
                <button class="btn" onclick={() => settingsState.importFromMuzza()} disabled={settingsState.busyMuzza !== false || settingsState.busyZetaBackup}>
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
    .yt-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
    }
    .yt-head p {
        flex: 1;
        min-width: 240px;
    }
    .browser-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .browser-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 12px 14px;
        border-radius: var(--r-md);
        background: rgb(255 255 255 / 0.04);
        border: 1px solid var(--border);
        transition: opacity 0.2s, border-color 0.2s, background 0.2s;
    }
    .browser-item.active {
        border-color: color-mix(in srgb, var(--accent) 55%, transparent);
        background: color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .browser-item.disabled {
        opacity: 0.45;
        filter: grayscale(0.85);
    }
    .browser-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }
    .browser-eyebrow {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--accent);
    }
    .browser-item.disabled .browser-eyebrow {
        color: var(--text-3);
    }
    .yt-manual {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        padding-top: 12px;
        border-top: 1px solid var(--border);
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
