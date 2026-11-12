<script lang="ts">
    import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
    import { onMount, untrack } from 'svelte';
    import { nextTrack, previousTrack } from '$lib/state/player.svelte';
    import { audioEffects } from '$lib/state/audio-effects.svelte';
    import { androidPreferences } from '$lib/state/android.svelte';
    import type { Song } from '$lib/schema';

    interface NativeState { id: string; position: number; duration: number; paused: boolean; ready: boolean; ended: boolean; revision: string }
    const native = registerPlugin<{
        setSource(options: { uri: string; id: string; title: string; artist: string; artwork?: string; position: number; paused: boolean; revision: string }): Promise<void>;
        setPaused(options: { paused: boolean; revision: string }): Promise<void>;
        seek(options: { position: number }): Promise<void>;
        setAudioEffects(options: { bands: number[]; leveling: boolean }): Promise<void>;
        setVolume(options: { volume: number }): Promise<void>;
        clear(): Promise<void>;
        takeWidgetCommand(): Promise<{ command?: string }>;
        setKeepAwake(options: { enabled: boolean }): Promise<void>;
        setWidgetTheme(options: { theme: 'artwork' | 'material' }): Promise<void>;
        addListener(name: 'widgetCommand', callback: (event: { command: string }) => void): Promise<PluginListenerHandle>;
        addListener(name: 'state', callback: (state: NativeState) => void): Promise<PluginListenerHandle>;
        addListener(name: 'playbackError', callback: (error: { message: string; id?: string }) => void): Promise<PluginListenerHandle>;
    }>('ZetaPlayer');

    let {
        uri, track, paused = $bindable(true), currentTime = $bindable(0), duration = $bindable(0),
        restoreAt = $bindable<number | null>(null), volume = 1, keepAwake = false,
        onended, ontimeupdate, onerror,
    }: {
        uri?: string; track: Song | null; paused?: boolean; currentTime?: number; duration?: number;
        restoreAt?: number | null; volume?: number; keepAwake?: boolean;
        onended: () => void; ontimeupdate: () => void; onerror: (error: Error) => void;
    } = $props();

    let ready = $state(false);
    let loadedUri: string | undefined;
    let loadedId: string | undefined;
    let nativePosition = 0;
    let endedFor: string | undefined;
    let revision: string;
    let sourceRevision: string;
    let pendingSource = false;
    let requestedPaused = true;
    let widgetCommand = $state<string>();

    onMount(() => {
        let disposed = false;
        const handles: PluginListenerHandle[] = [];
        void Promise.all([
            native.addListener('widgetCommand', ({ command }) => {
                if (!track) return;
                if (uri && command === 'next') nextTrack();
                else if (uri && command === 'previous') previousTrack();
                else widgetCommand = command;
            }),
            native.addListener('state', (state) => {
                if (state.id !== track?.id || !uri || uri !== loadedUri || state.revision !== revision) return;
                pendingSource = false;
                nativePosition = state.position;
                currentTime = state.position;
                duration = state.duration;
                // A new UI intent can exist before the effect has sent it to Android.
                if (paused === requestedPaused) {
                    requestedPaused = state.paused;
                    paused = state.paused;
                }
                ontimeupdate();
                if (state.ready && restoreAt !== null) restoreAt = null;
                if (state.ended && endedFor !== state.id) { endedFor = state.id; onended(); }
                if (!state.ended) endedFor = undefined;
            }),
            native.addListener('playbackError', (error) => {
                if (!error.id || error.id === track?.id) onerror(new Error(error.message));
            }),
        ]).then((listeners) => {
            handles.push(...listeners);
            if (disposed) handles.forEach((handle) => void handle.remove());
            else {
                ready = true;
                void native.takeWidgetCommand().then(({ command }) => {
                    if (!disposed && track && command) widgetCommand = command;
                }).catch(() => {});
            }
        }).catch(onerror);
        return () => {
            disposed = true;
            handles.forEach((handle) => void handle.remove());
            void native.clear().catch(() => {});
            void native.setKeepAwake({ enabled: false }).catch(() => {});
        };
    });

    $effect(() => {
        if (!ready || !uri || !widgetCommand) return;
        const command = widgetCommand;
        widgetCommand = undefined;
        untrack(() => {
            if (command === 'resume') paused = false;
            else if (command === 'next') nextTrack();
            else if (command === 'previous') previousTrack();
        });
    });

    $effect(() => {
        if (!ready) return;
        const nextUri = uri;
        const song = track;
        if (loadedUri === nextUri && loadedId === song?.id) return;
        loadedUri = nextUri;
        loadedId = song?.id;
        endedFor = undefined;
        nativePosition = 0;
        const request = crypto.randomUUID();
        revision = sourceRevision = request;
        pendingSource = true;
        requestedPaused = untrack(() => paused);
        const action = nextUri && song ? native.setSource({
            uri: nextUri, id: song.id, title: song.title, artist: song.artists.map((a) => a.name).join(', '),
            artwork: song.thumbnails.find((t) => t.url?.startsWith('https://'))?.url,
            position: untrack(() => restoreAt ?? 0), paused: requestedPaused, revision: request,
        }) : native.clear();
        void action.catch((error) => { if (sourceRevision === request) onerror(error); });
    });

    $effect(() => {
        if (!ready || !uri || paused === requestedPaused) return;
        requestedPaused = paused;
        const commandRevision = revision = crypto.randomUUID();
        void native.setPaused({ paused, revision: commandRevision }).catch((error) => {
            if (revision === commandRevision) onerror(error);
        });
    });
    $effect(() => {
        if (ready) void native.setAudioEffects({ bands: [...audioEffects.bands], leveling: audioEffects.leveling }).catch(() => {});
    });
    $effect(() => {
        if (ready) void native.setVolume({ volume: volume * volume }).catch(onerror);
    });
    $effect(() => {
        if (ready) void native.setKeepAwake({ enabled: !!uri && keepAwake && !paused }).catch(onerror);
    });
    $effect(() => {
        if (ready) void native.setWidgetTheme({ theme: androidPreferences.widgetTheme }).catch(() => {});
    });
    $effect(() => {
        const position = currentTime;
        if (ready && uri && !pendingSource && Math.abs(position - nativePosition) > 0.8) {
            nativePosition = position;
            void native.seek({ position }).catch(onerror);
        }
    });
</script>
