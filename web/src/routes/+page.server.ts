import type { PageServerLoad } from "./$types";
import { pool } from "$lib/server/db";
import { listEntries } from "$lib/server/queries";

export const load: PageServerLoad = async ({ url }) => {
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  const { entries, total } = await listEntries(pool, limit, offset);
  const totalPages = Math.ceil(total / limit);

  return { entries, page, totalPages, total };
};
