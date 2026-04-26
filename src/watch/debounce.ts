/**
 * Returns a debounced version of fn that waits `delayMs` after the last call.
 * Uses debounce (not throttle) per spec § 3.6.
 */
export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  delayMs: number
): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
}
