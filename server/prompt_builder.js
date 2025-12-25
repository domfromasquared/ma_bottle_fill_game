// server/prompt_builder.js
// Builds a quest-node prompt that keeps LLM output on-rails:
// - You route candidate lines deterministically with voice_router.js
// - LLM selects from candidates (and may produce max 1 paraphrase)
// - You validate with voice_validate.js
//
// This file is platform-agnostic; it does NOT call any API.
// Integrate with your LLM provider in your server route.
//
// Usage:
//   import voiceBank from "../voice/voice_bank.v1.json" assert { type: "json" };
//   import lexicons from "../voice/lexicons.v1.json" assert { type: "json" };
//   import { createVoiceRouter } from "../voice/voice_router.js";
//   import { validateLLMVoicePayload } from "../voice/voice_validate.js";
//   import { buildQuestNodeMessages, validateOrThrow } from "./prompt_builder.js";
//
//   const router = createVoiceRouter(voiceBank, lexicons);
//   const { messages, candidates } = buildQuestNodeMessages({ ...context, router, voiceBank, lexicons });
//   const llmJson = await callYourLLM(messages); // must return JSON text
//   const payload = JSON.parse(llmJson);
//   const safe = validateOrThrow(payload, voiceBank, lexicons);

import { validateLLMVoicePayload } from "../voice/voice_validate.js";

/**
 * @typedef {Object} QuestNodeContext
 * @property {string} act                 - e.g. "ACT_I"
 * @property {string} questId             - e.g. "Q1"
 * @property {string} thesis              - e.g. "UR_without_CL"
 * @property {("B"|"A"|"N"|"K")} bankPrimary
 * @property {number} bankConfidence      - 0..1
 * @property {("soft"|"standard"|"hard")} intensity
 * @property {string[]} historyIds        - last shown voice line ids (avoid repeats)
 * @property {string[]} sinTags           - e.g. ["panic","overcommitment","over_reset"]
 * @property {Object} performanceSummary  - compact stats (no raw events)
 * @property {string} seed                - deterministic seed string
 * @property {any} router                 - from createVoiceRouter()
 * @property {Object} voiceBank
 * @property {Object} lexicons
 */

/**
 * Build prompt messages for the quest-node LLM call.
 * The key: we provide "candidate lines" and demand assembly only from them,
 * with max 1 paraphrase of a selected line.
 *
 * @param {QuestNodeContext} ctx
 * @returns {{messages: Array<{role: "system"|"developer"|"user", content: string}>, candidates: any[]}}
 */
export function buildQuestNodeMessages(ctx) {
  const {
    act,
    questId,
    thesis,
    bankPrimary,
    bankConfidence,
    intensity,
    historyIds = [],
    sinTags = [],
    performanceSummary = {},
    seed,
    router,
    voiceBank,
    lexicons
  } = ctx;

  if (!router) throw new Error("router is required");
  if (!voiceBank) throw new Error("voiceBank is required");
  if (!lexicons) throw new Error("lexicons is required");

  // Pick candidates from multiple moments for richer assembly.
  // The LLM will choose which to use.
  const moments = ["quest_open", "quest_mid", "quest_end", "experiment_intro", "experiment_fail", "experiment_win"];
  const candidateSet = [];
  const desiredTags = normalizeTags(sinTags);

  for (const moment of moments) {
    const picks = router.pickMany(
      {
        moment,
        act,
        thesis,
        bank: bankPrimary || "ANY",
        intensity,
        historyIds,
        desiredTags
      },
      `${seed}:${moment}`,
      4
    );
    candidateSet.push(...picks);
  }

  // Deduplicate candidates by id
  const seen = new Set();
  const candidates = [];
  for (const c of candidateSet) {
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    candidates.push(c);
  }

  // Hard cap to keep prompt compact
  const trimmed = candidates.slice(0, 18);

  const system = [
    "You are The Marketing Alchemist: a pompous, cheeky, clean-roast marketing know-it-all.",
    "You insult BEHAVIORS and DECISIONS, never identity. No slurs, no profanity.",
    "You are diagnostic, terse, and coldly funny. No motivational coaching.",
    "Do NOT explain gameplay mechanics or give hints (no instructions like 'pour X into Y').",
    "Avoid meta-AI talk (do not mention being an AI/model).",
    "Your job: produce short quest-node copy using ONLY the candidate voice lines provided.",
    "You may create at most ONE paraphrase of ONE candidate line, staying faithful in meaning and tone."
  ].join("\n");

  const developer = [
    `Context: act=${act}, quest=${questId}, thesis=${thesis}`,
    `Player BANK inference: primary=${bankPrimary} confidence=${round2(bankConfidence)} (0..1)`,
    `Desired intensity=${intensity}`,
    `Player behavior tags (recent): ${desiredTags.length ? desiredTags.join(", ") : "none"}`,
    `Performance summary (compact): ${JSON.stringify(sanitizePerf(performanceSummary))}`,
    "",
    "Output MUST be valid JSON matching the schema exactly (no extra keys):",
    "{",
    '  "quest_title": string,',
    '  "dm_intro": string,',
    '  "dm_midpoint": string,',
    '  "dm_verdict": string,',
    '  "used_voice_ids": string[],',
    '  "paraphrases": [{ "source_id": string, "text": string }],',
    '  "reasoning_tags": string[]',
    "}",
    "",
    "Hard constraints:",
    "- dm_intro, dm_midpoint, dm_verdict: each <= 140 chars, <= 2 sentences, must feel like Marketing Alchemist.",
    "- used_voice_ids: include the ids of any candidates you used verbatim.",
    "- paraphrases: either [] or a single item (max 1). If used, source_id must be one of used_voice_ids.",
    "- reasoning_tags: include up to 6 short tags describing why you chose the lines (e.g., 'panic', 'restraint').",
    "- Do NOT include gameplay hints, solution steps, or mechanics language.",
    "- Do NOT add cheerleading or empathy. Keep it sharp and controlled."
  ].join("\n");

  const user = [
    "Candidate voice lines (use verbatim or select for paraphrase; do not invent new tone):",
    "",
    ...trimmed.map(formatCandidate),
    "",
    "Now output the JSON payload only."
  ].join("\n");

  const messages = [
    { role: "system", content: system },
    { role: "developer", content: developer },
    { role: "user", content: user }
  ];

  return { messages, candidates: trimmed };
}

/**
 * Validate payload or throw an Error with details.
 */
export function validateOrThrow(payload, voiceBank, lexicons) {
  const res = validateLLMVoicePayload(payload, voiceBank, lexicons);
  if (!res.ok) {
    const err = new Error("LLM voice payload failed validation");
    err.details = res.errors;
    err.sanitized = res.sanitized;
    throw err;
  }
  return res.sanitized;
}

/**
 * If you want a retry strategy: call this after a failed validation and
 * feed the error list back to the model in a follow-up message.
 */
export function buildRetryUserMessage(errors) {
  const lines = (errors || []).slice(0, 16).map(e => `- ${e}`);
  return [
    "Your previous JSON failed validation. Fix it.",
    "Do NOT add extra keys. Output JSON only.",
    "Errors:",
    ...lines
  ].join("\n");
}

/* -------------------------
   Helpers
------------------------- */

function formatCandidate(c) {
  // Keep compact
  return `- id=${c.id} moment=${c.moment} bank=${c.bank} intensity=${c.intensity} act=${c.act} thesis=${c.thesis}\n  text="${escapeQuotes(c.text)}"`;
}

function escapeQuotes(s) {
  return String(s || "").replace(/"/g, '\\"');
}

function normalizeTags(tags) {
  return (tags || [])
    .filter(t => typeof t === "string" && t.trim())
    .map(t => t.trim().toLowerCase())
    .slice(0, 10);
}

function sanitizePerf(perf) {
  // Keep only numeric summaries; avoid sending raw event logs
  const allowed = [
    "levels_completed",
    "avg_time_to_first_move_ms",
    "avg_move_time_ms",
    "invalid_pour_rate",
    "illegal_reaction_rate",
    "resets_per_level",
    "retries_last_level",
    "bonus_chase_rate",
    "buffer_move_ratio",
    "commitment_ratio"
  ];
  const out = {};
  for (const k of allowed) {
    if (typeof perf?.[k] === "number" && Number.isFinite(perf[k])) out[k] = perf[k];
  }
  return out;
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}
