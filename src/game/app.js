/* =========================
   PHASE 1 UPDATE
   - Introduces sealedUnknown + revealDepthPct
   - Removes hiddenSegs dependency
   - Rendering supports partial reveal
   - Gameplay otherwise unchanged
========================= */

import { ELEMENTS, THESES } from "../../element_schema.js";
import { getJSON, setJSON, setNum } from "../utils/storage.js";
import { makeRng, hashSeed, randInt } from "../utils/rng.js";
import { singleFlight } from "../utils/singleFlight.js";
import { postJSON } from "../utils/http.js";
import { makeToaster, qs } from "../utils/ui.js";

/* ---------------- State ---------------- */
const state = {
  bottles: [],
  capacity: 4,
  selected: -1,
  locked: [],
  sealedUnknown: [],
  revealDepthPct: [],
  stabilizer: null,
};

/* ---------- helpers ---------- */
const topColor = (b) => (b.length ? b[b.length - 1] : null);

function deepCloneBottles(bottles) {
  return bottles.map((b) => b.slice());
}

/* ---------------- Undo ---------------- */
let undoStack = [];
const MAX_UNDO = 3;

function pushUndoSnapshot() {
  undoStack.push({
    bottles: deepCloneBottles(state.bottles),
    locked: state.locked.slice(),
    sealedUnknown: state.sealedUnknown.slice(),
    revealDepthPct: state.revealDepthPct.slice(),
    selected: state.selected,
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function restoreUndoSnapshot() {
  const snap = undoStack.pop();
  if (!snap) return false;

  state.bottles = deepCloneBottles(snap.bottles);
  state.locked = snap.locked.slice();
  state.sealedUnknown = snap.sealedUnknown.slice();
  state.revealDepthPct = snap.revealDepthPct.slice();
  state.selected = snap.selected;

  render();
  redrawAllBottles();
  return true;
}

/* ---------------- Level generation ---------------- */
function generateBottlesFromRecipe(recipe) {
  const rng = makeRng(hashSeed(9999, recipe.colors, recipe.capacity));

  state.capacity = recipe.capacity;
  state.selected = -1;

  const pool = [];
  for (let c = 0; c < recipe.colors; c++) {
    for (let i = 0; i < recipe.capacity; i++) pool.push(c);
  }
  shuffle(pool, rng);

  state.bottles = [];
  let idx = 0;
  const filled = recipe.bottleCount - recipe.emptyBottles;

  for (let i = 0; i < filled; i++) {
    const b = [];
    for (let k = 0; k < recipe.capacity; k++) b.push(pool[idx++]);
    state.bottles.push(b);
  }
  for (let i = 0; i < recipe.emptyBottles; i++) state.bottles.push([]);

  state.locked = new Array(recipe.bottleCount).fill(false);
  state.sealedUnknown = new Array(recipe.bottleCount).fill(false);
  state.revealDepthPct = new Array(recipe.bottleCount).fill(1);

  // TEMP: preserve old behavior (hidden bottles now become sealed unknown)
  const hiddenCount = recipe.lockedBottles || 0;
  for (let i = 0; i < hiddenCount; i++) {
    state.locked[i] = true;
    state.sealedUnknown[i] = true;
    state.revealDepthPct[i] = 1 / state.capacity;
  }
}

/* ---------------- Rendering ---------------- */
const bottleEls = [];
const bottleCanvases = [];

function drawBottleLiquid(i) {
  const canvas = bottleCanvases[i];
  const bottleEl = bottleEls[i];
  if (!canvas || !bottleEl) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, rect.width, rect.height);

  const b = state.bottles[i];
  if (!b || !b.length) return;

  const cap = state.capacity;
  const revealPct = state.revealDepthPct[i] ?? 1;
  const revealedLayers = Math.ceil(revealPct * cap);
  const visibleCount = Math.min(revealedLayers, b.length);

  const h = rect.height / cap;

  for (let s = 0; s < b.length; s++) {
    const idx = b[s];
    const sym = ELEMENTS[currentElements[idx]];
    const y = rect.height - (s + 1) * h;

    if (s >= b.length - visibleCount) {
      ctx.fillStyle = sym.color;
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = "#0b121c";
      ctx.globalAlpha = 0.55;
    }

    ctx.fillRect(0, y, rect.width, h);
  }

  ctx.globalAlpha = 1;
}

/* ---------------- Pour logic ---------------- */
function applyPourState(from, to) {
  pushUndoSnapshot();

  const a = state.bottles[from];
  const b = state.bottles[to];
  const color = topColor(a);
  if (color == null) return;

  a.pop();
  b.push(color);

  if (state.sealedUnknown[from]) {
    const step = 1 / state.capacity;
    state.revealDepthPct[from] = Math.min(
      1,
      state.revealDepthPct[from] + step
    );
  }

  render();
  redrawAllBottles();
}

/* ---------------- Render ---------------- */
function render() {
  grid.innerHTML = "";
  bottleEls.length = 0;
  bottleCanvases.length = 0;

  for (let i = 0; i < state.bottles.length; i++) {
    const btn = document.createElement("button");
    btn.className = "bottle";
    if (state.locked[i]) btn.classList.add("locked");
    if (state.sealedUnknown[i] && state.revealDepthPct[i] < 1)
      btn.classList.add("sealedUnknown");

    btn.onclick = () => handleBottleTap(i);

    const canvas = document.createElement("canvas");
    bottleEls[i] = btn;
    bottleCanvases[i] = canvas;

    btn.appendChild(canvas);
    grid.appendChild(btn);
  }

  redrawAllBottles();
}

function redrawAllBottles() {
  for (let i = 0; i < state.bottles.length; i++) {
    drawBottleLiquid(i);
  }
}

/* ---------------- Input ---------------- */
function handleBottleTap(i) {
  if (state.locked[i]) return;

  if (state.selected < 0) {
    state.selected = i;
    render();
    return;
  }

  if (state.selected === i) {
    state.selected = -1;
    render();
    return;
  }

  applyPourState(state.selected, i);
  state.selected = -1;
}

/* ---------------- Boot ---------------- */
function boot() {
  startLevel();
}

boot();

