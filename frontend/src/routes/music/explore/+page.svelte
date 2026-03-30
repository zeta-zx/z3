<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import Result from "$lib/components/Result.svelte";
    import { client } from "$lib/ephaptic";
    import type { ExploreResult, MoodOrGenre } from "$lib/schema";
    import { createPlaceholderUrl, Font, randomChoice } from "$lib/utils";
    import { onMount } from "svelte";

    let results = $state<ExploreResult>();

    onMount(async () => {
        results = await client!.music_explore();
    });

    $inspect(results);

    function getMoodBg(mood: MoodOrGenre): string {
        const colors: Record<string, string> = {
            "Chill": "4682b4", // SteelBlue
            "Commute": "708090", // SlateGray
            "Energize": "ffd700", // Gold
            "Feel good": "ff69b4", // HotPink
            "Focus": "20b2aa", // LightSeaGreen
            "Gaming": "8a2be2", // BlueViolet
            "Party": "ff4500", // OrangeRed
            "Sad": "191970", // MidnightBlue
            "Workout": "32cd32", // LimeGreen
            "Rock": "b22222", // FireBrick
            "Jazz": "daa520", // GoldenRod
            "Pop": "ff00ff", // Magenta
            "Rap & hip-hop": "4b0082", // Indigo
        };

        let color;
        const title = mood.title;
        if (colors[title]) color = colors[title];
        let hash = 0;
        for (let i = 0; i < title.length; i++) {
            hash = title.charCodeAt(i) + ((hash << 5) - hash);
        }
        const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
        color = "00000".substring(0, 6 - c.length) + c;

        return createPlaceholderUrl({
            width: 512,
            height: 512,
            backgroundColor: color,
            textColor: "ffffff",
            text: mood.title,
            font: randomChoice(Object.values(Font)),
        });
    }
</script>

{#if !results}
    <Icon name="loader-circle" class='loader' />
{:else}
    {@const moods_and_genres = results.moods_and_genres}
    {@const new_releases = results.new_releases}
    {@const new_videos = results.new_videos}
    {@const top_episodes = results.top_episodes}
    {@const top_songs = results.top_songs}
    {@const trending = results.trending}

    {#if moods_and_genres}
        <h2>Moods And Genres</h2>
        <div class="moods">
            {#each moods_and_genres as mood (mood.title)}
                <img src={getMoodBg(mood)}>
            {/each}
        </div>
        <br />
    {/if}

    {#if new_releases}
        <h2>New Releases</h2>
        <div class="results explore-results">
            {#each new_releases as release}
                <Result result={release} handleClick={() => {}} />
            {/each}
        </div>
        <br />
    {/if}

    {#if new_videos}
        <h2>New Videos</h2>
        <div class="results explore-results">
            {#each new_videos as video}
                <Result result={video} handleClick={() => {}} />
            {/each}
        </div>
        <br />
    {/if}

    {#if top_episodes}
        <h2>Top Episodes</h2>
        <div class="results explore-results">
            {#each top_episodes as episode}
                <Result result={episode} handleClick={() => {}} />
            {/each}
        </div>
        <br />
    {/if}

    {#if top_songs}
        <h2>Top Songs</h2>
        <div class="results explore-results">
            {#each top_songs.items as song}
                <Result result={song} handleClick={() => {}} />
            {/each}
        </div>
        <br />
    {/if}

    {#if trending}
        <h2>Trending</h2>
        <div class="results explore-results">
            {#each trending.items as item}
                <Result result={item} handleClick={() => {}} />
            {/each}
        </div>
        <br />
    {/if}
{/if}