<script lang="ts">
    import { client } from "$lib/ephaptic";
    import Icon from "$lib/components/Icon.svelte";
    import { toTitleCase } from "$lib/utils";

    const isSearchDisabled = true;

    const options = [
        {
            name: 'music',
            icon: 'audio-lines',
            enabled: true,
        },
        {
            name: 'movies',
            icon: 'clapperboard',
        },
        {
            name: 'anime',
            icon: 'balloon',
        },
        {
            name: 'manga',
        },
    ];
</script>

<br />

<h1>Welcome to <span style="color: var(--pico-primary)">Zeta</span>!</h1>
<p>Zeta has been deployed.</p>

<p>What do you want to check out?</p>

{#each options as option}
    <a href="/{option.name}">
        <button disabled={!option.enabled}>
            {#if option.icon}<Icon name={option.icon} />{/if}
            {toTitleCase(option.name)}
        </button>
    </a>
    {' '}
{/each}

<br><br>

<fieldset role="search">
    <input disabled={isSearchDisabled} type="search" placeholder="Search... for anything!">
    <select disabled={isSearchDisabled} style="width:10rem;">
        {#each options as option}
            {#if option.enabled}
                <option>{toTitleCase(option.name)}</option>
            {/if}
        {/each}
    </select>
    <button disabled={isSearchDisabled}><Icon name="search" /></button>
</fieldset>

{#if isSearchDisabled}
    <small style="text-align: right;">
        Search is disabled for now as we work on Zeta.
    </small>
{/if}