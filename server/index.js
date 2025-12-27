// server/index.js
// Express API for MA Bottle Fill Game
// Endpoints:
//   GET  /health
//   POST /api/quest-node
//   POST /api/level-recipe
//
// Includes:
// - CORS for GitHub Pages + local dev
// - IP rate limiting (prevents request storms)
// - single-flight de-dupe (only 1 OpenAI call per unique key at a time)
// - robust extraction + safe JSON parsing for Responses API
//
// Deploy notes (Render):
// - Set OPENAI_API_KEY in Render Environment
// - Render provides PORT automatically; we bind to process.env.PORT

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Pick a modern model you have access to. Override via env if needed.
const MODEL_QUEST = process.env.MODEL_QUEST || "gpt-4o-mini";
const MODEL_RECIPE = process.env.MODEL_RECIPE || "gpt-4o-mini";

// Required signature token to reduce tone drift (your validator expects this)
const DM_SIGNATURE = "[SIG:MA_V1]";

// ---- CORS ----
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

// ---- Rate limit (per IP) ----
// Keeps you from getting nuked by accidental retry loops.
// Adjust max as you move to production.
const RL = new Map(); // ip -> { start, count }
function rateLimit(req, res, next) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .toString()
    .split(",")[0]
    .trim();

  const now = Date.now();
  const windowMs = 60_000; // 1 minute
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

// ---- single-flight de-dupe ----
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

// ---- OpenAI client ----
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- Helpers ----
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

// ---- JSON Schemas (Structured Outputs) ----
const QUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    quest_title: { type: "string" },
    dm_intro: { type: "string" },
    dm_midpoint: { type: "string" },
    dm_verdict: { type: "string" },
    used_voice_ids: { type: "array", items: { type: "string" } },
  },
  required: ["quest_title", "dm_intro", "dm_midpoint", "dm_verdict", "used_voice_ids"],
};

const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string" },
    title: { type: "string" },
    lore: { type: "string" },
    difficulty: { type: "integer", minimum: 1, maximum: 10 },

    // puzzle params used by the client
    colors: { type: "integer", minimum: 4, maximum: 10 },
    bottleCount: { type: "integer", minimum: 6, maximum: 14 },
    capacity: { type: "integer", minimum: 3, maximum: 6 },
    emptyBottles: { type: "integer", minimum: 1, maximum: 6 },
    lockedBottles: { type: "integer", minimum: 0, maximum: 3 },
    wildcardSlots: { type: "integer", minimum: 0, maximum: 2 },

    elements: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 12 },

    // optional narrative knobs
    sinTags: { type: "array", items: { type: "string" }, maxItems: 8 },
    bonuses: { type: "array", items: { type: "string" }, maxItems: 10 },
    constraints: { type: "array", items: { type: "string" }, maxItems: 10 },
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
  ],
};

// ---- Routes ----
app.get("/health", (_req, res) => ok(res));

// POST /api/quest-node
app.post("/api/quest-node", async (req, res) => {
  try {
    if (!requireApiKey(res)) return;

    const context = req.body || {};
    const required = ["act", "questId", "bankPrimary", "bankConfidence", "seed"];
    const missing = required.filter((k) => context[k] === undefined || context[k] === null || context[k] === "");
    if (missing.length) return fail(res, 400, "Missing required fields", missing);

    const instructions = `
You are THE MARKETING ALCHEMIST (Quest DM).
Tone: pompous, cheeky, clean-roast (no vulgarity), action-forcing.
Roast behavior, never identity. Keep outputs short.
Chemistry lab imagery + marketing alchemy metaphors.
CRITICAL: dm_verdict MUST contain this exact signature token: ${DM_SIGNATURE}
Return ONLY JSON that matches the schema.
`.trim();

    const input = `Generate the next quest node. Personalize to BANK and sinTags.\n\nContext:\n${JSON.stringify(context, null, 2)}`;

    const key = `quest:${context.seed}:${context.questId}:${context.bankPrimary}`;
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
        max_output_tokens: 500, // keep low to reduce rate-limit
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

    // Pass through Retry-After if present
    if (err?.status === 429) {
      res.set("Retry-After", "20");
    }

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

    const instructions = `
You design a "bottle fill / water sort" puzzle level recipe.
Return ONLY JSON matching the schema.
Keep it solvable (include empty bottles).
Make it feel like a Marketing Alchemist chemistry lab quest.
Use periodic-table vibe for 'elements' (short tokens).
`.trim();

    const input = `Generate the next level recipe.\n\nContext:\n${JSON.stringify(context, null, 2)}`;

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
        max_output_tokens: 700, // keep low to reduce rate-limit
      })
    );

    const raw = getOutputText(resp);
    if (!raw) return fail(res, 502, "LLM returned empty output", { responseKeys: Object.keys(resp || {}) });

    const parsed = safeJsonParse(raw, "level-recipe");
    if (!parsed.ok) return fail(res, 502, parsed.error, parsed.details);

    return ok(res, { recipe: parsed.value });
  } catch (err) {
    console.error("❌ /api/level-recipe error:", err);

    const status = Number.isFinite(err?.status) ? err.status : 500;

    if (err?.status === 429) {
      res.set("Retry-After", "20");
    }

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
