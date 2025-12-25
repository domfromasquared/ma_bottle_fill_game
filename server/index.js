// server/index.js
// Minimal Express API for quest-node LLM generation + validation.
//
// Folder suggestion:
//   /server/index.js
//   /server/prompt_builder.js
//   /voice/voice_bank.v1.json
//   /voice/lexicons.v1.json
//   /voice/voice_router.js
//   /voice/voice_validate.js
//
// Run:
//   cd server
//   npm i
//   node index.js
//
// NOTE: This file includes a provider-agnostic LLM call stub.
// Replace callLLM_JSON() with your provider of choice.

import express from "express";
import cors from "cors";

import voiceBank from "../voice/voice_bank.v1.json" assert { type: "json" };
import lexicons from "../voice/lexicons.v1.json" assert { type: "json" };

import { createVoiceRouter } from "../voice/voice_router.js";
import { buildQuestNodeMessages, validateOrThrow, buildRetryUserMessage } from "./prompt_builder.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const router = createVoiceRouter(voiceBank, lexicons);

// Basic health
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * POST /api/quest-node
 *
 * Body:
 * {
 *   "act": "ACT_I",
 *   "questId": "Q1",
 *   "thesis": "UR_without_CL",
 *   "bankPrimary": "A",
 *   "bankConfidence": 0.72,
 *   "intensity": "standard",
 *   "historyIds": ["EXP_INTRO_0001", ...],
 *   "sinTags": ["panic","overcommitment"],
 *   "performanceSummary": {...},
 *   "seed": "player123:ACT_I:Q1:node2"
 * }
 *
 * Returns:
 * {
 *   ok: true,
 *   payload: { quest_title, dm_intro, dm_midpoint, dm_verdict, used_voice_ids, paraphrases, reasoning_tags },
 *   debug: { candidate_count, used_voice_ids, paraphrase_used }
 * }
 */
app.post("/api/quest-node", async (req, res) => {
  try {
    const ctx = normalizeQuestNodeReq(req.body);

    // 1) Build messages + candidates (deterministic)
    const { messages, candidates } = buildQuestNodeMessages({
      ...ctx,
      router,
      voiceBank,
      lexicons
    });

    // 2) Call LLM (must return JSON string)
    //    Replace this stub with your provider integration.
    let raw = await callLLM_JSON(messages);

    // 3) Validate
    let payload;
    try {
      payload = validateOrThrow(JSON.parse(raw), voiceBank, lexicons);
    } catch (err) {
      // 4) Retry once with validation errors fed back
      const retryMsg = buildRetryUserMessage(err.details || [String(err.message || err)]);
      const retryMessages = messages.concat([{ role: "user", content: retryMsg }]);

      raw = await callLLM_JSON(retryMessages);
      payload = validateOrThrow(JSON.parse(raw), voiceBank, lexicons);
    }

    return res.json({
      ok: true,
      payload,
      debug: {
        candidate_count: candidates.length,
        used_voice_ids: payload.used_voice_ids,
        paraphrase_used: Array.isArray(payload.paraphrases) && payload.paraphrases.length > 0
      }
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e?.message || "Bad request",
      details: e?.details || undefined
    });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Quest-node API listening on http://localhost:${PORT}`);
});

/* ---------------------------
   Provider stub (replace me)
---------------------------- */

/**
 * callLLM_JSON(messages)
 * messages: [{role:"system"|"developer"|"user", content:string}, ...]
 *
 * Must return a JSON string that matches the schema.
 *
 * Replace this with your LLM provider call (OpenAI, Anthropic, etc.).
 * Keep: "JSON only" requirement + consider provider-side JSON schema enforcement.
 */
async function callLLM_JSON(messages) {
  // --- STUB: deterministic fake response for development ---
  // This ensures your endpoint works end-to-end before wiring a provider.
  // Replace when ready.
  const pick = (s) => s;

  // Try to echo a candidate line if we can detect it in the prompt
  const all = messages.map(m => m.content).join("\n");
  const match = all.match(/id=([A-Z0-9_]+).*?\n\s*text="([^"]+)"/);
  const id = match?.[1] || "EXP_INTRO_0001";
  const text = match?.[2] || "Try precision. It’s unfashionable, but effective.";

  const obj = {
    quest_title: "Quest Node: Distillation",
    dm_intro: pick(text).slice(0, 140),
    dm_midpoint: "Same elements. Same laws. New excuse?",
    dm_verdict: "Stabilized. Predictable outcome when you stop guessing.",
    used_voice_ids: [id],
    paraphrases: [],
    reasoning_tags: ["diagnostic", "constraint_pressure"]
  };

  return JSON.stringify(obj);
}

/* ---------------------------
   Request normalization
---------------------------- */

function normalizeQuestNodeReq(b) {
  if (!b || typeof b !== "object") throw new Error("JSON body required");

  const act = mustString(b.act, "act");
  const questId = mustString(b.questId, "questId");
  const thesis = mustString(b.thesis, "thesis");
  const seed = mustString(b.seed, "seed");

  const bankPrimary = oneOf(b.bankPrimary, ["B", "A", "N", "K"], "bankPrimary", "A");
  const intensity = oneOf(b.intensity, ["soft", "standard", "hard"], "intensity", "standard");

  const bankConfidence = clampNumber(b.bankConfidence, 0, 1, 0.6);

  const historyIds = Array.isArray(b.historyIds) ? b.historyIds.filter(x => typeof x === "string").slice(0, 24) : [];
  const sinTags = Array.isArray(b.sinTags) ? b.sinTags.filter(x => typeof x === "string").slice(0, 12) : [];
  const performanceSummary = (b.performanceSummary && typeof b.performanceSummary === "object") ? b.performanceSummary : {};

  return { act, questId, thesis, seed, bankPrimary, bankConfidence, intensity, historyIds, sinTags, performanceSummary };
}

function mustString(v, name) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} must be a non-empty string`);
  return v.trim();
}

function oneOf(v, allowed, name, fallback) {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  if (!allowed.includes(s)) return fallback;
  return s;
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
