/** Deletes the oldest entries (first inserted) of a Map or Set until at most `cap` remain: every cache's bound. */
export function trimOldest<K>(entries: Map<K, unknown> | Set<K>, cap: number): void {
  // Caches call this on every hit; under the cap it costs one comparison.
  if (entries.size <= cap) return;
  for (const key of entries.keys()) {
    entries.delete(key);
    if (entries.size <= cap) return;
  }
}
