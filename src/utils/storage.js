export function getJSON(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
export function setJSON(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}

export function getNum(key, fallback=0){
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v !== 0 ? v : fallback;
}
export function setNum(key, n){
  localStorage.setItem(key, String(Number(n)));
}
export function del(key){
  localStorage.removeItem(key);
}
