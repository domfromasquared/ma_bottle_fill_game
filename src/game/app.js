import { ELEMENTS, THESES, pickLoreLine } from "../../element_schema.js";
import { getJSON, setJSON, setNum } from "../utils/storage.js";
import { makeRng, hashSeed, randInt } from "../utils/rng.js";
import { singleFlight } from "../utils/singleFlight.js";
import { postJSON } from "../utils/http.js";
import { makeToaster, qs, playPourFX } from "../utils/ui.js";

const FORESHADOW_START_LEVEL = 10;
const STABILIZER_UNLOCK_LEVEL = 15;

const DEFAULT_PROD = "https://ma-bottle-fill-api.onrender.com";
const DEFAULT_LOCAL = "http://localhost:8787";
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

const INVALID_POUR_PUNISH_THRESHOLD = 3;
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

const DM_MOODS = ["amused","annoyed","disappointed","encouraging","frustrated","furious","impressed","proud","satisfied"];
function normMood(m){
  const s = String(m || "").trim().toLowerCase();
  if (DM_MOODS.includes(s)) return s;
  return "encouraging";
}
function pad3(n){
  const x = Math.max(0, Math.min(999, Number(n) || 0));
  return String(x).padStart(3, "0");
}

/* ---------------- Player identity (name) ---------------- */
const PLAYER_NAME_KEY = "ma_playerName";
const PLAYER_NAME_MAX = 14;
const DEFAULT_PLAYER_NAME = "Acolyte";

function getPlayerName(){
  return (localStorage.getItem(PLAYER_NAME_KEY) || "").trim();
}
function setPlayerName(name){
  const clean = String(name || "").trim().slice(0, PLAYER_NAME_MAX);
  localStorage.setItem(PLAYER_NAME_KEY, clean);
  return clean;
}
function ensurePlayerName(){
  const n = getPlayerName();
  if (n) return n;
  return setPlayerName(DEFAULT_PLAYER_NAME);
}

/* ---------------- DOM ---------------- */
const statusOut = qs("statusOut");
const grid = qs("grid");
const pourFX = qs("pourFX");
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

const SPEECH_THEME_KEY = "ma_speechTheme";
function getSpeechTheme(){
  const v = (localStorage.getItem(SPEECH_THEME_KEY) || "").toLowerCase();
  return (v === "light" || v === "dark") ? v : "dark";
}
function setSpeechTheme(theme){
  const t = (String(theme || "").toLowerCase() === "light") ? "light" : "dark";
  speech.dataset.theme = t;
  localStorage.setItem(SPEECH_THEME_KEY, t);
}
function toggleSpeechTheme(){
  setSpeechTheme(getSpeechTheme() === "dark" ? "light" : "dark");
}

const bankRail = qs("bankRail");
const bankExpanded = qs("bankExpanded");

const modSlot1 = qs("modSlot1");
const modSlot2 = qs("modSlot2");
const modSlot3 = qs("modSlot3");

const API_BASE_KEY = "ma_apiBase";
apiBaseEl.value = localStorage.getItem(API_BASE_KEY) || (isLocal ? DEFAULT_LOCAL : DEFAULT_PROD);

const RUN_SEED_KEY = "ma_runSeed";
const DM_COUNT_KEY = "ma_dmAppearCount";
const NEXT_DM_KEY = "ma_nextDMAtLevel";

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

/* ---------------- DM Sprite Helpers ---------------- */
function ensureDMImg(){
  let img = dmCharacter.querySelector("img");
  if (!img){
    img = document.createElement("img");
    img.alt = "Marketing Alchemist";
    img.decoding = "async";
    img.loading = "eager";
    img.draggable = false;
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.pointerEvents = "none";
    dmCharacter.appendChild(img);
  }
  return img;
}
function setDMAvatar({ mood, frame, seedKey }){
  const img = ensureDMImg();
  const m = normMood(mood);

  let f = Number.isInteger(frame) ? frame : null;
  if (f === null){
    const r = makeRng(hashSeed(runSeed, level, questId, seedKey || 777));
    f = r.int(0, 5);
  } else {
    f = Math.max(0, Math.min(5, f));
  }
  img.src = `assets/dm/${m}/MA_${pad3(f)}.png`;
}

/* ---------------- Telemetry (BANK inference) ---------------- */
const sig = { moves:0, invalid:0, resets:0, moveTimes:[], lastMoveAt:0 };
const avg = (arr)=> arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

let level = 1;

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

  const carry = consumeSinTag();
  if (carry) tags.push(carry);

  if (sig.resets >= 2 && sig.resets > level/2) tags.push("over_reset");
  const pace = avg(sig.moveTimes.slice(-12));
  if (pace > 1500) tags.push("hesitation");
  if ((sig.moves && sig.invalid/sig.moves > 0.18)) tags.push("indecision");

  if (!tags.length) tags.push("steady_hand");
  return [...new Set(tags)].slice(0,3);
}

function setBankRail(bankPrimary){
  const spans = bankRail.querySelectorAll(".bankLetters span");
  spans.forEach(s => s.classList.remove("on"));
  const on = bankRail.querySelector(`.bankLetters span[data-bank="${bankPrimary}"]`);
  if (on) on.classList.add("on");
}

/* ---------------- Thesis selection + palette ---------------- */
let currentElements = [];
let currentPalette = [];

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

/* ---------------- State ---------------- */
const state = {
  bottles:[],
  capacity:4,
  selected:-1,
  locked:[],
  hiddenSegs:[],
  stabilizer: null
};

/* ---------------- UI rendering helpers ---------------- */
function renderThesisBar(thesisKey){
  const thesis = thesisKey ? THESES[thesisKey] : null;
  if (!thesis){
    thesisLabel.textContent = "Thesis: —";
    thesisSub.textContent = "—";
    infoThesis.textContent = "—";
    return;
  }
  thesisLabel.textContent = `Thesis: ${thesis.name}`;
  thesisSub.textContent =
    `Must include: ${(thesis.must_include||[]).join(", ") || "—"} · Must exclude: ${(thesis.must_exclude||[]).join(", ") || "—"}`;
  infoThesis.textContent = thesis.name;
}

function renderGlossary(){
  glossaryList.innerHTML = "";
  const syms = Object.keys(ELEMENTS).sort();
  for (const sym of syms){
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
          ${el.punishes ? `${(el.role||el.teaches) ? " · " : ""}punishes: ${el.punishes}` : ""}
        </div>
      </div>
    `;
    glossaryList.appendChild(item);
  }
}

/* ---------------- Speech bubble (clean + consistent) ---------------- */
function clearSpeech(){
  speechText.innerHTML = "";
  questTitle.textContent = "—";
  speechSmall.textContent = "";
}

function makePrimaryBtn(label){
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

function makeInput(placeholder){
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

function setDMSpeech({ title, body, small }){
  questTitle.textContent = title || "—";
  speechSmall.textContent = small || "";

  speechText.innerHTML = "";
  const copy = document.createElement("div");
  copy.style.whiteSpace = "pre-wrap";
  copy.textContent = body || "";
  speechText.appendChild(copy);

  return { copy };
}

/* ---------------- DM overlay helpers ---------------- */
function showDMOverlay(){
  dmCharacter.classList.add("show");
  dmCharacter.setAttribute("aria-hidden","false");
  speech.classList.add("show");
  speech.setAttribute("aria-hidden","false");
}
function hideDMOverlay(){
  dmCharacter.classList.remove("show");
  dmCharacter.setAttribute("aria-hidden","true");
  speech.classList.remove("show");
  speech.setAttribute("aria-hidden","true");
}

/**
 * Cancellation token:
 * - increment dmToken to invalidate any in-flight DM response
 */
let dmToken = 0;

/* ---------------- Intro + deadlock mode flags ---------------- */
let introStep = 0;            // 0 = not running, 1 = name entry, 2 = ready to start quest
let deadlockActive = false;   // if DM popped for deadlock

function introIsActive(){ return introStep === 1 || introStep === 2; }

/* ---------------- Puzzle rules ---------------- */
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

function hasAnyPlayableMove(){
  for (let from = 0; from < state.bottles.length; from++){
    if (state.locked[from]) continue;
    if (!state.bottles[from]?.length) continue;
    for (let to = 0; to < state.bottles.length; to++){
      if (from === to) continue;
      if (canPour(from, to)) return true;
    }
  }
  return false;
}

/* ---------------- Stabilizer unlock ---------------- */
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
    render();
  }
}

/* ---------------- Per-level tracking ---------------- */
let levelInvalid = 0;
let punishedThisLevel = false;

/* ---------------- Info panel ---------------- */
function syncInfoPanel(){
  infoLevel.textContent = String(level);
  infoMoves.textContent = String(sig.moves);
  infoInvalid.textContent = String(sig.invalid);
  infoPlayer.textContent = getPlayerName() || "—";
}

/* ---------------- Pour logic ---------------- */
function doPour(from,to){
  if(!canPour(from,to)){
    sig.invalid++;
    syncInfoPanel();
    levelInvalid++;

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

  for(let i=0;i<amount;i++) b.push(a.pop());

  sig.moves++;
  syncInfoPanel();
  playPourFX(pourFX, from, to, currentPalette[color] || "#fff", amount);

  checkStabilizerUnlock();

  if (isSolved()){
    showToast("Solved. Next level.");
    nextLevel();
    return true;
  }

  render();

  // NEW: if deadlocked, DM pops in with retry option
  if (!isSolved() && !hasAnyPlayableMove()){
    showOutOfMovesDM();
  }

  return true;
}

/* ---------------- Level / recipe generation ---------------- */
let questId = 1;
let pendingModifier = null;

function setPendingModifier(mod){ pendingModifier = mod || null; }

function computeLevelConfig(){
  const base = {
    colors: Math.min(6, 3 + Math.floor((level-1)/6)),
    capacity: 4,
    bottleCount: null,
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

  let stabilizer = null;
  let elementsForPuzzle = [...elements];

  if (thesisKey === "UR_without_CL"){
    const hasUR = elementsForPuzzle.includes("UR");
    if (!hasUR) elementsForPuzzle[0] = "UR";

    if (ELEMENTS["CL"]){
      if (level >= STABILIZER_UNLOCK_LEVEL){
        if (!elementsForPuzzle.includes("CL")) elementsForPuzzle.push("CL");
        stabilizer = { unlock:"UR_full", symbol:"CL", idx:-1, unlocked:false };
      }
    }
  }

  return { level, cfg, thesisKey, elements: elementsForPuzzle, stabilizer };
}

function genPuzzle(recipe){
  const cfg = recipe.cfg;
  state.capacity = cfg.capacity;

  const symbols = recipe.elements.slice();
  const colors = symbols.length;

  const rng = makeRng(hashSeed(runSeed, 9001, level));
  const stabilizerSym = recipe.stabilizer?.symbol || null;
  const stabilizerIndex = stabilizerSym ? symbols.indexOf(stabilizerSym) : -1;

  const bottleCount = cfg.bottleCount;
  const bottles = Array.from({length:bottleCount}, ()=>[]);
  const locked = Array.from({length:bottleCount}, ()=>false);
  const hiddenSegs = Array.from({length:bottleCount}, ()=>false);

  const pool = [];
  for (let ci=0; ci<colors; ci++){
    if (ci === stabilizerIndex) continue;
    for (let k=0;k<cfg.capacity;k++) pool.push(ci);
  }

  for (let i=pool.length-1;i>0;i--){
    const j = rng.int(0,i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  let bi = 0;
  while (pool.length){
    if (bottles[bi].length >= cfg.capacity) bi = (bi+1) % (bottleCount - cfg.emptyBottles);
    bottles[bi].push(pool.pop());
  }

  for (let i=bottleCount-cfg.emptyBottles; i<bottleCount; i++){
    bottles[i] = [];
  }

  for (let i=0;i<cfg.lockedBottles;i++){
    locked[i] = true;
  }

  if (recipe.stabilizer && stabilizerIndex >= 0){
    const idx = bottleCount-1;
    recipe.stabilizer.idx = idx;

    bottles[idx] = Array.from({length:cfg.capacity}, ()=>stabilizerIndex);
    locked[idx] = true;
    hiddenSegs[idx] = true;
  }

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
        if (el?.role) seg.classList.add(`role-${String(el.role).toLowerCase()}`);
        seg.classList.add(`el-${sym}`);
      }
      bottle.appendChild(seg);
    }

    grid.appendChild(bottle);
  }
}

function onBottleTap(i){
  // If intro step 1 or 2 is active, still allow gameplay? No — intro is modal.
  if (introIsActive()) return;

  const now = performance.now();
  if (sig.lastMoveAt) sig.moveTimes.push(now - sig.lastMoveAt);
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

function nextLevel(){
  level++;
  startLevel();
}

/* ---------------- Intro DM (name -> start quest) ---------------- */
function runFirstLoadIntro(){
  if (getPlayerName()) return false;

  introStep = 1;
  deadlockActive = false;

  showDMOverlay();
  setSpeechTheme("dark");
  setDMAvatar({ mood: "impressed", seedKey: 20251229 });

  setDMSpeech({
    title: "Welcome to The Balance Protocol",
    body:
`I am The Marketing Alchemist.

You’ve stepped into The Balance Protocol — a system meant to keep power, process, and progress in equilibrium.

But something’s off. The balance has been disrupted — and it’s already leaking into everything you touch.

You’ll fix it. One bottle at a time. One thesis at a time.

What should I call you?`,
    small: "Enter a name (14 characters max), then press Submit."
  });

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "10px";
  row.style.alignItems = "center";
  row.style.marginTop = "10px";

  const input = makeInput(`Name (max ${PLAYER_NAME_MAX})`);
  const submitBtn = makePrimaryBtn("Submit");

  row.appendChild(input);
  row.appendChild(submitBtn);
  speechText.appendChild(row);

  const submit = () => {
    const name = (input.value || "").trim();
    if (!name){
      showToast("Give me a name.");
      return;
    }
    const saved = setPlayerName(name);
    syncInfoPanel();

    introStep = 2;

    // Show Start Quest button
    setDMSpeech({
      title: `Good. ${saved}.`,
      body:
`Now listen carefully, ${saved}.

The Balance Protocol doesn’t reward “busy.”
It rewards alignment.

When I appear, I’m not entertaining you.
I’m correcting you.

Ready?`,
      small: "Press Start Quest to begin. (You can also close me with ✕ anytime.)"
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
  };

  submitBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e)=>{ if (e.key === "Enter") submit(); });

  setTimeout(()=> input.focus(), 200);

  return true;
}

/* ---------------- Deadlock DM (out of moves) ---------------- */
function dmReactionForBANK(bankPrimary){
  switch (bankPrimary){
    case "A":
      return { mood:"annoyed", title:"Out of moves.", body:"Action without aim.\nYou brute-forced the ritual into a wall.\n\nRetry. Fewer clicks. More intent." };
    case "B":
      return { mood:"disappointed", title:"Protocol failure.", body:"Blueprint ignored.\nYou tried to solve chaos without structure.\n\nRetry. Plan two pours ahead. Minimum." };
    case "N":
      return { mood:"encouraging", title:"No moves left.", body:"Breathe.\n\nYou’re close — but you protected the wrong stacks.\n\nRetry. Calm hands. Clean pours." };
    case "K":
    default:
      return { mood:"amused", title:"No legal pours remain.", body:"Ah. Classic.\n\nYou constructed a perfectly unsolvable state.\n\nRetry — and respect constraints before you pour." };
  }
}

function showOutOfMovesDM(){
  if (deadlockActive) return; // prevent stacking
  deadlockActive = true;

  const { bankPrimary } = inferBANK();
  setBankRail(bankPrimary);

  const react = dmReactionForBANK(bankPrimary);

  showDMOverlay();
  setSpeechTheme("dark");
  setDMAvatar({ mood: react.mood, seedKey: 5050 });

  setDMSpeech({
    title: react.title,
    body: react.body,
    small: `BANK: ${bankPrimary} · Press Retry Level (or ✕ to auto-retry).`
  });

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "10px";
  row.style.alignItems = "center";
  row.style.marginTop = "10px";

  const retryBtn = makePrimaryBtn("Retry Level");
  retryBtn.addEventListener("click", () => {
    deadlockActive = false;
    sig.resets++;
    hideDMOverlay();
    startLevel(); // deterministic same level (same runSeed + level)
  });

  row.appendChild(retryBtn);
  speechText.appendChild(row);
}

/* ---------------- Quest-node DM (LLM) ---------------- */
async function runDMIfAvailable(){
  if (!isDMLevel(level)) return;

  const myToken = ++dmToken;

  const { bankPrimary, bankConfidence } = inferBANK();
  const sinTags = inferSinTags();
  setBankRail(bankPrimary);

  const upcoming = dmAppearCount + 1;
  const wantModifier = isMajorDM(upcoming);

  setSpeechTheme(wantModifier ? "light" : "dark");

  const foreshadowOnly = level >= FORESHADOW_START_LEVEL && level < STABILIZER_UNLOCK_LEVEL;

  statusOut.textContent = wantModifier ? "brewing..." : "speaking...";

  showDMOverlay();
  setDMAvatar({ mood: wantModifier ? "proud" : "encouraging", seedKey: 123 });

  setDMSpeech({
    title: wantModifier ? "Major Ritual" : "DM Speaks",
    body: "…",
    small: `BANK ${bankPrimary} (${Math.round(bankConfidence*100)}%) · sinTags: ${sinTags.join(", ")}`
  });

  const payload = {
    act: Math.ceil(level/5),
    questId,
    bankPrimary,
    bankConfidence,
    sinTags,
    seed: runSeed,
    level,
    wantModifier,
    foreshadowOnly,
    playerName: getPlayerName() || DEFAULT_PLAYER_NAME
  };

  try{
    const key = `quest-node:${runSeed}:${questId}:${level}:${upcoming}:${wantModifier}:${foreshadowOnly}`;
    const data = await singleFlight(key, () => postJSON(apiBaseEl.value, "/api/quest-node", payload));
    if (myToken !== dmToken) return; // cancelled by X

    const q = data.payload;

    setDMAvatar({
      mood: q.dm_mood || (wantModifier ? "proud" : "encouraging"),
      frame: Number.isInteger(q.dm_frame) ? q.dm_frame : null,
      seedKey: 999,
    });

    const parts = [q.dm_intro || "", q.dm_midpoint || "", q.dm_verdict || ""].filter(Boolean);
    setDMSpeech({
      title: q.quest_title || (wantModifier ? "Major Ritual" : "DM Speaks"),
      body: parts.join("\n\n") || "…",
      small: `Next DM scheduled · major every ${DM_MAJOR_EVERY}`
    });

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

    statusOut.textContent = "ok";
    questId++;
  } catch(e){
    if (myToken !== dmToken) return; // cancelled

    statusOut.textContent = (e?.status === 429) ? "rate-limited" : "dm error";
    setDMSpeech({
      title: "DM Error",
      body: (e?.status === 429)
        ? "Rate limited. Try again soon."
        : "DM error. Check API base / server.",
      small: ""
    });
    console.warn(e, e.detailText);
  }
}

/* ---------------- Start level ---------------- */
function startLevel(){
  deadlockActive = false;

  levelInvalid = 0;
  punishedThisLevel = false;

  const { bankPrimary } = inferBANK();
  setBankRail(bankPrimary);

  const rng = makeRng(hashSeed(runSeed, 4242, level));
  const sinTags = inferSinTags();
  const thesisKey = pickThesisKey(rng, sinTags, bankPrimary);

  const cfg = computeLevelConfig();
  const elements = chooseElementsForThesis(thesisKey, cfg.colors, rng);

  const recipe = (() => {
    let stabilizer = null;
    let elementsForPuzzle = [...elements];

    if (thesisKey === "UR_without_CL"){
      const hasUR = elementsForPuzzle.includes("UR");
      if (!hasUR) elementsForPuzzle[0] = "UR";

      if (ELEMENTS["CL"] && level >= STABILIZER_UNLOCK_LEVEL){
        if (!elementsForPuzzle.includes("CL")) elementsForPuzzle.push("CL");
        stabilizer = { unlock:"UR_full", symbol:"CL", idx:-1, unlocked:false };
      }
    }
    return { level, cfg, thesisKey, elements: elementsForPuzzle, stabilizer };
  })();

  applyElementPalette({ elements: recipe.elements, colors: recipe.elements.length });
  state.stabilizer = recipe.stabilizer;

  genPuzzle(recipe);
  renderThesisBar(recipe.thesisKey);
  syncInfoPanel();
  render();

  // If intro is active, do not trigger quest DM
  if (!introIsActive()){
    if (isDMLevel(level)) runDMIfAvailable();
    else hideDMOverlay();
  }

  // Safety: if it spawns deadlocked, show DM
  if (!introIsActive() && !isSolved() && !hasAnyPlayableMove()){
    showOutOfMovesDM();
  }

  statusOut.textContent = "ready";
}

/* ---------------- Boot ---------------- */
devBtn.addEventListener("click", ()=> settings.showModal());
apiBaseEl.addEventListener("change", ()=>{
  localStorage.setItem(API_BASE_KEY, apiBaseEl.value.trim());
});

bankRail.addEventListener("click", ()=>{
  const expanded = bankRail.classList.toggle("expanded");
  bankExpanded.setAttribute("aria-hidden", expanded ? "false" : "true");
});

/**
 * ✅ X ALWAYS WORKS
 * - Cancels any in-flight quest response
 * - Closes DM instantly
 * - If intro is active and no name exists: sets default "Acolyte"
 * - If deadlock is active: auto-retry the level so player isn't stuck
 */
dmClose.addEventListener("click", ()=>{
  dmToken++; // cancel any in-flight DM fetch

  if (introIsActive()){
    // allow cancelling the intro; ensure name exists
    ensurePlayerName();
    syncInfoPanel();
    introStep = 0;
  }

  if (deadlockActive){
    deadlockActive = false;
    sig.resets++;
    hideDMOverlay();
    startLevel();
    return;
  }

  hideDMOverlay();
});

// optional dev toggle
questTitle.addEventListener("dblclick", toggleSpeechTheme);

glossaryBtn.addEventListener("click", ()=>{
  renderGlossary();
  glossary.showModal();
});

function modTap(){ showToast("Modifier shop (later)."); }
modSlot1.addEventListener("click", modTap);
modSlot2.addEventListener("click", modTap);
modSlot3.addEventListener("click", modTap);

(function boot(){
  setSpeechTheme(getSpeechTheme());
  hideDMOverlay();

  startLevel();

  // First load intro (DM entrance + name)
  const introRan = runFirstLoadIntro();

  if (!introRan){
    const seen = localStorage.getItem("ma_seenMobileUI");
    if (!seen){
      localStorage.setItem("ma_seenMobileUI","1");
      showToast(pickLoreLine?.("open") || "Tap bottle → tap target.");
    }
  }
})();
