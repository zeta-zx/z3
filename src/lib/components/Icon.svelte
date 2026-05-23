<script lang="ts">
    import { icons, type IconProps } from "lucide-svelte";

    let { name = "", ...rest }: IconProps = $props();

    let typedRest = $derived(rest as IconProps);

    function toPascalCase(input: string): string {
        if (/^[A-Z][A-Za-z0-9]*$/.test(input)) {
            return input;
        }

        return input
            .split(/[-_ ]+/)
            .filter(Boolean)
            .map(
                part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
            )
            .join("");
    }


    let pascalName = $derived(toPascalCase(name));

    const IconComponent = $derived((icons as Record<string, any>)[pascalName]);
</script>

{#if IconComponent}
    <IconComponent strokeWidth="2" {...typedRest} />
{:else}
    ❓
{/if}