<script lang="ts">
  import EntryEditor from "$lib/components/EntryEditor.svelte";
  import TagInput from "$lib/components/TagInput.svelte";

  let { data, form } = $props();

  let text = $state("");
  let selectedTags = $state<string[]>([]);
</script>

<svelte:head>
  <title>New Entry - espejo</title>
</svelte:head>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">New Entry</h1>
  </div>

  {#if form?.error}
    <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {form.error}
    </div>
  {/if}

  <form method="POST" class="space-y-4">
    <input type="hidden" name="tags" value={selectedTags.join(",")} />
    <input type="hidden" name="text" value={text} />

    <EntryEditor value={text} onInput={(t) => (text = t)} />

    <TagInput
      allTags={data.allTags.map((t) => t.name)}
      selected={selectedTags}
      onUpdate={(tags) => (selectedTags = tags)}
    />

    <div class="flex gap-3">
      <button
        type="submit"
        class="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
      >
        Save Entry
      </button>
      <a
        href="/"
        class="rounded-lg border border-stone-300 px-4 py-2 text-sm hover:bg-stone-100"
      >
        Cancel
      </a>
    </div>
  </form>
</div>
