/* ============================================================
   MA Bottle Fill Game — Core Logic
   UPDATED: Corked vs Sealed Unknown + revealDepthPct
   ============================================================ */

import { ELEMENTS, THESES } from "../../element_schema.js";
import { getJSON, setJSON, setNum } from "../utils/storage.js";
import { makeRng, hashSeed, randInt } from "../utils/rng.js";
import { singleFlight } from "../utils/singleFlight.js";
import { postJSON } from "../utils/http.js";
import { makeToaster, qs } from "../utils/ui.js";

/* ---------------- Constants ---------------- */
const FORESHADOW_START_LEVEL = 10;
const STABILIZER_UNLOCK_LEVEL = 15;

const DEFAULT_PROD = "https://ma-bottle-fill-api.onrender.com";
const DEFAULT_LOCAL = "http://localhost:8787";
const isLocal =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

const INVALID_POUR_PUNISH_THRESHOLD = 3;
const SIN_QUEUE_KEY = "ma_sinQueue";

const PLAYER_NAME_KEY = "ma_playerName";
const PLAYER_NAME_MAX = 14;
const DEFAULT_PLAYER_NAME = "Acolyte";

const SPEECH_THEME_KEY = "ma_speechTheme";
const API_BASE_KEY = "ma_apiBase";

const RUN_SEED_KEY = "ma_runSeed";
const DM_COUNT_KEY = "ma_dmAppearCount";
const NEXT_DM_KEY = "ma_nextDMAtLevel";

const INTRO_SEEN_KEY = "ma_introSeen";
const NAME_PROMPTED_KEY = "ma_namePrompted";

/* ---------------- Anim constants ---------------- */
const MOVE_ANIM_MS = 600;
const TILT_MAX_DEG = 28;
const INPUT_LOCK_PADDING_MS = 0;

/* ============================================================
   STATE
   ============================================================ */

const state = {
  bottles: [],
  capacity: 4,
  selected: -1,

  // Interaction lock only (corked bottles)
  locked: [],

  // NEW: semantic flag
  sealedUnknown: [],

  // NEW: 0..1 reveal depth (percentage of capacity)
  revealDepthPct: [],

  stabilizer: null,
};

/* ============================================================
   HELPERS
   ============================================================ */

const topColor = (b) => (b.length ? b[b.length - 1] : null);

function topRunCount(b) {
  if (!b.length) return 0;
  const c = topColor(b);
  let n = 0;
  for (let i = b.length - 1; i >= 0; i--) {
    if (b[i] === c) n++;
    else break;
  }
  return n;
}

function isSolved() {
  return state.bottles.every((b) => {
    if (b.length === 0) return true;
    if (b.length !== state.capacity) return false;
    return b.every((x) => x === b[0]);
  });
}

function canPour(from, to) {
  if (from === to) return false;
  if (state.locked[from] || state.locked[to]) return false;

  const a = state.bottles[from];
  const b = state.bottles[to];

  if (!a.length) return false;
  if (b.length >= state.capacity) return false;

  const color = topColor(a);
  const target = topColor(b);

  return target === null || target === color;
}

/* ============================================================
   LEVEL GENERATION (LOCAL)
   ============================================================ */

function buildLocalRecipe() {
  return {
    colors: 4,
    bottleCount: 6,
    capacity: 4,
    emptyBottles: 2,

    // OLD name kept for now — interpreted as corked
    lockedBottles: 1,

    // NEW: sealed unknown count (optional)
    sealedUnknownBottles: 1,

    elements: Object.keys(ELEMENTS).slice(0, 4),
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng.f() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function generateBottlesFromRecipe(recipe) {
  const rng = makeRng(hashSeed(999, recipe.colors, recipe.capacity));

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
  for (let b = 0; b < filled; b++) {
    const bottle = [];
    for (let k = 0; k < recipe.capacity; k++) bottle.push(pool[idx++]);
    state.bottles.push(bottle);
  }
  for (let e = 0; e < recipe.emptyBottles; e++) state.bottles.push([]);

  const n = state.bottles.length;

  state.locked = new Array(n).fill(false);
  state.sealedUnknown = new Array(n).fill(false);
  state.revealDepthPct = new Array(n).fill(1);

  /* ----- Corked bottles (visible but interaction-locked) ----- */
  const corked = Math.min(recipe.lockedBottles || 0, n);
  for (let i = 0; i < corked; i++) {
    state.locked[i] = true;
  }

  /* ----- Sealed Unknown bottles (pourable, partial info) ----- */
  const unk = Math.min(recipe.sealedUnknownBottles || 0, n);
  for (let i = corked; i < corked + unk; i++) {
    state.sealedUnknown[i] = true;
    state.revealDepthPct[i] = 1 / state.capacity;
  }
}

/* ============================================================
   POUR LOGIC (REVEAL ON POUR)
   ============================================================ */

function applyPourState(from, to) {
  const a = state.bottles[from];
  const b = state.bottles[to];

  const run = topRunCount(a);
  const space = state.capacity - b.length;
  const amount = Math.min(run, space);

  for (let i = 0; i < amount; i++) b.push(a.pop());

  // 🔓 Reveal one segment if source is sealed unknown
  if (state.sealedUnknown[from]) {
    state.revealDepthPct[from] = Math.min(
      1,
      state.revealDepthPct[from] + 1 / state.capacity
    );
  }

  if (isSolved()) {
    alert("Solved!");
  }
}

/* ============================================================
   RENDERING (LOGIC ONLY — VISUAL FOG VIA CANVAS/CSS)
   ============================================================ */

function drawBottleLiquid(i, ctx, w, h) {
  const b = state.bottles[i];
  if (!b.length) return;

  const cap = state.capacity;
  const revealPct = state.revealDepthPct[i] ?? 1;
  const revealedLayers = Math.ceil(revealPct * cap);

  for (let s = 0; s < b.length; s++) {
    const idx = b[s];
    const isVisible = s >= b.length - revealedLayers;

    ctx.fillStyle = isVisible
      ? ELEMENTS[Object.keys(ELEMENTS)[idx]].color
      : "rgba(30,30,30,0.6)"; // clouded

    ctx.fillRect(0, h - (s + 1) * (h / cap), w, h / cap);
  }
}

/* ============================================================
   INPUT
   ============================================================ */

function handleBottleTap(i) {
  if (state.selected < 0) {
    state.selected = i;
    return;
  }

  if (state.selected === i) {
    state.selected = -1;
    return;
  }

  const from = state.selected;
  const to = i;
  state.selected = -1;

  if (!canPour(from, to)) return;

  applyPourState(from, to);
}

/* ============================================================
   BOOT
   ============================================================ */

function startLevel() {
  const recipe = buildLocalRecipe();
  generateBottlesFromRecipe(recipe);
}

startLevel();
