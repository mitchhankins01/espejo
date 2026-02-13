<script lang="ts">
  interface Props {
    value: string;
    onInput: (text: string) => void;
    readonly?: boolean;
  }

  let { value, onInput, readonly = false }: Props = $props();
</script>

<div class="rounded-lg border border-stone-300 bg-white">
  {#if readonly}
    <div class="prose prose-stone max-w-none whitespace-pre-wrap p-4">
      {value}
    </div>
  {:else}
    <textarea
      {value}
      oninput={(e) => onInput(e.currentTarget.value)}
      placeholder="Write your entry..."
      rows={16}
      class="w-full resize-y rounded-lg border-0 p-4 text-sm leading-relaxed text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-0"
    ></textarea>
  {/if}
</div>
