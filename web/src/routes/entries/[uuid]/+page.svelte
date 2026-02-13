<script lang="ts">
  import EntryEditor from "$lib/components/EntryEditor.svelte";
  import TagInput from "$lib/components/TagInput.svelte";
  import { formatEntryDate } from "$lib/utils/dates";
  import { markdownToHtml } from "$lib/utils/text";

  let { data, form } = $props();

  let editing = $state(false);
  let text = $state("");
  let selectedTags = $state<string[]>([]);
  let starred = $state(false);
  let showDeleteConfirm = $state(false);

  // Initialize from data (avoids state_referenced_locally warning)
  $effect(() => {
    text = data.entry.text ?? "";
    selectedTags = [...data.entry.tags];
    starred = data.entry.starred;
  });
</script>

<svelte:head>
  <title>{formatEntryDate(data.entry.created_at)} - espejo</title>
</svelte:head>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-start justify-between">
    <div>
      <h1 class="text-lg font-semibold">{formatEntryDate(data.entry.created_at)}</h1>
      <div class="mt-1 flex flex-wrap items-center gap-2 text-sm text-stone-500">
        {#if data.entry.city}
          <span>{data.entry.city}{data.entry.country ? `, ${data.entry.country}` : ""}</span>
        {/if}
        {#if data.entry.starred}
          <span>Starred</span>
        {/if}
      </div>
    </div>
    <div class="flex gap-2">
      {#if !editing}
        <button
          onclick={() => (editing = true)}
          class="rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
        >
          Edit
        </button>
      {/if}
      <button
        onclick={() => (showDeleteConfirm = true)}
        class="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
      >
        Delete
      </button>
    </div>
  </div>

  {#if form?.error}
    <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {form.error}
    </div>
  {/if}

  {#if form?.success}
    <div class="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
      Entry updated.
    </div>
  {/if}

  {#if editing}
    <!-- Edit mode -->
    <form method="POST" action="?/update" class="space-y-4">
      <input type="hidden" name="tags" value={selectedTags.join(",")} />
      <input type="hidden" name="starred" value={String(starred)} />
      <input type="hidden" name="text" value={text} />

      <EntryEditor value={text} onInput={(t) => (text = t)} />

      <TagInput
        allTags={data.allTags.map((t) => t.name)}
        selected={selectedTags}
        onUpdate={(tags) => (selectedTags = tags)}
      />

      <div class="flex items-center gap-4">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={starred} class="rounded border-stone-300" />
          Starred
        </label>
      </div>

      <div class="flex gap-3">
        <button
          type="submit"
          class="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
        >
          Save
        </button>
        <button
          type="button"
          onclick={() => (editing = false)}
          class="rounded-lg border border-stone-300 px-4 py-2 text-sm hover:bg-stone-100"
        >
          Cancel
        </button>
      </div>
    </form>
  {:else}
    <!-- View mode -->
    {#if data.entry.tags.length > 0}
      <div class="flex flex-wrap gap-1.5">
        {#each data.entry.tags as tag}
          <span class="rounded-full bg-stone-200 px-2.5 py-0.5 text-xs font-medium text-stone-700">
            {tag}
          </span>
        {/each}
      </div>
    {/if}

    <div class="prose prose-stone max-w-none">
      {@html markdownToHtml(data.entry.text ?? "")}
    </div>

    <!-- Metadata footer -->
    {#if data.entry.weather || data.entry.place_name}
      <div class="border-t border-stone-200 pt-4 text-sm text-stone-500">
        {#if data.entry.weather}
          <p>
            {#if data.entry.weather.conditions}{data.entry.weather.conditions}{/if}
            {#if data.entry.weather.temperature}, {data.entry.weather.temperature}&deg;C{/if}
          </p>
        {/if}
        {#if data.entry.place_name}
          <p>{data.entry.place_name}</p>
        {/if}
      </div>
    {/if}
  {/if}

  <!-- Delete confirmation modal -->
  {#if showDeleteConfirm}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div class="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <h2 class="text-lg font-semibold">Delete Entry?</h2>
        <p class="mt-2 text-sm text-stone-500">
          This action cannot be undone. The entry and all its data will be permanently deleted.
        </p>
        <div class="mt-4 flex justify-end gap-3">
          <button
            onclick={() => (showDeleteConfirm = false)}
            class="rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
          >
            Cancel
          </button>
          <form method="POST" action="?/delete">
            <button
              type="submit"
              class="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
            >
              Delete
            </button>
          </form>
        </div>
      </div>
    </div>
  {/if}
</div>
