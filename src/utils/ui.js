export function qs(id){
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

export function makeToaster(el){
  let t = null;
  return function show(msg, ms=1400){
    if (!msg) return;
    el.textContent = String(msg);
    el.classList.add("show");
    clearTimeout(t);
    t = setTimeout(()=> el.classList.remove("show"), ms);
  };
}

export function playPourFX(pourFX, fromIdx, toIdx, color, amount){
  // Very lightweight: just spark near center of screen; replace later if you want bottle-anchored coords.
  const x = 50 + (Math.random()*10-5);
  const y = 70 + (Math.random()*10-5);
  pourFX.style.left = x + "%";
  pourFX.style.top = y + "%";
  pourFX.style.background = color || "#fff";
  pourFX.style.opacity = "1";
  pourFX.style.transform = "translate(-50%,-50%) scale(" + (1 + Math.min(2, amount)*0.25) + ")";
  setTimeout(()=>{ pourFX.style.opacity="0"; }, 140);
}
