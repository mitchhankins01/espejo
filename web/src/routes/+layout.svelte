<script lang="ts">
  import "../app.css";

  let { children } = $props();
</script>

<div class="min-h-screen bg-stone-50 text-stone-900">
  <nav class="border-b border-stone-200 bg-white">
    <div class="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
      <a href="/" class="text-lg font-semibold tracking-tight">espejo</a>
      <a
        href="/entries/new"
        class="rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800"
      >
        New Entry
      </a>
    </div>
  </nav>

  <main class="mx-auto max-w-3xl px-4 py-6">
    {@render children()}
  </main>
</div>
