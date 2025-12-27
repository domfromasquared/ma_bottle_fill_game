// server/index.js
// Node 18+ / Render compatible

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const PORT = process.env.PORT || 8787;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ---------- safety ----------
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing");
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: [
      "https://domfromasquared.github.io",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:8787",
    ],
  })
);

// ---------- openai ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- constants ----------
const MODEL = "gpt-4o-2024-08-06";
const DM_SIGNATURE = "[SIG:MA_V1]";

// ---------- schemas ----------
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
  required: [
    "quest_title",
    "dm_intro",
    "dm_midpoint",
    "dm_verdict",
    "used_voice_ids",
  ],
};

const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string" },
    title: { type: "string" },
    lore: { type: "string" },
    difficulty: { type: "integer", minimum: 1, maximum: 10 },

    elements: { type: "array", items: { type: "string" }, minItems: 4 },
    colors: { type: "integer", minimum: 4, maximum: 10 },
    bottleCount: { type: "integer", minimum: 6, maximum: 12 },
    emptyBottles: { type: "integer", minimum: 1, maximum: 5 },
    lockedBottles: { type: "integer", minimum: 0, maximum: 3 },
    wildcardSlots: { type: "integer", minimum: 0, maximum: 2 },
    chaosFactor: { type: "number", minimum: 0, maximum: 1 },
    scrambleMoves: { type: "integer", minimum: 30, maximum: 300 },

    rules: {
      type: "object",
      properties: {
        reactionRules: { type: "string" },
        forgiveness: { type: "string" },
      },
      required: ["reactionRules", "forgiveness"],
    },

    bonuses: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
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

// ---------- routes ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ----- QUEST NODE -----
app.post("/api/quest-node", async (req, res) => {
  try {
    const context = req.body || {};

    const response = await openai.responses.create({
      model: MODEL,
      instructions: `
You are THE MARKETING ALCHEMIST.
Tone: cheeky, arrogant, clean roast.
Roast behavior, not people.
Always include this token verbatim in dm_verdict:
${DM_SIGNATURE}
`,
      input: `
Create a short quest narration.
Personalize to BANK type and hesitation.
Chemistry + marketing metaphors.
Context:
${JSON.stringify(context, null, 2)}
`,
      text: {
        format: {
          type: "json_schema",
          name: "quest_node",
          strict: true,
          schema: QUEST_SCHEMA,
        },
      },
      max_output_tokens: 600,
    });

    const raw = response.output_text;
    const payload = JSON.parse(raw);

    if (!payload.dm_verdict.includes(DM_SIGNATURE)) {
      return res.status(400).json({
        ok: false,
        error: "DM signature missing",
      });
    }

    res.json({ ok: true, payload });
  } catch (err) {
    console.error("❌ quest-node", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ----- LEVEL RECIPE -----
app.post("/api/level-recipe", async (req, res) => {
  try {
    const context = req.body || {};

    const response = await openai.responses.create({
      model: MODEL,
      instructions: `
You are designing a SPICY bottle-fill puzzle.
Difficulty ramps aggressively.
Return JSON only.
`,
      input: `
Generate a level recipe.
Context:
${JSON.stringify(context, null, 2)}
`,
      text: {
        format: {
          type: "json_schema",
          name: "level_recipe",
          strict: true,
          schema: RECIPE_SCHEMA,
        },
      },
      max_output_tokens: 900,
    });

    const recipe = JSON.parse(response.output_text);
    res.json({ ok: true, recipe });
  } catch (err) {
    console.error("❌ level-recipe", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Quest-node API listening on port ${PORT}`);
  console.log("API key loaded:", Boolean(OPENAI_API_KEY));
});
