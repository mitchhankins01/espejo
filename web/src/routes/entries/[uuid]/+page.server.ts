import type { PageServerLoad, Actions } from "./$types";
import { error, redirect, fail } from "@sveltejs/kit";
import { pool } from "$lib/server/db";
import { getEntry, updateEntry, deleteEntry, listAllTags } from "$lib/server/queries";

export const load: PageServerLoad = async ({ params }) => {
  const entry = await getEntry(pool, params.uuid);
  if (!entry) {
    error(404, "Entry not found");
  }

  const allTags = await listAllTags(pool);
  return { entry, allTags };
};

export const actions: Actions = {
  update: async ({ request, params }) => {
    const formData = await request.formData();
    const text = formData.get("text") as string;
    const tagsStr = formData.get("tags") as string | null;

    if (!text || text.trim().length === 0) {
      return fail(400, { error: "Entry text cannot be empty." });
    }

    const tags = tagsStr ? tagsStr.split(",").filter(Boolean) : undefined;

    const updated = await updateEntry(pool, params.uuid, {
      text: text.trim(),
      tags,
    });

    if (!updated) {
      error(404, "Entry not found");
    }

    return { success: true };
  },

  delete: async ({ params }) => {
    const deleted = await deleteEntry(pool, params.uuid);
    if (!deleted) {
      error(404, "Entry not found");
    }
    redirect(303, "/");
  },
};
