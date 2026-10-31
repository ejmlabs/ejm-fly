/**
 * The item at `index` (or `key`) that the caller keeps in range. A missing item is a bug in that range, so it throws
 * instead of letting `undefined` spread through the scene. Numeric arrays read inside their own loop bounds use
 * `?? 0` instead, which keeps hot loops free of the call.
 */
export function item<T>(items: Readonly<Record<number, T>>, index: number): T;
export function item<T>(items: Readonly<Record<string, T>>, key: string): T;
export function item<T>(items: Readonly<Record<number | string, T>>, key: number | string): T {
  const found = items[key];
  if (found === undefined) throw new RangeError(`No item at ${String(key)}`);
  return found;
}

/** The last item of a list the caller knows is not empty. */
export function last<T>(items: ArrayLike<T>): T {
  return item(items, items.length - 1);
}
