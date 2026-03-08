import { useMemo, useState } from "react";
import type { EntryMedia } from "../api.ts";

export function MediaGallery({
  media,
  onDelete,
  deletingId,
}: {
  media: EntryMedia[];
  onDelete?: (id: number) => Promise<void> | void;
  deletingId?: number | null;
}) {
  const photos = useMemo(
    () => media.filter((item) => item.type === "photo" && !!item.url),
    [media]
  );
  const [openId, setOpenId] = useState<number | null>(null);

  const active = photos.find((item) => item.id === openId) ?? null;

  if (photos.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
        No photos yet.
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {photos.map((item) => (
          <div key={item.id} className="relative rounded-lg overflow-hidden border border-border bg-surface">
            <button type="button" onClick={() => setOpenId(item.id)} className="w-full">
              <img src={item.url} alt={`Photo ${item.id}`} className="h-28 w-full object-cover" />
            </button>
            {onDelete && (
              <button
                type="button"
                disabled={deletingId === item.id}
                onClick={() => void onDelete(item.id)}
                className="absolute top-1 right-1 px-2 py-1 rounded-md bg-black/65 text-white text-xs disabled:opacity-50"
              >
                {deletingId === item.id ? "..." : "Delete"}
              </button>
            )}
          </div>
        ))}
      </div>

      {active && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setOpenId(null)}
        >
          <div
            className="relative max-w-5xl max-h-full"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpenId(null)}
              className="absolute -top-10 right-0 h-8 w-8 rounded-full bg-white/20 text-white"
              aria-label="Close image"
            >
              ×
            </button>
            <img
              src={active.url}
              alt={`Photo ${active.id}`}
              className="max-w-full max-h-[85vh] rounded-lg"
            />
          </div>
        </div>
      )}
    </>
  );
}
