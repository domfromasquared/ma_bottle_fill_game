// voice/voice_validate.js
// Backend-safe validator for (1) voice bank ingestion and (2) LLM quest-node output.
// No external deps. Uses lexicons + simple heuristics.
//
// Usage (bank ingestion):
//   import { validateVoiceBank } from "./voice_validate.js";
//   const { ok, errors } = validateVoiceBank(voiceBankJson, lexiconsJson);
//
// Usage (LLM output):
//   import { validateLLMVoicePayload } from "./voice_validate.js";
//   const { ok, errors, sanitized } = validateLLMVoicePayload(payload, voiceBankJson, lexiconsJson);

export function validateVoiceBank(voiceBank, lexicons) {
  const errors = [];
  if (!voiceBank || typeof voiceBank !== "object") {
    return { ok: false, errors: ["voiceBank must be an object"] };
  }
  if (!Array.isArray(voiceBank.lines)) {
    return { ok: false, errors: ["voiceBank.lines must be an array"] };
  }

  const maxChars = voiceBank?.character?.style?.max_chars_per_line ?? 140;
  const maxSentences = voiceBank?.character?.style?.max_sentences ?? 2;

  const seenIds = new Set();

  for (const line of voiceBank.lines) {
    const lineErr = validateLine(line, { maxChars, maxSentences }, lexicons);
    for (const e of lineErr) errors.push(`[${line?.id || "NO_ID"}] ${e}`);

    if (!line?.id || typeof line.id !== "string") continue;
    if (seenIds.has(line.id)) errors.push(`[${line.id}] duplicate id`);
    seenIds.add(line.id);
  }

  return { ok: errors.length === 0, errors };
}

export function validateLLMVoicePayload(payload, voiceBank, lexicons) {
  const errors = [];
  const sanitized = {};

  // Hard schema
  if (!payload || typeof payload !== "object") {
    return { ok: false, errors: ["payload must be an object"], sanitized: null };
  }

  const requiredStr = ["quest_title", "dm_intro", "dm_midpoint", "dm_verdict"];
  for (const k of requiredStr) {
    if (typeof payload[k] !== "string" || !payload[k].trim()) {
      errors.push(`missing/invalid string: ${k}`);
    } else {
      sanitized[k] = payload[k].trim();
    }
  }

  // used_voice_ids validation
  const ids = new Set((voiceBank?.lines || []).map(l => l.id));
  if (!Array.isArray(payload.used_voice_ids)) {
    errors.push("used_voice_ids must be an array");
    sanitized.used_voice_ids = [];
  } else {
    const out = [];
    for (const id of payload.used_voice_ids) {
      if (typeof id !== "string") continue;
      if (!ids.has(id)) errors.push(`used_voice_ids contains unknown id: ${id}`);
      else out.push(id);
    }
    sanitized.used_voice_ids = out;
  }

  // paraphrases validation (optional but constrained)
  sanitized.paraphrases = [];
  if (payload.paraphrases != null) {
    if (!Array.isArray(payload.paraphrases)) {
      errors.push("paraphrases must be an array if present");
    } else {
      if (payload.paraphrases.length > 1) errors.push("paraphrases: max 1 allowed");
      for (const p of payload.paraphrases) {
        if (!p || typeof p !== "object") { errors.push("paraphrases item must be object"); continue; }
        const source_id = p.source_id;
        const text = p.text;
        if (typeof source_id !== "string" || !ids.has(source_id)) errors.push("paraphrases.source_id must exist in voice bank");
        if (typeof text !== "string" || !text.trim()) errors.push("paraphrases.text must be a non-empty string");

        if (typeof text === "string") {
          const v = validateRuntimeLine(text, voiceBank, lexicons);
          v.errors.forEach(e => errors.push(`paraphrase: ${e}`));

          // Similarity heuristic: must retain at least 2 keywords from source OR contain a signature token
          if (typeof source_id === "string" && ids.has(source_id)) {
            const src = (voiceBank.lines || []).find(l => l.id === source_id);
            const simOk = similarityHeuristicOk(src?.text || "", text, lexicons);
            if (!simOk) errors.push("paraphrase: failed similarity heuristic (too drifted)");
          }
        }

        sanitized.paraphrases.push({ source_id, text: (text || "").trim() });
      }
    }
  }

  // Validate the produced strings (quest_title etc.) with runtime rules
  for (const k of requiredStr) {
    if (typeof sanitized[k] === "string") {
      const v = validateRuntimeLine(sanitized[k], voiceBank, lexicons, { allowTitle: k === "quest_title" });
      v.errors.forEach(e => errors.push(`${k}: ${e}`));
      sanitized[k] = v.text; // normalized text
    }
  }

  // Optional reasoning tags
  if (Array.isArray(payload.reasoning_tags)) {
    sanitized.reasoning_tags = payload.reasoning_tags
      .filter(t => typeof t === "string")
      .slice(0, 10);
  } else {
    sanitized.reasoning_tags = [];
  }

  return { ok: errors.length === 0, errors, sanitized: errors.length ? sanitized : sanitized };
}

/* -------------------------
   Validation primitives
------------------------- */

function validateLine(line, style, lexicons) {
  const errors = [];
  if (!line || typeof line !== "object") return ["line must be an object"];

  const required = ["id", "moment", "bank", "intensity", "act", "thesis", "text"];
  for (const k of required) {
    if (typeof line[k] !== "string" || !line[k].trim()) errors.push(`missing/invalid ${k}`);
  }
  if (typeof line.text === "string") {
    const runtime = validateRuntimeLine(line.text, { character: { style } }, lexicons, { allowTitle: false });
    errors.push(...runtime.errors);
  }
  return errors;
}

function validateRuntimeLine(text, voiceBank, lexicons, opts = {}) {
  const errors = [];
  const style = voiceBank?.character?.style || {};
  const maxChars = style.max_chars_per_line ?? 140;
  const maxSentences = style.max_sentences ?? 2;

  let t = String(text || "").trim();
  if (!t) return { ok: false, errors: ["empty text"], text: "" };

  // Basic length/structure
  if (!opts.allowTitle && t.length > maxChars) errors.push(`too long (${t.length} > ${maxChars})`);
  const sentences = countSentences(t);
  if (!opts.allowTitle && sentences > maxSentences) errors.push(`too many sentences (${sentences} > ${maxSentences})`);

  // Hard bans
  const lower = t.toLowerCase();
  const forbidden = {
    profanity: lexicons?.forbidden_profanity || [],
    identityInsults: lexicons?.forbidden_identity_insults || [],
    cheerleading: lexicons?.forbidden_cheerleading || [],
    hinting: lexicons?.forbidden_hinting || []
  };

  for (const w of forbidden.profanity) if (lower.includes(String(w).toLowerCase())) errors.push("contains profanity");
  for (const w of forbidden.identityInsults) if (lower.includes(String(w).toLowerCase())) errors.push("contains identity insult");
  for (const w of forbidden.cheerleading) if (lower.includes(String(w).toLowerCase())) errors.push("contains cheerleading");
  for (const w of forbidden.hinting) if (lower.includes(String(w).toLowerCase())) errors.push("contains mechanics hinting");

  // Tone guard: require at least 1 signature token for non-title lines
  const signature = lexicons?.signature_tokens || [];
  if (!opts.allowTitle && signature.length && !containsAny(lower, signature)) {
    errors.push("missing signature token (risk of tone drift)");
  }

  return { ok: errors.length === 0, errors, text: t };
}

function similarityHeuristicOk(sourceText, newText, lexicons) {
  const src = tokenize(sourceText);
  const nxt = tokenize(newText);

  // must share at least 2 meaningful tokens OR include a signature token
  const shared = intersectionCount(src, nxt);
  const signature = (lexicons?.signature_tokens || []).map(s => String(s).toLowerCase());
  const hasSig = containsAny(newText.toLowerCase(), signature);

  return hasSig || shared >= 2;
}

function tokenize(s) {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 4) // drop tiny words
  );
}

function intersectionCount(aSet, bSet) {
  let c = 0;
  for (const w of aSet) if (bSet.has(w)) c++;
  return c;
}

function containsAny(lowerText, list) {
  const t = String(lowerText || "");
  for (const w of list) {
    const needle = String(w).toLowerCase();
    if (needle && t.includes(needle)) return true;
  }
  return false;
}

function countSentences(text) {
  // Rough, robust heuristic: counts ., !, ? that end clauses
  const m = String(text || "").match(/[.!?]+/g);
  return m ? m.length : 1;
}

{
  "quest_title": "Quest: Funnel Contamination",
  "dm_intro": "Try precision. It’s unfashionable, but effective.",
  "dm_midpoint": "Same elements. Same laws. New excuse?",
  "dm_verdict": "Stabilized. Predictable outcome when you stop guessing.",
  "used_voice_ids": ["EXP_INTRO_0001", "QUEST_OPEN_UR_0001"],
  "paraphrases": [
    { "source_id": "WIN_0007", "text": "Stabilized. Now explain why it worked." }
  ],
  "reasoning_tags": ["panic", "overcommitment"]
}
