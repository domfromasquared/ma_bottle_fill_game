// src/game/app.js
import { ELEMENTS, THESES } from "../../element_schema.js";
import { getJSON, setJSON, setNum } from "../utils/storage.js";
import { makeRng, hashSeed, randInt } from "../utils/rng.js";
import { singleFlight } from "../utils/singleFlight.js";
import { postJSON } from "../utils/http.js";
import { makeToaster, qs } from "../utils/ui.js";

/* ---------------- Constants ---------------- */
const FORESHADOW_START_LEVEL = 10;
const STABILIZER_UNLOCK_LEVEL = 15;

const DEFAULT_PROD = "https://ma-bottle-fill-aApi.onrender.com";
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

/* ---------------- Anim constants ---------------- */
const MOVE_ANIM_MS = 700;
const TILT_MAX_DEG = 28; // visual tilt for gravity surface
const INPUT_LOCK_PADDING_MS = 30;

/* ---------------- Instability system ---------------- */
/**
 * Untouched full+mixed bottles destabilize after a move-threshold.
 * - "Untouched" counts ONLY valid pours (applyPourState).
 * - Locked bottles are immune.
 * - Modifiers do NOT count as moves (we don't tick here).
 * - Early game: warnings exist, but no collapse (training mode).
 */
const INSTABILITY_ENABLE_LEVEL = 8; // warnings begin (training mode)
const INSTABILITY_COLLAPSE_LEVEL = 14; // collapse can fail the level

const INSTABILITY_STAGE_MAX = 3;
const INSTABILITY_COLLAPSE_STAGE = 4;

// stage thresholds: stage1 at X, stage2 at X+3, stage3 at X+5, collapse at X+7
const STAGE_OFFSETS = [0, 0, 3, 5, 7];

// mostly-solved mercy default (thesis may enable it)
const MOSTLY_SOLVED_ENABLED_DEFAULT = false;

// per-level tracking
let levelMoveIndex = 0;
let lastTouchedMove = [];
let untouchedMoves = [];
let instabilityStage = [];
let warnedStage2 = [];
let warnedStage3 = [];
let instabilityEnabledThisLevel = false;
let collapseEnabledThisLevel = false;
let mostlySolvedEnabledThisLevel = MOSTLY_SOLVED_ENABLED_DEFAULT;

// deterministic-ish random salt (no LLM)
let instabilityLineSalt = 0;

// mod overlay pause
let modOverlayOpen = false;

function setGamePaused(paused) {
  modOverlayOpen = !!paused;
  try {
    grid.inert = paused;
  } catch {}
}

/* ---------------- Player Modifiers (3-slot system) ---------------- */
const MODIFIERS = {
  DECOHERENCE_KEY: {
    id: "DECOHERENCE_KEY",
    name: "Decoherence Key",
    icon: "assets/modifiers/decoherence_key_selector.png",
    perLevelUses: 1,
    tooltip: "Completion is a claim. Claims may be revoked.",
    maLine: "Seal revoked. Reality updated.",
    bankSignal: "Knowledge / Control",
  },
  TEMPORAL_RETRACTION: {
    id: "TEMPORAL_RETRACTION",
    name: "Temporal Retraction Vial",
    icon: "assets/modifiers/temporal_retraction_vial_selector.png",
    perLevelUses: 3,
    tooltip: "Time does not forgive. It permits revision.",
    maLine: "Time retracts. Try again—cleanly.",
    bankSignal: "Action / Impulse Recovery",
  },
  EQUILIBRIUM_VESSEL: {
    id: "EQUILIBRIUM_VESSEL",
    name: "Equilibrium Vessel",
    icon: "assets/modifiers/equilibrium_vessel_selector.png",
    perLevelUses: 1,
    tooltip: "When balance degrades, the system may intervene.",
    maLine: "Equilibrium intervenes. Don’t get used to it.",
    bankSignal: "Nurturing / Safety Net",
  },
};

const MOD_SLOTS = [
  MODIFIERS.DECOHERENCE_KEY,
  MODIFIERS.TEMPORAL_RETRACTION,
  MODIFIERS.EQUILIBRIUM_VESSEL,
];

const modState = {
  usesLeft: {
    DECOHERENCE_KEY: MODIFIERS.DECOHERENCE_KEY.perLevelUses,
    TEMPORAL_RETRACTION: MODIFIERS.TEMPORAL_RETRACTION.perLevelUses,
    EQUILIBRIUM_VESSEL: MODIFIERS.EQUILIBRIUM_VESSEL.perLevelUses,
  },
  targeting: null, // "DECOHERENCE_KEY" when armed
};

let undoStack = [];
const MAX_UNDO = 3;

function deepCloneBottles(bottles) {
  return bottles.map((b) => b.slice());
}

function pushUndoSnapshot() {
  undoStack.push({
    bottles: deepCloneBottles(state.bottles),
    locked: state.locked.slice(),
    hiddenSegs: state.hiddenSegs.slice(),
    selected: state.selected,
    levelInvalid,
    punishedThisLevel,
    sigMoves: sig.moves,
    sigInvalid: sig.invalid,
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function restoreUndoSnapshot() {
  const snap = undoStack.pop();
  if (!snap) return false;

  state.bottles = deepCloneBottles(snap.bottles);
  state.locked = snap.locked.slice();
  state.hiddenSegs = snap.hiddenSegs.slice();
  state.selected = snap.selected;

  levelInvalid = snap.levelInvalid;
  punishedThisLevel = snap.punishedThisLevel;

  sig.moves = snap.sigMoves;
  sig.invalid = snap.sigInvalid;

  syncInfoPanel();
  render();
  redrawAllBottles();
  return true;
}

/* ---------------- SIN queue ---------------- */
function loadSinQueue() {
  return getJSON(SIN_QUEUE_KEY, []);
}
function saveSinQueue(q) {
  setJSON(SIN_QUEUE_KEY, q.slice(0, 12));
}
function pushSinTag(tag) {
  if (!tag) return;
  const q = loadSinQueue();
  q.push(String(tag));
  saveSinQueue(q);
}
function consumeSinTag() {
  const q = loadSinQueue();
  const next = q.shift() || null;
  saveSinQueue(q);
  return next;
}

/* ---------------- Player identity ---------------- */
function getPlayerName() {
  return (localStorage.getItem(PLAYER_NAME_KEY) || "").trim();
}
function setPlayerName(name) {
  const clean = String(name || "").trim().slice(0, PLAYER_NAME_MAX);
  localStorage.setItem(PLAYER_NAME_KEY, clean);
  return clean;
}
function ensurePlayerName() {
  const n = getPlayerName();
  if (n) return n;
  return setPlayerName(DEFAULT_PLAYER_NAME);
}

/* ---------------- DOM ---------------- */
const statusOut = qs("statusOut");
const grid = qs("grid");
const showToast = makeToaster(qs("toast"));

const settings = qs("settings");
const devBtn = qs("devBtn");
const apiBaseEl = qs("apiBase");

const infoLevel = qs("infoLevel");
const infoMoves = qs("infoMoves");
const infoInvalid = qs("infoInvalid");
const infoThesis = qs("infoThesis");
const infoPlayer = qs("infoPlayer");

const thesisLabel = qs("thesisLabel");
const thesisSub = qs("thesisSub");
const glossaryBtn = qs("glossaryBtn");

const glossary = qs("glossary");
const glossaryList = qs("glossaryList");

const dmCharacter = qs("dmCharacter");
const dmClose = qs("dmClose");
const speech = qs("speech");
const questTitle = qs("questTitle");
const speechText = qs("speechText");
const speechSmall = qs("speechSmall");

const bankRail = qs("bankRail");
const bankExpanded = qs("bankExpanded");

const modSlot1 = qs("modSlot1");
const modSlot2 = qs("modSlot2");
const modSlot3 = qs("modSlot3");

const modOverlay = qs("modOverlay");
const modOverlayImg = qs("modOverlayImg");
const modOverlayName = qs("modOverlayName");
const modOverlayDesc = qs("modOverlayDesc");
const modOverlayUse = qs("modOverlayUse");
const modOverlayCancel = qs("modOverlayCancel");
const modOverlayClose = qs("modOverlayClose");

const retryLevelBtn = qs("retryLevelBtn");
const factoryResetBtn = qs("factoryResetBtn");

/* ---------------- Speech theme ---------------- */
function getSpeechTheme() {
  const v = (localStorage.getItem(SPEECH_THEME_KEY) || "").toLowerCase();
  return v === "light" || v === "dark" ? v : "dark";
}
function setSpeechTheme(theme) {
  const t = String(theme || "").toLowerCase() === "light" ? "light" : "dark";
  speech.dataset.theme = t;
  localStorage.setItem(SPEECH_THEME_KEY, t);
}
function toggleSpeechTheme() {
  setSpeechTheme(getSpeechTheme() === "dark" ? "light" : "dark");
}

/* ---------------- API base ---------------- */
apiBaseEl.value =
  localStorage.getItem(API_BASE_KEY) || (isLocal ? DEFAULT_LOCAL : DEFAULT_PROD);
apiBaseEl.addEventListener("change", () => {
  localStorage.setItem(API_BASE_KEY, (apiBaseEl.value || "").trim());
});

/* ---------------- Run state ---------------- */
const DM_GAP_MIN = 3;
const DM_GAP_MAX = 6;
const DM_MAJOR_EVERY = 5;

function loadOrInitRunState() {
  let runSeed = Number(localStorage.getItem(RUN_SEED_KEY) || "0");
  if (!runSeed) {
    runSeed = Math.floor(Math.random() * 1e9);
    setNum(RUN_SEED_KEY, runSeed);
  }
  const dmAppearCount = Number(localStorage.getItem(DM_COUNT_KEY) || "0");
  let nextDMAtLevel = Number(localStorage.getItem(NEXT_DM_KEY) || "0");
  if (!nextDMAtLevel) {
    nextDMAtLevel =
      1 + randInt(DM_GAP_MIN, DM_GAP_MAX, hashSeed(runSeed, 111, 222));
    setNum(NEXT_DM_KEY, nextDMAtLevel);
  }
  return { runSeed, dmAppearCount, nextDMAtLevel };
}

let { runSeed, dmAppearCount, nextDMAtLevel } = loadOrInitRunState();
function isDMLevel(lvl) {
  return lvl === nextDMAtLevel;
}
function isMajorDM(upcomingCount) {
  return upcomingCount % DM_MAJOR_EVERY === 0;
}
function scheduleNextDM(currentLevel) {
  const gap = randInt(
    DM_GAP_MIN,
    DM_GAP_MAX,
    hashSeed(runSeed, dmAppearCount * 97, currentLevel * 131)
  );
  nextDMAtLevel = currentLevel + gap;
  setNum(NEXT_DM_KEY, nextDMAtLevel);
}

/* ---------------- DM sprite ---------------- */
const DM_MOODS = [
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
function normMood(m) {
  const s = String(m || "").trim().toLowerCase();
  return DM_MOODS.includes(s) ? s : "encouraging";
}
function pad3(n) {
  return String(Math.max(0, Math.min(999, Number(n) || 0))).padStart(3, "0");
}

function ensureDMImg() {
  let img = dmCharacter.querySelector("img");
  if (!img) {
    img = document.createElement("img");
    img.alt = "Marketing Alchemist";
    img.decoding = "async";
    img.loading = "eager";
    img.draggable = false;

    // center + ground the sprite
    img.style.position = "absolute";
    img.style.left = "50%";
    img.style.bottom = "0";
    img.style.transform = "translateX(-50%)";
    img.style.width = "140%";
    img.style.height = "auto";
    img.style.objectFit = "contain";
    img.style.pointerEvents = "none";

    dmCharacter.appendChild(img);
  }
  return img;
}

let level = 1;
let questId = 1;

function setDMAvatar({ mood, frame, seedKey }) {
  const img = ensureDMImg();
  const m = normMood(mood);

  let f = Number.isInteger(frame) ? frame : null;
  if (f === null) {
    const r = makeRng(hashSeed(runSeed, level, questId, seedKey || 777));
    f = r.int(0, 5);
  } else {
    f = Math.max(0, Math.min(5, f));
  }
  img.src = `assets/dm/${m}/MA_${pad3(f)}.png`;
}

/* ---------------- BANK inference ---------------- */
const sig = { moves: 0, invalid: 0, resets: 0, moveTimes: [], lastMoveAt: 0 };
const avg = (arr) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

function inferBANK() {
  const pace = avg(sig.moveTimes.slice(-12));
  const invalidRate = sig.moves ? sig.invalid / sig.moves : 0;
  const resetRate = sig.resets ? sig.resets / Math.max(1, level) : 0;

  const score = { B: 0, A: 0, N: 0, K: 0 };
  score.B += pace > 1400 ? 1.2 : 0;
  score.B += invalidRate < 0.1 ? 1.0 : 0;

  score.A += pace && pace < 900 ? 1.2 : 0;
  score.A += invalidRate < 0.22 ? 0.5 : 0;

  score.N += resetRate > 0.3 ? 1.0 : 0;
  score.N += invalidRate > 0.18 ? 0.6 : 0;

  score.K += invalidRate > 0.12 ? 0.7 : 0;
  score.K += resetRate < 0.25 ? 0.7 : 0;

  const usedEqui =
    MODIFIERS.EQUILIBRIUM_VESSEL.perLevelUses -
    modState.usesLeft.EQUILIBRIUM_VESSEL;
  const usedDeco =
    MODIFIERS.DECOHERENCE_KEY.perLevelUses - modState.usesLeft.DECOHERENCE_KEY;
  const usedTemp =
    MODIFIERS.TEMPORAL_RETRACTION.perLevelUses -
    modState.usesLeft.TEMPORAL_RETRACTION;

  score.N += usedEqui ? 0.6 : 0;
  score.K += usedDeco ? 0.6 : 0;
  score.A += usedTemp ? 0.35 : 0;
  score.B += usedTemp >= 2 ? 0.2 : 0;

  const entries = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [bankPrimary, top] = entries[0];
  const second = entries[1][1];
  const conf = Math.max(0.25, Math.min(0.92, 0.35 + (top - second) * 0.55));
  return { bankPrimary, bankConfidence: Number(conf.toFixed(2)) };
}

function inferSinTags() {
  const tags = [];
  const carry = consumeSinTag();
  if (carry) tags.push(carry);

  if (sig.resets >= 2 && sig.resets > level / 2) tags.push("over_reset");
  const pace = avg(sig.moveTimes.slice(-12));
  if (pace > 1500) tags.push("hesitation");
  if (sig.moves && sig.invalid / sig.moves > 0.18) tags.push("indecision");

  if (!tags.length) tags.push("steady_hand");
  return [...new Set(tags)].slice(0, 3);
}

function setBankRail(bankPrimary) {
  const spans = bankRail.querySelectorAll(".bankLetters span");
  spans.forEach((s) => s.classList.remove("on"));
  const on = bankRail.querySelector(
    `.bankLetters span[data-bank="${bankPrimary}"]`
  );
  if (on) on.classList.add("on");
}

/* ---------------- Thesis + palette ---------------- */
let currentElements = [];
let currentPalette = [];
let currentThesisKey = null;

function pickThesisKey(rng, sinTags = [], bankPrimary = "K") {
  const tags = new Set(sinTags || []);
  if (tags.has("hesitation")) return "UR_without_CL";
  if (tags.has("indecision")) return "Traffic_without_ME";
  if (tags.has("over_reset")) return "PA_without_PR";

  if (bankPrimary === "A") return "UR_without_CL";
  if (bankPrimary === "K") return "Traffic_without_ME";
  if (bankPrimary === "N") return "PA_without_PR";
  if (bankPrimary === "B") return "VI_without_ST";

  const keys = Object.keys(THESES);
  return rng.pick(keys);
}

function chooseElementsForThesis(thesisKey, colorsWanted, rng) {
  const thesis = THESES[thesisKey] || null;
  const all = Object.keys(ELEMENTS);

  const mustInclude = thesis?.must_include || [];
  const mustExclude = new Set(thesis?.must_exclude || []);
  const chosen = [];

  for (const sym of mustInclude) {
    if (ELEMENTS[sym] && !chosen.includes(sym)) chosen.push(sym);
  }

  const pool = all.filter(
    (sym) => ELEMENTS[sym] && !mustExclude.has(sym) && !chosen.includes(sym)
  );

  while (chosen.length < colorsWanted && pool.length) {
    const idx = Math.floor(rng.f() * pool.length);
    chosen.push(pool.splice(idx, 1)[0]);
  }
  while (chosen.length < colorsWanted) {
    chosen.push(all[chosen.length % all.length]);
  }
  return chosen.slice(0, colorsWanted);
}

function applyElementPalette(recipe) {
  const elems = (recipe.elements || []).slice(0, recipe.colors);
  currentElements = elems;
  currentPalette = elems.map((sym) => ELEMENTS[sym]?.color || "#ffffff");
}

/* ---------------- State ---------------- */
const state = {
  bottles: [],
  capacity: 4,
  selected: -1,
  locked: [],
  hiddenSegs: [],
  stabilizer: null,
};

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
  const a = state.bottles[from],
    b = state.bottles[to];
  if (!a.length) return false;
  if (b.length >= state.capacity) return false;
  const color = topColor(a),
    target = topColor(b);
  return target === null || target === color;
}

function hasAnyPlayableMove() {
  for (let from = 0; from < state.bottles.length; from++) {
    if (state.locked[from]) continue;
    if (!state.bottles[from]?.length) continue;
    for (let to = 0; to < state.bottles.length; to++) {
      if (from === to) continue;
      if (canPour(from, to)) return true;
    }
  }
  return false;
}

/* ---------------- Instability helpers ---------------- */
function countDistinctColors(b) {
  return new Set(b).size;
}
function isBottleSolvedOrEmpty(i) {
  const b = state.bottles[i] || [];
  if (!b.length) return true;
  if (b.length !== state.capacity) return false;
  return b.every((x) => x === b[0]);
}
function isBottleFullAndMixed(i) {
  if (state.locked[i]) return false; // immune
  const b = state.bottles[i] || [];
  if (b.length !== state.capacity) return false;
  return countDistinctColors(b) >= 2;
}
function isBottleMostlySolved(i) {
  const b = state.bottles[i] || [];
  if (b.length !== state.capacity) return false;
  const counts = new Map();
  for (const c of b) counts.set(c, (counts.get(c) || 0) + 1);
  let max = 0;
  for (const v of counts.values()) max = Math.max(max, v);
  return max >= state.capacity - 1;
}

let pendingModifier = null;

function computeLevelConfig() {
  const base = {
    colors: Math.min(6, 3 + Math.floor((level - 1) / 6)),
    capacity: 4,
    bottleCount: null,
    emptyBottles: 2,
    lockedBottles: 0,
    wildcardSlots: 0,
  };
  const m = pendingModifier || null;
  if (m) {
    base.colors = Math.max(3, Math.min(8, base.colors + (m.colorsDelta || 0)));
    base.capacity = Math.max(
      3,
      Math.min(6, base.capacity + (m.capacityDelta || 0))
    );
    base.emptyBottles = Math.max(
      1,
      Math.min(4, base.emptyBottles + (m.emptyBottlesDelta || 0))
    );
    base.lockedBottles = Math.max(
      0,
      Math.min(2, base.lockedBottles + (m.lockedBottlesDelta || 0))
    );
    base.wildcardSlots = Math.max(
      0,
      Math.min(2, base.wildcardSlots + (m.wildcardSlotsDelta || 0))
    );
    base.bottleCount =
      base.colors + base.emptyBottles + (m.bottleCountDelta || 0);
  }
  if (!base.bottleCount) base.bottleCount = base.colors + base.emptyBottles;
  return base;
}

function thesisAdjust() {
  const cfg = computeLevelConfig();
  const base = 10;
  let threshold = base + Math.floor(level / 2) + (cfg.bottleCount - cfg.colors);

  const hasHO = currentElements.includes("HO");
  const hasVI = currentElements.includes("VI");
  const hasCO = currentElements.includes("CO") || currentElements.includes("CN");
  const hasUR = currentElements.includes("UR") || currentElements.includes("CL");

  if (hasHO || hasVI || hasCO) threshold -= 2;
  if (hasUR) threshold += 1;

  threshold = Math.max(6, Math.min(28, threshold));

  const { bankPrimary } = inferBANK();
  const allowMercy = hasUR || bankPrimary === "B";
  return { threshold, allowMercy };
}

function computeStageForUntouched(movesUntouched, threshold) {
  if (movesUntouched < threshold + STAGE_OFFSETS[1]) return 0;
  if (movesUntouched < threshold + STAGE_OFFSETS[2]) return 1;
  if (movesUntouched < threshold + STAGE_OFFSETS[3]) return 2;
  if (movesUntouched < threshold + STAGE_OFFSETS[4]) return 3;
  return 4;
}

function initInstabilityForLevel() {
  levelMoveIndex = 0;
  instabilityLineSalt = 0;

  const n = state.bottles.length;
  lastTouchedMove = new Array(n).fill(0);
  untouchedMoves = new Array(n).fill(0);
  instabilityStage = new Array(n).fill(0);
  warnedStage2 = new Array(n).fill(false);
  warnedStage3 = new Array(n).fill(false);

  instabilityEnabledThisLevel = level >= INSTABILITY_ENABLE_LEVEL;
  collapseEnabledThisLevel = level >= INSTABILITY_COLLAPSE_LEVEL;

  const adj = thesisAdjust();
  mostlySolvedEnabledThisLevel = adj.allowMercy;
}

function markTouched(i) {
  if (i < 0) return;
  lastTouchedMove[i] = levelMoveIndex;
  untouchedMoves[i] = 0;
}

function pickLine(arr) {
  const r = makeRng(hashSeed(runSeed, level, 77771, instabilityLineSalt++));
  return arr[r.int(0, arr.length - 1)];
}

const MA_UNSTABLE_WARN_2 = {
  A: [
    "You ignore a full mixed bottle for ten moves and call it ‘momentum’? Adorable.",
    "Speed without attention breeds instability. Touch it—now.",
    "Your pace is impressive. Your discipline is not.",
  ],
  B: [
    "Structure decays when you abandon it. Stabilize the unattended bottle.",
    "Order is maintained—never assumed. Return to the neglected vial.",
    "You left a mixed system unattended. Blueprint failure.",
  ],
  N: [
    "That bottle is shaking because it’s been neglected. Calm it down.",
    "Stability requires care. Don’t abandon a mixed vial.",
    "You’re close. But you’re leaving chaos unattended.",
  ],
  K: [
    "A mixed full bottle left untouched becomes unstable. Yes, it’s your fault.",
    "Predictable. Neglected systems degrade. Intervene.",
    "You can compute anything except consequences.",
  ],
};

const MA_UNSTABLE_WARN_3 = {
  A: [
    "Final warning. That vial is about to blow your ‘strategy’ apart.",
    "You’ve got one job: stabilize the mixed bottle before it collapses.",
    "This is not a race. It’s a ritual. Stabilize it.",
  ],
  B: [
    "Critical instability. A neglected mixed vial will collapse the level.",
    "Blueprints fail at the unattended step. Fix the unstable bottle.",
    "Your plan is leaking. Stabilize the vial—now.",
  ],
  N: [
    "It’s critical. Please—stabilize the unstable bottle before it breaks the run.",
    "One vial is screaming for attention. Calm it down.",
    "Care first. Then elegance. Stabilize it.",
  ],
  K: [
    "Critical. The unattended mixture is about to collapse the level.",
    "You created a failure condition and then watched it shake. Genius.",
    "Stabilize it. Or enjoy the collapse.",
  ],
};

let dmToken = 0;

function showMAWarning(stage) {
  if (introIsActive() || deadlockActive) return;

  const { bankPrimary } = inferBANK();
  setBankRail(bankPrimary);

  const line =
    stage === 2
      ? pickLine(MA_UNSTABLE_WARN_2[bankPrimary] || MA_UNSTABLE_WARN_2.K)
      : pickLine(MA_UNSTABLE_WARN_3[bankPrimary] || MA_UNSTABLE_WARN_3.K);

  showToast(line);

  // small non-blocking DM pop; auto-dismiss
  try {
    dmToken++;
    showDMOverlay();
    setSpeechTheme("dark");
    setDMAvatar({
      mood: stage === 2 ? "annoyed" : "furious",
      seedKey: 8800 + stage,
    });
    setDMSpeech({
      title: stage === 2 ? "Instability rising." : "Critical instability.",
      body: line,
      small: "Stabilize the untouched mixed vial: make it SOLID or EMPTY.",
    });

    const my = dmToken;
    setTimeout(() => {
      if (dmToken !== my) return;
      if (!introIsActive() && !deadlockActive) hideDMOverlay();
    }, stage === 2 ? 1600 : 2200);
  } catch {}
}

function makePrimaryBtn(label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.style.flex = "1";
  btn.style.borderRadius = "14px";
  btn.style.padding = "12px 14px";
  btn.style.border = "1px solid rgba(220,232,255,.18)";
  btn.style.background = "rgba(17,26,39,.80)";
  btn.style.color = "#e6edf3";
  btn.style.fontWeight = "1000";
  btn.style.cursor = "pointer";
  return btn;
}

/* ---------------- Speech auto-fit (shrink to fit bubble) ---------------- */
function shrinkTextToFitBubble() {
  const bubble = speech;
  if (!bubble) return;
  if (!questTitle || !speechText || !speechSmall) return;

  const rect = bubble.getBoundingClientRect();
  if (rect.width > 0) {
    const targetH = Math.round(rect.width * 0.564);
    const currentH = parseFloat(getComputedStyle(bubble).height || "0");
    if (!currentH || Math.abs(currentH - targetH) > 2) {
      bubble.style.height = `${targetH}px`;
    }
  }

  questTitle.style.fontSize = "26px";
  speechText.style.fontSize = "16px";
  speechSmall.style.fontSize = "13px";

  const fits = () => bubble.scrollHeight <= bubble.clientHeight;
  if (fits()) return;

  let title = 26,
    body = 16,
    small = 13;

  const minTitle = 16,
    minBody = 12,
    minSmall = 10;

  for (let k = 0; k < 40; k++) {
    if (fits()) break;

    if (body > minBody) body -= 0.5;
    else if (title > minTitle) title -= 0.5;
    else if (small > minSmall) small -= 0.5;
    else break;

    questTitle.style.fontSize = `${title}px`;
    speechText.style.fontSize = `${body}px`;
    speechSmall.style.fontSize = `${small}px`;
  }
}

function setDMSpeech({ title, body, small }) {
  questTitle.textContent = title || "—";
  speechSmall.textContent = small || "";
  speechText.innerHTML = "";
  const copy = document.createElement("div");
  copy.style.whiteSpace = "pre-wrap";
  copy.textContent = body || "";
  speechText.appendChild(copy);

  requestAnimationFrame(() => shrinkTextToFitBubble());
  return { copy };
}

/* ---------------- DM overlay helpers (accessibility-safe) ---------------- */
function showDMOverlay() {
  dmCharacter.classList.add("show");
  speech.classList.add("show");

  dmCharacter.removeAttribute("aria-hidden");
  speech.removeAttribute("aria-hidden");

  dmCharacter.inert = false;
  speech.inert = false;

  try {
    dmClose?.focus?.();
  } catch {}
}

function hideDMOverlay() {
  const ae = document.activeElement;
  if (ae && (dmCharacter.contains(ae) || speech.contains(ae))) {
    try {
      ae.blur();
    } catch {}
  }

  dmCharacter.classList.remove("show");
  speech.classList.remove("show");

  dmCharacter.setAttribute("aria-hidden", "true");
  speech.setAttribute("aria-hidden", "true");

  dmCharacter.inert = true;
  speech.inert = true;

  try {
    grid?.focus?.();
  } catch {}
}

/* ---------------- Intro/deadlock flags ---------------- */
let introStep = 0; // 0 none, 1 name entry, 2 ready start quest
let deadlockActive = false;
function introIsActive() {
  return introStep === 1 || introStep === 2;
}

/* ---------------- Fail-state modifier offering ---------------- */
function getFailModSuggestion() {
  if (
    (modState?.usesLeft?.TEMPORAL_RETRACTION ?? 0) > 0 &&
    (undoStack?.length ?? 0) > 0
  ) {
    return MODIFIERS.TEMPORAL_RETRACTION;
  }

  if ((modState?.usesLeft?.EQUILIBRIUM_VESSEL ?? 0) > 0) {
    return MODIFIERS.EQUILIBRIUM_VESSEL;
  }

  if (
    (modState?.usesLeft?.DECOHERENCE_KEY ?? 0) > 0 &&
    (state?.locked?.some(Boolean) ?? false)
  ) {
    return MODIFIERS.DECOHERENCE_KEY;
  }

  return null;
}

function useFailMod(mod) {
  if (!mod) return false;

  if (mod.id === "TEMPORAL_RETRACTION") {
    const ok = restoreUndoSnapshot();
    if (!ok) {
      showToast("No safe state to retract to.");
      return false;
    }
    spendUse("TEMPORAL_RETRACTION");
    maOneLiner(MODIFIERS.TEMPORAL_RETRACTION.maLine);
    deadlockActive = false;
    return true;
  }

  if (mod.id === "EQUILIBRIUM_VESSEL") {
    if (!spendUse("EQUILIBRIUM_VESSEL")) return false;

    state.bottles.push([]);
    state.locked.push(false);
    state.hiddenSegs.push(false);

    const to = state.bottles.length - 1;
    let best = null;

    for (let from = 0; from < state.bottles.length; from++) {
      if (from === to) continue;
      if (!canPour(from, to)) continue;

      const run = topRunCount(state.bottles[from]);
      if (!best || run > best.run) best = { from, to, run };
    }

    render();
    redrawAllBottles();

    if (!best) {
      showToast("Equilibrium found no legal siphon.");
    } else {
      animateTransferThenPour(best.from, best.to);
    }

    maOneLiner(MODIFIERS.EQUILIBRIUM_VESSEL.maLine);
    deadlockActive = false;
    return true;
  }

  if (mod.id === "DECOHERENCE_KEY") {
    modState.targeting = "DECOHERENCE_KEY";
    renderModifiers();
    showToast("Decoherence armed. Tap a LOCKED bottle.");
    deadlockActive = false;
    return true;
  }

  return false;
}

function showInstabilityFailDM() {
  if (deadlockActive) return;
  deadlockActive = true;

  const { bankPrimary } = inferBANK();
  setBankRail(bankPrimary);

  showDMOverlay();
  setSpeechTheme("dark");
  setDMAvatar({ mood: "furious", seedKey: 9901 });

  const suggested = getFailModSuggestion();
  const hint = suggested
    ? `BANK: ${bankPrimary} · Use a Modifier or Retry Level (✕ to auto-retry).`
    : `BANK: ${bankPrimary} · Press Retry Level (or ✕ to auto-retry).`;

  setDMSpeech({
    title: "Collapse.",
    body: `You left a full mixed vial unattended long enough to destabilize the entire protocol.

Retry the level.

And this time—touch the problem before it becomes the problem.`,
    small: hint,
  });

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "10px";
  row.style.alignItems = "center";
  row.style.marginTop = "10px";

  if (suggested) {
    const modBtn = makePrimaryBtn(`Use ${suggested.name}`);
    modBtn.addEventListener("click", () => {
      openModOverlay(suggested, "Use", () => {
        hideDMOverlay();
        deadlockActive = false;
        useFailMod(suggested);
      });
    });
    row.appendChild(modBtn);
  }

  const retryBtn = makePrimaryBtn("Retry Level");
  retryBtn.addEventListener("click", () => {
    deadlockActive = false;
    sig.resets++;
    hideDMOverlay();
    startLevel();
  });

  row.appendChild(retryBtn);
  speechText.appendChild(row);

  requestAnimationFrame(() => shrinkTextToFitBubble());
}

function tickInstabilityAfterValidMove() {
  if (!instabilityEnabledThisLevel) return;

  const { threshold } = thesisAdjust();
  let collapseNow = false;

  for (let i = 0; i < state.bottles.length; i++) {
    if (state.locked[i]) {
      instabilityStage[i] = 0;
      untouchedMoves[i] = 0;
      continue;
    }
    if (isBottleSolvedOrEmpty(i)) {
      instabilityStage[i] = 0;
      untouchedMoves[i] = 0;
      continue;
    }
    if (mostlySolvedEnabledThisLevel && isBottleMostlySolved(i)) {
      instabilityStage[i] = 0;
      untouchedMoves[i] = 0;
      continue;
    }
    if (!isBottleFullAndMixed(i)) {
      instabilityStage[i] = 0;
      untouchedMoves[i] = 0;
      continue;
    }

    const untouched = levelMoveIndex - (lastTouchedMove[i] || 0);
    untouchedMoves[i] = untouched;

    const stage = computeStageForUntouched(untouched, threshold);
    const prev = instabilityStage[i] || 0;
    instabilityStage[i] = stage;

    if (stage >= 2 && prev < 2 && !warnedStage2[i]) {
      warnedStage2[i] = true;
      showMAWarning(2);
    }
    if (stage >= 3 && prev < 3 && !warnedStage3[i]) {
      warnedStage3[i] = true;
      showMAWarning(3);
    }
    if (stage >= INSTABILITY_COLLAPSE_STAGE && collapseEnabledThisLevel) {
      collapseNow = true;
    }
  }

  render();
  redrawAllBottles();

  if (collapseNow) showInstabilityFailDM();
}

/* ---------------- UI ---------------- */
function syncInfoPanel() {
  infoLevel.textContent = String(level);
  infoMoves.textContent = String(sig.moves);
  infoInvalid.textContent = String(sig.invalid);
  infoPlayer.textContent = getPlayerName() || "—";
  infoThesis.textContent = thesisLabel.textContent.replace("Thesis: ", "") || "—";
}

function renderThesisBar(thesisKey) {
  const thesis = thesisKey ? THESES[thesisKey] : null;
  if (!thesis) {
    thesisLabel.textContent = "Thesis: —";
    thesisSub.textContent = "—";
    infoThesis.textContent = "—";
    return;
  }
  thesisLabel.textContent = `Thesis: ${thesis.name}`;
  thesisSub.textContent = `Must include: ${
    (thesis.must_include || []).join(", ") || "—"
  } · Must exclude: ${(thesis.must_exclude || []).join(", ") || "—"}`;
  infoThesis.textContent = thesis.name;
}

function renderGlossary() {
  glossaryList.innerHTML = "";
  const syms = Object.keys(ELEMENTS).sort();
  for (const sym of syms) {
    const el = ELEMENTS[sym];
    if (!el) continue;

    const item = document.createElement("div");
    item.className = "gItem";
    item.innerHTML = `
      <div class="gSwatch" style="background:${el.color || "#fff"}"></div>
      <div>
        <div class="gTitle">${el.symbol} — ${el.name}</div>
        <div class="gSub">
          ${el.role ? `role: ${el.role}` : ""}
          ${el.teaches ? `${el.role ? " · " : ""}teaches: ${el.teaches}` : ""}
          ${el.punishes ? `${el.role || el.teaches ? " · " : ""}punishes: ${el.punishes}` : ""}
        </div>
      </div>
    `;
    glossaryList.appendChild(item);
  }
}

/* ---------------- Input lock during animations ---------------- */
let inputLocked = false;
function lockInput(ms) {
  inputLocked = true;
  setTimeout(() => {
    inputLocked = false;
  }, Math.max(0, ms | 0));
}

/* ---------------- Modifier UI ---------------- */
function setModSlotButton(btn, mod) {
  if (!btn) return;

  btn.innerHTML = "";

  const img = document.createElement("img");
  img.src = mod.icon;
  img.alt = mod.name;
  img.draggable = false;
  img.className = "modIcon";

  const uses = modState.usesLeft[mod.id] ?? 0;

  if (uses <= 0) btn.classList.add("depleted");
  else btn.classList.remove("depleted");

  btn.title = `${mod.name}\n${mod.tooltip}\nUses left: ${uses}\nBANK: ${mod.bankSignal}`;

  const badge = document.createElement("div");
  badge.className = "modBadge";
  badge.textContent = String(uses);

  btn.appendChild(img);
  btn.appendChild(badge);
}

function renderModifiers() {
  setModSlotButton(modSlot1, MOD_SLOTS[0]);
  setModSlotButton(modSlot2, MOD_SLOTS[1]);
  setModSlotButton(modSlot3, MOD_SLOTS[2]);

  [modSlot1, modSlot2, modSlot3].forEach((b) => b?.classList.remove("armed"));
  if (modState.targeting === "DECOHERENCE_KEY") modSlot1?.classList.add("armed");
}

/* ---------- Decoherence toggle helpers (FIX) ---------- */
function isDecoArmed() {
  return modState.targeting === "DECOHERENCE_KEY";
}
function toggleDecoherence() {
  modState.targeting = isDecoArmed() ? null : "DECOHERENCE_KEY";
  renderModifiers();
  showToast(
    isDecoArmed()
      ? "Decoherence disarmed."
      : "Decoherence armed. Tap a locked bottle."
  );
}

function resetModifiersForLevel() {
  modState.usesLeft.DECOHERENCE_KEY = MODIFIERS.DECOHERENCE_KEY.perLevelUses;
  modState.usesLeft.TEMPORAL_RETRACTION =
    MODIFIERS.TEMPORAL_RETRACTION.perLevelUses;
  modState.usesLeft.EQUILIBRIUM_VESSEL =
    MODIFIERS.EQUILIBRIUM_VESSEL.perLevelUses;
  modState.targeting = null;
  undoStack = [];
  renderModifiers();
}

function spendUse(modId) {
  const left = modState.usesLeft[modId] ?? 0;
  if (left <= 0) return false;
  modState.usesLeft[modId] = left - 1;
  renderModifiers();
  return true;
}

function maOneLiner(text) {
  showToast(text);
}

/* ---------------- MOD OVERLAY (pause + use/cancel) ---------------- */
function closeModOverlay() {
  if (!modOverlay) return;
  try {
    modOverlay.close();
  } catch {
    modOverlay.removeAttribute("open");
  }
  setGamePaused(false);
}

function openModOverlay(mod, useLabel, onUse) {
  if (!modOverlay) return;

  setGamePaused(true);

  modOverlayImg.src = mod.icon;
  modOverlayImg.alt = mod.name;
  modOverlayName.textContent = mod.name;
  modOverlayDesc.textContent = mod.tooltip;

  modOverlayUse.textContent = useLabel || "Use";
  if (mod?.id === "DECOHERENCE_KEY") {
    modOverlayUse.textContent = isDecoArmed() ? "Disarm" : "Arm";
  }

  const cancel = () => closeModOverlay();

  modOverlayCancel.onclick = cancel;
  modOverlayClose.onclick = cancel;

  modOverlayUse.onclick = () => {
    closeModOverlay();
    if (typeof onUse === "function") onUse();
  };

  try {
    modOverlay.showModal();
  } catch {
    modOverlay.setAttribute("open", "open");
  }

  try {
    modOverlayUse?.focus?.();
  } catch {}
}

/* ---------------- Modifier input (UPDATED: uses overlay) ---------------- */
modSlot1?.addEventListener("click", () => {
  if (introIsActive() || deadlockActive || inputLocked || modOverlayOpen) return;

  const left = modState.usesLeft.DECOHERENCE_KEY;
  if (left <= 0) {
    showToast("Decoherence Key is spent for this level.");
    return;
  }

  openModOverlay(
    MODIFIERS.DECOHERENCE_KEY,
    isDecoArmed() ? "Disarm" : "Arm",
    () => toggleDecoherence()
  );
});

modSlot2?.addEventListener("click", () => {
  if (introIsActive() || deadlockActive || inputLocked || modOverlayOpen) return;

  const left = modState.usesLeft.TEMPORAL_RETRACTION;
  if (left <= 0) {
    showToast("Temporal Retraction is empty for this level.");
    return;
  }

  openModOverlay(MODIFIERS.TEMPORAL_RETRACTION, "Use", () => {
    const ok = restoreUndoSnapshot();
    if (!ok) {
      showToast("No safe state to retract to.");
      return;
    }
    spendUse("TEMPORAL_RETRACTION");
    maOneLiner(MODIFIERS.TEMPORAL_RETRACTION.maLine);
  });
});

modSlot3?.addEventListener("click", () => {
  if (introIsActive() || deadlockActive || inputLocked || modOverlayOpen) return;

  const left = modState.usesLeft.EQUILIBRIUM_VESSEL;
  if (left <= 0) {
    showToast("Equilibrium Vessel is spent for this level.");
    return;
  }

  openModOverlay(MODIFIERS.EQUILIBRIUM_VESSEL, "Deploy", () => {
    state.bottles.push([]);
    state.locked.push(false);
    state.hiddenSegs.push(false);

    const to = state.bottles.length - 1;
    let best = null;

    for (let from = 0; from < state.bottles.length; from++) {
      if (from === to) continue;
      if (!canPour(from, to)) continue;

      const run = topRunCount(state.bottles[from]);
      if (!best || run > best.run) best = { from, to, run };
    }

    render();
    redrawAllBottles();

    if (!best) {
      showToast("Equilibrium found no legal siphon.");
    } else {
      animateTransferThenPour(best.from, best.to);
    }

    spendUse("EQUILIBRIUM_VESSEL");
    maOneLiner(MODIFIERS.EQUILIBRIUM_VESSEL.maLine);
  });
});

/* ---------------- Name roast (server) ---------------- */
async function getNameRoastFromServer(name) {
  const apiBase = (apiBaseEl?.value || "").trim();
  if (!apiBase) throw new Error("no api base");
  const res = await postJSON(apiBase, "/api/name-roast", {
    candidateName: String(name || "").trim().slice(0, PLAYER_NAME_MAX),
  });
  const roast = res?.payload?.roast;
  const blocked = !!res?.payload?.blocked;
  if (!roast) throw new Error("no roast returned");
  return { roast: String(roast), blocked };
}

function localNameRoast(name) {
  const n = String(name || "").trim();
  const refs = [
    `“${n}”? And you felt comfortable submitting that.`,
    `“${n}”… We’ll unpack that later.`,
    `“${n}”… We’ll compensate for this decision.`,
    `“${n}”… Yes. That tracks.`,
  ];
  return refs[Math.floor(Math.random() * refs.length)];
}

function makeInput(placeholder) {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.maxLength = PLAYER_NAME_MAX;
  input.style.flex = "1";
  input.style.minWidth = "0";
  input.style.borderRadius = "12px";
  input.style.padding = "10px 12px";
  input.style.border = "1px solid rgba(220,232,255,.18)";
  input.style.background = "rgba(17,26,39,.55)";
  input.style.color = "#e6edf3";
  input.style.outline = "none";
  input.style.fontWeight = "800";
  return input;
}

/* ---------------- Intro DM (first load) ---------------- */
function runFirstLoadIntro() {
  if (localStorage.getItem(INTRO_SEEN_KEY) === "1") return false;

  introStep = 1;
  dmToken++;

  showDMOverlay();
  setSpeechTheme("dark");
  setDMAvatar({ mood: "impressed", seedKey: 9001 });

  setDMSpeech({
    title: "At last.",
    body: `Welcome to The Balance Protocol.

There’s a flaw in the lab — the mixtures are unstable.
Your job is to restore order.

Tell me… what do I call you?`,
    small: "Enter a name (14 characters max), then press Submit.",
  });

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "10px";
  row.style.alignItems = "center";
  row.style.marginTop = "10px";

  const input = makeInput("Your name…");
  const submitBtn = makePrimaryBtn("Submit");

  const submit = async () => {
    const name = (input.value || "").trim();
    if (!name) {
      showToast("Give me a name.");
      return;
    }

    let roastRes;
    try {
      roastRes = await getNameRoastFromServer(name);
    } catch {
      roastRes = { roast: localNameRoast(name), blocked: false };
    }

    if (roastRes.blocked) {
      setDMSpeech({
        title: "No.",
        body: `${roastRes.roast}\n\nTry again.`,
        small: "Enter a different name.",
      });
      return;
    }

    const saved = setPlayerName(name);
    localStorage.setItem(INTRO_SEEN_KEY, "1");
    syncInfoPanel();
    introStep = 2;

    setDMSpeech({
      title: `…${saved}.`,
      body: `${roastRes.roast}

Fine. ${saved} it is.

The Balance Protocol doesn’t reward “busy.”
It rewards alignment.

Ready?`,
      small: "Press Start Quest to begin. (✕ always cancels me.)",
    });

    const row2 = document.createElement("div");
    row2.style.display = "flex";
    row2.style.gap = "10px";
    row2.style.alignItems = "center";
    row2.style.marginTop = "10px";

    const startBtn = makePrimaryBtn("Start Quest");
    startBtn.addEventListener("click", () => {
      introStep = 0;
      hideDMOverlay();
    });

    row2.appendChild(startBtn);
    speechText.appendChild(row2);

    requestAnimationFrame(() => shrinkTextToFitBubble());
  };

  submitBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  row.appendChild(input);
  row.appendChild(submitBtn);
  speechText.appendChild(row);

  setTimeout(() => input.focus(), 200);

  requestAnimationFrame(() => shrinkTextToFitBubble());
  return true;
}

/* ---------------- Deadlock DM ---------------- */
function dmReactionForBANK(bankPrimary) {
  switch (bankPrimary) {
    case "A":
      return {
        mood: "annoyed",
        title: "Out of moves.",
        body:
          "Action without aim.\nYou brute-forced the ritual into a wall.\n\nRetry. Fewer clicks. More intent.",
      };
    case "B":
      return {
        mood: "disappointed",
        title: "Protocol failure.",
        body:
          "Blueprint ignored.\nYou tried to solve chaos without structure.\n\nRetry. Plan two pours ahead. Minimum.",
      };
    case "N":
      return {
        mood: "encouraging",
        title: "No moves left.",
        body:
          "Breathe.\n\nYou’re close — but you protected the wrong stacks.\n\nRetry. Calm hands. Clean pours.",
      };
    case "K":
    default:
      return {
        mood: "amused",
        title: "No legal pours remain.",
        body:
          "Ah. Classic.\n\nYou constructed a perfectly unsolvable state.\n\nRetry — and respect constraints before you pour.",
      };
  }
}

function showOutOfMovesDM() {
  if (deadlockActive) return;
  deadlockActive = true;

  const { bankPrimary } = inferBANK();
  setBankRail(bankPrimary);

  const react = dmReactionForBANK(bankPrimary);

  showDMOverlay();
  setSpeechTheme("dark");
  setDMAvatar({ mood: react.mood, seedKey: 5050 });

  const suggested = getFailModSuggestion();
  const hint = suggested
    ? `BANK: ${bankPrimary} · Use a Modifier or Retry Level (✕ to auto-retry).`
    : `BANK: ${bankPrimary} · Press Retry Level (or ✕ to auto-retry).`;

  setDMSpeech({
    title: react.title,
    body: react.body,
    small: hint,
  });

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "10px";
  row.style.alignItems = "center";
  row.style.marginTop = "10px";

  if (suggested) {
    const modBtn = makePrimaryBtn(`Use ${suggested.name}`);
    modBtn.addEventListener("click", () => {
      openModOverlay(suggested, "Use", () => {
        hideDMOverlay();
        deadlockActive = false;
        useFailMod(suggested);
      });
    });
    row.appendChild(modBtn);
  }

  const retryBtn = makePrimaryBtn("Retry Level");
  retryBtn.addEventListener("click", () => {
    deadlockActive = false;
    sig.resets++;
    hideDMOverlay();
    startLevel();
  });

  row.appendChild(retryBtn);
  speechText.appendChild(row);

  requestAnimationFrame(() => shrinkTextToFitBubble());
}

/* ---------------- Quest-node DM (LLM) ---------------- */
async function runDMIfAvailable() {
  if (!isDMLevel(level)) return;

  const myToken = ++dmToken;
  const { bankPrimary, bankConfidence } = inferBANK();
  setBankRail(bankPrimary);

  showDMOverlay();
  setSpeechTheme("dark");

  const apiBase = (apiBaseEl?.value || "").trim();
  if (!apiBase) {
    setDMAvatar({ mood: "annoyed", seedKey: 222 });
    setDMSpeech({
      title: "No server.",
      body: "You didn’t connect the lab’s brain.\nSet API Base in Settings.",
      small: "Open Settings (⚙️) → set API Base.",
    });
    return;
  }

  const sinTags = inferSinTags();
  const act = Math.max(1, Math.floor((level - 1) / 5) + 1);

  const wantModifier = true;
  const foreshadowOnly =
    level >= FORESHADOW_START_LEVEL && level < STABILIZER_UNLOCK_LEVEL;

  let payload;
  try {
    const resp = await singleFlight(
      `quest:${runSeed}:${questId}:${level}:${bankPrimary}:${wantModifier}`,
      () =>
        postJSON(apiBase, "/api/quest-node", {
          act,
          questId,
          level,
          playerName: ensurePlayerName(),
          bankPrimary,
          bankConfidence,
          sinTags,
          seed: runSeed,
          wantModifier,
          foreshadowOnly,
        })
    );
    payload = resp?.payload;
  } catch (e) {
    if (myToken !== dmToken) return;
    setDMAvatar({ mood: "furious", seedKey: 333 });
    setDMSpeech({
      title: "Server error.",
      body: "The lab stuttered.\n\nFix your API, then return.",
      small: String(e?.message || e),
    });
    return;
  }

  if (myToken !== dmToken) return;
  if (!payload) {
    setDMAvatar({ mood: "annoyed", seedKey: 444 });
    setDMSpeech({
      title: "Empty response.",
      body: "The lab answered with silence.",
      small: "Check server logs.",
    });
    return;
  }

  setDMAvatar({
    mood: payload.dm_mood || "encouraging",
    frame: payload.dm_frame,
    seedKey: 555,
  });

  if (payload.modifier) pendingModifier = payload.modifier;

  dmAppearCount++;
  setNum(DM_COUNT_KEY, dmAppearCount);
  scheduleNextDM(level);

  setDMSpeech({
    title: payload.quest_title || "Quest",
    body: `${payload.dm_intro || ""}\n\n${payload.dm_midpoint || ""}\n\n${
      payload.dm_verdict || ""
    }`,
    small: isMajorDM(dmAppearCount) ? "Major node." : "Minor node.",
  });
}

/* ---------------- Level generation ---------------- */
function buildLocalRecipe() {
  const rng = makeRng(hashSeed(runSeed, 4242, level));
  const { bankPrimary } = inferBANK();
  const sinTags = inferSinTags();
  currentThesisKey = pickThesisKey(rng, sinTags, bankPrimary);

  const cfg = computeLevelConfig();
  const elems = chooseElementsForThesis(currentThesisKey, cfg.colors, rng);

  return {
    title: `Level ${level}`,
    colors: cfg.colors,
    bottleCount: cfg.bottleCount,
    capacity: cfg.capacity,
    emptyBottles: cfg.emptyBottles,
    lockedBottles: cfg.lockedBottles,
    wildcardSlots: cfg.wildcardSlots,
    elements: elems,
    sinTags,
    appliedModifier: pendingModifier || null,
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng.f() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function generateBottlesFromRecipe(recipe) {
  const rng = makeRng(hashSeed(runSeed, 9898, level));
  state.capacity = recipe.capacity;
  state.selected = -1;

  const colors = recipe.colors;
  const bottleCount = recipe.bottleCount;
  const empty = recipe.emptyBottles;

  const pool = [];
  for (let c = 0; c < colors; c++) {
    for (let i = 0; i < recipe.capacity; i++) pool.push(c);
  }
  shuffle(pool, rng);

  state.bottles = [];
  let idx = 0;
  const filledBottles = bottleCount - empty;

  for (let b = 0; b < filledBottles; b++) {
    const bottle = [];
    for (let k = 0; k < recipe.capacity; k++) bottle.push(pool[idx++]);
    state.bottles.push(bottle);
  }
  for (let e = 0; e < empty; e++) state.bottles.push([]);

  state.locked = new Array(bottleCount).fill(false);
  state.hiddenSegs = new Array(bottleCount).fill(false);
  state.stabilizer = null;

  const lockCount = Math.min(recipe.lockedBottles || 0, bottleCount);
  for (let i = 0; i < lockCount; i++) {
    state.locked[i] = true;
    state.hiddenSegs[i] = true;
  }

  if (level >= STABILIZER_UNLOCK_LEVEL && lockCount > 0) {
    state.stabilizer = { unlock: "UR_full", idx: 0, unlocked: false };
  }
}

function checkStabilizerUnlock() {
  if (!state.stabilizer || state.stabilizer.unlocked) return;
  if (state.stabilizer.unlock !== "UR_full") return;

  const urIndex = currentElements.indexOf("UR");
  if (urIndex < 0) return;

  const cap = state.capacity;
  const hasFullUR = state.bottles.some(
    (b) => b.length === cap && b.every((x) => x === urIndex)
  );
  if (hasFullUR) {
    const idx = state.stabilizer.idx;
    state.locked[idx] = false;
    state.hiddenSegs[idx] = false;
    state.stabilizer.unlocked = true;
    showToast("Clarity unlocked. Now stop panicking.");
    render();
    redrawAllBottles();
  }
}

/* ---------------- Canvas liquid rendering ---------------- */
const bottleEls = [];
const bottleCanvases = [];
const bottleTiltRad = [];
let rafResize = 0;

function getRoleTextureUrl(role) {
  const r = String(role || "").toLowerCase();
  if (r.includes("volatile"))
    return "assets/elements/textures/pattern_ripples.svg";
  if (r.includes("catalyst"))
    return "assets/elements/textures/pattern_streaks.svg";
  if (r.includes("stabilizer"))
    return "assets/elements/textures/pattern_noise.svg";
  if (r.includes("foundational"))
    return "assets/elements/textures/pattern_grid.svg";
  if (r.includes("structural"))
    return "assets/elements/textures/pattern_hatch.svg";
  if (r.includes("transmission"))
    return "assets/elements/textures/pattern_chevrons.svg";
  if (r.includes("conversion"))
    return "assets/elements/textures/pattern_bubbles.svg";
  return "assets/elements/textures/pattern_grid.svg";
}

const patternImgCache = new Map();
function getPatternImage(url) {
  if (patternImgCache.has(url)) return patternImgCache.get(url);
  const img = new Image();
  img.decoding = "async";
  img.loading = "eager";
  img.src = url;
  patternImgCache.set(url, img);
  return img;
}

function resizeCanvasToCSS(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

/* ---------- Alpha mask: match bottle art "contain + center bottom" ---------- */
const halo = document.createElement("div");
halo.className = "bottleHalo";
halo.setAttribute("aria-hidden", "true");

// order matters: liquid (z=2) -> halo (z=4) -> bottle art (::after z=5)
bottle.appendChild(canvas);
bottle.appendChild(halo);

const VIAL_ALPHA_URL = "assets/chemset/vial/vial_alpha.png";
const vialAlphaImg = new Image();
vialAlphaImg.decoding = "async";
vialAlphaImg.loading = "eager";
vialAlphaImg.src = VIAL_ALPHA_URL;

function cssVarPx(el, name, fallback = 0) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function computeContainBottomBox(canvasW, canvasH, imgW, imgH) {
  const scale = Math.min(canvasW / imgW, canvasH / imgH);
  const dw = imgW * scale;
  const dh = imgH * scale;
  const dx = (canvasW - dw) * 0.5; // center X
  const dy = canvasH - dh; // bottom align
  return { dx, dy, dw, dh, scale };
}

function applyAlphaMask(ctx, bottleEl, w, h, dpr) {
  if (!vialAlphaImg.complete || vialAlphaImg.naturalWidth <= 0) return;

  const imgW = vialAlphaImg.naturalWidth;
  const imgH = vialAlphaImg.naturalHeight;

  // chamber in canvas px
  const chTop = cssVarPx(bottleEl, "--ch-top", 0) * dpr;
  const chSide = cssVarPx(bottleEl, "--ch-side", 0) * dpr;
  const chBottom = cssVarPx(bottleEl, "--ch-bottom", 0) * dpr;

  const innerX = chSide;
  const innerY = chTop;
  const innerW = Math.max(1, w - chSide * 2);
  const innerH = Math.max(1, h - chTop - chBottom);

  // Fit alpha to chamber using "contain + bottom"
  const { dx, dy, dw, dh } = computeContainBottomBox(innerW, innerH, imgW, imgH);

  const padX = cssVarPx(bottleEl, "--alpha-pad-x", 0) * dpr;
  const padY = cssVarPx(bottleEl, "--alpha-pad-y", 0) * dpr;
  const offX = cssVarPx(bottleEl, "--alpha-off-x", 0) * dpr;
  const offY = cssVarPx(bottleEl, "--alpha-off-y", 0) * dpr;

  ctx.save();
  ctx.globalCompositeOperation = "destination-in";

  // translate so 0,0 is chamber top-left
  ctx.translate(innerX, innerY);

  ctx.drawImage(
    vialAlphaImg,
    0,
    0,
    imgW,
    imgH,
    dx + offX + padX,
    dy + offY + padY,
    Math.max(1, dw - padX * 2),
    Math.max(1, dh - padY * 2)
  );

  ctx.restore();
}

function drawBottleLiquid(i) {
  const canvas = bottleCanvases[i];
  const bottleEl = bottleEls[i];
  if (!canvas || !bottleEl) return;

  const { w, h, dpr } = resizeCanvasToCSS(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, w, h);

  if (state.hiddenSegs[i]) return;

  const b = state.bottles[i] || [];
  const cap = state.capacity;
  if (!b.length) return;

  // Draw into chamber rect (based on CSS vars) so fill height feels correct
  const chTop = cssVarPx(bottleEl, "--ch-top", 0) * dpr;
  const chSide = cssVarPx(bottleEl, "--ch-side", 0) * dpr;
  const chBottom = cssVarPx(bottleEl, "--ch-bottom", 0) * dpr;

  const innerX = chSide;
  const innerY = chTop;
  const innerW = Math.max(1, w - chSide * 2);
  const innerH = Math.max(1, h - chTop - chBottom);
  const cellH = innerH / cap;

  const tilt = bottleTiltRad[i] || 0;
  const slant = Math.tan(tilt) * (innerW * 0.18);

  for (let s = 0; s < cap; s++) {
    const idx = b[s] ?? null;
    if (idx === null || idx === undefined) continue;

    const sym = currentElements[idx];
    const el = ELEMENTS?.[sym];
    const fill = el?.color || currentPalette[idx] || "#fff";
    const role = el?.role || "";
    const texUrl = getRoleTextureUrl(role);
    const img = getPatternImage(texUrl);

    const yBottom = innerY + (innerH - (s + 1) * cellH);
    const yTop = innerY + (innerH - s * cellH);

    // base fill
    ctx.fillStyle = fill;
    ctx.fillRect(innerX, yBottom, innerW, cellH);

    // top surface tilt illusion ONLY for top-most filled segment
    const isTopMost = s === b.length - 1;
    if (isTopMost && Math.abs(tilt) > 0.001) {
      ctx.save();
      ctx.beginPath();

      const sgn = tilt >= 0 ? 1 : -1;
      const dx = Math.max(-cellH * 0.6, Math.min(cellH * 0.6, slant));

      const yL = yTop + (sgn > 0 ? Math.abs(dx) : 0);
      const yR = yTop + (sgn > 0 ? 0 : Math.abs(dx));

      ctx.moveTo(innerX, yBottom);
      ctx.lineTo(innerX, yL);
      ctx.lineTo(innerX + innerW, yR);
      ctx.lineTo(innerX + innerW, yBottom);
      ctx.closePath();
      ctx.clip();

      ctx.fillStyle = fill;
      ctx.fillRect(innerX, yBottom, innerW, cellH + Math.abs(dx) + 2);
      ctx.restore();
    }

    // texture overlay (FULL OPACITY per your request)
    if (img && img.complete && img.naturalWidth > 0) {
      const pat = ctx.createPattern(img, "repeat");
      if (pat) {
        ctx.save();
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = pat;
        ctx.fillRect(innerX, yBottom, innerW, cellH);
        ctx.restore();
      }
    }
  }

  // subtle glass shading
  ctx.save();
  ctx.globalAlpha = 0.22;
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, "rgba(255,255,255,.10)");
  g.addColorStop(0.5, "rgba(255,255,255,.02)");
  g.addColorStop(1, "rgba(0,0,0,.10)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // ✅ FINAL CLIP: enforce vial_alpha silhouette aligned to bottle art
  applyAlphaMask(ctx, bottleEl, w, h, dpr);
}

function redrawAllBottles() {
  for (let i = 0; i < state.bottles.length; i++) drawBottleLiquid(i);
}

function requestRedraw() {
  if (rafResize) cancelAnimationFrame(rafResize);
  rafResize = requestAnimationFrame(() => {
    rafResize = 0;
    redrawAllBottles();
  });
}

window.addEventListener("resize", requestRedraw, { passive: true });
window.addEventListener("orientationchange", requestRedraw, { passive: true });

/* ---------------- Pour + win ---------------- */
let levelInvalid = 0;
let punishedThisLevel = false;

function applyPourState(from, to) {
  pushUndoSnapshot();

  const a = state.bottles[from],
    b = state.bottles[to];
  const run = topRunCount(a);
  const space = state.capacity - b.length;
  const amount = Math.min(run, space);

  for (let i = 0; i < amount; i++) b.push(a.pop());

  sig.moves++;
  syncInfoPanel();

  levelMoveIndex++;
  markTouched(from);
  markTouched(to);
  tickInstabilityAfterValidMove();

  checkStabilizerUnlock();

  if (isSolved()) {
    showToast("Solved. Next level.");
    nextLevel();
    return true;
  }

  render();
  redrawAllBottles();

  if (!isSolved() && !hasAnyPlayableMove()) {
    showOutOfMovesDM();
  }

  return true;
}

function invalidWiggle(i) {
  const el = bottleEls[i];
  if (!el) return;
  el.classList.remove("wiggle");
  void el.offsetWidth;
  el.classList.add("wiggle");
  setTimeout(() => el.classList.remove("wiggle"), 380);
}

async function animateTransferThenPour(from, to) {
  const aEl = bottleEls[from];
  const bEl = bottleEls[to];
  if (!aEl || !bEl) return applyPourState(from, to);

  lockInput(MOVE_ANIM_MS + INPUT_LOCK_PADDING_MS);

  const a = aEl.getBoundingClientRect();
  const b = bEl.getBoundingClientRect();
  const dx = b.left + b.width * 0.5 - (a.left + a.width * 0.5);
  const dy = b.top + b.height * 0.25 - (a.top + a.height * 0.25);

  const dir = dx >= 0 ? 1 : -1;
  const tiltDeg = dir * TILT_MAX_DEG;
  const tiltRad = (tiltDeg * Math.PI) / 180;

  const keyframes = [
    { transform: `translate3d(0,0,0) rotate(0deg)`, offset: 0 },
    {
      transform: `translate3d(${dx}px,${dy}px,0) rotate(${tiltDeg}deg)`,
      offset: 0.38,
    },
    {
      transform: `translate3d(${dx}px,${dy}px,0) rotate(${tiltDeg}deg)`,
      offset: 0.7,
    },
    { transform: `translate3d(0,0,0) rotate(0deg)`, offset: 1 },
  ];
  const timing = {
    duration: MOVE_ANIM_MS,
    easing: "cubic-bezier(.15,.9,.15,1)",
    fill: "none",
  };

  const t0 = performance.now();
  const dur = MOVE_ANIM_MS;

  const anim = aEl.animate(keyframes, timing);

  let raf = 0;
  const tick = (now) => {
    const t = (now - t0) / dur;
    const peak = Math.sin(Math.max(0, Math.min(1, t)) * Math.PI);
    bottleTiltRad[from] = tiltRad * peak;
    drawBottleLiquid(from);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  try {
    await anim.finished;
  } catch {}

  if (raf) cancelAnimationFrame(raf);
  bottleTiltRad[from] = 0;
  drawBottleLiquid(from);

  applyPourState(from, to);
}

/* ---------------- Render bottles ---------------- */
function render() {
  grid.innerHTML = "";
  bottleEls.length = 0;
  bottleCanvases.length = 0;
  bottleTiltRad.length = 0;

  for (let i = 0; i < state.bottles.length; i++) {
    const bottle = document.createElement("button");
    bottle.className = "bottle";
    bottle.type = "button";

    bottleEls[i] = bottle;
    bottleTiltRad[i] = 0;

    if (state.selected === i) bottle.classList.add("selected");
    if (state.locked[i]) bottle.classList.add("locked");
    if (state.hiddenSegs[i]) bottle.classList.add("hiddenSegs");

    const stg = instabilityStage[i] || 0;
    if (stg === 1) bottle.classList.add("unstable1");
    if (stg === 2) bottle.classList.add("unstable2");
    if (stg >= 3) bottle.classList.add("unstable3");

    bottle.addEventListener("pointerdown", () => bottle.classList.add("pressed"));
    const clearPressed = () => bottle.classList.remove("pressed");
    bottle.addEventListener("pointerup", clearPressed);
    bottle.addEventListener("pointercancel", clearPressed);
    bottle.addEventListener("pointerleave", clearPressed);

    bottle.addEventListener("pointerup", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      handleBottleTap(i);
    });

    const canvas = document.createElement("canvas");
    canvas.className = "liquidCanvas";
    canvas.setAttribute("aria-hidden", "true");
    bottleCanvases[i] = canvas;

    bottle.appendChild(canvas);
    grid.appendChild(bottle);
  }

  requestAnimationFrame(() => {
    redrawAllBottles();
  });
}

/* ---------------- Input ---------------- */
function handleBottleTap(i) {
  if (modOverlayOpen) return;
  if (introIsActive()) return;
  if (deadlockActive) return;
  if (inputLocked) return;

  if (modState.targeting === "DECOHERENCE_KEY") {
    if (!state.locked[i]) {
      showToast("Tap a LOCKED bottle to revoke its seal.");
      invalidWiggle(i);
      return;
    }
    if (!spendUse("DECOHERENCE_KEY")) {
      modState.targeting = null;
      renderModifiers();
      showToast("Decoherence Key is spent.");
      return;
    }
    state.locked[i] = false;
    state.hiddenSegs[i] = false;
    modState.targeting = null;
    renderModifiers();
    render();
    redrawAllBottles();
    maOneLiner(MODIFIERS.DECOHERENCE_KEY.maLine);
    return;
  }

  const now = performance.now();
  if (sig.lastMoveAt) sig.moveTimes.push(now - sig.lastMoveAt);
  sig.lastMoveAt = now;

  if (state.selected < 0) {
    state.selected = i;
    render();
    redrawAllBottles();
    return;
  }

  if (state.selected === i) {
    state.selected = -1;
    render();
    redrawAllBottles();
    return;
  }

  const from = state.selected;
  const to = i;

  state.selected = -1;
  render();
  redrawAllBottles();

  if (!canPour(from, to)) {
    sig.invalid++;
    levelInvalid++;
    syncInfoPanel();

    invalidWiggle(from);
    invalidWiggle(to);

    if (!punishedThisLevel && levelInvalid >= INVALID_POUR_PUNISH_THRESHOLD) {
      punishedThisLevel = true;
      const a = state.bottles[from] || [];
      const ci = a.length ? topColor(a) : null;
      const sym = ci !== null && ci !== undefined ? currentElements[ci] : null;
      const el = sym ? ELEMENTS[sym] : null;
      const punishTag = el?.punishes || "sloppiness";
      showToast(`${el?.symbol || sym || "??"} punishes: ${punishTag}`);
      pushSinTag(punishTag);
    } else {
      showToast("Invalid pour");
    }
    return;
  }

  animateTransferThenPour(from, to);
}

/* ---------------- Level flow ---------------- */
function startLevel() {
  deadlockActive = false;
  punishedThisLevel = false;
  levelInvalid = 0;

  resetModifiersForLevel();

  const recipe = buildLocalRecipe();
  applyElementPalette(recipe);
  renderThesisBar(currentThesisKey);

  generateBottlesFromRecipe(recipe);

  initInstabilityForLevel();

  render();
  syncInfoPanel();
  redrawAllBottles();

  runDMIfAvailable();
}

function nextLevel() {
  level++;
  questId++;
  startLevel();
}

/* ---------------- Settings / Glossary / BANK ---------------- */
devBtn.addEventListener("click", () => settings.showModal());
glossaryBtn.addEventListener("click", () => {
  renderGlossary();
  glossary.showModal();
});

bankRail.addEventListener("click", () => {
  const expanded = bankRail.classList.toggle("expanded");
  bankExpanded.setAttribute("aria-hidden", expanded ? "false" : "true");
});

/* ---------------- DM close: ALWAYS WORKS ---------------- */
dmClose.addEventListener("click", () => {
  dmToken++;
  hideDMOverlay();

  if (introIsActive()) {
    setPlayerName(DEFAULT_PLAYER_NAME);
    introStep = 0;
    syncInfoPanel();
    return;
  }

  if (deadlockActive) {
    deadlockActive = false;
    sig.resets++;
    startLevel();
  }
});

/* ---------------- Factory reset (Settings) ---------------- */
function factoryResetGame() {
  const ok = confirm(
    "Factory Reset will erase ALL progress, name, and history.\n\nProceed?"
  );
  if (!ok) return;

  try {
    dmToken++;
    showDMOverlay();
    setSpeechTheme("dark");
    setDMAvatar({ mood: "satisfied", seedKey: 7777 });
    setDMSpeech({
      title: "Factory Reset",
      body: `Good.

Burn it down.
We begin again — clean glass, clean ritual.

Try not to disappoint me twice.`,
      small: "Resetting…",
    });
  } catch {}

  setTimeout(() => {
    localStorage.removeItem(PLAYER_NAME_KEY);
    localStorage.removeItem(INTRO_SEEN_KEY);
    localStorage.removeItem(RUN_SEED_KEY);
    localStorage.removeItem(DM_COUNT_KEY);
    localStorage.removeItem(NEXT_DM_KEY);
    localStorage.removeItem(SIN_QUEUE_KEY);
    localStorage.removeItem(SPEECH_THEME_KEY);
    localStorage.removeItem(API_BASE_KEY);
    location.reload();
  }, 650);
}

factoryResetBtn?.addEventListener("click", factoryResetGame);

retryLevelBtn?.addEventListener("click", () => {
  try {
    settings?.close?.();
  } catch {}
  sig.resets++;
  deadlockActive = false;
  introStep = 0;
  startLevel();
});

/* ---------------- Boot ---------------- */
function boot() {
  setSpeechTheme(getSpeechTheme());
  syncInfoPanel();

  startLevel();

  setTimeout(() => {
    const seen = localStorage.getItem(INTRO_SEEN_KEY) === "1";
    if (!seen) runFirstLoadIntro();
  }, 0);
}

boot();
