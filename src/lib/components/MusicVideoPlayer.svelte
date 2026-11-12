<script lang="ts">
    import { onDestroy, onMount, untrack } from "svelte";
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import Slider from "$lib/components/Slider.svelte";
    import ArtistLinks from "$lib/components/ArtistLinks.svelte";
    import { client } from "$lib/ephaptic";
    import {
        playerState,
        togglePlay,
        nextTrack,
        previousTrack,
        isNextTrackAvailable,
        toggleShuffle,
        cycleRepeat,
        seek,
        setVolume,
        toggleMute,
    } from "$lib/state/player.svelte";
    import { libraryState } from "$lib/state/library.svelte";
    import { artworkState } from "$lib/state/artwork.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { trackMenu } from "$lib/actions";
    import { formatTime } from "$lib/utils";
    import type { Song, VideoStreamInfo } from "$lib/schema";

    interface Props {
        track: Song;
        videoId: string;
        videos: Song[];
        selectedVideo: Song | null;
        loadingVideos?: boolean;
        videoError?: string;
        idle?: boolean;
        entryTime?: number;
        entryPlaying?: boolean;
        onselectvideo: (video: Song) => void;
        onretry: () => void;
    }

    let {
        track,
        videoId,
        videos,
        selectedVideo,
        loadingVideos = false,
        videoError = "",
        idle = false,
        entryTime = 0,
        entryPlaying = true,
        onselectvideo,
        onretry,
    }: Props = $props();

    // When the selected video is the exact same YouTube ID as the currently playing song,
    // Zeta's main <audio> engine keeps playing uninterrupted and the <video> simply mirrors
    // its clock (100% gapless transitions between Lyrics / Stage / Visualizer / Video).
    const sameRecording = $derived(track.id === `yt:${videoId}`);

    let stream = $state<VideoStreamInfo | null>(null);
    let streamLoading = $state(false);
    let streamError = $state("");
    let streamReq = 0;

    let stageEl = $state<HTMLDivElement>();
    let wrapEl = $state<HTMLDivElement>();
    let videoEl = $state<HTMLVideoElement>();
    let audioEl = $state<HTMLAudioElement>();
    let ambientCanvas = $state<HTMLCanvasElement>();

    // Independent clock when playing a separate music video (sameRecording === false).
    let localTime = $state(0);
    let localDuration = $state(0);
    let localPaused = $state(false);
    let videoReady = $state(false);
    let picksOpen = $state(false);
    let removeBars = $state(true);

    // Detected black-bar crop fractions (0..0.24) on top/bottom and left/right.
    let cropY = $state(0);
    let cropX = $state(0);
    let naturalW = $state(16);
    let naturalH = $state(9);
    let wrapW = $state(1280);
    let wrapH = $state(720);

    // Live frame colours for the ambient background glow.
    let col1 = $state("rgb(90 60 180)");
    let col2 = $state("rgb(200 60 130)");
    let col3 = $state("rgb(25 20 48)");

    const fav = $derived(libraryState.isFavourite(track.id));
    const shownTime = $derived(sameRecording ? playerState.currentTime : localTime);
    const shownDuration = $derived(
        sameRecording
            ? playerState.duration || track.duration || stream?.duration || 0
            : localDuration || stream?.duration || track.duration || 0,
    );
    const shownPaused = $derived(sameRecording ? playerState.paused : localPaused);

    // Effective aspect ratio of the active (bar-cropped) video region.
    const activeAspect = $derived.by(() => {
        const w = Math.max(1, naturalW * (1 - (removeBars ? cropX * 2 : 0)));
        const h = Math.max(1, naturalH * (1 - (removeBars ? cropY * 2 : 0)));
        return w / h;
    });

    // Compute exact viewport dimensions that remove black bars and take as much of the screen
    // as possible while leaving surrounding space for the live frame-reactive ambient glow.
    const viewportDims = $derived.by(() => {
        const maxW = Math.max(320, wrapW);
        const maxH = Math.max(200, wrapH);
        const stageAspect = maxW / maxH;
        let targetAspect = activeAspect;
        if (removeBars) {
            // Gently pull ultra-wide (>2.0:1) or 4:3 videos closer to the window aspect (up to 14% zoom)
            // so the active picture takes as much of the screen as possible without cropping faces.
            if (activeAspect > stageAspect * 1.12) {
                targetAspect = Math.max(stageAspect, activeAspect / 1.14);
            } else if (activeAspect < stageAspect * 0.88) {
                targetAspect = Math.min(stageAspect, activeAspect * 1.14);
            }
        }
        let w = maxW;
        let h = w / targetAspect;
        if (h > maxH) {
            h = maxH;
            w = h * targetAspect;
        }
        return { w: Math.round(w), h: Math.round(h), aspect: targetAspect };
    });

    // Uniform scale factor inside the viewport so baked-in letterbox & pillarbox bars are
    // pushed completely outside the rounded viewport without distorting the image.
    const videoScale = $derived.by(() => {
        if (!removeBars) return 1;
        const rawAspect = naturalW / Math.max(1, naturalH);
        const vpAspect = viewportDims.aspect;
        const coverScaleX = vpAspect < rawAspect ? rawAspect / vpAspect : 1;
        const coverScaleY = vpAspect > rawAspect ? vpAspect / rawAspect : 1;
        const needX = 1 / Math.max(0.5, 1 - cropX * 2);
        const needY = 1 / Math.max(0.5, 1 - cropY * 2);
        return Math.max(1, (needX / coverScaleX) * 1.01, (needY / coverScaleY) * 1.01);
    });

    async function loadStream(id: string) {
        if (!id) return;
        const req = ++streamReq;
        streamLoading = true;
        streamError = "";
        videoReady = false;
        stream = null;
        cropX = 0;
        cropY = 0;
        smoothCropX = 0;
        smoothCropY = 0;
        try {
            const info = await client.musicVideoStream(id);
            if (req !== streamReq) return;
            stream = info;
            naturalW = info.width || 1280;
            naturalH = info.height || 720;
            if (info.duration) localDuration = info.duration;
        } catch (err: any) {
            if (req !== streamReq) return;
            streamError = err?.message ?? String(err);
        } finally {
            if (req === streamReq) streamLoading = false;
        }
    }

    $effect(() => {
        const id = videoId;
        if (id) untrack(() => loadStream(id));
    });

    // Manage seamless audio handoff between Zeta's main <audio> and a separate music video.
    $effect(() => {
        const isSame = sameRecording;
        const hasStream = !!stream;
        if (!hasStream) return;
        if (!isSame) {
            // Pause main song audio while the separate music video plays its own audio.
            untrack(() => {
                if (!playerState.paused) playerState.paused = true;
            });
        }
    });

    // Keep <video> synced with Zeta's main <audio> when sameRecording === true.
    $effect(() => {
        if (!sameRecording || !videoEl || !videoReady) return;
        const targetPaused = playerState.paused;
        if (targetPaused && !videoEl.paused) videoEl.pause();
        else if (!targetPaused && videoEl.paused) void videoEl.play().catch(() => {});
    });

    $effect(() => {
        if (!sameRecording || !videoEl || !videoReady) return;
        const t = playerState.currentTime;
        if (Math.abs(videoEl.currentTime - t) > 0.32) {
            videoEl.currentTime = t;
        }
    });

    // Keep companion <audio> volume and play state synced when sameRecording === false.
    $effect(() => {
        const vol = playerState.muted ? 0 : playerState.volume ** 2;
        if (audioEl) audioEl.volume = vol;
        if (videoEl) videoEl.volume = sameRecording || stream?.audioUrl ? 0 : vol;
    });

    function onVideoLoaded() {
        if (!videoEl) return;
        videoReady = true;
        if (videoEl.videoWidth && videoEl.videoHeight) {
            naturalW = videoEl.videoWidth;
            naturalH = videoEl.videoHeight;
        }
        if (videoEl.duration && Number.isFinite(videoEl.duration)) {
            localDuration = videoEl.duration;
        }

        if (sameRecording) {
            videoEl.currentTime = playerState.currentTime || 0;
            if (!playerState.paused) void videoEl.play().catch(() => {});
        } else {
            const dur = videoEl.duration || stream?.duration || 0;
            const startAt = entryTime > 0.5 && (!dur || entryTime < dur - 3) ? entryTime : 0;
            videoEl.currentTime = startAt;
            localTime = startAt;
            if (audioEl) audioEl.currentTime = startAt;
            localPaused = !entryPlaying;
            if (entryPlaying) {
                void videoEl.play().catch(() => {});
                if (audioEl) void audioEl.play().catch(() => {});
            }
        }
        sampleVideoFrame();
    }

    function onVideoTimeUpdate() {
        if (!videoEl) return;
        if (sameRecording) {
            const drift = videoEl.currentTime - playerState.currentTime;
            if (Math.abs(drift) > 0.35) videoEl.currentTime = playerState.currentTime;
            return;
        }
        localTime = videoEl.currentTime;
        if (audioEl && Math.abs(audioEl.currentTime - videoEl.currentTime) > 0.22) {
            audioEl.currentTime = videoEl.currentTime;
        }
    }

    function toggleVideoPlay() {
        if (sameRecording) {
            togglePlay();
            return;
        }
        if (!videoEl) return;
        if (videoEl.paused) {
            localPaused = false;
            void videoEl.play().catch(() => {});
            if (audioEl) {
                audioEl.currentTime = videoEl.currentTime;
                void audioEl.play().catch(() => {});
            }
        } else {
            localPaused = true;
            videoEl.pause();
            audioEl?.pause();
        }
    }

    function seekVideo(to: number) {
        if (sameRecording) {
            seek(to);
            if (videoEl) videoEl.currentTime = to;
            return;
        }
        localTime = to;
        if (videoEl) videoEl.currentTime = to;
        if (audioEl) audioEl.currentTime = to;
    }

    function toggleFullscreen() {
        if (!stageEl) return;
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else void stageEl.requestFullscreen().catch(() => {});
    }

    /* ---- Frame sampler: black-bar detection & live ambient colours ---- */
    const SAMPLE_W = 64;
    const SAMPLE_H = 36;
    let sampleCanvas: HTMLCanvasElement | null = null;
    let sampleCtx: CanvasRenderingContext2D | null = null;
    let smoothCropY = 0;
    let smoothCropX = 0;
    let smoothColors = [
        [90, 60, 180],
        [200, 60, 130],
        [25, 20, 48],
    ];

    function luma(r: number, g: number, b: number): number {
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function sampleVideoFrame() {
        if (!videoEl || videoEl.readyState < 2 || ui.lite) return;
        if (!sampleCanvas) {
            sampleCanvas = document.createElement("canvas");
            sampleCanvas.width = SAMPLE_W;
            sampleCanvas.height = SAMPLE_H;
            sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
        }
        if (!sampleCtx) return;

        try {
            sampleCtx.drawImage(videoEl, 0, 0, SAMPLE_W, SAMPLE_H);
            const data = sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;

            // 1. Check center brightness first so dark scenes don't trigger false bar detection.
            let centerLuma = 0;
            let centerCount = 0;
            for (let y = 10; y < 26; y++) {
                for (let x = 16; x < 48; x++) {
                    const idx = (y * SAMPLE_W + x) * 4;
                    centerLuma += luma(data[idx], data[idx + 1], data[idx + 2]);
                    centerCount++;
                }
            }
            centerLuma /= Math.max(1, centerCount);

            if (centerLuma > 22) {
                const isRowDark = (y: number) => {
                    let sum = 0;
                    let sqSum = 0;
                    const count = SAMPLE_W - 8;
                    for (let x = 4; x < SAMPLE_W - 4; x++) {
                        const idx = (y * SAMPLE_W + x) * 4;
                        const l = luma(data[idx], data[idx + 1], data[idx + 2]);
                        sum += l;
                        sqSum += l * l;
                    }
                    const avg = sum / count;
                    const std = Math.sqrt(Math.max(0, sqSum / count - avg * avg));
                    // Handles both full-range (0) and limited MPEG studio-range (16-24) black bars.
                    return avg < 26 && std < 7.5;
                };
                const isColDark = (x: number) => {
                    let sum = 0;
                    let sqSum = 0;
                    const count = SAMPLE_H - 8;
                    for (let y = 4; y < SAMPLE_H - 4; y++) {
                        const idx = (y * SAMPLE_W + x) * 4;
                        const l = luma(data[idx], data[idx + 1], data[idx + 2]);
                        sum += l;
                        sqSum += l * l;
                    }
                    const avg = sum / count;
                    const std = Math.sqrt(Math.max(0, sqSum / count - avg * avg));
                    return avg < 26 && std < 7.5;
                };

                const maxRowBar = Math.floor(SAMPLE_H * 0.25);
                let topRows = 0;
                while (topRows < maxRowBar && isRowDark(topRows)) topRows++;
                let bottomRows = 0;
                while (bottomRows < maxRowBar && isRowDark(SAMPLE_H - 1 - bottomRows)) bottomRows++;
                // Letterbox bars are symmetric on top and bottom.
                const symRows = Math.min(topRows, bottomRows);
                const targetY = symRows >= 1 ? (symRows + 0.5) / SAMPLE_H : 0;

                const maxColBar = Math.floor(SAMPLE_W * 0.25);
                let leftCols = 0;
                while (leftCols < maxColBar && isColDark(leftCols)) leftCols++;
                let rightCols = 0;
                while (rightCols < maxColBar && isColDark(SAMPLE_W - 1 - rightCols)) rightCols++;
                const symCols = Math.min(leftCols, rightCols);
                const targetX = symCols >= 1 ? (symCols + 0.5) / SAMPLE_W : 0;

                // Lock immediately on the first detected bar, then smooth subsequent shifts.
                const rateY = smoothCropY === 0 && targetY > 0 ? 0.85 : targetY < smoothCropY ? 0.35 : 0.22;
                const rateX = smoothCropX === 0 && targetX > 0 ? 0.85 : targetX < smoothCropX ? 0.35 : 0.22;
                smoothCropY += (targetY - smoothCropY) * rateY;
                smoothCropX += (targetX - smoothCropX) * rateX;
                cropY = smoothCropY < 0.015 ? 0 : Number(smoothCropY.toFixed(4));
                cropX = smoothCropX < 0.015 ? 0 : Number(smoothCropX.toFixed(4));
            }

            // 2. Extract 3 regional colours (upper-left, upper-right, lower) from the active frame.
            const y0 = Math.min(10, Math.round(cropY * SAMPLE_H) + 2);
            const y1 = Math.max(y0 + 4, SAMPLE_H - y0);
            const x0 = Math.min(14, Math.round(cropX * SAMPLE_W) + 2);
            const x1 = Math.max(x0 + 4, SAMPLE_W - x0);
            const midX = (x0 + x1) >> 1;
            const midY = (y0 + y1) >> 1;

            const regionColor = (xa: number, xb: number, ya: number, yb: number): [number, number, number] => {
                let r = 0, g = 0, b = 0, wSum = 0;
                for (let y = ya; y < yb; y += 2) {
                    for (let x = xa; x < xb; x += 2) {
                        const idx = (y * SAMPLE_W + x) * 4;
                        const pr = data[idx], pg = data[idx + 1], pb = data[idx + 2];
                        const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
                        // Weight colourful, mid-bright pixels higher so the ambient glow feels vivid.
                        const sat = max > 0 ? (max - min) / max : 0;
                        const lum = (max + min) / 510;
                        const weight = 0.25 + sat * 1.8 + (1 - Math.abs(lum - 0.52)) * 0.6;
                        r += pr * weight;
                        g += pg * weight;
                        b += pb * weight;
                        wSum += weight;
                    }
                }
                if (!wSum) return [60, 45, 110];
                return [Math.round(r / wSum), Math.round(g / wSum), Math.round(b / wSum)];
            };

            const nextCols = [
                regionColor(x0, midX, y0, midY),
                regionColor(midX, x1, y0, midY),
                regionColor(x0, x1, midY, y1),
            ];

            for (let i = 0; i < 3; i++) {
                for (let c = 0; c < 3; c++) {
                    smoothColors[i][c] = Math.round(smoothColors[i][c] + (nextCols[i][c] - smoothColors[i][c]) * 0.22);
                }
            }
            const css = (rgb: number[]) => `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
            col1 = css(smoothColors[0]);
            col2 = css(smoothColors[1]);
            col3 = css(smoothColors[2]);

            const root = document.documentElement.style;
            root.setProperty("--art-1", col1);
            root.setProperty("--art-2", col2);
            root.setProperty("--art-3", col3);

            // 3. Paint the cropped active frame into the blurred ambient backdrop canvas.
            if (ambientCanvas) {
                const aCtx = ambientCanvas.getContext("2d");
                if (aCtx) {
                    const sx = cropX * SAMPLE_W;
                    const sy = cropY * SAMPLE_H;
                    const sw = Math.max(8, SAMPLE_W - sx * 2);
                    const sh = Math.max(8, SAMPLE_H - sy * 2);
                    aCtx.drawImage(sampleCanvas, sx, sy, sw, sh, 0, 0, ambientCanvas.width, ambientCanvas.height);
                }
            }
        } catch {
            /* ignore transient frame read errors */
        }
    }

    function measureWrap() {
        if (!wrapEl) return;
        const style = getComputedStyle(wrapEl);
        const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        wrapW = Math.max(320, (wrapEl.clientWidth || 1280) - padX);
        wrapH = Math.max(200, (wrapEl.clientHeight || 720) - padY);
    }

    $effect(() => {
        // Re-measure when idle padding transitions.
        void idle;
        measureWrap();
        const t = setTimeout(measureWrap, 520);
        return () => clearTimeout(t);
    });

    onMount(() => {
        const timer = setInterval(sampleVideoFrame, 120);
        const ro = new ResizeObserver(measureWrap);
        if (wrapEl) ro.observe(wrapEl);
        measureWrap();
        return () => {
            clearInterval(timer);
            ro.disconnect();
        };
    });

    onDestroy(() => {
        // Restore the song's album-cover palette and seamlessly continue song playback at the video's timestamp!
        artworkState.restyle();
        if (!sameRecording) {
            const dur = playerState.duration || track.duration || 0;
            if (localTime > 0.5 && (!dur || localTime < dur - 1)) {
                seek(localTime);
            }
            if (!localPaused || entryPlaying) {
                playerState.paused = false;
            }
        }
    });
</script>

<div
    class="mv-stage"
    class:idle
    bind:this={stageEl}
    style:--vid-1={col1}
    style:--vid-2={col2}
    style:--vid-3={col3}
>
    <!-- Live frame-reactive ambient backdrop filling any extra screen space around the video -->
    <div class="mv-ambient" aria-hidden="true">
        <canvas class="ambient-canvas" bind:this={ambientCanvas} width="64" height="36"></canvas>
        <div class="ambient-wash"></div>
    </div>

    <div class="mv-viewport-wrap" bind:this={wrapEl}>
        {#if stream && !streamError}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="mv-viewport"
                style:width="{viewportDims.w}px"
                style:height="{viewportDims.h}px"
                onclick={toggleVideoPlay}
                ondblclick={toggleFullscreen}
            >
                <video
                    bind:this={videoEl}
                    src={stream.videoUrl}
                    crossorigin="anonymous"
                    playsinline
                    muted={sameRecording || !!stream.audioUrl || playerState.muted}
                    style:transform="scale({videoScale.toFixed(4)})"
                    onloadedmetadata={onVideoLoaded}
                    ontimeupdate={onVideoTimeUpdate}
                    onplay={() => {
                        if (!sameRecording) {
                            localPaused = false;
                            if (audioEl) {
                                audioEl.currentTime = videoEl!.currentTime;
                                void audioEl.play().catch(() => {});
                            }
                        }
                    }}
                    onpause={() => {
                        if (!sameRecording) {
                            localPaused = true;
                            audioEl?.pause();
                        }
                    }}
                    onwaiting={() => audioEl?.pause()}
                    onplaying={() => {
                        if (!sameRecording && !localPaused && audioEl) {
                            audioEl.currentTime = videoEl!.currentTime;
                            void audioEl.play().catch(() => {});
                        }
                    }}
                    onended={() => {
                        if (!sameRecording) {
                            if (isNextTrackAvailable()) nextTrack();
                            else localPaused = true;
                        }
                    }}
                    onerror={() => {
                        streamError = "Couldn't play this video stream.";
                    }}
                ></video>

                {#if !sameRecording && stream.audioUrl}
                    <audio
                        bind:this={audioEl}
                        src={stream.audioUrl}
                        crossorigin="anonymous"
                    ></audio>
                {/if}
            </div>
        {:else if streamLoading || loadingVideos}
            <div class="mv-state">
                <span class="spin"><Icon name="loader-circle" /></span>
                <span>Loading music video…</span>
            </div>
        {:else if streamError || videoError}
            <div class="mv-state">
                <Icon name="triangle-alert" />
                <span>{streamError || videoError}</span>
                <button class="btn" onclick={() => (streamError ? loadStream(videoId) : onretry())}>
                    <Icon name="refresh-cw" /> Try again
                </button>
            </div>
        {:else}
            <div class="mv-state">
                <Icon name="film" />
                <span>No music video found for this song.</span>
            </div>
        {/if}
    </div>

    {#if picksOpen && videos.length > 1}
        <div class="mv-picks glass">
            <div class="mv-picks-head">
                <span>Switch video</span>
                <button class="icon-btn sm" onclick={() => (picksOpen = false)}><Icon name="x" /></button>
            </div>
            <div class="mv-picks-list">
                {#each videos as v (v.id)}
                    <button
                        class="mv-pick"
                        class:selected={selectedVideo?.id === v.id}
                        onclick={() => {
                            onselectvideo(v);
                            picksOpen = false;
                        }}
                    >
                        <Cover thumbnails={v.thumbnails} title={v.title} size={48} radius="8px" />
                        <span class="mv-pick-text">
                            <strong class="ellipsis">{v.title}</strong>
                            <small class="ellipsis">{v.artists.map((a) => a.name).join(", ")}</small>
                        </span>
                    </button>
                {/each}
            </div>
        </div>
    {/if}

    <div class="mv-bottom">
        <div class="mv-meta">
            <Cover thumbnails={track.thumbnails} title={track.title} size={56} radius="var(--r-sm)" />
            <div class="mv-meta-text">
                <h2 class="ellipsis" title={selectedVideo?.title ?? track.title}>{track.title}</h2>
                <p class="ellipsis">
                    <ArtistLinks artists={track.artists} album={track.album} providerHint={track.id.startsWith("js:") ? "js" : "yt"} />
                </p>
            </div>
            <button class="icon-btn fav" class:is-fav={fav} title="Favourite" onclick={() => libraryState.toggleFavourite(track)}>
                <Icon name="heart" />
            </button>
            <button
                class="icon-btn"
                title="More"
                onclick={(e) => ui.openMenuAt(e.currentTarget, trackMenu(track, { playlist: playerState.currentPlaylist }))}
            >
                <Icon name="ellipsis" />
            </button>
        </div>

        <div class="mv-ctl">
            <div class="mv-progress">
                <Slider
                    value={shownTime}
                    max={shownDuration}
                    onchange={seekVideo}
                    format={formatTime}
                    label="Seek video"
                />
                <div class="mv-times">
                    <span>{formatTime(shownTime)}</span>
                    <span>-{formatTime(Math.max(0, shownDuration - shownTime))}</span>
                </div>
            </div>

            <div class="mv-buttons">
                <button class="icon-btn" class:on={playerState.shuffle} title="Shuffle" onclick={toggleShuffle}>
                    <Icon name="shuffle" />
                </button>
                <button class="icon-btn xl" title="Previous" onclick={previousTrack}>
                    <Icon name="skip-back" />
                </button>
                <button
                    class="big-play"
                    title="Play/Pause"
                    disabled={streamLoading || loadingVideos}
                    onclick={toggleVideoPlay}
                >
                    {#if streamLoading || loadingVideos}
                        <span class="spin"><Icon name="loader-circle" /></span>
                    {:else}
                        <Icon name={shownPaused ? "play" : "pause"} />
                    {/if}
                </button>
                <button class="icon-btn xl" title="Next" disabled={!isNextTrackAvailable()} onclick={nextTrack}>
                    <Icon name="skip-forward" />
                </button>
                <button class="icon-btn" class:on={playerState.repeat !== "off"} title="Repeat: {playerState.repeat}" onclick={cycleRepeat}>
                    <Icon name={playerState.repeat === "one" ? "repeat-1" : "repeat"} />
                </button>
            </div>
        </div>

        <div class="mv-right">
            <div class="mv-tools">
                <button
                    class="chip"
                    aria-pressed={removeBars}
                    title={removeBars ? "Cropping black bars & filling screen" : "Showing original video frame"}
                    onclick={() => (removeBars = !removeBars)}
                >
                    <Icon name="maximize-2" /> {removeBars ? "Auto-crop" : "Fit"}
                </button>
                {#if videos.length > 1}
                    <button
                        class="chip"
                        aria-pressed={picksOpen}
                        onclick={() => (picksOpen = !picksOpen)}
                    >
                        <Icon name="film" /> Videos ({videos.length})
                    </button>
                {/if}
                <button class="icon-btn sm" title="Fullscreen" onclick={toggleFullscreen}>
                    <Icon name="expand" />
                </button>
            </div>
            <div class="mv-vol">
                <button class="icon-btn sm" onclick={toggleMute} title="Mute">
                    <Icon name={playerState.muted || !playerState.volume ? "volume-x" : "volume-1"} />
                </button>
                <Slider value={playerState.muted ? 0 : playerState.volume} max={1} live onchange={setVolume} label="Volume" />
                <Icon name="volume-2" />
            </div>
        </div>
    </div>
</div>

<style>
    .mv-stage {
        position: relative;
        z-index: 1;
        flex: 1;
        min-height: 0;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
    }

    /* Live frame-sampled ambient light filling any extra screen area around the video */
    .mv-ambient {
        position: absolute;
        inset: -8%;
        z-index: 0;
        pointer-events: none;
        overflow: hidden;
    }
    .ambient-canvas {
        width: 100%;
        height: 100%;
        object-fit: cover;
        filter: blur(48px) saturate(2.4) brightness(0.92);
        transform: scale(1.16);
        opacity: 0.96;
    }
    .ambient-wash {
        position: absolute;
        inset: 0;
        background:
            radial-gradient(65% 65% at 22% 28%, color-mix(in srgb, var(--vid-1) 68%, transparent), transparent 72%),
            radial-gradient(65% 65% at 78% 32%, color-mix(in srgb, var(--vid-2) 62%, transparent), transparent 72%),
            radial-gradient(80% 70% at 50% 82%, color-mix(in srgb, var(--vid-3) 76%, transparent), transparent 76%);
        mix-blend-mode: screen;
        opacity: 0.78;
        transition: background 0.35s linear;
    }

    .mv-viewport-wrap {
        position: relative;
        z-index: 1;
        width: 100%;
        height: 100%;
        padding: 8px clamp(14px, 2.2vw, 32px) clamp(118px, 15.5vh, 142px);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: padding-bottom 0.5s var(--ease-out);
    }
    .idle .mv-viewport-wrap {
        padding-bottom: 18px;
    }

    .mv-viewport {
        position: relative;
        max-width: 100%;
        max-height: 100%;
        border-radius: 24px;
        overflow: hidden;
        background: #000;
        box-shadow:
            0 36px 90px -24px rgb(0 0 0 / 0.85),
            0 0 110px -16px color-mix(in srgb, var(--vid-1) 62%, transparent),
            0 0 0 1px rgb(255 255 255 / 0.14);
        cursor: pointer;
        transition: width 0.38s var(--ease-out), height 0.38s var(--ease-out), box-shadow 0.5s;
    }
    video {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        transform-origin: center;
        transition: transform 0.45s var(--ease-out);
    }

    .mv-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 32px;
        border-radius: 24px;
        background: rgb(12 10 18 / 0.65);
        border: 1px solid rgb(255 255 255 / 0.1);
        backdrop-filter: blur(20px);
        color: rgb(255 255 255 / 0.8);
        text-align: center;
    }
    .mv-state :global(svg) {
        width: 30px;
        height: 30px;
        opacity: 0.78;
    }

    .mv-picks {
        position: absolute;
        right: 28px;
        bottom: 152px;
        z-index: 5;
        width: min(360px, calc(100vw - 40px));
        max-height: 52vh;
        display: flex;
        flex-direction: column;
        padding: 12px;
        border-radius: 22px;
        background: rgb(14 12 22 / 0.86);
        backdrop-filter: blur(28px) saturate(1.6);
        border: 1px solid rgb(255 255 255 / 0.14);
        box-shadow: var(--shadow-lg);
    }
    .mv-picks-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 6px 8px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-2);
    }
    .mv-picks-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        overflow-y: auto;
    }
    .mv-pick {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 8px;
        border-radius: 14px;
        text-align: left;
        transition: background 0.18s;
    }
    .mv-pick:hover,
    .mv-pick.selected {
        background: rgb(255 255 255 / 0.12);
    }
    .mv-pick-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
        gap: 2px;
    }
    .mv-pick-text strong {
        font-size: 13px;
        font-weight: 650;
    }
    .mv-pick-text small {
        font-size: 11.5px;
        color: var(--text-3);
    }

    .mv-bottom {
        position: absolute;
        z-index: 3;
        left: 0;
        right: 0;
        bottom: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 520px) minmax(0, 1fr);
        align-items: end;
        gap: 28px;
        padding: 52px 32px 22px;
        background: linear-gradient(0deg, rgb(0 0 0 / 0.72), rgb(0 0 0 / 0.32) 60%, transparent);
        transition: opacity 0.5s, translate 0.5s var(--ease-out);
    }
    .idle .mv-bottom {
        opacity: 0;
        translate: 0 16px;
        pointer-events: none;
    }

    .mv-meta {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
    }
    .mv-meta-text {
        flex: 1;
        min-width: 0;
    }
    .mv-meta-text h2 {
        font-size: clamp(18px, 1.8vw, 23px);
        font-weight: 800;
    }
    .mv-meta-text p {
        font-size: 14px;
        color: rgb(255 255 255 / 0.72);
        margin-top: 2px;
    }
    .fav.is-fav :global(svg) {
        fill: currentColor;
    }

    .mv-ctl {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .mv-ctl :global(.fill) {
        background: #fff !important;
    }
    .mv-times {
        display: flex;
        justify-content: space-between;
        font-size: 11.5px;
        font-weight: 600;
        color: rgb(255 255 255 / 0.6);
        font-variant-numeric: tabular-nums;
        margin-top: 2px;
    }
    .mv-buttons {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 4px;
    }
    .icon-btn.xl {
        width: 48px;
        height: 48px;
    }
    .icon-btn.xl :global(svg) {
        width: 26px;
        height: 26px;
        fill: currentColor;
    }
    .big-play {
        display: grid;
        place-items: center;
        width: 62px;
        height: 62px;
        border-radius: 50%;
        background: #fff;
        color: #000;
        box-shadow: 0 12px 34px -8px rgb(0 0 0 / 0.6);
        transition: transform 0.3s var(--ease-spring);
    }
    .big-play :global(svg) {
        width: 28px;
        height: 28px;
        fill: currentColor;
    }
    .big-play .spin :global(svg) {
        fill: none;
    }
    .big-play:hover:not(:disabled) {
        transform: scale(1.06);
    }

    .mv-right {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
    }
    .mv-tools {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        justify-content: flex-end;
    }
    .mv-vol {
        display: flex;
        align-items: center;
        gap: 6px;
        width: min(220px, 100%);
        color: rgb(255 255 255 / 0.65);
    }
    .mv-vol > :global(svg) {
        width: 16px;
        height: 16px;
    }

    @media (max-width: 900px) {
        .mv-bottom {
            grid-template-columns: 1fr;
            gap: 14px;
            padding: 36px 20px 18px;
        }
        .mv-right {
            flex-direction: row;
            justify-content: space-between;
            width: 100%;
        }
        .mv-vol {
            display: none;
        }
    }
</style>
