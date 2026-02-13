<script lang="ts">
  import type { JournalEntry } from "@espejo/shared";
  import { formatEntryDate, formatRelativeDate } from "$lib/utils/dates";
  import { truncateText, stripMarkdown } from "$lib/utils/text";

  interface Props {
    entry: JournalEntry;
  }

  let { entry }: Props = $props();

  const preview = $derived(entry.text ? truncateText(stripMarkdown(entry.text), 200) : "No text");
</script>

<a
  href="/entries/{entry.uuid}"
  class="block rounded-lg border border-stone-200 bg-white p-4 transition-colors hover:border-stone-300 hover:bg-stone-50"
>
  <div class="flex items-start justify-between gap-4">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium text-stone-900">
          {formatEntryDate(entry.created_at)}
        </span>
        <span class="text-xs text-stone-400">
          {formatRelativeDate(entry.created_at)}
        </span>
        {#if entry.starred}
          <span class="text-xs text-amber-500">Starred</span>
        {/if}
      </div>

      {#if entry.city}
        <p class="mt-0.5 text-xs text-stone-500">
          {entry.city}{entry.country ? `, ${entry.country}` : ""}
        </p>
      {/if}

      <p class="mt-2 text-sm leading-relaxed text-stone-700">
        {preview}
      </p>

      {#if entry.tags.length > 0}
        <div class="mt-2 flex flex-wrap gap-1">
          {#each entry.tags as tag}
            <span class="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">
              {tag}
            </span>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</a>
