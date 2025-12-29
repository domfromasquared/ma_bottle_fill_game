// src/game/dmAssets.js
// DM mood → asset path helpers

export const DM_MOODS = [
  "amused",
  "annoyed",
  "disappointed",
  "encouraging",
  "frustrated",
  "furious",
  "impressed",
  "proud",
  "satisfied",
];

export const DM_FRAME_COUNT = 6; // MA_000.png .. MA_005.png

export function normalizeMood(mood) {
  const m = String(mood || "").trim().toLowerCase();
  return DM_MOODS.includes(m) ? m : "encouraging";
}

export function dmFrameName(frameIndex = 0) {
  const i = Math.max(0, Math.min(DM_FRAME_COUNT - 1, Number(frameIndex) || 0));
  return `MA_${String(i).padStart(3, "0")}.png`;
}

// IMPORTANT: URL should be relative to index.html (repo root) since we set it via style/background-image.
export function dmImagePath(mood, frameIndex = 0) {
  const m = normalizeMood(mood);
  return `assets/dm/${m}/${dmFrameName(frameIndex)}`;
}

// light preload so the slide-in doesn’t “pop”
const _cache = new Map();
export function preloadImage(url) {
  if (!url || _cache.has(url)) return;
  const img = new Image();
  img.decoding = "async";
  img.loading = "eager";
  img.src = url;
  _cache.set(url, img);
}

export function preloadMood(mood) {
  // preload only MA_000 for that mood (keep mobile memory sane)
  preloadImage(dmImagePath(mood, 0));
}
