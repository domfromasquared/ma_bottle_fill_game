export function makeToaster(toastEl){
  let t = null;
  return function showToast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    if (t) clearTimeout(t);
    t = setTimeout(()=>toastEl.classList.remove("show"), 1500);
  };
}

export function qs(id){ return document.getElementById(id); }

export function bottleCenter(i){
  const el = document.querySelector(`[data-bottle="${i}"]`);
  if(!el) return {x:innerWidth/2,y:innerHeight/2};
  const r = el.getBoundingClientRect();
  return {x:r.left+r.width/2, y:r.top+r.height/4};
}

export function playPourFX(pourFX, from, to, color, amount){
  const a=bottleCenter(from), b=bottleCenter(to);
  pourFX.style.background=color;
  pourFX.style.opacity="1";
  pourFX.style.left=a.x+"px"; pourFX.style.top=a.y+"px";
  const dx=b.x-a.x, dy=b.y-a.y;
  const dur=Math.max(260, Math.min(580, 220+amount*90));
  pourFX.animate([
    { transform:"translate(-50%,-50%) scale(1)", opacity:0.9 },
    { transform:`translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.9)`, opacity:0.85 },
    { transform:`translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.7)`, opacity:0.0 }
  ], { duration:dur, easing:"cubic-bezier(.2,.8,.2,1)" });
  setTimeout(()=> pourFX.style.opacity="0", dur);
}
