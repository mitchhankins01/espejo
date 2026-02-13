<script lang="ts">
  interface Props {
    allTags: string[];
    selected: string[];
    onUpdate: (tags: string[]) => void;
  }

  let { allTags, selected, onUpdate }: Props = $props();

  let inputValue = $state("");
  let showSuggestions = $state(false);

  const suggestions = $derived(
    inputValue.length > 0
      ? allTags
          .filter(
            (tag) =>
              tag.toLowerCase().includes(inputValue.toLowerCase()) &&
              !selected.includes(tag)
          )
          .slice(0, 8)
      : []
  );

  function addTag(tag: string): void {
    const normalized = tag.trim().toLowerCase();
    if (normalized && !selected.includes(normalized)) {
      onUpdate([...selected, normalized]);
    }
    inputValue = "";
    showSuggestions = false;
  }

  function removeTag(tag: string): void {
    onUpdate(selected.filter((t) => t !== tag));
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0) {
        addTag(suggestions[0]);
      } else if (inputValue.trim()) {
        addTag(inputValue);
      }
    }
    if (e.key === "Backspace" && !inputValue && selected.length > 0) {
      removeTag(selected[selected.length - 1]);
    }
  }
</script>

<div class="space-y-2">
  <label for="tag-input" class="text-sm font-medium text-stone-700">Tags</label>

  {#if selected.length > 0}
    <div class="flex flex-wrap gap-1.5">
      {#each selected as tag}
        <button
          type="button"
          onclick={() => removeTag(tag)}
          class="flex items-center gap-1 rounded-full bg-stone-200 px-2.5 py-0.5 text-xs font-medium text-stone-700 hover:bg-stone-300"
        >
          {tag}
          <span class="text-stone-400">&times;</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="relative">
    <input
      id="tag-input"
      type="text"
      bind:value={inputValue}
      onfocus={() => (showSuggestions = true)}
      onblur={() => setTimeout(() => (showSuggestions = false), 200)}
      onkeydown={handleKeydown}
      placeholder="Add tag..."
      class="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-500"
    />

    {#if showSuggestions && suggestions.length > 0}
      <div class="absolute z-10 mt-1 w-full rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
        {#each suggestions as suggestion}
          <button
            type="button"
            class="block w-full px-3 py-1.5 text-left text-sm hover:bg-stone-100"
            onmousedown={() => addTag(suggestion)}
          >
            {suggestion}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
