<script lang="ts">
    import { playerState } from "$lib/state/player.svelte";

    let lyricsTextCurrent = $state("♪");
    let lyricsTextNext = $state("");

    let currentLyricIndex = $state(-1);
    let transitionStyle = $state("");
    let currentPos = $state("lyric-center");
    let nextPos = $state("lyric-down");

    $effect(() => {
        if (playerState.isLoading) {
            lyricsTextCurrent = 'Loading song...';
            return;
        }

        if (currentLyricIndex < 0) {
            lyricsTextCurrent = '♪';
            // return;
        }

        if (!playerState.lyrics || playerState.lyrics.length === 0) {
            lyricsTextCurrent = "♪ (Lyrics not available)";
            return;
        }

        let newIdx = playerState.lyrics.findIndex(line => line.time > playerState.currentTime) - 1;
        if (newIdx < 0 && playerState.currentTime >= (playerState.lyrics.at(-1)?.time || 0))
            newIdx = playerState.lyrics.length - 1;

        if (newIdx >= 0 && newIdx !== currentLyricIndex) {
            const nextLyricText = playerState.lyrics[newIdx]?.text || '♪';

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
                    lyricsTextNext = playerState.lyrics[newIdx + 1]?.text || '♪';
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