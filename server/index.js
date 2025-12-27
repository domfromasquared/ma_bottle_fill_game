// server/index.js
// Render + GitHub Pages compatible Express API for:
//   POST /api/quest-node
//   POST /api/level-recipe
//   GET  /health

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ---- Config ----
const MODEL_QUEST = process.env.MODEL_QUEST || "gpt-4o-2024-08-06";
const MODEL_RECIPE = process.env.MODEL_RECIPE || "gpt-4o-2024-08-06";

// signature token required by your voice validator
const DM_SIGNATURE = "[SIG:MA_V1]";

// ---- App ----
const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS: allow GitHub Pages + local dev
app.use(
  cors({
    origin: [
      "https://domfromasquared.github.io",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
    ],
  })
);

// ---- OpenAI Client ----
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
    fail(res, 500, "OPENAI_API_KEY is missing on server (Render env var)", [
      'Set Render Environment → OPENAI_API_KEY = "sk-..." and redeploy.',
    ]);
    return false;
  }
  return true;
}

/**
 * Robust extraction for Responses API output text.
 * (Fixes "output_text undefined" causing JSON.parse crashes -> 500)
 */
function getOutputText(resp) {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text;

  // Alternate shapes (SDK versions / response formats)
  const out1 = resp?.output?.[0]?.content?.[0]?.text;
  if (typeof out1 === "string" && out1.trim()) return out1;

  // Sometimes it can be in content array items
  const maybe = resp?.output?.flatMap(o => o?.content || []) || [];
  for (const c of maybe) {
    if (typeof c?.text === "string" && c.text.trim()) return c.text;
  }
  return "";
}

function safeJsonParse(raw, label = "payload") {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: `${label} JSON.parse failed`, details: { raw: String(raw).slice(0, 1400) } };
  }
}

// ---- Schemas (Structured Outputs) ----
const QUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    quest_title: { type: "string" },
    dm_intro: { type: "string" },
    dm_midpoint: { type: "string" },
    dm_verdict: { type: "string" },
    used_voice_ids: {
      type: "array",
      items: { type: "string" },
    },
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

    elements: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 12 },
    colors: { type: "integer", minimum: 4, maximum: 10 },
    bottleCount: { type: "integer", minimum: 6, maximum: 12 },
    emptyBottles: { type: "integer", minimum: 1, maximum: 5 },
    lockedBottles: { type: "integer", minimum: 0, maximum: 3 },
    wildcardSlots: { type: "integer", minimum: 0, maximum: 2 },
    chaosFactor: { type: "number", minimum: 0, maximum: 1 },
    scrambleMoves: { type: "integer", minimum: 30, maximum: 320 },

    rules: {
      type: "object",
      additionalProperties: false,
      properties: {
        reactionRules: { type: "string" },
        forgiveness: { type: "string" },
      },
      required: ["reactionRules", "forgiveness"],
    },

    bonuses: { type: "array", items: { type: "string" }, maxItems: 10 },
    constraints: { type: "array", items: { type: "string" }, maxItems: 10 },
  },
  required: [
    "version",
    "title",
    "lore",
    "difficulty",
    "elements",
    "colors",
    "bottleCount",
    "emptyBottles",
    "lockedBottles",
    "wildcardSlots",
    "chaosFactor",
    "scrambleMoves",
    "rules",
    "bonuses",
    "constraints",
  ],
};

// ---- Health ----
app.get("/health", (_req, res) => ok(res));

// ============================================================================
// POST /api/quest-node
// ============================================================================
app.post("/api/quest-node", async (req, res) => {
  try {
    if (!requireApiKey(res)) return;

    const context = req.body || {};

    // Minimal required fields so the model has what it expects
    const required = ["act", "questId", "bankPrimary", "bankConfidence", "seed"];
    const missing = required.filter((k) => context[k] === undefined || context[k] === null || context[k] === "");
    if (missing.length) {
      return fail(res, 400, "Missing required fields", missing);
    }

    const instructions = `
You are THE MARKETING ALCHEMIST (Quest DM).
Tone: pompous, cheeky, clean-roast (no vulgarity), action-forcing.
Roast behavior and decisions, never identity.
Keep each field short (~500 chars max).
Chemistry lab imagery + marketing alchemy metaphors.
IMPORTANT: dm_verdict MUST contain this exact signature token: ${DM_SIGNATURE}
Return ONLY JSON that matches the schema.
`;

    const input = `
Generate the next quest node for this player.
Personalize to BANK and sinTags.
Context JSON:
${JSON.stringify(context, null, 2)}
`;

    const resp = await openai.responses.create({
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
    });

    const raw = getOutputText(resp);
    if (!raw) {
      return fail(res, 502, "LLM returned empty output_text", {
        hint: "OpenAI responded but no output text was found. Check Render logs for the raw response shape.",
        responseKeys: Object.keys(resp || {}),
      });
    }

    const parsed = safeJsonParse(raw, "quest-node");
    if (!parsed.ok) {
      return fail(res, 502, parsed.error, parsed.details);
    }

    const payload = parsed.value;

    // Signature validation (matches your client-side validator)
    if (typeof payload?.dm_verdict !== "string" || !payload.dm_verdict.includes(DM_SIGNATURE)) {
      return fail(res, 400, "LLM voice payload failed validation", [
        "dm_verdict: missing signature token (risk of tone drift)",
      ]);
    }

    ok(res, { payload });
  } catch (err) {
    console.error("❌ /api/quest-node error:", err);

    // If OpenAI returns a status, pass it through
    const status = Number.isFinite(err?.status) ? err.status : 500;

    // Try to expose useful details to the browser
    return fail(res, status, err?.message || String(err), {
      name: err?.name || null,
      status: err?.status || null,
      code: err?.code || null,
      type: err?.type || null,
      // Some SDKs store API response details here:
      response: err?.response?.data || err?.response || null,
    });
  }
});

// ============================================================================
// POST /api/level-recipe
// ============================================================================
app.post("/api/level-recipe", async (req, res) => {
  try {
    if (!requireApiKey(res)) return;

    const context = req.body || {};

    const required = ["act", "questId", "bankPrimary", "bankConfidence", "seed"];
    const missing = required.filter((k) => context[k] === undefined || context[k] === null || context[k] === "");
    if (missing.length) {
      return fail(res, 400, "Missing required fields", missing);
    }

    const instructions = `
You are a level designer for a "bottle fill / water sort" puzzle game.
Return ONLY JSON that matches the schema.
Make it feel like a Marketing Alchemist chemistry lab quest.
Difficulty should feel "spicy" as levels increase.
Use periodic-table vibes for 'elements' (short tokens).
`;

    const input = `
Generate the next level recipe JSON.
Context JSON:
${JSON.stringify(context, null, 2)}
`;

    const resp = await openai.responses.create({
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
      max_output_tokens: 950,
    });

    const raw = getOutputText(resp);
    if (!raw) {
      return fail(res, 502, "LLM returned empty output_text", {
        hint: "OpenAI responded but no output text was found. Check Render logs for the raw response shape.",
        responseKeys: Object.keys(resp || {}),
      });
    }

    const parsed = safeJsonParse(raw, "level-recipe");
    if (!parsed.ok) {
      return fail(res, 502, parsed.error, parsed.details);
    }

    const recipe = parsed.value;
    ok(res, { recipe });
  } catch (err) {
    console.error("❌ /api/level-recipe error:", err);

    const status = Number.isFinite(err?.status) ? err.status : 500;

    return fail(res, status, err?.message || String(err), {
      name: err?.name || null,
      status: err?.status || null,
      code: err?.code || null,
      type: err?.type || null,
      response: err?.response?.data || err?.response || null,
    });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`✅ Quest-node API listening on port ${PORT}`);
  console.log("API key loaded:", Boolean(OPENAI_API_KEY));
  console.log("Models:", { MODEL_QUEST, MODEL_RECIPE });
});
