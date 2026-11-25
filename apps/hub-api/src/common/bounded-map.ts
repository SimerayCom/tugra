/**
 * Insert into a Map used as a cache or throttle table and keep it bounded: the entry moves to the newest position and
 * the oldest entries beyond `max` are dropped (Map iterates in insertion order). A dropped entry only costs a
 * recomputation or an earlier-than-usual retry, so this is safe for every cache that is a pure optimisation.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}
