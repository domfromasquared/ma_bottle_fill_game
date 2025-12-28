export async function postJSON(baseUrl, path, body){
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const url = base + path;
  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok){
    let detailText = "";
    try { detailText = await r.text(); } catch {}
    const retryAfter = r.headers.get("Retry-After");
    const err = new Error(`${r.status} ${r.statusText}${retryAfter ? ` (Retry-After: ${retryAfter}s)` : ""}`);
    err.status = r.status;
    err.retryAfter = retryAfter ? Number(retryAfter) : null;
    err.detailText = detailText;
    throw err;
  }
  return await r.json();
}
