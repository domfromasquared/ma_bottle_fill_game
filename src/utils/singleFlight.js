const inflight = new Map();

/** Dedup concurrent calls with same key. */
export function singleFlight(key, fn){
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => { try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}
