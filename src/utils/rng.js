export function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(a,b,c){
  let x = (a|0) ^ ((b|0)*0x9E3779B1) ^ ((c|0)*0x85EBCA77);
  x = Math.imul(x ^ (x>>>16), 0x7feb352d);
  x = Math.imul(x ^ (x>>>15), 0x846ca68b);
  x = x ^ (x>>>16);
  return x >>> 0;
}

export function randInt(min, max, seed) {
  const r = mulberry32(seed)();
  return Math.floor(r * (max - min + 1)) + min;
}

export function makeRng(seed){
  const f = mulberry32(seed >>> 0);
  return {
    f,
    int(min,max){ return Math.floor(f() * (max - min + 1)) + min; },
    pick(arr){ return arr[Math.floor(f() * arr.length)]; }
  };
}

export const clamp = (n,min,max)=> Math.max(min, Math.min(max, n));
