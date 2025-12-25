// voice/voice_router.js
// Deterministic voice line selector ("Tone Router") for The Marketing Alchemist.
// Usage:
//   import { createVoiceRouter } from "./voice_router.js";
//   const router = createVoiceRouter(voiceBankJson, lexiconsJson);
//   const pick = router.pickLine({ moment:"experiment_intro", act:"ACT_I", thesis:"UR_without_CL", bank:"A", intensity:"standard", historyIds:[...] }, "seed-string");

export function createVoiceRouter(voiceBank, lexicons) {
  const index = buildIndex(voiceBank);

  return {
    pickLine,
    pickMany,
    scoreLine,
    filterLines
  };

  function pickLine(ctx, seedStr) {
    const candidates = filterLines(ctx);
    if (!candidates.length) return null;

    const rng = makeRng(seedStr);
    const scored = candidates
      .map(line => ({ line, score: scoreLine(line, ctx) }))
      .sort((a, b) => b.score - a.score);

    // Choose from top-k to avoid robotic repetition
    const k = Math.min(5, scored.length);
    const chosen = scored[Math.floor(rng.f() * k)].line;
    return chosen;
  }

  function pickMany(ctx, seedStr, count = 6) {
    const rng = makeRng(seedStr);
    let candidates = filterLines(ctx)
      .map(line => ({ line, score: scoreLine(line, ctx) }))
      .sort((a, b) => b.score - a.score)
      .map(x => x.line);

    // Shuffle within top band for variety
    const band = Math.min(12, candidates.length);
    const top = shuffle(candidates.slice(0, band), rng);
    const rest = candidates.slice(band);

    candidates = top.concat(rest);

    const picked = [];
    const seen = new Set(ctx.historyIds || []);
    for (const line of candidates) {
      if (picked.length >= count) break;
      if (seen.has(line.id)) continue;
      picked.push(line);
      seen.add(line.id);
    }
    return picked;
  }

  function filterLines(ctx) {
    const { moment, act = "ANY", thesis = "ANY", bank = "ANY", intensity = "standard" } = ctx;

    // Fast candidate set by moment
    const byMoment = index.byMoment.get(moment) || [];

    // Apply hierarchical filters: act -> thesis -> bank -> intensity (allow ANY fallbacks)
    const out = [];
    for (const line of byMoment) {
      if (!matches(line.act, act)) continue;
      if (!matches(line.thesis, thesis)) continue;
      if (!matches(line.bank, bank)) continue;
      if (!matchesIntensity(line.intensity, intensity)) continue;
      out.push(line);
    }
    // If too few, relax intensity constraint (keep other constraints)
    if (out.length < 3) {
      const relaxed = [];
      for (const line of byMoment) {
        if (!matches(line.act, act)) continue;
        if (!matches(line.thesis, thesis)) continue;
        if (!matches(line.bank, bank)) continue;
        relaxed.push(line);
      }
      return relaxed;
    }
    return out;
  }

  function scoreLine(line, ctx) {
    // Higher is better.
    let s = 0;

    // Exact matches rewarded; ANY is allowed but lower score
    s += matchScore(line.act, ctx.act);
    s += matchScore(line.thesis, ctx.thesis);
    s += matchScore(line.bank, ctx.bank);

    // Intensity proximity: exact best, otherwise small penalty
    s += intensityScore(line.intensity, ctx.intensity);

    // Avoid repetition
    const history = new Set(ctx.historyIds || []);
    if (history.has(line.id)) s -= 10;

    // Prefer lines with signature tokens (optional, small bump)
    if (containsSignatureToken(line.text, lexicons?.signature_tokens || [])) s += 0.5;

    // Prefer tags matching active "sin tags" (panic, overcommitment, etc.)
    const desiredTags = ctx.desiredTags || [];
    if (desiredTags.length && Array.isArray(line.tags)) {
      for (const t of desiredTags) if (line.tags.includes(t)) s += 0.35;
    }

    return s;
  }
}

/* -------------------------
   Index + helpers
------------------------- */

function buildIndex(voiceBank) {
  const byMoment = new Map();
  for (const line of (voiceBank.lines || [])) {
    const m = line.moment;
    if (!byMoment.has(m)) byMoment.set(m, []);
    byMoment.get(m).push(line);
  }
  return { byMoment };
}

function matches(lineValue, ctxValue) {
  // lineValue may be "ANY". ctxValue may be undefined.
  const c = ctxValue || "ANY";
  return (lineValue === "ANY" || lineValue === c);
}

function matchScore(lineValue, ctxValue) {
  const c = ctxValue || "ANY";
  if (lineValue === c) return 2.0;
  if (lineValue === "ANY") return 0.6;
  return -999; // should have been filtered out
}

function matchesIntensity(lineIntensity, desiredIntensity) {
  // allow exact or adjacent if we need to relax later
  return (lineIntensity === desiredIntensity);
}

function intensityScore(lineIntensity, desiredIntensity) {
  const map = { soft: 0, standard: 1, hard: 2 };
  const a = map[lineIntensity] ?? 1;
  const b = map[desiredIntensity] ?? 1;
  const d = Math.abs(a - b);
  if (d === 0) return 1.0;
  if (d === 1) return 0.3;
  return -0.4;
}

function containsSignatureToken(text, signatureTokens) {
  const t = (text || "").toLowerCase();
  for (const tok of signatureTokens) {
    if (t.includes(String(tok).toLowerCase())) return true;
  }
  return false;
}

function makeRng(seedStr) {
  function xmur3(str){
    let h = 1779033703 ^ str.length;
    for (let i=0; i<str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function() {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= (h >>> 16)) >>> 0;
    };
  }
  function mulberry32(a){
    return function() {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const seed = xmur3(String(seedStr || "seed"))();
  const rand = mulberry32(seed);
  return {
    f: () => rand(),
    int: (min, max) => Math.floor(rand() * (max - min + 1)) + min
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i=a.length-1; i>0; i--) {
    const j = Math.floor(rng.f() * (i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
