/**
 * server/index.js
 * Minimal Express server for the Marketing Alchemist quest-node system
 * - Safe .env loading
 * - Safe key diagnostics (never prints the key)
 * - OpenAI call that returns strict JSON for your pipeline
 */

import "dotenv/config";
import { buildLevelRecipeMessages, validateRecipeOrThrow } from "./level_recipe.js";

import express from "express";
import cors from "cors";
import OpenAI from "openai";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createVoiceRouter } from "../voice/voice_router.js";
import {
  buildQuestNodeMessages,
  validateOrThrow,
  buildRetryUserMessage
} from "./prompt_builder.js";

// --------------------
// ESM dirname helpers
// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------
// Load JSON (no comments allowed in JSON files)
// --------------------
const voiceBank = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "voice", "voice_bank.v1.json"), "utf8")
);

const lexicons = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "voice", "lexicons.v1.json"), "utf8")
);

// --------------------
// App + core services
// --------------------
const app = express();
app.use(cors({
  origin: [
    "https://domfromasquared.github.io",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:8787"
  ]
}));

app.use(express.json({ limit: "1mb" }));

const router = createVoiceRouter(voiceBank, lexicons);

// -----------
// OpenAI client
// -----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// SAFE diagnostics (does NOT reveal key)
console.log("API key loaded:", !!process.env.OPENAI_API_KEY);
if (!process.env.OPENAI_API_KEY) {
  console.log("⚠️  Missing OPENAI_API_KEY. Create server/.env with:");
  console.log("OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx");
}

// --------------------
// Routes
// --------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/quest-node", async (req, res) => {
  try {
    const ctx = normalizeQuestNodeReq(req.body);

    const { messages, candidates } = buildQuestNodeMessages({
      ...ctx,
      router,
      voiceBank,
      lexicons
    });

    app.post("/api/level-recipe", async (req, res) => {
  try {
    const ctx = normalizeQuestNodeReq(req.body);

    const messages = buildLevelRecipeMessages(ctx);

    // Reuse your existing OpenAI JSON caller.
    // IMPORTANT: this expects your callLLM_JSON returns a JSON string.
    const raw = await callLLM_JSON(messages);

    const recipe = validateRecipeOrThrow(JSON.parse(raw));
    res.json({ ok: true, recipe });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err?.message || "Recipe failed",
      details: err?.details || null
    });
  }
});

    // If key missing, fail fast with helpful error
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Server missing OPENAI_API_KEY (check server/.env)",
        details: null
      });
    }

    // Call LLM (JSON only)
    let raw = await callLLM_JSON(messages);

    // Validate (and retry once if needed)
    let payload;
    try {
      payload = validateOrThrow(JSON.parse(raw), voiceBank, lexicons);
    } catch (err) {
      const retryMessage = buildRetryUserMessage(err.details || []);
      const retryMessages = messages.concat([{ role: "user", content: retryMessage }]);

      raw = await callLLM_JSON(retryMessages);
      payload = validateOrThrow(JSON.parse(raw), voiceBank, lexicons);
    }

    return res.json({
      ok: true,
      payload,
      debug: {
        candidate_count: candidates.length,
        used_voice_ids: payload.used_voice_ids,
        paraphrase_used: Array.isArray(payload.paraphrases) && payload.paraphrases.length > 0,
        model: process.env.OPENAI_MODEL || "gpt-4o-mini"
      }
    });
  } catch (err) {
    const msg = err?.message || "Request failed";
    return res.status(400).json({
      ok: false,
      error: msg,
      details: err?.details || null
    });
  }
});

// --------------------
// OpenAI call (simple + robust)
// - Forces JSON response via instruction
// - Returns ONLY JSON text
// --------------------
async function callLLM_JSON(messages) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // We pass messages in as-is (system/developer/user) to keep your tone router prompt intact.
  // We also add a final hard instruction to output JSON only.
  const hardened = messages.concat([
    {
      role: "user",
      content:
        "Return ONLY valid JSON. No markdown, no code fences, no commentary, no extra keys."
    }
  ]);

  // Using Responses API. We'll ask for text output.
  // We are NOT using schema formatting here to avoid the 'text.format.name' issue.
  const resp = await openai.responses.create({
    model,
    input: hardened
  });

  // output_text is the concatenated text response
  const out = resp.output_text || "";

  // Basic hardening: strip accidental code fences if model adds them
  const cleaned = stripCodeFences(out).trim();

  // One more guard: ensure it starts with { and ends with }
  // If not, throw so retry kicks in.
  if (!(cleaned.startsWith("{") && cleaned.endsWith("}"))) {
    throw new Error("LLM did not return raw JSON object");
  }

  return cleaned;
}

function stripCodeFences(s) {
  // Remove ```json ... ``` or ``` ... ```
  return String(s || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "");
}

// --------------------
// Request normalization
// --------------------
function normalizeQuestNodeReq(body) {
  if (!body || typeof body !== "object") {
    throw new Error("JSON body required");
  }

  return {
    act: mustString(body.act, "act"),
    questId: mustString(body.questId, "questId"),
    thesis: mustString(body.thesis, "thesis"),
    seed: mustString(body.seed, "seed"),

    bankPrimary: oneOf(body.bankPrimary, ["B", "A", "N", "K"], "A"),
    bankConfidence: clampNumber(body.bankConfidence, 0, 1, 0.6),
    intensity: oneOf(body.intensity, ["soft", "standard", "hard"], "standard"),

    historyIds: Array.isArray(body.historyIds)
      ? body.historyIds.filter(x => typeof x === "string").slice(0, 24)
      : [],

    sinTags: Array.isArray(body.sinTags)
      ? body.sinTags.filter(x => typeof x === "string").slice(0, 12)
      : [],

    performanceSummary:
      body.performanceSummary && typeof body.performanceSummary === "object"
        ? body.performanceSummary
        : {}
  };
}

function mustString(v, name) {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return v.trim();
}

function oneOf(v, allowed, fallback) {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  return allowed.includes(s) ? s : fallback;
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Quest-node API listening on http://localhost:${PORT}`);
  console.log(`Test health: curl http://localhost:${PORT}/health`);
});
