<script lang="ts">
    /**
     * Owns the <audio> element and every integration around playback: loading,
     * preloading, Web Audio routing, MPRIS, Media Session, Discord RPC,
     * listening stats, autoplay, session restore, the sleep timer and global
     * keyboard shortcuts. Renders nothing visible.
     */
    import { client } from "$lib/ephaptic";
    import { goto } from "$app/navigation";
    import { untrack, onDestroy } from "svelte";
    import {
        playerState,
        cache,
        loadTrack,
        resetState,
        applyCache,
        nextTrack,
        previousTrack,
        handleTrackEnded,
        isNextTrackAvailable,
        isPreviousTrackAvailable,
        getUpcomingTrack,
        togglePlay,
        seekBy,
        setVolume,
        toggleMute,
        toggleShuffle,
        cycleRepeat,
        setShuffle,
        setRepeat,
        refreshAutoplay,
    } from "$lib/state/player.svelte";
    import { libraryState } from "$lib/state/library.svelte";
    import { artworkState } from "$lib/state/artwork.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { toasts } from "$lib/state/toast.svelte";
    import { analyser } from "$lib/audio/analyser";
    import { onMediaCommand, type MediaCommand } from "$lib/mpris";
    import { updateThumbnailUrl, getThumbnailUrl, artistNames } from "$lib/utils";
    import { isCoverUrl } from "$lib/covers";
    import type { Song } from "$lib/schema";

    let audio = $state<HTMLAudioElement>();

    /* ---------------------------- audio source ---------------------------- */

    // One object URL per stream, revoked when replaced (they used to leak one
    // full copy of the song per track played).
    let src = $state<string | null>(null);
    $effect(() => {
        const stream = playerState.stream;
        if (!stream) {
            src = null;
            return;
        }
        const url = URL.createObjectURL(new Blob([new Uint8Array(stream.data)], { type: stream.mimetype }));
        src = url;
        // Revoke a little later: the element may still be tearing down the old source.
        return () => setTimeout(() => URL.revokeObjectURL(url), 2000);
    });

    $effect(() => {
        if (audio) analyser.attach(audio);
    });

    $effect(() => {
        analyser.setVolume(playerState.muted ? 0 : playerState.volume);
    });

    /* -------------------------- session restore --------------------------- */

    const SESSION_KEY = "zeta:session";
    // Set while restoring: load the last track paused, at its old position.
    let restoreAt = $state<number | null>(null);

    (function restoreSession() {
        try {
            const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
            if (!saved?.track) return;
            restoreAt = saved.time ?? 0;
            playerState.currentTrack = saved.track;
            if (saved.playlistId) {
                // The library loads asynchronously; attach the context once it has.
                const stop = $effect.root(() => {
                    $effect(() => {
                        if (libraryState.loading) return;
                        const playlist = libraryState.getPlaylist(saved.playlistId);
                        if (playlist && playerState.currentTrack?.id === saved.track.id && !playerState.currentPlaylist) {
                            playerState.currentPlaylist = playlist;
                            playerState._anchorId = saved.track.id;
                            playerState._anchorIndex = playlist.tracks.findIndex((t) => t.id === saved.track.id);
                            if (playerState.shuffle) setShuffle(false), setShuffle(true);
                        }
                        queueMicrotask(stop);
                    });
                });
            }
        } catch {
            /* corrupt session: start fresh */
        }
    })();

    function saveSession() {
        const track = playerState.currentTrack;
        if (!track) return localStorage.removeItem(SESSION_KEY);
        const playlist = playerState.currentPlaylist;
        const snapshot = $state.snapshot(track) as Song;
        // Don't persist raw cover bytes into localStorage.
        snapshot.thumbnails = snapshot.thumbnails.map((t) => (t.data ? { ...t, data: undefined } : t)).filter((t) => t.url || t.data);
        localStorage.setItem(
            SESSION_KEY,
            JSON.stringify({
                track: snapshot,
                time: playerState.currentTime || 0,
                playlistId: playlist && libraryState.getPlaylist(playlist.id) ? playlist.id : null,
            }),
        );
    }

    $effect(() => {
        void playerState.currentTrack;
        untrack(saveSession);
    });
    $effect(() => {
        const timer = setInterval(() => untrack(saveSession), 5000);
        return () => clearInterval(timer);
    });

    /* ------------------------------ loading ------------------------------- */

    let failCount = 0;

    function handlePlaybackFailure(track: Song, err: unknown) {
        if (playerState.currentTrack?.id !== track.id) return;

        playerState.stream = null;
        playerState.isLoading = false;
        playerState.paused = true;

        const msg = (err as any)?.message ?? String(err);

        // Skip onward so playback keeps going — unless we've already skipped
        // through a whole playlist's worth of failures.
        const limit = playerState.currentPlaylist?.tracks.length ?? 3;
        if (isNextTrackAvailable() && failCount < limit) {
            failCount++;
            toasts.error(`Skipping “${track.title}”: ${msg}`);
            nextTrack();
        } else {
            failCount = 0;
            toasts.error(`Couldn't play “${track.title}”: ${msg}`);
        }
    }

    $effect(() => {
        const track = playerState.currentTrack;
        untrack(() => artworkState.update(track));

        if (!track) {
            playerState.stream = null;
            playerState.lyrics = null;
            playerState.paused = true;
            return;
        }

        const loadingId = track.id;
        untrack(() => {
            resetState();
            const done = () => {
                if (playerState.currentTrack?.id !== loadingId) return;
                applyCache(cache.get(loadingId));
                failCount = 0;
                if (restoreAt !== null) playerState.paused = true;
            };
            if (cache.has(track.id)) done();
            else loadTrack(track).then(done).catch((err) => handlePlaybackFailure(track, err));
        });
    });

    // When the library gets a better copy of the playing song (metadata repaired,
    // or a restored session's stale info), update it in place: same object and
    // id, so playback isn't interrupted.
    $effect(() => {
        const current = playerState.currentTrack;
        const fresh = current ? libraryState.tracks.get(current.id) : undefined;
        if (!current || !fresh) return;
        untrack(() => {
            const names = (s: Song) => s.artists.map((a) => a.name).join("\u0000");
            const coverChanged = fresh.thumbnails.length !== current.thumbnails.length;
            if (fresh.title === current.title && names(fresh) === names(current) && !coverChanged) return;
            Object.assign(current, {
                title: fresh.title,
                artists: fresh.artists,
                album: fresh.album,
                thumbnails: fresh.thumbnails,
                duration: fresh.duration || current.duration,
            });
            if (coverChanged) artworkState.refresh(current);
            saveSession();
        });
    });

    // Preload whatever is up next (reactive: follows shuffle/queue changes).
    $effect(() => {
        const upcoming = getUpcomingTrack();
        if (upcoming && !playerState.isLoading) loadTrack(upcoming).catch(() => {});
    });

    // Autoplay: fetch similar songs as the queue runs low.
    $effect(() => {
        void playerState.currentTrack?.id;
        void playerState.upNext.length;
        void playerState.autoplay;
        void playerState.repeat;
        void playerState.currentPlaylist?.tracks.length;
        // Suggestions get cleared when a new context starts (even for the same song).
        void playerState.autoplayTracks.length;
        untrack(() => refreshAutoplay());
    });

    /* --------------------------- listening stats -------------------------- */

    let statsTrack: Song | null = null;
    let playedMs = 0;
    let lastTime = 0;

    function flushListen() {
        const track = statsTrack;
        if (track && playedMs >= 1000) {
            client
                .statsRecordEvent(track.id, Math.round(playedMs), Date.now() - Math.round(playedMs), {
                    title: track.title,
                    artists: track.artists.map((a) => a.name),
                    thumbnailUrl: track.thumbnails.find((t) => t.url)?.url,
                })
                .catch(() => {});
        }
        playedMs = 0;
        lastTime = 0;
    }

    function accumulatePlaytime() {
        if (!audio) return;
        const t = audio.currentTime;
        const dt = t - lastTime;
        if (dt > 0 && dt < 2 && !playerState.paused) playedMs += dt * 1000;
        lastTime = t;
    }

    $effect(() => {
        const track = playerState.currentTrack;
        if (track?.id !== statsTrack?.id) {
            untrack(() => flushListen());
            statsTrack = track;
        }
    });

    onDestroy(() => flushListen());

    /* -------------------------------- MPRIS ------------------------------- */

    function trackUrl(track: Song): string | undefined {
        if (track.id.startsWith("yt:")) return `https://music.youtube.com/watch?v=${track.id.slice(3)}`;
        return undefined;
    }

    let artSentFor: string | null = null;

    function publishMpris(seeked = false) {
        const track = playerState.currentTrack;
        // A web URL if there is one; otherwise our cover URL, which the main
        // process resolves into a file for MPRIS.
        const remote =
            track?.thumbnails.find((t) => /^https?:/.test(t.url ?? "")) ?? track?.thumbnails.find((t) => isCoverUrl(t.url));
        const needsArt = !!track && track.id !== artSentFor;
        const embedded = needsArt ? track?.thumbnails.find((t) => t.data?.length) : undefined;
        if (track) artSentFor = track.id;

        client
            .mprisUpdate({
                track: track
                    ? {
                          id: track.id,
                          title: track.title,
                          artists: track.artists.map((a) => a.name),
                          album: track.album?.title ?? null,
                          durationSec: playerState.duration || track.duration || 0,
                          artUrl: remote?.url ? updateThumbnailUrl(remote.url) : undefined,
                          artData: embedded?.data ? $state.snapshot(embedded.data) : undefined,
                          artMimetype: embedded?.mimetype,
                          url: trackUrl(track),
                      }
                    : null,
                paused: playerState.paused,
                positionSec: playerState.currentTime || 0,
                canNext: isNextTrackAvailable(),
                canPrevious: isPreviousTrackAvailable(),
                repeat: playerState.repeat,
                shuffle: playerState.shuffle,
                volume: playerState.muted ? 0 : playerState.volume,
                seeked,
            })
            .catch(() => {});
    }

    $effect(() => {
        void playerState.currentTrack;
        void playerState.paused;
        void playerState.duration;
        void playerState.repeat;
        void playerState.shuffle;
        void playerState.volume;
        void playerState.muted;
        void getUpcomingTrack();
        untrack(() => publishMpris());
    });

    $effect(() => {
        const timer = setInterval(() => {
            if (!playerState.paused && playerState.currentTrack) untrack(() => publishMpris());
        }, 5000);
        return () => clearInterval(timer);
    });

    function handleCommand(command: MediaCommand) {
        const track = playerState.currentTrack;
        switch (command.type) {
            case "play":
                if (track) playerState.paused = false;
                break;
            case "pause":
                playerState.paused = true;
                break;
            case "playpause":
                if (track) playerState.paused = !playerState.paused;
                break;
            case "stop":
                playerState.paused = true;
                playerState.currentTime = 0;
                break;
            case "next":
                nextTrack();
                break;
            case "previous":
                previousTrack();
                break;
            case "seek":
                seekBy(command.offsetSec);
                publishMpris(true);
                break;
            case "setPosition":
                playerState.currentTime = Math.min(Math.max(0, command.positionSec), playerState.duration || 0);
                publishMpris(true);
                break;
            case "setRepeat":
                setRepeat(command.repeat);
                break;
            case "setShuffle":
                setShuffle(command.shuffle);
                break;
            case "setVolume":
                setVolume(command.volume);
                break;
        }
    }

    $effect(() => onMediaCommand(handleCommand));

    /* ---------------------------- Media Session --------------------------- */

    $effect(() => {
        const track = playerState.currentTrack;
        if (!track || !("mediaSession" in navigator)) return;
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: artistNames(track),
            album: track.album?.title ?? "Zeta Music",
            artwork: [{ src: getThumbnailUrl(track.thumbnails, track.title), sizes: "512x512" }],
        });
    });

    $effect(() => {
        if (!("mediaSession" in navigator)) return;
        navigator.mediaSession.playbackState = playerState.currentTrack ? (playerState.paused ? "paused" : "playing") : "none";
    });

    $effect(() => {
        if (!("mediaSession" in navigator)) return;
        navigator.mediaSession.setActionHandler("play", () => (playerState.paused = false));
        navigator.mediaSession.setActionHandler("pause", () => (playerState.paused = true));
        navigator.mediaSession.setActionHandler("seekto", (d) => {
            if (d.seekTime != null) playerState.currentTime = d.seekTime;
        });
        navigator.mediaSession.setActionHandler("previoustrack", previousTrack);
        navigator.mediaSession.setActionHandler("nexttrack", nextTrack);
    });

    function updatePositionState() {
        if (!playerState.currentTrack || !("mediaSession" in navigator) || !playerState.duration) return;
        try {
            navigator.mediaSession.setPositionState({
                duration: playerState.duration,
                playbackRate: 1,
                position: Math.min(playerState.currentTime, playerState.duration),
            });
        } catch {
            /* position can briefly exceed duration while metadata loads */
        }
    }

    /* ----------------------------- Discord RPC ---------------------------- */
    // Discord draws the progress bar only with BOTH timestamps; presence
    // updates are rate-limited, so republish only on discrete events.
    function publishRPC() {
        const track = playerState.currentTrack;
        if (!track || playerState.paused) {
            client.clearRPC().catch(() => {});
            return;
        }
        const position = playerState.currentTime || 0;
        const total = playerState.duration || track.duration || 0;
        const now = Date.now();
        // Discord fetches the image itself, so only a real web URL works.
        const art = updateThumbnailUrl(track.thumbnails.find((t) => /^https?:/.test(t.url ?? ""))?.url);

        client
            .setRPC({
                type: 2, // Listening
                details: track.title,
                state: artistNames(track),
                name: track.title,
                startTimestamp: Math.round(now - position * 1000),
                ...(total > 0 ? { endTimestamp: Math.round(now + Math.max(0, total - position) * 1000) } : {}),
                largeImageUrl: art,
                largeImageKey: art,
                smallImageText: "Zeta Music",
                smallImageUrl: "zeta",
                smallImageKey: "zeta",
            })
            ?.catch(console.error);
    }

    $effect(() => {
        void playerState.currentTrack;
        void playerState.paused;
        void playerState.duration;
        untrack(() => publishRPC());
    });

    /* ------------------------------ sleep timer --------------------------- */

    $effect(() => {
        const at = ui.sleepAt;
        if (typeof at !== "number") return;
        const timer = setTimeout(() => {
            playerState.paused = true;
            ui.sleepAt = null;
            toasts.info("Sleep timer: playback paused. Good night 🌙");
        }, Math.max(0, at - Date.now()));
        return () => clearTimeout(timer);
    });

    function onEnded() {
        flushListen();
        if (ui.sleepAt === "track") {
            ui.sleepAt = null;
            playerState.paused = true;
            playerState.currentTime = 0;
            toasts.info("Sleep timer: stopped after the track. Good night 🌙");
            return;
        }
        handleTrackEnded();
    }

    /* ------------------------------ shortcuts ----------------------------- */

    function isTyping(target: EventTarget | null) {
        const el = target as HTMLElement | null;
        return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
    }

    function onKey(e: KeyboardEvent) {
        if (e.defaultPrevented || ui.dialog || ui.menu) return;

        // Search is reachable from anywhere, even while typing elsewhere.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            goto("/music/search").then(() => document.querySelector<HTMLInputElement>("#search-input")?.focus());
            return;
        }
        if (isTyping(e.target) || e.altKey) return;

        const mod = e.ctrlKey || e.metaKey;
        const k = e.key;
        let handled = true;

        if (k === " " || k === "k") togglePlay();
        else if (k === "ArrowRight" && (mod || e.shiftKey)) nextTrack();
        else if (k === "ArrowLeft" && (mod || e.shiftKey)) previousTrack();
        else if (k === "ArrowRight" || k === "l") seekBy(5);
        else if (k === "ArrowLeft" || k === "j") seekBy(-5);
        else if (k === "ArrowUp") setVolume(playerState.volume + 0.05);
        else if (k === "ArrowDown") setVolume(playerState.volume - 0.05);
        else if (k === "m") toggleMute();
        else if (k === "s") toggleShuffle();
        else if (k === "r") cycleRepeat();
        else if (k === "q") ui.toggleSidePanel("queue");
        else if (k === "y") ui.toggleSidePanel("lyrics");
        else if (k === "f" && playerState.currentTrack) ui.nowPlayingOpen = !ui.nowPlayingOpen;
        else if (k === "v" && playerState.currentTrack) ui.openNowPlaying(ui.nowPlayingOpen && ui.nowPlayingMode === "visualizer" ? "lyrics" : "visualizer");
        else if (k === "/") {
            goto("/music/search").then(() => document.querySelector<HTMLInputElement>("#search-input")?.focus());
        } else if (k === "?") ui.shortcutsOpen = !ui.shortcutsOpen;
        else if (k === "Escape" && ui.shortcutsOpen) ui.shortcutsOpen = false;
        else if (k === "Escape" && ui.nowPlayingOpen) ui.nowPlayingOpen = false;
        else handled = false;

        if (handled) e.preventDefault();
    }
</script>

<svelte:window onkeydown={onKey} onbeforeunload={() => { flushListen(); saveSession(); }} />

<audio
    bind:this={audio}
    bind:paused={playerState.paused}
    bind:currentTime={playerState.currentTime}
    bind:duration={playerState.duration}
    autoplay={restoreAt === null}
    {src}
    onloadedmetadata={() => {
        if (restoreAt !== null && audio) {
            audio.currentTime = Math.min(restoreAt, audio.duration || restoreAt);
            restoreAt = null;
        }
    }}
    onended={onEnded}
    ontimeupdate={accumulatePlaytime}
    onplay={() => {
        analyser.resume();
        updatePositionState();
        if (restoreAt !== null) restoreAt = null;
    }}
    onseeked={() => {
        updatePositionState();
        publishMpris(true);
        untrack(() => publishRPC());
    }}
    onerror={() => {
        if (playerState.stream && playerState.currentTrack)
            handlePlaybackFailure(playerState.currentTrack, new Error("This track could not be played."));
    }}
></audio>
