import { useEffect, useRef } from "react";

/**
 * Runs `callback` exactly once per distinct new truthy `value`.
 *
 * Why this exists: `useEffect(() => { ... }, [fetcher.data])` (or
 * `[actionData]`) is the natural pattern for reacting to a server response,
 * but the effect re-fires on any re-render where the value stays the *same*
 * truthy reference. In practice this happens after every
 * `revalidator.revalidate()`, every parent re-render, every
 * `useNavigation()` transition, etc. — causing duplicate toast notifications
 * that keep popping up from the bottom until the user navigates away.
 *
 * This hook tracks the last-seen value in a ref and only calls the callback
 * when the reference (or primitive value) actually changes to a new truthy
 * one. The callback is read via a ref too, so consumers don't need to wrap
 * it in `useCallback` and don't have to worry about stale closures on
 * `appBridge`, `navigate`, etc.
 *
 * Usage:
 *
 *   useNewValueEffect(fetcher.data, (data) => {
 *     if ("deleted" in data && data.deleted) appBridge.toast.show("Deleted");
 *   });
 *
 *   // Works for search-param toasts too:
 *   useNewValueEffect(searchParams.get("toast"), (value) => {
 *     if (value === "field_saved") appBridge.toast.show("Field saved");
 *   });
 */
export function useNewValueEffect<T>(
  value: T,
  callback: (value: NonNullable<T>) => void,
): void {
  const lastSeenRef = useRef<T | undefined>(undefined);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (value && value !== lastSeenRef.current) {
      lastSeenRef.current = value;
      callbackRef.current(value as NonNullable<T>);
    }
  }, [value]);
}
