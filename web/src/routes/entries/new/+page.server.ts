import type { Actions } from "./$types";
import { redirect, fail } from "@sveltejs/kit";
import { pool } from "$lib/server/db";
import { createEntry, listAllTags } from "$lib/server/queries";

export async function load() {
  const tags = await listAllTags(pool);
  return { allTags: tags };
}

export const actions: Actions = {
  default: async ({ request }) => {
    const formData = await request.formData();
    const text = formData.get("text") as string;
    const tagsStr = formData.get("tags") as string | null;

    if (!text || text.trim().length === 0) {
      return fail(400, { error: "Entry text cannot be empty." });
    }

    const tags = tagsStr ? tagsStr.split(",").filter(Boolean) : undefined;

    const entry = await createEntry(pool, {
      text: text.trim(),
      tags,
    });

    redirect(303, `/entries/${entry.uuid}`);
  },
};
