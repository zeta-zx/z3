<script lang="ts">
    import { playerState } from "$lib/state/player.svelte";
    import { parseLrc } from "$lib/utils";

    let lyricsTextCurrent = $state("♪");
    let lyricsTextNext = $state("");

    let currentLyricIndex = $state(-1);
    let transitionStyle = $state("");
    let currentPos = $state("lyric-center");
    let nextPos = $state("lyric-down");

    let lyrics = $derived(parseLrc(playerState?.currentTrack?.lyrics ?? '') || playerState.lyrics);

    $effect(() => {
        if (playerState.isLoading) {
            lyricsTextCurrent = 'Loading song...';
            return;
        }

        if (currentLyricIndex < 0) {
            lyricsTextCurrent = '♪';
            // return;
        }

        if (!lyrics) {
            lyricsTextCurrent = "♪ (Lyrics not available)";
            return;
        }

        let newIdx = lyrics.findIndex(line => line.time > playerState.currentTime) - 1;
        if (newIdx < 0 && playerState.currentTime >= (lyrics.at(-1)?.time || 0))
            newIdx = lyrics.length - 1;

        if (newIdx >= 0 && newIdx !== currentLyricIndex) {
            const nextLyricText = lyrics[newIdx]?.text || '♪';

            transitionStyle = "none";
            nextPos = "lyric-down";
            lyricsTextNext = nextLyricText;

            requestAnimationFrame(() => {
                transitionStyle = "opacity 0.3s ease-out, transform 0.3s ease-out";
                currentPos = "lyric-up";
                nextPos = "lyric-center";

                setTimeout(() => {
                    lyricsTextCurrent = nextLyricText;
                    transitionStyle = "none";
                    currentPos = "lyric-center";
                    nextPos = "lyric-down";
                    lyricsTextNext = lyrics[newIdx + 1]?.text || '♪';
                }, 300);
            });

            currentLyricIndex = newIdx;
        }

    });
</script>

<span
    class="lyric-line {currentPos}"
    style="transition: {transitionStyle}"
>{lyricsTextCurrent}</span>

<span
    class="lyric-line {nextPos}"
    style="transition: {transitionStyle}"
>{lyricsTextNext}</span>