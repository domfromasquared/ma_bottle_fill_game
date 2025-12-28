export async function postJSON(apiBase, path, body){
  const url = apiBase.replace(/\/+$/,"") + path;
  const res = await fetch(url, {
    method:"POST",
    headers: { "content-type":"application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try{ json = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!res.ok){
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.detailText = text;
    err.payload = json;
    throw err;
  }
  return json;
}
