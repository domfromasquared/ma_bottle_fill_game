import { ELEMENTS, THESES } from "../../element_schema.js";
import { getJSON, setJSON, setNum } from "../utils/storage.js";
import { makeRng, hashSeed, randInt } from "../utils/rng.js";
import { singleFlight } from "../utils/singleFlight.js";
import { postJSON } from "../utils/http.js";
import { makeToaster, qs, playPourFX } from "../utils/ui.js";

/* ---------------- Constants ---------------- */
const FORESHADOW_START_LEVEL = 10;
const STABILIZER_UNLOCK_LEVEL = 15;

const DEFAULT_PROD = "https://ma-bottle-fill-aApi.onrender.com";
const DEFAULT_LOCAL = "http://localhost:8787";
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

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

/* ---------------- SIN queue ---------------- */
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

/* ---------------- Player identity ---------------- */
function getPlayerName(){ return (localStorage.getItem(PLAYER_NAME_KEY) || "").trim(); }
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

const bankRail = qs("bankRail");
const bankExpanded = qs("bankExpanded");

const modSlot1 = qs("modSlot1");
const modSlot2 = qs("modSlot2");
const modSlot3 = qs("modSlot3");

const factoryResetBtn = qs("factoryResetBtn");

/* ---------------- Speech theme ---------------- */
function getSpeechTheme(){
  const v = (localStorage.getItem(SPEECH_THEME_KEY) || "").toLowerCase();
  return (v === "light" || v === "dark") ? v : "dark";
}
function setSpeechTheme(theme){
  const t = (String(theme || "").toLowerCase() === "light") ? "light" : "dark";
  speech.dataset.theme = t;
  localStorage.setItem(SPEECH_THEME_KEY, t);
}
function toggleSpeechTheme(){ setSpeechTheme(getSpeechTheme() === "dark" ? "light" : "dark"); }

/* ---------------- API base ---------------- */
apiBaseEl.value = localStorage.getItem(API_BASE_KEY) || (isLocal ? DEFAULT_LOCAL : DEFAULT_PROD);
apiBaseEl.addEventListener("change", () => {
  localStorage.setItem(API_BASE_KEY, (apiBaseEl.value || "").trim());
});

/* ---------------- Run state ---------------- */
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

/* ---------------- DM sprite ---------------- */
const DM_MOODS = ["amused","annoyed","disappointed","encouraging","frustrated","furious","impressed","proud","satisfied"];
function normMood(m){
  const s = String(m || "").trim().toLowerCase();
  return DM_MOODS.includes(s) ? s : "encouraging";
}
function pad3(n){ return String(Math.max(0, Math.min(999, Number(n)||0))).padStart(3,"0"); }

function ensureDMImg(){
  let img = dmCharacter.querySelector("img");
  if (!img){
    img = document.createElement("img");
    img.alt = "Marketing Alchemist";
    img.decoding = "async";
    img.loading = "eager";
    img.draggable = false;
    img.style.width = "150%";
    img.style.height = "150%";
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

/* ---------------- BANK inference ---------------- */
const sig = { moves:0, invalid:0, resets:0, moveTimes:[], lastMoveAt:0 };
const avg = (arr)=> arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

let level = 1;
let questId = 1;

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

/* ---------------- Thesis + palette ---------------- */
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
  bottles: [],
  capacity: 4,
  selected: -1,
  locked: [],
  hiddenSegs: [],
  stabilizer: null,
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

function hasAnyPlayableMove(){
  for (let from = 0; from < state.bottles.length; from++){
    if (state.locked[from]) continue;
    if (!state.bottles[from]?.length) continue;
    for (let to = 0; to < state.bottles.length; to++){
      if (from === to) continue;
      if (canPour(from,to)) return true;
    }
  }
  return false;
}

/* ---------------- UI ---------------- */
function syncInfoPanel(){
  infoLevel.textContent = String(level);
  infoMoves.textContent = String(sig.moves);
  infoInvalid.textContent = String(sig.invalid);
  infoPlayer.textContent = getPlayerName() || "—";
  infoThesis.textContent = thesisLabel.textContent.replace("Thesis: ","") || "—";
}

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

/* ---------------- Speech bubble helpers ---------------- */
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

/* ---------------- DM cancellation token ---------------- */
let dmToken = 0;

/* ---------------- Intro/deadlock flags ---------------- */
let introStep = 0;          // 0 none, 1 name entry, 2 ready start quest
let deadlockActive = false; // deadlock DM active
function introIsActive(){ return introStep === 1 || introStep === 2; }

/* ---------------- Name roast (server) ---------------- */
async function getNameRoastFromServer(name){
  const apiBase = (apiBaseEl?.value || "").trim();
  if (!apiBase) throw new Error("no api base");
  const res = await postJSON(apiBase, "/api/name-roast", {
    candidateName: String(name || "").trim().slice(0, PLAYER_NAME_MAX)
  });
  const roast = res?.payload?.roast;
  const blocked = !!res?.payload?.blocked;
  if (!roast) throw new Error("no roast returned");
  return { roast: String(roast), blocked };
}

function localNameRoast(name){
  const n = String(name || "").trim();
  const refs = [
    `“${n}”? That name walks in like it’s about to pitch a mastermind with no slides.`,
    `“${n}”… bold. Very “main character energy” and “supporting character execution.”`,
    `“${n}”? That sounds like a legend in their own group chat.`,
    `“${n}”… fine. Just don’t pour like you’re guessing.`,
  ];
  return refs[Math.floor(Math.random() * refs.length)];
}

/* ---------------- Intro DM (first load) ---------------- */
function runFirstLoadIntro(){
if (localStorage.getItem("ma_introSeen") === "1") return false;
  localStorage.setItem("ma_introSeen", "1");

  introStep = 1;
  dmToken++;

  showDMOverlay();
  setSpeechTheme("dark");
  setDMAvatar({ mood:"impressed", seedKey: 9001 });

  setDMSpeech({
    title: "At last.",
    body:
`Welcome to The Balance Protocol.

There’s a flaw in the lab — the mixtures are unstable.
Your job is to restore order.

Tell me… what do I call you?`,
    small: "Enter a name (14 characters max), then press Submit."
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
    if (!name){
      showToast("Give me a name.");
      return;
    }

    let roastRes;
    try {
      roastRes = await getNameRoastFromServer(name);
    } catch {
      roastRes = { roast: localNameRoast(name), blocked: false };
    }

    if (roastRes.blocked){
      setDMSpeech({
        title: "No.",
        body: `${roastRes.roast}\n\nTry again.`,
        small: "Enter a different name."
      });
      return;
    }

    const saved = setPlayerName(name);
    syncInfoPanel();
    introStep = 2;

    setDMSpeech({
      title: `…${saved}.`,
      body:
`${roastRes.roast}

Fine. ${saved} it is.

The Balance Protocol doesn’t reward “busy.”
It rewards alignment.

Ready?`,
      small: "Press Start Quest to begin. (✕ always cancels me.)"
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

  row.appendChild(input);
  row.appendChild(submitBtn);
  speechText.appendChild(row);

  setTimeout(()=> input.focus(), 200);
  return true;
}

/* ---------------- Deadlock DM ---------------- */
function dmReactionForBANK(bankPrimary){
  switch (bankPrimary){
    case "A": return { mood:"annoyed", title:"Out of moves.", body:"Action without aim.\nYou brute-forced the ritual into a wall.\n\nRetry. Fewer clicks. More intent." };
    case "B": return { mood:"disappointed", title:"Protocol failure.", body:"Blueprint ignored.\nYou tried to solve chaos without structure.\n\nRetry. Plan two pours ahead. Minimum." };
    case "N": return { mood:"encouraging", title:"No moves left.", body:"Breathe.\n\nYou’re close — but you protected the wrong stacks.\n\nRetry. Calm hands. Clean pours." };
    case "K":
    default:  return { mood:"amused", title:"No legal pours remain.", body:"Ah. Classic.\n\nYou constructed a perfectly unsolvable state.\n\nRetry — and respect constraints before you pour." };
  }
}

function showOutOfMovesDM(){
  if (deadlockActive) return;
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
    startLevel();
  });

  row.appendChild(retryBtn);
  speechText.appendChild(row);
}

/* ---------------- Quest-node DM (LLM) ---------------- */
async function runDMIfAvailable(){
  if (!isDMLevel(level)) return;

  const myToken = ++dmToken;
  const { bankPrimary, bankConfidence } = inferBANK();
  setBankRail(bankPrimary);

  showDMOverlay();
  setSpeechTheme("dark");

  const apiBase = (apiBaseEl?.value || "").trim();
  if (!apiBase){
    setDMAvatar({ mood:"annoyed", seedKey: 222 });
    setDMSpeech({
      title: "No server.",
      body: "You didn’t connect the lab’s brain.\nSet API Base in Settings.",
      small: "Open Settings (⚙️) → set API Base."
    });
    return;
  }

  const sinTags = inferSinTags();
  const act = Math.max(1, Math.floor((level-1)/5)+1);

  const wantModifier = true;
  const foreshadowOnly = level >= FORESHADOW_START_LEVEL && level < STABILIZER_UNLOCK_LEVEL;

  let payload;
  try{
    const resp = await singleFlight(`quest:${runSeed}:${questId}:${level}:${bankPrimary}:${wantModifier}`, () =>
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
        foreshadowOnly
      })
    );
    payload = resp?.payload;
  } catch (e){
    if (myToken !== dmToken) return;
    setDMAvatar({ mood:"furious", seedKey: 333 });
    setDMSpeech({
      title: "Server error.",
      body: "The lab stuttered.\n\nFix your API, then return.",
      small: String(e?.message || e)
    });
    return;
  }

  if (myToken !== dmToken) return;
  if (!payload){
    setDMAvatar({ mood:"annoyed", seedKey: 444 });
    setDMSpeech({ title:"Empty response.", body:"The lab answered with silence.", small:"Check server logs." });
    return;
  }

  setDMAvatar({ mood: payload.dm_mood || "encouraging", frame: payload.dm_frame, seedKey: 555 });

  // Apply modifier for NEXT level build if present
  if (payload.modifier){
    pendingModifier = payload.modifier;
  }

  dmAppearCount++;
  setNum(DM_COUNT_KEY, dmAppearCount);
  scheduleNextDM(level);

  setDMSpeech({
    title: payload.quest_title || "Quest",
    body: `${payload.dm_intro || ""}\n\n${payload.dm_midpoint || ""}\n\n${payload.dm_verdict || ""}`,
    small: isMajorDM(dmAppearCount) ? "Major node." : "Minor node."
  });
}

/* ---------------- Level generation ---------------- */
let pendingModifier = null;
let currentThesisKey = null;

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

function buildLocalRecipe(){
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

function shuffle(arr, rng){
  for (let i=arr.length-1;i>0;i--){
    const j = Math.floor(rng.f() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function generateBottlesFromRecipe(recipe){
  const rng = makeRng(hashSeed(runSeed, 9898, level));
  state.capacity = recipe.capacity;
  state.selected = -1;

  const colors = recipe.colors;
  const bottleCount = recipe.bottleCount;
  const empty = recipe.emptyBottles;

  const pool = [];
  for (let c=0;c<colors;c++){
    for (let i=0;i<recipe.capacity;i++) pool.push(c);
  }
  shuffle(pool, rng);

  state.bottles = [];
  let idx = 0;
  const filledBottles = bottleCount - empty;

  for (let b=0;b<filledBottles;b++){
    const bottle = [];
    for (let k=0;k<recipe.capacity;k++){
      bottle.push(pool[idx++]);
    }
    state.bottles.push(bottle);
  }
  for (let e=0;e<empty;e++) state.bottles.push([]);

  state.locked = new Array(bottleCount).fill(false);
  state.hiddenSegs = new Array(bottleCount).fill(false);
  state.stabilizer = null;

  // Locked bottles (uses your open/locked PNG visuals)
  const lockCount = Math.min(recipe.lockedBottles || 0, bottleCount);
  for (let i=0;i<lockCount;i++){
    state.locked[i] = true;
    state.hiddenSegs[i] = true;
  }

  // Stabilizer unlock mechanic after threshold
  if (level >= STABILIZER_UNLOCK_LEVEL && lockCount > 0){
    state.stabilizer = { unlock: "UR_full", idx: 0, unlocked: false };
  }
}

function checkStabilizerUnlock(){
  if (!state.stabilizer || state.stabilizer.unlocked) return;
  if (state.stabilizer.unlock !== "UR_full") return;

  const urIndex = currentElements.indexOf("UR");
  if (urIndex < 0) return;

  const cap = state.capacity;
  const hasFullUR = state.bottles.some(b => b.length === cap && b.every(x => x === urIndex));
  if (hasFullUR){
    const idx = state.stabilizer.idx;
    state.locked[idx] = false;
    state.hiddenSegs[idx] = false;
    state.stabilizer.unlocked = true;
    showToast("Clarity unlocked. Now stop panicking.");
    render();
  }
}

/* ---------------- Pour + win ---------------- */
let levelInvalid = 0;
let punishedThisLevel = false;

function doPour(from,to){
  if(!canPour(from,to)){
    sig.invalid++;
    levelInvalid++;
    syncInfoPanel();

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

  if (!isSolved() && !hasAnyPlayableMove()){
    showOutOfMovesDM();
  }

  return true;
}

/* ---------------- Render bottles ---------------- */
function render(){
  grid.innerHTML = "";

  for (let i=0;i<state.bottles.length;i++){
    const bottle = document.createElement("button");
    bottle.className = "bottle";
    if (state.selected === i) bottle.classList.add("selected");
    if (state.locked[i]) bottle.classList.add("locked");
    if (state.hiddenSegs[i]) bottle.classList.add("hiddenSegs");

    bottle.addEventListener("pointerup", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  handleBottleTap(i);
});

    // segments
    const seg = document.createElement("div");
seg.className = "seg";

const idx = b[s] ?? null;

if (idx !== null && idx !== undefined) {
  const sym = currentElements[idx];       // e.g. "VI", "EM", "CO"
  const el  = ELEMENTS[sym];

  // color fill
  seg.style.background = el?.color || currentPalette[idx] || "#fff";

  // element class → enables el-EM, el-CO, etc
  if (sym) seg.classList.add(`el-${sym}`);

  // role class → enables role-volatile, role-stabilizer, etc
  if (el?.role) {
    const roleSlug = el.role.toLowerCase().replace(/\s+/g, "-");
    seg.classList.add(`role-${roleSlug}`);
  }
} else {
  seg.style.background = "transparent";
      segs.appendChild(seg);
    }

    bottle.appendChild(segs);
    grid.appendChild(bottle);
  }
}

/* ---------------- Input ---------------- */
function handleBottleTap(i){
  if (introIsActive()) return;
  if (deadlockActive) return;

  const now = performance.now();
  if (sig.lastMoveAt) sig.moveTimes.push(now - sig.lastMoveAt);
  sig.lastMoveAt = now;

  if (state.selected < 0){
    state.selected = i;
    render();
    return;
  }

  // NEW: deselect on same-bottle tap
  if (state.selected === i){
    state.selected = -1;
    render();
    return;
  }

  const from = state.selected;
  const to = i;
  state.selected = -1;
  doPour(from,to);
}

/* ---------------- Level flow ---------------- */
function startLevel(){
  deadlockActive = false;
  punishedThisLevel = false;
  levelInvalid = 0;

  const recipe = buildLocalRecipe();
  applyElementPalette(recipe);
  renderThesisBar(currentThesisKey);

  generateBottlesFromRecipe(recipe);
  render();
  syncInfoPanel();

  // DM node may pop on this level
  runDMIfAvailable();
}

function nextLevel(){
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
  dmToken++; // cancels in-flight LLM
  hideDMOverlay();

  // If intro was active, we still need a name to proceed
  if (introIsActive()){
    setPlayerName(DEFAULT_PLAYER_NAME);
    introStep = 0;
    syncInfoPanel();
    return;
  }

  // If deadlock DM was active, auto-retry (prevents stuck state)
  if (deadlockActive){
    deadlockActive = false;
    sig.resets++;
    startLevel();
  }
});

/* ---------------- Factory reset (Settings) ---------------- */
function factoryResetGame(){
  const ok = confirm(
    "Factory Reset will erase ALL progress, name, and history.\n\nProceed?"
  );
  if (!ok) return;

  // MA reset line
  try{
    dmToken++;
    showDMOverlay();
    setSpeechTheme("dark");
    setDMAvatar({ mood:"satisfied", seedKey: 7777 });

    setDMSpeech({
      title: "Factory Reset",
      body:
`Good.

Burn it down.
We begin again — clean glass, clean ritual.

Try not to disappoint me twice.`,
      small: "Resetting…"
    });
  } catch {}

  setTimeout(() => {
    localStorage.removeItem("ma_playerName");
    localStorage.removeItem("ma_introSeen");
    localStorage.removeItem("ma_runSeed");
    localStorage.removeItem("ma_dmAppearCount");
    localStorage.removeItem("ma_nextDMAtLevel");
    localStorage.removeItem("ma_sinQueue");
    localStorage.removeItem("ma_speechTheme");
    location.reload();
  }, 650);
}

factoryResetBtn?.addEventListener("click", factoryResetGame);

/* ---------------- Boot ---------------- */
function boot(){
  setSpeechTheme(getSpeechTheme());
  syncInfoPanel();

  // If player already named, do normal start
  startLevel();

  // If new player, run intro (overrides name)
  // Run on next tick to avoid any immediate hide calls
  setTimeout(() => {
    if (!getPlayerName() || getPlayerName() === DEFAULT_PLAYER_NAME && !localStorage.getItem("ma_introSeen")){
      runFirstLoadIntro();
    }
  }, 0);
}

boot();
