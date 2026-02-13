<script lang="ts">
  import EntryCard from "$lib/components/EntryCard.svelte";

  let { data } = $props();
</script>

<svelte:head>
  <title>espejo</title>
</svelte:head>

{#if data.entries.length === 0}
  <div class="py-16 text-center">
    <p class="text-lg text-stone-500">No entries yet.</p>
    <a
      href="/entries/new"
      class="mt-4 inline-block rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
    >
      Write your first entry
    </a>
  </div>
{:else}
  <div class="space-y-4">
    {#each data.entries as entry (entry.uuid)}
      <EntryCard {entry} />
    {/each}
  </div>

  {#if data.totalPages > 1}
    <div class="mt-8 flex items-center justify-center gap-4">
      {#if data.page > 1}
        <a
          href="/?page={data.page - 1}"
          class="rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
        >
          Previous
        </a>
      {/if}
      <span class="text-sm text-stone-500">
        Page {data.page} of {data.totalPages}
      </span>
      {#if data.page < data.totalPages}
        <a
          href="/?page={data.page + 1}"
          class="rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
        >
          Next
        </a>
      {/if}
    </div>
  {/if}
{/if}
