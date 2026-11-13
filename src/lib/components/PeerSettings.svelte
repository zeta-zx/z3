<script lang="ts">
    import { onMount } from 'svelte';
    import QRCode from 'qrcode';
    import jsQR from 'jsqr';
    import { peers } from '$lib/state/peers.svelte';
    import { wayship } from '$lib/state/wayship.svelte';
    import { toasts } from '$lib/state/toast.svelte';
    import { client } from '$lib/ephaptic';
    import type { Song } from '$lib/schema';

    let { includeAudio }: { includeAudio: boolean } = $props();
    let code = $state('');
    let wayshipTokenInput = $state('');
    let qr = $state('');
    let qrTooLarge = $state(false);
    let camera = $state<MediaStream | null>(null);
    let video = $state<HTMLVideoElement>();
    let openingCamera = $state(false);
    let joining = $state(false);
    let cameraRequest = 0;
    let query = $state('');
    let results = $state<Song[]>([]);
    const guest = $derived(peers.links.find((link) => !link.host && link.connected && link.mode !== 'backup'));

    $effect(() => {
        const pairing = peers.pending?.code;
        let cancelled = false;
        qr = '';
        qrTooLarge = false;
        if (pairing) void QRCode.toDataURL(pairing, { errorCorrectionLevel: 'M', scale: 6, margin: 5 })
            .catch(() => QRCode.toDataURL(pairing, { errorCorrectionLevel: 'L', scale: 6, margin: 5 }))
            .then((value) => { if (!cancelled) qr = value; }).catch(() => { if (!cancelled) qrTooLarge = true; });
        return () => { cancelled = true; };
    });

    function stopCamera() {
        cameraRequest++;
        openingCamera = false;
        camera?.getTracks().forEach((track) => track.stop());
        camera = null;
    }

    onMount(() => stopCamera);

    async function run(work: () => Promise<unknown>) {
        try { await work(); }
        catch (error) { toasts.error(error); }
    }

    async function useCode(value: string) {
        if (joining || !value.trim()) return;
        joining = true;
        stopCamera();
        try {
            await peers.join(value.replace(/\s/g, ''));
            code = '';
        } finally { joining = false; }
    }

    function invite(mode: 'backup' | 'remote' | 'party') {
        stopCamera();
        return run(() => peers.invite(mode, includeAudio));
    }

    async function scan() {
        const request = ++cameraRequest;
        openingCamera = true;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false,
            });
            if (request === cameraRequest) camera = stream;
            else stream.getTracks().forEach((track) => track.stop());
        } catch (error) {
            if (request === cameraRequest) throw error;
        } finally {
            if (request === cameraRequest) openingCamera = false;
        }
    }

    function readQr(ctx: CanvasRenderingContext2D, source: CanvasImageSource,
        width: number, height: number, crop: number, resolution: number) {
        const square = Math.round(Math.min(width, height) * crop);
        const w = crop ? square : width;
        const h = crop ? square : height;
        const scale = Math.min(1, resolution / Math.max(w, h));
        const outWidth = Math.max(1, Math.round(w * scale));
        const outHeight = Math.max(1, Math.round(h * scale));
        const canvas = ctx.canvas;
        if (canvas.width !== outWidth || canvas.height !== outHeight) {
            canvas.width = outWidth;
            canvas.height = outHeight;
        }
        ctx.drawImage(source, (width - w) / 2, (height - h) / 2, w, h, 0, 0, outWidth, outHeight);
        const { data } = ctx.getImageData(0, 0, outWidth, outHeight);
        const match = jsQR(data, outWidth, outHeight, { inversionAttempts: 'dontInvert' });
        return match?.data.startsWith('zeta-peer:') ? match.data : undefined;
    }

    async function scanImage(file: File) {
        const image = await createImageBitmap(file);
        try {
            const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error('Could not read this image.');
            const match = readQr(ctx, image, image.width, image.height, 0, 1600)
                ?? readQr(ctx, image, image.width, image.height, 0.82, 1200)
                ?? readQr(ctx, image, image.width, image.height, 0, 1000);
            if (!match) throw new Error('No Zeta pairing QR found in this image.');
            await useCode(match);
        } finally { image.close(); }
    }

    $effect(() => {
        const stream = camera;
        const element = video;
        if (!stream || !element) return;
        element.srcObject = stream;
        const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        let frameId: number;
        let last = 0;
        let attempt = 0;
        // Try native detail in the center as well as the full frame at two scales.
        const views = [[0.8, 1200], [0, 1280], [0, 900], [0.6, 960]];
        function frame(now: number) {
            if (element && ctx && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && now - last >= 150) {
                last = now;
                const [crop, resolution] = views[attempt++ % views.length];
                const match = readQr(ctx, element, element.videoWidth, element.videoHeight, crop, resolution);
                if (match) {
                    void run(() => useCode(match));
                    return;
                }
            }
            frameId = requestAnimationFrame(frame);
        }
        frameId = requestAnimationFrame(frame);
        return () => {
            cancelAnimationFrame(frameId);
            element.srcObject = null;
        };
    });

    async function search() {
        if (query.trim()) results = (await client.musicSearch(query.trim(), 'yt')).slice(0, 10);
    }
</script>

<section class="card peer">
    <div class="wayship-box">
        <div class="wayship-head">
            <div>
                <span class="wayship-eyebrow">Wayship P2P Cloud Mesh</span>
                <h2>Connect with Wayship</h2>
                <p class="muted">
                    Sign in on your desktop and phone to automatically discover your devices and sync listening stats, playlists, and favourites anywhere—even across different networks.
                </p>
            </div>
            {#if wayship.connected}
                <button class="btn" onclick={() => wayship.disconnect()}>Disconnect</button>
            {:else}
                <button class="btn btn-primary" disabled={wayship.connecting} onclick={() => wayship.signInWithBrowser()}>
                    {wayship.connecting ? 'Waiting for Wayship…' : 'Connect with Wayship'}
                </button>
            {/if}
        </div>

        {#if wayship.connected}
            <div class="wayship-status">
                <span class="pulse-dot" aria-hidden="true"></span>
                <span>
                    Connected as <strong>{wayship.displayName || wayship.handle}</strong>
                    {#if wayship.handle}<small class="muted">(@{wayship.handle})</small>{/if}
                    · <small class="muted">{wayship.deviceName}</small>
                </span>
                <button class="btn" onclick={() => run(() => wayship.announce())}>Refresh peers</button>
            </div>

            {#if wayship.onlinePeers.length}
                <div class="wayship-peers" role="list" aria-label="Online Wayship devices">
                    {#each wayship.onlinePeers as wp (wp.peer_id)}
                        {@const linked = peers.links.find((l) => l.wayshipPeerId === wp.peer_id && l.connected)}
                        <div class="wayship-peer" role="listitem">
                            <div class="wayship-peer-info">
                                <span class="pulse-dot" aria-hidden="true"></span>
                                <strong>{wp.device_name || 'Zeta device'}</strong>
                                <small class="muted">{linked ? `Connected (${linked.mode})` : 'Online on Wayship'}</small>
                            </div>
                            <button class="btn btn-primary" disabled={!!linked} onclick={() => run(() => wayship.connectPeer(wp.peer_id, 'remote'))}>
                                {linked ? 'Connected' : 'Connect'}
                            </button>
                        </div>
                    {/each}
                </div>
            {:else}
                    <p class="muted">No other Zeta devices are online on your Wayship account right now. Open Zeta and connect Wayship on another device, then it will appear here.</p>
            {/if}
        {:else}
            <details class="invitation">
                <summary>Already have a Wayship token?</summary>
                <form onsubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                    await wayship.useToken(wayshipTokenInput);
                    wayshipTokenInput = '';
                });
            }}>
                <label for="wayship-token">Or paste a Wayship app token (<code>wsa_…</code>)</label>
                <div class="code-row">
                    <input class="input" id="wayship-token" type="password" bind:value={wayshipTokenInput}
                        placeholder="wsa_…" spellcheck={false} autocomplete="off" autocapitalize="off" />
                    <button class="btn" type="submit" disabled={!wayshipTokenInput.trim()}>Save token</button>
                </div>
                </form>
            </details>
        {/if}
    </div>

    <hr class="peer-divider" />

    <h2>Nearby devices</h2>
    <p class="muted">Use this when both devices are on the same Wi-Fi network. Connect once, then Zeta syncs playback and library data.</p>
    <div class="buttons">
        <button class="btn btn-primary" disabled={!!peers.pending || peers.busy || joining} onclick={() => invite('remote')}>
            Connect nearby device
        </button>
    </div>
    {#if peers.pending}
        <p role="status">
            {peers.pending.host
                ? 'Searching for other Zeta devices… Tap Pair on your other device, or scan this QR code.'
                : 'Connecting to the host…'}
        </p>
        {#if qr}<img src={qr} alt="Pairing invitation QR code" />{/if}
        {#if qrTooLarge}<p class="muted">Use Copy code if this connection is too large for a QR code.</p>{/if}
        <div class="buttons">
            {#if peers.pending.code}
                <button class="btn" onclick={() => run(() => navigator.clipboard.writeText(peers.pending!.code!))}>Copy code</button>
            {/if}
            <button class="btn" onclick={() => peers.disconnect(peers.pending!.id)}>Cancel pairing</button>
        </div>
    {/if}
    {#if !peers.pending && !joining}
        <details class="invitation">
        <summary>Use a QR code or invitation code</summary>
        <form onsubmit={(event) => { event.preventDefault(); void run(() => useCode(code)); }}>
            <label for="peer-code">Invitation code</label>
            <div class="code-row">
                <input class="input" id="peer-code" type="text" bind:value={code} placeholder="Paste invitation code"
                    spellcheck={false} autocomplete="off" autocapitalize="off" />
                <button class="btn" type="submit" disabled={!code.trim() || peers.busy}>Join</button>
            </div>
        </form>
        <div class="buttons">
            <button class="btn" onclick={() => camera || openingCamera ? stopCamera() : run(scan)}>
                {camera ? 'Close camera' : openingCamera ? 'Cancel camera' : 'Scan QR'}
            </button>
            <label class="btn qr-image">
                Open QR image
                <input type="file" accept="image/*" aria-label="Open QR image" onchange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (file) void run(() => scanImage(file));
                }} />
            </label>
        </div>
        </details>
    {:else if joining && !peers.pending}
        <p role="status">Connecting to the host…</p>
    {/if}
    {#if camera}
        <div class="scanner">
            <video bind:this={video} autoplay muted playsinline aria-label="QR scanner"></video>
            <div class="viewfinder" aria-hidden="true"></div>
        </div>
        <p class="muted">Fit the whole QR code inside the frame and hold steady.</p>
    {/if}
    {#if peers.progress !== null}<progress aria-label="Backup transfer" value={peers.progress} max="1"></progress>{/if}
    {#each peers.links.filter((link) => link.connected) as link (link.id)}
        <div class="buttons">
            <span>{link.mode === 'party' ? 'Listening party' : link.mode === 'backup' ? 'Backup transfer' : 'Remote control'}</span>
            {#if link.mode === 'backup' && link.host}
                <button class="btn" disabled={peers.progress !== null} onclick={() => run(() => peers.sendBackup(link.id))}>Send backup again</button>
            {:else}
                <button class="btn" disabled={peers.progress !== null} onclick={() => run(() => peers.syncLibrary(link.id, true))}>Sync stats &amp; library</button>
            {/if}
            <button class="btn" onclick={() => peers.disconnect(link.id)}>Disconnect</button>
        </div>
    {/each}
    {#if peers.links.some((link) => link.connected && link.host && link.mode === 'party')}
        <label><input type="checkbox" bind:checked={peers.partyControls} /> Let guests control playback</label>
    {/if}
    {#if guest}
        <p>{peers.remote?.song?.title ?? 'Waiting for the host to play a song'}</p>
        <div class="buttons">
            <button class="btn" onclick={() => peers.command('previous')}>Previous</button>
            <button class="btn" onclick={() => peers.command('toggle')}>{peers.remote?.paused ? 'Play' : 'Pause'}</button>
            <button class="btn" onclick={() => peers.command('next')}>Next</button>
        </div>
        {#if peers.remote?.duration}
            <label>Seek <input type="range" min="0" max={peers.remote.duration} value={peers.remote.position}
                onchange={(event) => peers.command('seek', Number(event.currentTarget.value))} /></label>
        {/if}
        <label>Volume <input type="range" min="0" max="1" step="0.01" onchange={(event) => peers.command('volume', Number(event.currentTarget.value))} /></label>
        {#if guest.mode === 'party'}
            <label><input type="checkbox" bind:checked={peers.following} /> Play along on this device</label>
            <form class="buttons" onsubmit={(event) => { event.preventDefault(); void run(search); }}>
                <input class="input" aria-label="Find a song for the party" bind:value={query} />
                <button class="btn" type="submit">Search YouTube Music</button>
            </form>
            {#each results as song (song.id)}
                <button class="btn" onclick={() => peers.queue(song)}>Add {song.title}</button>
            {/each}
        {/if}
        {#if peers.remote?.queue.length}<p class="muted">Up next: {peers.remote.queue.join(' · ')}</p>{/if}
    {/if}
</section>

<style>
    .peer { display: grid; gap: 12px; padding: 18px; }
    .wayship-box { display: grid; gap: 12px; }
    .wayship-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .wayship-head > div { flex: 1; min-width: 240px; }
    .wayship-eyebrow {
        display: inline-block;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--accent);
        margin-bottom: 2px;
    }
    .wayship-status {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        padding: 10px 12px;
        border-radius: var(--r-md);
        background: rgb(255 255 255 / 0.04);
        border: 1px solid var(--border);
    }
    .wayship-peers { display: grid; gap: 8px; }
    .wayship-peer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        padding: 10px 12px;
        border-radius: var(--r-md);
        background: rgb(255 255 255 / 0.03);
        border: 1px solid var(--border);
    }
    .wayship-peer-info { display: flex; align-items: center; gap: 8px; }
    .pulse-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #34d399;
        box-shadow: 0 0 8px #34d399;
        flex-shrink: 0;
    }
    .peer-divider {
        border: 0;
        border-top: 1px solid var(--border);
        margin: 4px 0;
    }
    .buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .invitation { display: grid; gap: 6px; min-width: 0; }
    .invitation label { color: var(--text-2); font-weight: 650; }
    .code-row { display: flex; align-items: center; gap: 8px; }
    .code-row .input { flex: 1; min-width: 0; }
    img {
        width: min(100%, 440px);
        border-radius: var(--r-sm);
        image-rendering: pixelated;
    }
    .scanner {
        position: relative;
        display: grid;
        place-items: center;
        width: min(100%, 440px);
        aspect-ratio: 4 / 3;
        overflow: hidden;
        border-radius: var(--r-md);
        background: var(--bg);
    }
    video { width: 100%; height: 100%; object-fit: cover; }
    .viewfinder {
        position: absolute;
        height: 78%;
        max-width: 85%;
        aspect-ratio: 1;
        border: 2px solid white;
        border-radius: var(--r-sm);
        box-shadow: 0 0 0 50vmax rgb(0 0 0 / 0.36);
        pointer-events: none;
    }
    .qr-image { position: relative; }
    .qr-image input { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
    .qr-image:focus-within { outline: 2px solid currentColor; }
</style>
