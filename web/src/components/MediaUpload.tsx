import { useEffect, useMemo, useRef, useState } from "react";

export function mediaUploadKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function MediaUpload({
  files,
  onChange,
  progressByKey,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  progressByKey?: Record<string, number>;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const previews = useMemo(
    () =>
      files.map((file) => ({
        key: mediaUploadKey(file),
        file,
        url: URL.createObjectURL(file),
      })),
    [files]
  );

  useEffect(() => {
    return () => {
      for (const item of previews) {
        URL.revokeObjectURL(item.url);
      }
    };
  }, [previews]);

  function addFiles(list: FileList | null): void {
    if (!list) return;
    const incoming = Array.from(list).filter((file) =>
      file.type.startsWith("image/")
    );
    if (incoming.length === 0) return;

    const existing = new Set(files.map(mediaUploadKey));
    const deduped = incoming.filter((file) => !existing.has(mediaUploadKey(file)));
    if (deduped.length === 0) return;
    onChange([...files, ...deduped]);
  }

  function removeFile(target: File): void {
    const key = mediaUploadKey(target);
    onChange(files.filter((file) => mediaUploadKey(file) !== key));
  }

  return (
    <div className="space-y-3">
      <div
        className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
          isDragging
            ? "border-pine-500 bg-pine-500/10"
            : "border-border bg-surface-elevated"
        }`}
        onDragOver={(event) => {
          event.preventDefault();
          if (disabled) return;
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (disabled) return;
          addFiles(event.dataTransfer.files);
        }}
      >
        <p className="text-sm text-text-primary">Drop images here or</p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="mt-2 px-3 py-1.5 rounded-md border border-border bg-surface text-sm font-medium text-text-primary hover:bg-border disabled:opacity-50"
        >
          Choose files
        </button>
        <p className="text-xs text-text-muted mt-2">Images only. Max 10MB each.</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => addFiles(event.target.files)}
        />
      </div>

      {previews.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {previews.map(({ key, file, url }) => {
            const progress = progressByKey?.[key];
            const uploading = typeof progress === "number" && progress < 100;
            return (
              <div key={key} className="relative rounded-lg overflow-hidden border border-border bg-surface">
                <img src={url} alt={file.name} className="w-full h-24 object-cover" />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => removeFile(file)}
                  className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/65 text-white text-xs disabled:opacity-50"
                  aria-label={`Remove ${file.name}`}
                >
                  ×
                </button>
                <div className="px-2 py-1">
                  <div className="text-[11px] text-text-muted truncate" title={file.name}>
                    {file.name}
                  </div>
                  {typeof progress === "number" && (
                    <div className="mt-1">
                      <div className="h-1.5 rounded-full bg-surface-elevated overflow-hidden">
                        <div
                          className="h-full bg-pine-600 dark:bg-pine-500 transition-all"
                          style={{ width: `${Math.max(0, Math.min(progress, 100))}%` }}
                        />
                      </div>
                      <div className="text-[10px] text-text-muted mt-0.5">
                        {uploading ? `Uploading ${progress}%` : "Uploaded"}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
