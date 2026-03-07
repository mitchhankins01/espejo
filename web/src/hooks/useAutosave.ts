import { useRef, useCallback, useEffect } from "react";

export function useAutosave(
  save: () => Promise<void>,
  debounceMs = 1500
): { trigger: () => void; cancel: () => void } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const trigger = useCallback(() => {
    cancel();
    timerRef.current = setTimeout(() => {
      void saveRef.current();
    }, debounceMs);
  }, [cancel, debounceMs]);

  useEffect(() => cancel, [cancel]);

  return { trigger, cancel };
}
