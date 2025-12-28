const inflight = new Map();

export async function singleFlight(key, fn){
  if (inflight.has(key)) return inflight.get(key);
  const p = (async ()=>{
    try { return await fn(); }
    finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}
