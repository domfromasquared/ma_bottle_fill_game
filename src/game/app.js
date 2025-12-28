import { ELEMENTS, THESES, pickLoreLine } from "../../element_schema.js";
import { getJSON, setJSON, getNum, setNum, del } from "../utils/storage.js";
import { makeRng, hashSeed, randInt } from "../utils/rng.js";
import { singleFlight } from "../utils/singleFlight.js";
import { postJSON } from "../utils/http.js";
import { makeToaster, qs, playPourFX } from "../utils/ui.js";

/**
 * This module replaces the huge inline <script> from index.html.
 * It keeps the same core mechanics you’ve been iterating:
 * - DM visits: seeded & persisted per run (minor/major cadence)
 * - Soft foreshadowing window (DM only, no stabilizer complexity)
 * - Illegal reaction trap: UR_without_CL can hide/lock CL behind a stabilizer bottle
 * - Punish-on-behavior: after X invalid pours in a level, show element punishes line + queue sinTag to bias next thesis pick
 */

// ---------------- Progression gates ----------------
const FORESHADOW_START_LEVEL = 10;
const STABILIZER_UNLOCK_LEVEL = 15;

// ---------------- API base ----------------
const DEFAULT_PROD = "https://ma-bottle-fill-api.onrender.com";
const DEFAULT_LOCAL = "http://localhost:8787";
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

// ---------------- Punish-on-behavior ----------------
const INVALID_POUR_PUNISH_THRESHOLD = 3; // X invalid pours in a level triggers punish callout once
const SIN_QUEUE_KEY = "ma_sinQueue";

function loadSinQueue(){ return getJSON(SIN_QUEUE_KEY, []); }
function saveSinQueue(q){ setJSON(SIN_QUEUE_KEY, q.slice(0, 12)); }
function pushSinTag(tag){
  if (!tag) return;
  const q = loadSinQueue();
  q.push(String(tag));
  saveSinQueue(q);
}
function consumeSinTag(){
  const q = loadSinQueue();
  const next = q.shift() || null;
  saveSinQueue(q);
  return next;
}

// ---------------- DOM ----------------
const apiBaseEl = qs("apiBase");
const statusOut = qs("statusOut");
const questTitle = qs("questTitle");
const dmIntro = qs("dmIntro");
const dmStatus = qs("dmStatus");
const dmMid = qs("dmMid");
const dmVerdict = qs("dmVerdict");
const bankOut = qs("bankOut");
const sinsOut = qs("sinsOut");
const modOut = qs("modOut");
const cfgOut = qs("cfgOut");
const recipeSrcOut = qs("recipeSrcOut");
const dmCountOut = qs("dmCountOut");
const nextDmOut = qs("nextDmOut");

const btnQuest = qs("btnQuest");
const btnNext = qs("btnNext");
const btnReset = qs("btnReset");

const grid = qs("grid");
const legendEl = qs("legend");

const levelOut = qs("levelOut");
const movesOut = qs("movesOut");
const badOut = qs("badOut");
const resetOut = qs("resetOut");
const pourFX = qs("pourFX");

const showToast = makeToaster(qs("toast"));

apiBaseEl.value = isLocal ? DEFAULT_LOCAL : DEFAULT_PROD;

// ---------------- Run/Progress storage keys ----------------
const RUN_SEED_KEY = "ma_runSeed";
const DM_COUNT_KEY = "ma_dmAppearCount";
const NEXT_DM_KEY = "ma_nextDMAtLevel";

// ---------------- DM Scheduling ----------------
const DM_GAP_MIN = 3;
const DM_GAP_MAX = 6;
const DM_MAJOR_EVERY = 5;

function loadOrInitRunState(){
  let runSeed = Number(localStorage.getItem(RUN_SEED_KEY) || "0");
  if (!runSeed){
    runSeed = Math.floor(Math.random() * 1e9);
    setNum(RUN_SEED_KEY, runSeed);
  }
  const dmAppearCount = Number(localStorage.getItem(DM_COUNT_KEY) || "0");
  let nextDMAtLevel = Number(localStorage.getItem(NEXT_DM_KEY) || "0");
  if (!nextDMAtLevel){
    nextDMAtLevel = 1 + randInt(DM_GAP_MIN, DM_GAP_MAX, hashSeed(runSeed, 111, 222));
    setNum(NEXT_DM_KEY, nextDMAtLevel);
  }
  return { runSeed, dmAppearCount, nextDMAtLevel };
}

let { runSeed, dmAppearCount, nextDMAtLevel } = loadOrInitRunState();

function isDMLevel(lvl){ return lvl === nextDMAtLevel; }
function isMajorDM(upcomingCount){ return (upcomingCount % DM_MAJOR_EVERY) === 0; }

function scheduleNextDM(currentLevel){
  const gap = randInt(DM_GAP_MIN, DM_GAP_MAX, hashSeed(runSeed, dmAppearCount * 97, currentLevel * 131));
  nextDMAtLevel = currentLevel + gap;
  setNum(NEXT_DM_KEY, nextDMAtLevel);
}

function updateDMButton(){
  dmCountOut.textContent = String(dmAppearCount);
  nextDmOut.textContent = `L${nextDMAtLevel}`;

  if (isDMLevel(level)){
    const upcoming = dmAppearCount + 1;
    const major = isMajorDM(upcoming);
    btnQuest.disabled = false;
    btnQuest.textContent = major ? "Major Ritual (Brew Modifier)" : "DM Speaks (No Modifier)";

    dmStatus.textContent = major
      ? "A major ritual is available now. Brew a modifier that affects the NEXT level."
      : "Minor DM visit. Story + directive only. No modifier brewed this time.";
  } else {
    btnQuest.disabled = true;
    btnQuest.textContent = `DM @ L${nextDMAtLevel}`;
    dmStatus.textContent =
      `DM appears randomly every ${DM_GAP_MIN}–${DM_GAP_MAX} levels. ` +
      `Next appearance: level ${nextDMAtLevel}. ` +
      `Modifiers only brew on every ${DM_MAJOR_EVERY}th DM appearance.`;
  }
}

function renderDM(payload){
  questTitle.textContent = payload.quest_title || "—";
  dmIntro.textContent = payload.dm_intro || "";
  dmMid.textContent = payload.dm_midpoint || "";
  dmVerdict.textContent = payload.dm_verdict || "";
}

// ---------------- Telemetry (BANK inference) ----------------
const sig = { moves:0, invalid:0, resets:0, moveTimes:[], lastMoveAt:0 };
const avg = (arr)=> arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

function inferBANK(){
  const pace = avg(sig.moveTimes.slice(-12));
  const invalidRate = sig.moves ? (sig.invalid / sig.moves) : 0;
  const resetRate = sig.resets ? (sig.resets / Math.max(1, level)) : 0;

  const score = { B:0, A:0, N:0, K:0 };
  score.B += pace > 1400 ? 1.2 : 0;
  score.B += invalidRate < 0.10 ? 1.0 : 0;

  score.A += pace && pace < 900 ? 1.2 : 0;
  score.A += invalidRate < 0.22 ? 0.5 : 0;

  score.N += resetRate > 0.30 ? 1.0 : 0;
  score.N += invalidRate > 0.18 ? 0.6 : 0;

  score.K += invalidRate > 0.12 ? 0.7 : 0;
  score.K += resetRate < 0.25 ? 0.7 : 0;

  const entries = Object.entries(score).sort((a,b)=>b[1]-a[1]);
  const [bankPrimary, top] = entries[0];
  const second = entries[1][1];
  const conf = Math.max(0.25, Math.min(0.92, 0.35 + (top-second)*0.55));
  return { bankPrimary, bankConfidence: Number(conf.toFixed(2)) };
}

function inferSinTags(){
  const tags = [];

  // Pull exactly one carryover sinTag from last level's punish event (if any)
  const carry = consumeSinTag();
  if (carry) tags.push(carry);

  if (sig.resets >= 2 && sig.resets > level/2) tags.push("over_reset");
  const pace = avg(sig.moveTimes.slice(-12));
  if (pace > 1500) tags.push("hesitation");
  if ((sig.moves && sig.invalid/sig.moves > 0.18)) tags.push("indecision");

  if (!tags.length) tags.push("steady_hand");
  return [...new Set(tags)].slice(0,3);
}

// ---------------- Thesis selection + palette ----------------
let currentElements = [];
let currentPalette = [];

// Bias thesis selection based on sinTags + current BANK
function pickThesisKey(rng, sinTags=[], bankPrimary="K"){
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

function chooseElementsForThesis(thesisKey, colorsWanted, rng){
  const thesis = THESES[thesisKey] || null;
  const all = Object.keys(ELEMENTS);

  const mustInclude = thesis?.must_include || [];
  const mustExclude = new Set(thesis?.must_exclude || []);

  const chosen = [];
  for (const sym of mustInclude){
    if (ELEMENTS[sym] && !chosen.includes(sym)) chosen.push(sym);
  }

  const pool = all.filter(sym => ELEMENTS[sym] && !mustExclude.has(sym) && !chosen.includes(sym));
  while (chosen.length < colorsWanted && pool.length){
    const idx = Math.floor(rng.f() * pool.length);
    chosen.push(pool.splice(idx,1)[0]);
  }
  while (chosen.length < colorsWanted){
    chosen.push(all[chosen.length % all.length]);
  }
  return chosen.slice(0, colorsWanted);
}

function applyElementPalette(recipe){
  const elems = (recipe.elements || []).slice(0, recipe.colors);
  currentElements = elems;
  currentPalette = elems.map(sym => (ELEMENTS[sym]?.color || "#ffffff"));
}

function renderLegend(recipe){
  legendEl.innerHTML = "";

  const thesisKey = recipe.thesisKey;
  const thesis = thesisKey ? THESES[thesisKey] : null;
  if (thesis){
    const pill = document.createElement("div");
    pill.className = "legendItem thesisPill";
    pill.innerHTML = `
      <div class="legendText">
        <div class="legendTop">Thesis: ${thesis.name}</div>
        <div class="legendSub">Must include: ${(thesis.must_include||[]).join(", ") || "—"} · Must exclude: ${(thesis.must_exclude||[]).join(", ") || "—"}</div>
      </div>
    `;
    legendEl.appendChild(pill);
  }

  const hideCL = !!state.stabilizer && !state.stabilizer.unlocked && state.stabilizer.symbol === "CL";
  for (let i=0; i<currentElements.length; i++){
    const sym = currentElements[i];
    if (hideCL && sym === "CL") continue;

    const el = ELEMENTS[sym];
    if (!el) continue;
    const item = document.createElement("div");
    item.className = "legendItem";
    const teaches = el.teaches ? `teaches: ${el.teaches}` : "";
    const punishes = el.punishes ? `punishes: ${el.punishes}` : "";
    item.innerHTML = `
      <div class="swatch" style="background:${el.color}"></div>
      <div class="legendText">
        <div class="legendTop">${el.symbol} — ${el.name}</div>
        <div class="legendSub">${[teaches, punishes].filter(Boolean).join(" · ")}</div>
      </div>
    `;
    legendEl.appendChild(item);
  }
}

// ---------------- Modifier (UI placeholder) ----------------
let pendingModifier = null;
function formatMod(mod){
  if (!mod) return "—";
  const parts = [];
  const map = [
    ["bottleCountDelta","bottles"],
    ["colorsDelta","colors"],
    ["capacityDelta","cap"],
    ["emptyBottlesDelta","empty"],
    ["lockedBottlesDelta","locks"],
    ["wildcardSlotsDelta","wild"],
  ];
  for (const [k,label] of map){
    const v = mod[k] ?? 0;
    if (v) parts.push(`${label}${v>0?"+":""}${v}`);
  }
  const tag = mod.ruleTag && mod.ruleTag !== "none" ? mod.ruleTag : "";
  return (parts.length ? parts.join(" ") : "no-delta") + (tag ? ` | ${tag}` : "");
}
function setPendingModifier(mod){
  pendingModifier = mod;
  modOut.textContent = formatMod(mod);
}

// ---------------- Bottle Game State ----------------
const state = {
  bottles:[],
  capacity:4,
  selected:-1,
  locked:[],
  hiddenSegs:[],
  stabilizer: null // { idx, unlock, symbol, unlocked:false }
};

const topColor = (b)=> b.length ? b[b.length-1] : null;
function topRunCount(b){
  if (!b.length) return 0;
  const c = topColor(b);
  let n=0;
  for (let i=b.length-1;i>=0;i--){ if (b[i]===c) n++; else break; }
  return n;
}

function isSolved(){
  return state.bottles.every(b => {
    if (b.length === 0) return true;
    if (b.length !== state.capacity) return false;
    return b.every(x => x === b[0]);
  });
}

function canPour(from,to){
  if (from===to) return false;
  if (state.locked[from] || state.locked[to]) return false;
  const a=state.bottles[from], b=state.bottles[to];
  if (!a.length) return false;
  if (b.length>=state.capacity) return false;
  const color=topColor(a), target=topColor(b);
  return (target===null || target===color);
}

function checkStabilizerUnlock(){
  if (!state.stabilizer || state.stabilizer.unlocked) return;
  if (state.stabilizer.unlock !== "UR_full") return;

  const urIndex = currentElements.indexOf("UR");
  if (urIndex < 0) return;

  const cap = state.capacity;
  const hasFullUR = state.bottles.some(b =>
    b.length === cap && b.every(x => x === urIndex)
  );

  if (hasFullUR){
    const idx = state.stabilizer.idx;
    state.locked[idx] = false;
    state.hiddenSegs[idx] = false;
    state.stabilizer.unlocked = true;

    showToast("Clarity unlocked. Now stop panicking.");
    renderLegend(lastRecipe);
    render();
  }
}

// invalid pour punish tracking (per-level)
let levelInvalid = 0;
let punishedThisLevel = false;

function doPour(from,to){
  if(!canPour(from,to)){
    sig.invalid++; badOut.textContent=String(sig.invalid);
    levelInvalid++;

    // After X invalid pours in this level, show element punishes + queue a sinTag for next thesis pick
    if (!punishedThisLevel && levelInvalid >= INVALID_POUR_PUNISH_THRESHOLD){
      punishedThisLevel = true;

      const a = state.bottles[from] || [];
      const ci = a.length ? topColor(a) : null;
      const sym = (ci !== null && ci !== undefined) ? currentElements[ci] : null;
      const el = sym ? ELEMENTS[sym] : null;

      const punishTag = el?.punishes || "sloppiness";
      showToast(`${el?.symbol || sym || "??"} punishes: ${punishTag}`);
      pushSinTag(punishTag);
    } else {
      showToast("Invalid pour");
    }
    return false;
  }

  const a=state.bottles[from], b=state.bottles[to];
  const color=topColor(a);
  const run=topRunCount(a);
  const space=state.capacity-b.length;
  const amount=Math.min(run, space);

  // move segments
  for(let i=0;i<amount;i++) b.push(a.pop());

  sig.moves++;
  movesOut.textContent = String(sig.moves);
  playPourFX(pourFX, from, to, currentPalette[color] || "#fff", amount);

  checkStabilizerUnlock();

  if (isSolved()){
    showToast("Solved. Next level.");
  }
  render();
  return true;
}

// ---------------- Level generation ----------------
let level = 1;
let questId = 1;
let lastRecipe = null;

function computeLevelConfig(){
  // base, then apply pending modifier if present
  const base = {
    colors: Math.min(6, 3 + Math.floor((level-1)/6)),  // ramps slowly
    capacity: 4,
    bottleCount: null, // derived
    emptyBottles: 2,
    lockedBottles: 0,
    wildcardSlots: 0,
  };

  const m = pendingModifier || null;
  if (m){
    base.colors = Math.max(3, Math.min(8, base.colors + (m.colorsDelta||0)));
    base.capacity = Math.max(3, Math.min(6, base.capacity + (m.capacityDelta||0)));
    base.emptyBottles = Math.max(1, Math.min(4, base.emptyBottles + (m.emptyBottlesDelta||0)));
    base.lockedBottles = Math.max(0, Math.min(2, base.lockedBottles + (m.lockedBottlesDelta||0)));
    base.wildcardSlots = Math.max(0, Math.min(2, base.wildcardSlots + (m.wildcardSlotsDelta||0)));
    // bottleCountDelta can push bottleCount directly, but we keep derived default + delta
    base.bottleCount = (base.colors + base.emptyBottles) + (m.bottleCountDelta||0);
  }
  if (!base.bottleCount) base.bottleCount = base.colors + base.emptyBottles;
  return base;
}

function buildRecipe(){
  const rng = makeRng(hashSeed(runSeed, 4242, level));
  const { bankPrimary } = inferBANK();
  const sinTags = inferSinTags();
  const thesisKey = pickThesisKey(rng, sinTags, bankPrimary);

  const cfg = computeLevelConfig();
  const elements = chooseElementsForThesis(thesisKey, cfg.colors, rng);

  // Illegal reaction trap: if thesis is UR_without_CL, allow UR in palette but hide/lock CL as stabilizer mechanic
  let stabilizer = null;
  let elementsForPuzzle = [...elements];

  if (thesisKey === "UR_without_CL"){
    const hasUR = elementsForPuzzle.includes("UR");
    if (!hasUR) elementsForPuzzle[0] = "UR";

    // CL should exist in schema
    if (ELEMENTS["CL"]){
      // add CL to palette as an extra "hidden color" only when stabilizer complexity is allowed
      // before STABILIZER_UNLOCK_LEVEL, we only foreshadow via DM and do NOT introduce CL into the puzzle
      if (level >= STABILIZER_UNLOCK_LEVEL){
        if (!elementsForPuzzle.includes("CL")) elementsForPuzzle.push("CL");
        stabilizer = { unlock:"UR_full", symbol:"CL", idx:-1, unlocked:false };
      }
    }
  }

  return {
    level,
    cfg,
    thesisKey,
    recipeSource: thesisKey, // surfacing where it came from
    elements: elementsForPuzzle
  , stabilizer
  };
}

function genPuzzle(recipe){
  const cfg = recipe.cfg;
  state.capacity = cfg.capacity;

  // Determine actual palette used for fill colors (exclude hidden stabilizer symbol if needed)
  // If stabilizer is present, that color still exists in palette, but all its segments live in the locked bottle.
  const symbols = recipe.elements.slice();
  const colors = symbols.length;

  const rng = makeRng(hashSeed(runSeed, 9001, level));
  // Color indices 0..colors-1, but we might place stabilizer color segments specially.
  const stabilizerSym = recipe.stabilizer?.symbol || null;
  const stabilizerIndex = stabilizerSym ? symbols.indexOf(stabilizerSym) : -1;

  // Start with empty bottles
  const bottleCount = cfg.bottleCount;
  const bottles = Array.from({length:bottleCount}, ()=>[]);
  const locked = Array.from({length:bottleCount}, ()=>false);
  const hiddenSegs = Array.from({length:bottleCount}, ()=>false);

  // Fill distribution:
  // - For normal colors: create capacity segments each.
  // - For stabilizer color: create capacity segments that will be put into the stabilizer bottle, not shuffled.
  const pool = [];
  for (let ci=0; ci<colors; ci++){
    if (ci === stabilizerIndex) continue;
    for (let k=0;k<cfg.capacity;k++) pool.push(ci);
  }

  // Shuffle pool
  for (let i=pool.length-1;i>0;i--){
    const j = rng.int(0,i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  // Fill first (colors) bottles with segments (classic)
  let bi = 0;
  while (pool.length){
    if (bottles[bi].length >= cfg.capacity) bi = (bi+1) % (bottleCount - cfg.emptyBottles);
    bottles[bi].push(pool.pop());
  }

  // Ensure last emptyBottles are empty
  for (let i=bottleCount-cfg.emptyBottles; i<bottleCount; i++){
    bottles[i] = [];
  }

  // Locked bottles (optional): lock first N non-empty bottles
  for (let i=0;i<cfg.lockedBottles;i++){
    locked[i] = true;
  }

  // Stabilizer bottle (optional): allocate a bottle at end-1 (but not an empty bottle if possible)
  if (recipe.stabilizer && stabilizerIndex >= 0){
    // pick an index that is currently empty to keep readability (prefer last)
    const idx = bottleCount-1; // last bottle
    recipe.stabilizer.idx = idx;

    bottles[idx] = Array.from({length:cfg.capacity}, ()=>stabilizerIndex);
    locked[idx] = true;
    hiddenSegs[idx] = true;
  }

  // Commit to state
  state.bottles = bottles;
  state.locked = locked;
  state.hiddenSegs = hiddenSegs;
  state.selected = -1;
  state.stabilizer = recipe.stabilizer;
}

function render(){
  grid.innerHTML = "";

  for (let i=0;i<state.bottles.length;i++){
    const bottle = document.createElement("div");
    bottle.className = "bottle";
    bottle.dataset.bottle = String(i);

    if (state.selected === i) bottle.classList.add("selected");
    if (state.locked[i]) bottle.classList.add("locked");
    if (state.hiddenSegs[i]) bottle.classList.add("hiddenSegs");

    bottle.addEventListener("click", () => onBottleTap(i));
    bottle.addEventListener("touchend", (e)=>{ e.preventDefault(); onBottleTap(i); }, {passive:false});

    // segments bottom->top
    const b = state.bottles[i];
    for (let s=0; s<state.capacity; s++){
      const seg = document.createElement("div");
      seg.className = "seg";

      const ci = b[s] ?? null;
      if (ci === null || ci === undefined){
        seg.style.background = "transparent";
      } else {
        const sym = currentElements[ci];
        const el = ELEMENTS[sym];
        seg.style.background = el?.color || "#fff";

        // pattern overlay classes
        if (el?.role) seg.classList.add(`role-${String(el.role).toLowerCase()}`);
        seg.classList.add(`el-${sym}`);
      }

      bottle.appendChild(seg);
    }

    grid.appendChild(bottle);
  }
}

function onBottleTap(i){
  const now = performance.now();
  if (sig.lastMoveAt){
    sig.moveTimes.push(now - sig.lastMoveAt);
  }
  sig.lastMoveAt = now;

  if (state.selected < 0){
    state.selected = i;
    render();
    return;
  }

  const from = state.selected;
  const to = i;
  state.selected = -1;

  doPour(from,to);
}

// ---------------- DM click ----------------
btnQuest.addEventListener("click", async () => {
  if (!isDMLevel(level)) return;

  const { bankPrimary, bankConfidence } = inferBANK();
  const sinTags = inferSinTags();

  bankOut.textContent = `${bankPrimary} (${Math.round(bankConfidence*100)}%)`;
  sinsOut.textContent = sinTags.length ? sinTags.join(", ") : "—";

  const upcoming = dmAppearCount + 1;
  const wantModifier = isMajorDM(upcoming);

  const foreshadowOnly =
    level >= FORESHADOW_START_LEVEL &&
    level < STABILIZER_UNLOCK_LEVEL;

  statusOut.textContent = wantModifier ? "brewing..." : "speaking...";

  const payload = {
    act: Math.ceil(level/5),
    questId,
    bankPrimary,
    bankConfidence,
    sinTags,
    seed: runSeed,
    level,
    wantModifier,
    foreshadowOnly
  };

  try{
    const key = `quest-node:${runSeed}:${questId}:${level}:${upcoming}:${wantModifier}:${foreshadowOnly}`;
    const data = await singleFlight(key, () => postJSON(apiBaseEl.value, "/api/quest-node", payload));
    const q = data.payload;

    renderDM(q);

    if (wantModifier){
      setPendingModifier(q.modifier);
      showToast("Modifier brewed for next level");
    } else {
      setPendingModifier(null);
      showToast("DM visit (no modifier)");
    }

    dmAppearCount = upcoming;
    setNum(DM_COUNT_KEY, dmAppearCount);
    scheduleNextDM(level);
    updateDMButton();

    statusOut.textContent = "ok";
  } catch(e){
    statusOut.textContent = (e?.status === 429) ? "rate-limited" : "dm error";
    showToast((e?.status === 429) ? "Rate limited. Try again soon." : "DM error (check server).");
    console.warn(e, e.detailText);
  }
});

// ---------------- Buttons ----------------
btnNext.addEventListener("click", () => {
  level++;
  startLevel();
});
btnReset.addEventListener("click", () => {
  sig.resets++;
  resetOut.textContent = String(sig.resets);

  // reset run seed + DM schedule + pending modifier + sin queue
  del(RUN_SEED_KEY); del(DM_COUNT_KEY); del(NEXT_DM_KEY);
  del(SIN_QUEUE_KEY);
  runSeed = 0; dmAppearCount = 0; nextDMAtLevel = 0;
  ({ runSeed, dmAppearCount, nextDMAtLevel } = loadOrInitRunState());

  pendingModifier = null;
  modOut.textContent = "—";

  level = 1;
  startLevel();
});

function startLevel(){
  // clear per-level punish tracking
  levelInvalid = 0;
  punishedThisLevel = false;

  levelOut.textContent = String(level);
  badOut.textContent = String(sig.invalid);
  movesOut.textContent = String(sig.moves);
  cfgOut.textContent = "—";
  recipeSrcOut.textContent = "—";

  updateDMButton();

  lastRecipe = buildRecipe();
  const recipe = lastRecipe;

  // Apply palette and render legend
  applyElementPalette({ elements: recipe.elements, colors: recipe.elements.length, thesisKey: recipe.thesisKey });
  state.stabilizer = recipe.stabilizer;

  // generate puzzle
  genPuzzle(recipe);

  // render info
  cfgOut.textContent = `C${recipe.cfg.colors}/B${recipe.cfg.bottleCount}/Cap${recipe.cfg.capacity}/E${recipe.cfg.emptyBottles}` + (recipe.cfg.lockedBottles ? `/L${recipe.cfg.lockedBottles}` : "");
  recipeSrcOut.textContent = recipe.recipeSource || "—";

  renderLegend({ thesisKey: recipe.thesisKey, colors: recipe.elements.length, elements: recipe.elements });

  // If we’re before stabilizer unlock levels and the thesis would be UR_without_CL, we keep it as foreshadow only:
  // we DO still allow UR in the palette, but we do NOT insert the hidden CL bottle. (recipe.stabilizer will be null in that case)
  statusOut.textContent = "ready";
  render();
}

// ---------------- Boot ----------------
(function boot(){
  levelOut.textContent = String(level);
  movesOut.textContent = String(sig.moves);
  badOut.textContent = String(sig.invalid);
  resetOut.textContent = String(sig.resets);

  updateDMButton();
  startLevel();

  // tiny: show some lore in DM card as a default ambient line
  if (!dmIntro.textContent){
    dmIntro.textContent = pickLoreLine?.("open") || "You want the potion? Stop being dramatic and pour.";
  }
})();
