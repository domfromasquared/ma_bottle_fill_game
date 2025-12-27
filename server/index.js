// server/index.js
// Express API for MA Bottle Fill Game
// Endpoints:
//   GET  /health
//   POST /api/quest-node   -> returns quest text + gameplay modifier
//   POST /api/level-recipe -> returns level recipe (applies modifier)
//
// Includes:
// - CORS for GitHub Pages + local dev
// - IP rate limiting (prevents request storms)
// - single-flight de-dupe (only 1 OpenAI call per unique key at a time)
// - robust extraction + safe JSON parsing for Responses API

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Override via env if desired.
const MODEL_QUEST = process.env.MODEL_QUEST || "gpt-4o-mini";
const MODEL_RECIPE = process.env.MODEL_RECIPE || "gpt-4o-mini";

// Required signature token to reduce tone drift (client validates this)
const DM_SIGNATURE = "[SIG:MA_V1]";

// -------------------- CORS --------------------
app.use(
  cors({
    origin: [
      "https://domfromasquared.github.io",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// -------------------- Rate limit --------------------
const RL = new Map(); // ip -> { start, count }
function rateLimit(req, res, next) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .toString()
    .split(",")[0]
    .trim();

  const now = Date.now();
  const windowMs = 60_000;
  const max = Number(process.env.RL_MAX_PER_MIN || 18);

  const row = RL.get(ip) || { start: now, count: 0 };
  if (now - row.start > windowMs) {
    row.start = now;
    row.count = 0;
  }
  row.count += 1;
  RL.set(ip, row);

  if (row.count > max) {
    res.set("Retry-After", "60");
    return res.status(429).json({
      ok: false,
      error: "Rate limited (server guard). Too many requests.",
      details: { max, windowMs },
    });
  }
  next();
}
app.use(rateLimit);

// -------------------- single-flight --------------------
const INFLIGHT = new Map(); // key -> Promise
async function singleFlightServer(key, fn) {
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const p = (async () => {
    try {
      return await fn();
    } finally {
      INFLIGHT.delete(key);
    }
  })();
  INFLIGHT.set(key, p);
  return p;
}

// -------------------- OpenAI client --------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------- Helpers --------------------
function ok(res, data = {}) {
  res.json({ ok: true, ...data });
}
function fail(res, status, error, details = null) {
  res.status(status).json({ ok: false, error, details });
}
function requireApiKey(res) {
  if (!OPENAI_API_KEY) {
    fail(res, 500, "OPENAI_API_KEY is missing on server", [
      "Set Render Environment → OPENAI_API_KEY and redeploy.",
    ]);
    return false;
  }
  return true;
}

// Robust extraction for Responses API output text.
function getOutputText(resp) {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text;

  const out1 = resp?.output?.[0]?.content?.[0]?.text;
  if (typeof out1 === "string" && out1.trim()) return out1;

  const contentItems = (resp?.output || []).flatMap((o) => o?.content || []);
  for (const c of contentItems) {
    if (typeof c?.text === "string" && c.text.trim()) return c.text;
  }
  return "";
}

function safeJsonParse(raw, label = "payload") {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      error: `${label} JSON.parse failed`,
      details: { raw: String(raw).slice(0, 1400) },
    };
  }
}

// Clamp helper to keep modifiers sane
function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

// -------------------- Schemas --------------------
const MODIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    // deltas are applied to the *next* level recipe (client will consume then clear)
    lockedBottlesDelta: { type: "integer", minimum: -1, maximum: 2 },
    emptyBottlesDelta: { type: "integer", minimum: -2, maximum: 3 },
    capacityDelta: { type: "integer", minimum: -1, maximum: 2 },
    wildcardSlotsDelta: { type: "integer", minimum: -1, maximum: 2 },
    colorsDelta: { type: "integer", minimum: -1, maximum: 2 },
    bottleCountDelta: { type: "integer", minimum: -2, maximum: 3 },

    // flavor + mechanical tags (optional)
    ruleTag: { type: "string" },           // e.g. "catalyst_only", "purity_lock"
    bonusObjective: { type: "string" },    // e.g. "Solve in <= 28 moves"
  },
  required: [
    "lockedBottlesDelta",
    "emptyBottlesDelta",
    "capacityDelta",
    "wildcardSlotsDelta",
    "colorsDelta",
    "bottleCountDelta",
    "ruleTag",
    "bonusObjective",
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
  required: ["quest_title", "dm_intro", "dm_midpoint", "dm_verdict", "used_voice_ids", "modifier"],
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

    // so the client can display what happened
    appliedModifier: MODIFIER_SCHEMA,
  },
  required: [
    "version",
    "title",
    "lore",
    "difficulty",
    "colors",
    "bottleCount",
    "capacity",
    "emptyBottles",
    "lockedBottles",
    "wildcardSlots",
    "elements",
    "sinTags",
    "bonuses",
    "constraints",
    "appliedModifier",
  ],
};

// -------------------- Routes --------------------
app.get("/health", (_req, res) => ok(res));

// POST /api/quest-node
app.post("/api/quest-node", async (req, res) => {
  try {
    if (!requireApiKey(res)) return;

    const context = req.body || {};
    const required = ["act", "questId", "bankPrimary", "bankConfidence", "seed", "level"];
    const missing = required.filter((k) => context[k] === undefined || context[k] === null || context[k] === "");
    if (missing.length) return fail(res, 400, "Missing required fields", missing);

    const instructions = `
You are THE MARKETING ALCHEMIST (Quest DM).
Tone: pompous, cheeky, clean-roast (no vulgarity), action-forcing.
Roast behavior, never identity. Keep outputs short.
Chemistry lab imagery + marketing alchemy metaphors.

CRITICAL:
1) dm_verdict MUST contain this exact signature token: ${DM_SIGNATURE}
2) You MUST output a gameplay modifier for the NEXT level. Use deltas only.
3) Keep modifiers realistic: do NOT make impossible levels.
Return ONLY JSON that matches the schema.
`.trim();

    const input = `
Generate the next quest node for this player.
Personalize to BANK and sinTags.
You are at level ${context.level}. QuestId ${context.questId}.

Context:
${JSON.stringify(context, null, 2)}

Modifier guidance (deltas apply to next level only):
- emptyBottlesDelta: add/remove empty bottles
- lockedBottlesDelta: add locks (0..3 total after clamping)
- capacityDelta: change bottle capacity (3..6)
- colorsDelta: adjust number of colors (4..10)
- bottleCountDelta: adjust bottle count (6..14)
- wildcardSlotsDelta: special wildcard bottles (0..2)

Pick 1-2 meaningful changes; leave others as 0.
Add ruleTag + a short bonusObjective.
`.trim();

    const key = `quest:${context.seed}:${context.questId}:${context.level}:${context.bankPrimary}`;
    const resp = await singleFlightServer(key, () =>
      openai.responses.create({
        model: MODEL_QUEST,
        instructions,
        input,
        text: {
          format: {
            type: "json_schema",
            name: "quest_node",
            strict: true,
            schema: QUEST_SCHEMA,
          },
        },
        max_output_tokens: 650,
      })
    );

    const raw = getOutputText(resp);
    if (!raw) return fail(res, 502, "LLM returned empty output", { responseKeys: Object.keys(resp || {}) });

    const parsed = safeJsonParse(raw, "quest-node");
    if (!parsed.ok) return fail(res, 502, parsed.error, parsed.details);

    const payload = parsed.value;

    if (typeof payload.dm_verdict !== "string" || !payload.dm_verdict.includes(DM_SIGNATURE)) {
      return fail(res, 400, "LLM voice payload failed validation", [
        "dm_verdict: missing signature token (risk of tone drift)",
      ]);
    }

    return ok(res, { payload });
  } catch (err) {
    console.error("❌ /api/quest-node error:", err);

    const status = Number.isFinite(err?.status) ? err.status : 500;
    if (err?.status === 429) res.set("Retry-After", "20");

    return fail(res, status, err?.message || String(err), {
      name: err?.name || null,
      status: err?.status || null,
      code: err?.code || null,
      type: err?.type || null,
      response: err?.response?.data || err?.response || null,
    });
  }
});

// POST /api/level-recipe
app.post("/api/level-recipe", async (req, res) => {
  try {
    if (!requireApiKey(res)) return;

    const context = req.body || {};
    const required = ["act", "questId", "bankPrimary", "bankConfidence", "seed", "level"];
    const missing = required.filter((k) => context[k] === undefined || context[k] === null || context[k] === "");
    if (missing.length) return fail(res, 400, "Missing required fields", missing);

    // modifier is optional; if not present, treat as zeros
    const incomingMod = context.modifier || {
      lockedBottlesDelta: 0,
      emptyBottlesDelta: 0,
      capacityDelta: 0,
      wildcardSlotsDelta: 0,
      colorsDelta: 0,
      bottleCountDelta: 0,
      ruleTag: "none",
      bonusObjective: "",
    };

    const instructions = `
You design a "bottle fill / water sort" puzzle level recipe.
Return ONLY JSON matching the schema.
Make it solvable (include empty bottles).
Make it feel like a Marketing Alchemist chemistry lab quest.
Use periodic-table vibe for 'elements' (short tokens).

IMPORTANT:
You MUST obey the provided modifier deltas for THIS level.
If a delta would push values out of bounds, clamp to valid ranges.
`.trim();

    const input = `
Generate the next level recipe.
You are generating level ${context.level}. QuestId ${context.questId}.

Player context:
${JSON.stringify(
  {
    act: context.act,
    questId: context.questId,
    level: context.level,
    bankPrimary: context.bankPrimary,
    bankConfidence: context.bankConfidence,
    sinTags: context.sinTags || [],
    seed: context.seed,
  },
  null,
  2
)}

Gameplay modifier deltas (apply to THIS recipe):
${JSON.stringify(incomingMod, null, 2)}

Return appliedModifier equal to these deltas (same object).
`.trim();

    const key = `recipe:${context.seed}:${context.questId}:${context.level}:${context.bankPrimary}`;
    const resp = await singleFlightServer(key, () =>
      openai.responses.create({
        model: MODEL_RECIPE,
        instructions,
        input,
        text: {
          format: {
            type: "json_schema",
            name: "level_recipe",
            strict: true,
            schema: RECIPE_SCHEMA,
          },
        },
        max_output_tokens: 850,
      })
    );

    const raw = getOutputText(resp);
    if (!raw) return fail(res, 502, "LLM returned empty output", { responseKeys: Object.keys(resp || {}) });

    const parsed = safeJsonParse(raw, "level-recipe");
    if (!parsed.ok) return fail(res, 502, parsed.error, parsed.details);

    // Hard clamp on server as a safety net
    const recipe = parsed.value;

    recipe.capacity = clamp(recipe.capacity, 3, 6);
    recipe.colors = clamp(recipe.colors, 4, 10);
    recipe.bottleCount = clamp(recipe.bottleCount, 6, 14);
    recipe.emptyBottles = clamp(recipe.emptyBottles, 1, 6);
    recipe.lockedBottles = clamp(recipe.lockedBottles, 0, 3);
    recipe.wildcardSlots = clamp(recipe.wildcardSlots, 0, 2);

    // Keep empty <= bottles-1
    recipe.emptyBottles = Math.min(recipe.emptyBottles, Math.max(1, recipe.bottleCount - 1));

    return ok(res, { recipe });
  } catch (err) {
    console.error("❌ /api/level-recipe error:", err);

    const status = Number.isFinite(err?.status) ? err.status : 500;
    if (err?.status === 429) res.set("Retry-After", "20");

    return fail(res, status, err?.message || String(err), {
      name: err?.name || null,
      status: err?.status || null,
      code: err?.code || null,
      type: err?.type || null,
      response: err?.response?.data || err?.response || null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ API listening on port ${PORT}`);
  console.log("API key loaded:", Boolean(OPENAI_API_KEY));
  console.log("Models:", { MODEL_QUEST, MODEL_RECIPE });
  console.log(`Test: curl http://localhost:${PORT}/health`);
});
