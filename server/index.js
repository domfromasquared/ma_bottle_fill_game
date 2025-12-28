// server/index.js
// Marketing Alchemist Bottle Fill API (Voice-Locked + Minor/Major DM)
//
// Endpoints:
//   GET  /health
//   POST /api/quest-node   (supports wantModifier: boolean)
//   POST /api/level-recipe

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const MODEL_QUEST = process.env.MODEL_QUEST || "gpt-4o-mini";
const MODEL_RECIPE = process.env.MODEL_RECIPE || "gpt-4o-mini";

const DM_SIGNATURE = "[SIG:MA_V1]";

// ---------- Load voice canon ----------
const VOICE_DIR = path.join(process.cwd(), "voice");
const VOICE_LOCK_PATH = path.join(VOICE_DIR, "ma_voice_lock.v1.txt");
const FEWSHOTS_PATH = path.join(VOICE_DIR, "ma_fewshots.v1.json");

function readTextIfExists(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : ""; } catch { return ""; }
}
function readJsonIfExists(p) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : []; } catch { return []; }
}

const MA_VOICE_LOCK = readTextIfExists(VOICE_LOCK_PATH);
const MA_FEWSHOTS = readJsonIfExists(FEWSHOTS_PATH);

// ---------- CORS ----------
app.use(cors({
  origin: [
    "https://domfromasquared.github.io",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
  ],
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));

// ---------- Basic rate limit ----------
const RL = new Map();
app.use((req, res, next) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
  const now = Date.now();
  const windowMs = 60_000;
  const max = Number(process.env.RL_MAX_PER_MIN || 18);

  const row = RL.get(ip) || { start: now, count: 0 };
  if (now - row.start > windowMs) { row.start = now; row.count = 0; }
  row.count += 1;
  RL.set(ip, row);

  if (row.count > max) {
    res.set("Retry-After", "60");
    return res.status(429).json({ ok:false, error:"Rate limited (server guard). Too many requests.", details:{max, windowMs} });
  }
  next();
});

// ---------- Single-flight ----------
const INFLIGHT = new Map();
async function singleFlight(key, fn) {
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const p = (async () => { try { return await fn(); } finally { INFLIGHT.delete(key); } })();
  INFLIGHT.set(key, p);
  return p;
}

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- Helpers ----------
function ok(res, data={}) { res.json({ ok:true, ...data }); }
function fail(res, status, error, details=null) { res.status(status).json({ ok:false, error, details }); }

function requireApiKey(res) {
  if (!OPENAI_API_KEY) {
    fail(res, 500, "OPENAI_API_KEY is missing on server", ["Set Render Environment → OPENAI_API_KEY and redeploy."]);
    return false;
  }
  return true;
}

function voiceLockOrFail(res) {
  if (!MA_VOICE_LOCK || !MA_VOICE_LOCK.trim()) {
    fail(res, 500, "Missing voice lock file", ["Expected: server/voice/ma_voice_lock.v1.txt"]);
    return null;
  }
  return MA_VOICE_LOCK;
}

function getOutputText(resp) {
  if (typeof resp?.output_text === "string") return resp.output_text;
  // fallback: some SDK versions store in output array; keep robust
  try {
    const out = resp?.output || [];
    for (const item of out) {
      const content = item?.content || [];
      for (const c of content) {
        if (typeof c?.text === "string") return c.text;
      }
    }
  } catch {}
  return "";
}

function safeJsonParse(s, label="json") {
  try { return { ok:true, value: JSON.parse(s) }; }
  catch (e) { return { ok:false, error:`Invalid JSON from ${label}`, details:{ message: e?.message || String(e), raw: s?.slice(0, 1200) } }; }
}

function violatesVoice(text) {
  const t = String(text || "").toLowerCase();
  const forbidden = [
    "bank account","routing number","interest rate","apr","credit score",
    "roi","pipeline","lead gen","funnel","kpi","stakeholder","q4",
    "synergy","enterprise","salesforce","revops","mrr","arr"
  ];
  return forbidden.some(w => t.includes(w));
}

function fewshotsBlock() {
  if (!Array.isArray(MA_FEWSHOTS) || !MA_FEWSHOTS.length) return "";
  const lines = [];
  lines.push("FEWSHOTS:");
  for (const ex of MA_FEWSHOTS) {
    lines.push(`- Input: ${JSON.stringify(ex?.input || {})}`);
    lines.push(`  Output: ${JSON.stringify(ex?.output || {})}`);
  }
  return lines.join("\n");
}

// ---------- Modifier defaults ----------
const ZERO_MOD = {
  lockedBottlesDelta: 0,
  emptyBottlesDelta: 0,
  capacityDelta: 0,
  wildcardSlotsDelta: 0,
  colorsDelta: 0,
  bottleCountDelta: 0,
  ruleTag: "none",
  bonusObjective: ""
};

// ---------- Schemas ----------
const MODIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    lockedBottlesDelta: { type: "integer", minimum: -1, maximum: 2 },
    emptyBottlesDelta: { type: "integer", minimum: -2, maximum: 3 },
    capacityDelta: { type: "integer", minimum: -1, maximum: 2 },
    wildcardSlotsDelta: { type: "integer", minimum: -1, maximum: 2 },
    colorsDelta: { type: "integer", minimum: -1, maximum: 2 },
    bottleCountDelta: { type: "integer", minimum: -2, maximum: 3 },
    ruleTag: { type: "string" },
    bonusObjective: { type: "string" },
  },
  required: [
    "lockedBottlesDelta","emptyBottlesDelta","capacityDelta","wildcardSlotsDelta",
    "colorsDelta","bottleCountDelta","ruleTag","bonusObjective"
  ],
};

const QUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    quest_title: { type: "string" },
    dm_intro: { type: "string" },
    dm_midpoint: { type: "string" },
    dm_verdict: { type: "string" },
    used_voice_ids: { type: "array", items: { type: "string" } },
    modifier: MODIFIER_SCHEMA,
  },
  required: ["quest_title","dm_intro","dm_midpoint","dm_verdict","used_voice_ids","modifier"],
};

const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string" },
    title: { type: "string" },
    lore: { type: "string" },
    difficulty: { type: "integer", minimum: 1, maximum: 10 },

    colors: { type: "integer", minimum: 4, maximum: 10 },
    bottleCount: { type: "integer", minimum: 6, maximum: 14 },
    capacity: { type: "integer", minimum: 3, maximum: 6 },
    emptyBottles: { type: "integer", minimum: 1, maximum: 6 },
    lockedBottles: { type: "integer", minimum: 0, maximum: 3 },
    wildcardSlots: { type: "integer", minimum: 0, maximum: 2 },

    elements: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 12 },
    sinTags: { type: "array", items: { type: "string" }, maxItems: 8 },
    bonuses: { type: "array", items: { type: "string" }, maxItems: 10 },
    constraints: { type: "array", items: { type: "string" }, maxItems: 10 },

    appliedModifier: MODIFIER_SCHEMA,
  },
  required: [
    "version","title","lore","difficulty",
    "colors","bottleCount","capacity","emptyBottles","lockedBottles","wildcardSlots",
    "elements","sinTags","bonuses","constraints","appliedModifier"
  ],
};

// ---------- Normalization (backward compatible) ----------
function normalizeContext(body) {
  const c = { ...(body || {}) };

  // accept snake_case too (older clients)
  c.bankPrimary = c.bankPrimary ?? c.bank_primary;
  c.bankConfidence = c.bankConfidence ?? c.bank_confidence;
  c.questId = c.questId ?? c.quest_id;
  c.sinTags = c.sinTags ?? c.sin_tags;
  c.wantModifier = c.wantModifier ?? c.want_modifier;
  c.modifier = c.modifier ?? c.modifier_delta;
  c.foreshadowOnly = c.foreshadowOnly ?? c.foreshadow_only;

  return c;
}

// ---------- Routes ----------
app.get("/health", (_req, res) => ok(res, { voiceLockLoaded: Boolean(MA_VOICE_LOCK), models:{MODEL_QUEST, MODEL_RECIPE} }));

app.post("/api/quest-node", async (req, res) => {
  try {
    if (!requireApiKey(res)) return;
    const voiceLock = voiceLockOrFail(res);
    if (!voiceLock) return;

    const context = normalizeContext(req.body);
    const required = ["act","questId","bankPrimary","bankConfidence","seed","level"];
    const missing = required.filter(k => context[k] === undefined || context[k] === null || context[k] === "");
    if (missing.length) return fail(res, 400, "Missing required fields", missing);

    const wantModifier = context.wantModifier !== false;

    const instructions = `
${voiceLock}

${fewshotsBlock()}

CRITICAL OUTPUT RULES:
- Return ONLY JSON matching schema.
- Keep it SHORT and punchy.
- dm_intro: 1–2 sentences. MUST include (a) clean roast and (b) lab metaphor.
- dm_midpoint: 1 sentence. MUST be a tactical directive with urgency.
- dm_verdict: 1 sentence. MUST include signature token: ${DM_SIGNATURE}
- Use 1–2 required catchphrases per response.
- HARD BAN: finance/corporate jargon. BANK is personality framework only.

MODIFIER RULE:
- If wantModifier=false, you MUST output modifier as ALL ZEROS with ruleTag "none".

FORESHADOW MODE (when context.foreshadowOnly=true):
- DO NOT introduce new mechanics.
- DO NOT mention "locks", "stabilizers", "hidden bottles", "unlock conditions", or anything that reveals gameplay rules.
- You are ONLY planting a warning about consequences (metaphor + behavior) that will pay off later.
- The warning MUST reference the *meaning* of urgency vs clarity (or missing stabilizing factors), but never explain how the game will enforce it.
- Use BANK-adaptive framing based on context.bankPrimary:

  If bankPrimary = "A" (Action):
  - challenge + consequence framing, short and sharp, "you'll get stopped" energy.

  If bankPrimary = "K" (Knowledge):
  - systems + inevitability framing, "constraints emerge" energy.

  If bankPrimary = "N" (Nurturing):
  - safety + burnout framing, "panic costs you" energy.

  If bankPrimary = "B" (Blueprint):
  - structure + preparation framing, "you're skipping a step" energy.

- Keep it confident and in-character. No spoilers.
`.trim();

    const input = `
Generate the next DM quest node for this player.
If wantModifier=false, deliver story + directive only (modifier zeros).
Player context JSON:
${JSON.stringify(context, null, 2)}

wantModifier = ${wantModifier}
`.trim();

    const key = `quest:${context.seed}:${context.questId}:${context.level}:${context.bankPrimary}:${wantModifier}`;
    const resp = await singleFlight(key, () =>
      openai.responses.create({
        model: MODEL_QUEST,
        instructions,
        input,
        text: { format: { type:"json_schema", name:"quest_node", strict:true, schema: QUEST_SCHEMA } },
        max_output_tokens: 650,
      })
    );

    const raw = getOutputText(resp);
    if (!raw) return fail(res, 502, "LLM returned empty output", {});

    const parsed = safeJsonParse(raw, "quest-node");
    if (!parsed.ok) return fail(res, 502, parsed.error, parsed.details);

    const payload = parsed.value;

    if (typeof payload.dm_verdict !== "string" || !payload.dm_verdict.includes(DM_SIGNATURE)) {
      return fail(res, 400, "LLM voice payload failed validation", ["dm_verdict: missing signature token (risk of tone drift)"]);
    }

    if (!wantModifier) payload.modifier = { ...ZERO_MOD };

    const fullText = [payload.quest_title, payload.dm_intro, payload.dm_midpoint, payload.dm_verdict].join(" ");
    if (violatesVoice(fullText)) {
      return fail(res, 400, "LLM voice drift: forbidden-topic detected", ["Detected finance/corporate language. Voice lock violation."]);
    }

    return ok(res, { payload });
  } catch (err) {
    console.error("❌ /api/quest-node error:", err);
    if (err?.status === 429) res.set("Retry-After", "20");
    return fail(res, Number(err?.status) || 500, err?.message || String(err), { status: err?.status || null });
  }
});

app.post("/api/level-recipe", async (req, res) => {
  try {
    if (!requireApiKey(res)) return;
    const voiceLock = voiceLockOrFail(res);
    if (!voiceLock) return;

    const context = normalizeContext(req.body);
    const required = ["act","questId","bankPrimary","bankConfidence","seed","level"];
    const missing = required.filter(k => context[k] === undefined || context[k] === null || context[k] === "");
    if (missing.length) return fail(res, 400, "Missing required fields", missing);

    const incomingMod = context.modifier || { ...ZERO_MOD };

    const instructions = `
${voiceLock}

${fewshotsBlock()}

You design a "bottle fill / water sort" puzzle level recipe.
Return ONLY JSON matching schema. Keep lore punchy and in-lab.
HARD BAN: finance/corporate language. BANK is personality framework only.

IMPORTANT:
- You MUST obey modifier deltas for THIS level.
- If a delta would push out of bounds, clamp to valid ranges.
- Make it solvable: include emptyBottles.
`.trim();

    const input = `
Generate the next level recipe.
Player context JSON:
${JSON.stringify({
  act: context.act,
  questId: context.questId,
  level: context.level,
  bankPrimary: context.bankPrimary,
  bankConfidence: context.bankConfidence,
  sinTags: context.sinTags || [],
  seed: context.seed
}, null, 2)}

Gameplay modifier deltas (apply to THIS recipe):
${JSON.stringify(incomingMod, null, 2)}

Return appliedModifier equal to these deltas (same object).
`.trim();

    const key = `recipe:${context.seed}:${context.questId}:${context.level}:${context.bankPrimary}`;
    const resp = await singleFlight(key, () =>
      openai.responses.create({
        model: MODEL_RECIPE,
        instructions,
        input,
        text: { format: { type:"json_schema", name:"level_recipe", strict:true, schema: RECIPE_SCHEMA } },
        max_output_tokens: 850,
      })
    );

    const raw = getOutputText(resp);
    if (!raw) return fail(res, 502, "LLM returned empty output", {});

    const parsed = safeJsonParse(raw, "level-recipe");
    if (!parsed.ok) return fail(res, 502, parsed.error, parsed.details);

    const recipe = parsed.value;

    const checkText = [recipe.title, recipe.lore, ...(recipe.bonuses||[]), ...(recipe.constraints||[])].join(" ");
    if (violatesVoice(checkText)) {
      return fail(res, 400, "LLM voice drift: forbidden-topic detected", ["Detected finance/corporate language in recipe text."]);
    }

    // clamp safety
    recipe.capacity = clamp(recipe.capacity, 3, 6);
    recipe.colors = clamp(recipe.colors, 4, 10);
    recipe.bottleCount = clamp(recipe.bottleCount, 6, 14);
    recipe.emptyBottles = clamp(recipe.emptyBottles, 1, 6);
    recipe.lockedBottles = clamp(recipe.lockedBottles, 0, 3);
    recipe.wildcardSlots = clamp(recipe.wildcardSlots, 0, 2);

    return ok(res, { payload: recipe });
  } catch (err) {
    console.error("❌ /api/level-recipe error:", err);
    if (err?.status === 429) res.set("Retry-After", "20");
    return fail(res, Number(err?.status) || 500, err?.message || String(err), { status: err?.status || null });
  }
});

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

app.listen(PORT, () => {
  console.log(`✅ MA Bottle Fill API listening on :${PORT}`);
});
