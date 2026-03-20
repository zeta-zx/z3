<script lang="ts">
    import { client } from "$lib/ephaptic";
    import Icon from "$lib/components/Icon.svelte";
    import MusicPlayer from "$lib/components/MusicPlayer.svelte";
    import MiniMusicPlayer from "$lib/components/MiniMusicPlayer.svelte";
    import { playerState } from "$lib/state/player.svelte";
    import { page } from "$app/state";
    import { parseLrc } from "$lib/utils";

    let { children } = $props();

    $effect(() => {
        const track = playerState.currentTrack;

        if (!track) {
            playerState.streams = [];
            playerState.lyrics = [];
            playerState.paused = true;
            return;
        }

        playerState.streams = [];
        playerState.lyrics = [];
        playerState.paused = true;
        playerState.currentTime = 0;
        playerState.duration = 0;
        playerState.isLoading = true;

        client!.music_lyrics(`${track.title} - ${track.artists.map(a => a.name).join(', ')}`)
            .then(data => playerState.lyrics = parseLrc(data || ""))
            .catch(console.error);

        client!.music_stream(track.videoId)
            .then(data => {
                playerState.streams = data;
                playerState.isLoading = false;
                playerState.paused = false;
            })
            .catch(err => {
                console.error(err);
            })
            .finally(() => {
                playerState.isLoading = false;
            });

    });

</script>

<div class="layout-grid">
    <aside>
        <nav>
            <ul>
            	<li>
					<a
						href="/music/explore"
						aria-current={page.url.pathname === '/music/explore' ? 'page' : undefined}
					>
						<Icon name="boom-box" /> Explore
					</a>
				</li>
                <li>
					<a
						href="/music/search"
						aria-current={page.url.pathname === '/music/search' ? 'page' : undefined}
					>
						<Icon name="search" /> Search
					</a>
				</li>
				<li>
					<a
						href="/music/library"
						aria-current={page.url.pathname === '/music/library' ? 'page' : undefined}
					>
						<Icon name="library-big" /> Library
					</a>
				</li>
            </ul>
        </nav>

        <br>

        <MiniMusicPlayer />
    </aside>

    <div class="content">
		<main class="container">
            <br />

            <h1 class="zeta"><span class="zcolor"><Icon name="audio-lines" /> Zeta</span> Music</h1>

            <p>What do you want to check out?</p>

            {@render children()}
        </main>
	</div>
</div>

{#if playerState.currentTrack}
    <MusicPlayer />
{/if}