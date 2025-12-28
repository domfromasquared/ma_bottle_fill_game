export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...nums){
  let h = 2166136261 >>> 0;
  for (const n of nums){
    const x = (Number(n) >>> 0);
    h ^= x;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function makeRng(seed){
  const f = mulberry32(seed >>> 0);
  return {
    f,
    int(min, max){
      return Math.floor(f() * (max - min + 1)) + min;
    },
    pick(arr){
      return arr[Math.floor(f() * arr.length)];
    }
  };
}

export function randInt(min, max, seed){
  return makeRng(seed).int(min, max);
}
