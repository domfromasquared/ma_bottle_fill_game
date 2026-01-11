/* ============================================================
   BANK Inference v1.0 — Deterministic, testable
   Implements spec sections 1–7 (optional 8 deferred)

   Usage:
     const events = JSON.parse(localStorage.getItem("ma_telemetry_v1") || "[]");
     const result = computeBankProfile(events);
     console.log(result);

   Output:
     {
       probabilities: { Blueprint, Action, Nurturing, Knowledge },
       confidence: 0..1,
       scores: { Blueprint, Action, Nurturing, Knowledge },   // raw (pre-softmax)
       evidence: [ { featureId, weight, delta, note }, ... ], // top 3 by abs impact
       diagnostics: {...}
     }
   ============================================================ */
import "./bankInference.js";

const BANK_TYPES = ["Blueprint", "Action", "Nurturing", "Knowledge"];

/* ------------------------ Constants (locked) ------------------------ */
const BANK_CFG = {
  // accumulator decay per event (spec §1)
  DECAY_PER_EVENT: 0.985,

  // softmax temperature (spec §1)
  SOFTMAX_TAU: 3.0,

  // clamp raw score to avoid runaway
  SCORE_CLAMP: 30,

  // competence gate (spec §2)
  MIN_POURS_FOR_FULL_SIGNAL: 12,
  ILLEGAL_RATE_HARD: 0.25,
  LEARNING_DAMP: 0.35,
  CONFIDENCE_CAP_LEARNING: 0.45,

  // event weights hierarchy (spec §4)
  EVENT_WEIGHT: {
    level_start: 0.8,
    bottle_select: 0.2,
    pour_attempt: 0.5,
    pour_execute: 0.5,
    unknown_reveal: 1.2,
    instability_warning: 1.5,
    instability_reset: 1.5,
    instability_collapse: 1.5,
    deco_key_use: 1.4,
    keystone_solved: 1.8,
    cork_unlock: 1.8,
    level_end: 0.8,
  },

  // feature weights (spec §3)
  FEATURES: {
    // Keystone
    KS1_UNLOCK_METHOD: {
      keystone: { Blueprint: +3.0, Knowledge: +2.0, Nurturing: +1.0, Action: -1.0 },
      deco_key: { Action: +3.0, Blueprint: -1.0, Knowledge: -0.5, Nurturing: 0.0 },
    },

    KS2_KEY_EARLY: { Action: +2.0, Blueprint: -1.5, Nurturing: -0.5, Knowledge: 0.0 },
    KS2_KEY_LATE: { Action: +0.8, Blueprint: +0.2, Nurturing: 0.0, Knowledge: 0.0 },

    // Unknown (sealed unknown)
    U1_REVEAL_EARLY: { Knowledge: +2.5, Blueprint: +1.0, Action: 0.0, Nurturing: 0.0 },
    U1_REVEAL_LATE: { Action: +1.5, Knowledge: -0.5, Blueprint: 0.0, Nurturing: 0.0 },

    U2_AVOID_UNKNOWN: { Action: +1.0, Knowledge: -1.0, Blueprint: 0.0, Nurturing: 0.0 },

    U3_STAGE_WITH_UNKNOWN: { Blueprint: +1.5, Knowledge: +1.0, Action: 0.0, Nurturing: 0.0 },

    // Instability
    I1_DT_LE2: { Nurturing: +3.0, Blueprint: +1.0, Action: 0.0, Knowledge: 0.0 },
    I1_DT_3_5: { Nurturing: +1.5, Blueprint: 0.0, Action: 0.0, Knowledge: 0.0 },
    I1_DT_GT5: { Action: +1.5, Nurturing: -0.5, Blueprint: 0.0, Knowledge: 0.0 },

    I1_COLLAPSE: { Action: +2.0, Blueprint: -1.5, Nurturing: -1.5, Knowledge: 0.0 },

    I2_STABILIZE_BEFORE_KEYSTONE: { Nurturing: +2.0, Blueprint: +1.0, Action: 0.0, Knowledge: 0.0 },
    I2_KEYSTONE_WHILE_UNSTABLE: { Action: +1.5, Nurturing: -1.0, Blueprint: 0.0, Knowledge: 0.0 },

    // Blueprint / move quality
    B1_ILLEGAL_LT5PCT: { Blueprint: +2.0, Action: 0.0, Nurturing: 0.0, Knowledge: 0.0 },
    B1_ILLEGAL_GT20PCT: { Action: +0.5, Blueprint: 0.0, Nurturing: 0.0, Knowledge: 0.0 },

    // Undo nuance (if you emit undos in level_end; we treat as optional)
    B2_UNDO_REFINEMENT: { Blueprint: +1.5, Knowledge: +0.5, Action: 0.0, Nurturing: 0.0 },
  },

  // normalization factors by opportunity (spec §6)
  OPPORTUNITY_REDUCTIONS: {
    NO_UNKNOWN: { Knowledge: 0.6 },    // reduce K evidence by 40% => multiply by 0.6
    NO_CORKED: { Blueprint: 0.4, Knowledge: 0.4, Action: 0.4, Nurturing: 0.4 }, // keystone features damped heavily via gating (see below)
    NO_INSTABILITY: { Nurturing: 0.5 },
  },

  // expected solve moves by band (spec §3 KS2). Conservative defaults.
  EXPECTED_SOLVE_MOVES_BY_BAND: {
    early: 28,
    mid: 44,
    late: 62,
    infinite: 72,
  },
};

/* ------------------------ Helpers ------------------------ */
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function addDelta(acc, delta) {
  for (const k of BANK_TYPES) acc[k] = (acc[k] || 0) + (delta[k] || 0);
}

function scaleDelta(delta, s) {
  const out = {};
  for (const k of BANK_TYPES) out[k] = (delta[k] || 0) * s;
  return out;
}

function softmax(scores, tau) {
  const vals = BANK_TYPES.map(k => Math.exp(scores[k] / tau));
  const sum = vals.reduce((a,b)=>a+b,0) || 1;
  const out = {};
  BANK_TYPES.forEach((k, i) => out[k] = vals[i] / sum);
  return out;
}

function entropy(prob) {
  // normalized entropy [0..1] over 4 classes
  const eps = 1e-12;
  const H = BANK_TYPES.reduce((s,k) => s - (prob[k] || 0) * Math.log((prob[k] || 0) + eps), 0);
  const Hmax = Math.log(BANK_TYPES.length);
  return clamp(H / Hmax, 0, 1);
}

function summarizeLevelOpportunities(levelStartEvent) {
  // Normalize by opportunity (spec §6).
  // We only use what we can reliably read from level_start payload.
  const sealedUnknownCount = Number(levelStartEvent?.sealedUnknownCount ?? 0);
  const corkedCount = Number(levelStartEvent?.corkedCount ?? levelStartEvent?.lockedBottles ?? 0);
  const instabilityEnabled = (levelStartEvent?.instabilityEnabled != null)
    ? !!levelStartEvent.instabilityEnabled
    : true; // default true; early levels can override later if you emit it

  return { sealedUnknownCount, corkedCount, instabilityEnabled };
}

function inferLevelBand(levelStartEvent) {
  // Deterministic, simple banding. Replace later if you have explicit difficulty tiers.
  const lvl = Number(levelStartEvent?.level ?? levelStartEvent?.levelId ?? 0);
  if (!Number.isFinite(lvl) || lvl <= 0) return "mid";
  if (lvl < 8) return "early";
  if (lvl < 18) return "mid";
  if (lvl < 35) return "late";
  return "infinite";
}

function expectedSolveMoves(levelStartEvent) {
  const band = inferLevelBand(levelStartEvent);
  return BANK_CFG.EXPECTED_SOLVE_MOVES_BY_BAND[band] || 44;
}

function getEventTs(e) {
  // support both legacy `t` and newer `ts`
  const v = e?.ts ?? e?.t ?? 0;
  return Number.isFinite(v) ? v : 0;
}

/* ------------------------ Main ------------------------ */
function computeBankProfile(events) {
  const evs = Array.isArray(events) ? events.slice() : [];
  evs.sort((a,b) => getEventTs(a) - getEventTs(b));  // deterministic if timestamps present

  // State
  let S = { Blueprint: 0, Action: 0, Nurturing: 0, Knowledge: 0 };
  const evidenceLog = [];

  // Aggregate stats for competence gate & features
  let totalPourAttempts = 0;
  let illegalPourAttempts = 0;

  // Opportunity context (per latest level_start we’ve seen)
  let lastLevelStart = null;
  let opp = { sealedUnknownCount: 0, corkedCount: 0, instabilityEnabled: true };

  // Unknown reveal timing stats
  let totalReveals = 0;
  let revealsBeforeFirstInstability = 0;
  let firstInstabilitySeen = false;

  // Unknown usage pattern inference
  let sealedUnknownTouched = false;
  let sealedUnknownCountAtStart = 0;
  let movesSinceLevelStart = 0;

  // Instability response stats
  // Track last warning per bottle index to compute dt; deterministic: first match reset after warning.
  const lastWarningMoveByBottle = new Map();

  // Keystone / cork logic
  let sawKeystoneSolved = false;
  let lastCorkUnlockMethod = null;
  let usedDecoKey = false;
  let firstDecoKeyMove = null;
  let keystoneSolvedMove = null;
  let instabilityActiveAtKeystoneSolve = null; // optional if event includes it

  // Undo refinement (only if level_end includes undos)
  let lastLevelEnd = null;

  // Helper to apply one feature delta with weighting/decay and log evidence
  function applyFeature(featureId, baseDelta, eventType, note = "") {
    // decay
    for (const k of BANK_TYPES) {
      S[k] *= BANK_CFG.DECAY_PER_EVENT;
      S[k] = clamp(S[k], -BANK_CFG.SCORE_CLAMP, BANK_CFG.SCORE_CLAMP);
    }

    // competence damp
    const illegalRate = totalPourAttempts > 0 ? (illegalPourAttempts / totalPourAttempts) : 0;
    const inLearning = (totalPourAttempts < BANK_CFG.MIN_POURS_FOR_FULL_SIGNAL) || (illegalRate > BANK_CFG.ILLEGAL_RATE_HARD);
    const damp = inLearning ? BANK_CFG.LEARNING_DAMP : 1.0;

    // opportunity normalization (spec §6)
    // Apply reductions only when the mechanic has no opportunity.
    let oppScale = { Blueprint: 1, Action: 1, Nurturing: 1, Knowledge: 1 };
    if ((opp.sealedUnknownCount || 0) === 0) {
      // reduce Knowledge evidence when unknowns never appear
      oppScale.Knowledge *= BANK_CFG.OPPORTUNITY_REDUCTIONS.NO_UNKNOWN.Knowledge;
    }
    if (!opp.instabilityEnabled) {
      oppScale.Nurturing *= BANK_CFG.OPPORTUNITY_REDUCTIONS.NO_INSTABILITY.Nurturing;
    }

    // Keystone evidence only meaningful when corked+keystone exist; otherwise damp across board for those features.
    // We can’t always know “keystone active” from level_start, but we can infer if events contain keystone/cork.
    const isKeystoneFeature = featureId.startsWith("KS");
    if (isKeystoneFeature && (opp.corkedCount || 0) === 0) {
      // heavy damp (spec §6)
      for (const k of BANK_TYPES) oppScale[k] *= 0.4;
    }

    const eventW = BANK_CFG.EVENT_WEIGHT[eventType] ?? 0.5;

    // Apply scaled delta
    const scaled = {};
    for (const k of BANK_TYPES) {
      scaled[k] = (baseDelta[k] || 0) * damp * oppScale[k] * eventW;
      S[k] += scaled[k];
      S[k] = clamp(S[k], -BANK_CFG.SCORE_CLAMP, BANK_CFG.SCORE_CLAMP);
    }

    // Evidence log (store magnitude for top-3 later)
    const mag = BANK_TYPES.reduce((m,k)=> m + Math.abs(scaled[k] || 0), 0);
    evidenceLog.push({ featureId, weight: eventW, delta: scaled, magnitude: mag, note });
  }

  // Pass through events
  for (const e of evs) {
    const type = e.eventType || e.type;
    if (!type) continue;

    // Update moveIndex context if present
    if (type === "level_start") {
      lastLevelStart = e;
      opp = summarizeLevelOpportunities(e);
      sealedUnknownCountAtStart = opp.sealedUnknownCount;
      movesSinceLevelStart = 0;

      // reset per-level trackers
      firstInstabilitySeen = false;
      totalReveals = 0;
      revealsBeforeFirstInstability = 0;
      sealedUnknownTouched = false;
      usedDecoKey = false;
      firstDecoKeyMove = null;
      sawKeystoneSolved = false;
      keystoneSolvedMove = null;
      instabilityActiveAtKeystoneSolve = null;
      lastCorkUnlockMethod = null;
      lastLevelEnd = null;

      // no direct BANK delta for level_start (by design)
      continue;
    }

    // best-effort move index tracking
    const moveIndex = Number.isFinite(e.moveIndex) ? e.moveIndex : null;
    if (moveIndex != null) movesSinceLevelStart = Math.max(movesSinceLevelStart, moveIndex);

    if (type === "bottle_select") {
      // For v1 we only use this to detect unknown-touch avoidance
      if (e.type === "sealedUnknown" || e.bottleType === "sealed_unknown" || e.bottleType === "sealedUnknown") {
        sealedUnknownTouched = true;
      }
      continue;
    }

    if (type === "pour_attempt") {
      totalPourAttempts += 1;
      if (e.legal === false) illegalPourAttempts += 1;
      continue;
    }

    if (type === "pour_execute") {
      // Track unknown staging heuristic: pouring INTO unknown repeatedly while legal implies planning+info use
      // We detect “into unknown” if toType says sealedUnknown
      if (e.toType === "sealedUnknown" || e.toBottleType === "sealed_unknown" || e.toBottleType === "sealedUnknown") {
        // only treat as staging if player is not failing constantly
        // we’ll apply later as aggregate (U3), to avoid spamming per pour
      }
      continue;
    }

    if (type === "unknown_reveal") {
      totalReveals += 1;
      if (!firstInstabilitySeen) revealsBeforeFirstInstability += 1;
      continue;
    }

    if (type === "instability_warning") {
      firstInstabilitySeen = true;
      if (e.bottleIndex != null && e.moveIndex != null) {
        lastWarningMoveByBottle.set(String(e.bottleIndex), e.moveIndex);
      }
      continue;
    }

    if (type === "instability_reset") {
      const b = e.bottleIndex != null ? String(e.bottleIndex) : null;
      const wMove = b ? lastWarningMoveByBottle.get(b) : null;
      if (wMove != null && e.moveIndex != null) {
        const dt = e.moveIndex - wMove;
        if (dt <= 2) applyFeature("I1_DT_LE2", BANK_CFG.FEATURES.I1_DT_LE2, type, `dt=${dt}`);
        else if (dt <= 5) applyFeature("I1_DT_3_5", BANK_CFG.FEATURES.I1_DT_3_5, type, `dt=${dt}`);
        else applyFeature("I1_DT_GT5", BANK_CFG.FEATURES.I1_DT_GT5, type, `dt=${dt}`);
        lastWarningMoveByBottle.delete(b);
      }
      continue;
    }

    if (type === "instability_collapse") {
      applyFeature("I1_COLLAPSE", BANK_CFG.FEATURES.I1_COLLAPSE, type, "collapse");
      continue;
    }

    if (type === "deco_key_use") {
      usedDecoKey = true;
      if (firstDecoKeyMove == null && e.moveIndex != null) firstDecoKeyMove = e.moveIndex;
      continue;
    }

    if (type === "cork_unlock") {
      lastCorkUnlockMethod = e.method || null;
      if (lastCorkUnlockMethod === "keystone") {
        applyFeature("KS1_UNLOCK_METHOD", BANK_CFG.FEATURES.KS1_UNLOCK_METHOD.keystone, type, "method=keystone");
      } else if (lastCorkUnlockMethod === "deco_key") {
        applyFeature("KS1_UNLOCK_METHOD", BANK_CFG.FEATURES.KS1_UNLOCK_METHOD.deco_key, type, "method=deco_key");
      }
      continue;
    }

    if (type === "keystone_solved") {
      sawKeystoneSolved = true;
      if (e.moveIndex != null) keystoneSolvedMove = e.moveIndex;
      if (e.instabilityActive != null) instabilityActiveAtKeystoneSolve = !!e.instabilityActive;

      // Instability/keystone interaction (I2)
      if (instabilityActiveAtKeystoneSolve === true) {
        applyFeature("I2_KEYSTONE_WHILE_UNSTABLE", BANK_CFG.FEATURES.I2_KEYSTONE_WHILE_UNSTABLE, type, "keystone solved while unstable");
      }
      continue;
    }

    if (type === "level_end") {
      lastLevelEnd = e;
      continue;
    }
  }

  // ---------- Post-pass features that require aggregation ----------

  // Competence-derived Blueprint signals (B1)
  const illegalRate = totalPourAttempts > 0 ? (illegalPourAttempts / totalPourAttempts) : 0;
  if (totalPourAttempts >= BANK_CFG.MIN_POURS_FOR_FULL_SIGNAL) {
    if (illegalRate < 0.05) applyFeature("B1_ILLEGAL_LT5PCT", BANK_CFG.FEATURES.B1_ILLEGAL_LT5PCT, "pour_attempt", `illegalRate=${illegalRate.toFixed(3)}`);
    if (illegalRate > 0.20) applyFeature("B1_ILLEGAL_GT20PCT", BANK_CFG.FEATURES.B1_ILLEGAL_GT20PCT, "pour_attempt", `illegalRate=${illegalRate.toFixed(3)}`);
  }

  // Unknown reveal timing (U1)
  if (totalReveals > 0) {
    const revealEarlyRate = revealsBeforeFirstInstability / totalReveals;
    if (revealEarlyRate >= 0.6) applyFeature("U1_REVEAL_EARLY", BANK_CFG.FEATURES.U1_REVEAL_EARLY, "unknown_reveal", `rate=${revealEarlyRate.toFixed(2)}`);
    else if (revealEarlyRate <= 0.3) applyFeature("U1_REVEAL_LATE", BANK_CFG.FEATURES.U1_REVEAL_LATE, "unknown_reveal", `rate=${revealEarlyRate.toFixed(2)}`);
  }

  // Unknown avoidance (U2)
  // Only apply if unknowns exist in the level and player had time to notice.
  if ((sealedUnknownCountAtStart || 0) > 0 && !sealedUnknownTouched && movesSinceLevelStart >= 10) {
    applyFeature("U2_AVOID_UNKNOWN", BANK_CFG.FEATURES.U2_AVOID_UNKNOWN, "bottle_select", "no unknown interaction after 10 moves");
  }

  // Keystone key timing (KS2) if player used key + we have level context
  if (usedDecoKey && firstDecoKeyMove != null) {
    const exp = expectedSolveMoves(lastLevelStart || {});
    const early = firstDecoKeyMove < 0.20 * exp;
    if (early) applyFeature("KS2_KEY_EARLY", BANK_CFG.FEATURES.KS2_KEY_EARLY, "deco_key_use", `firstKeyMove=${firstDecoKeyMove}, exp=${exp}`);
    else applyFeature("KS2_KEY_LATE", BANK_CFG.FEATURES.KS2_KEY_LATE, "deco_key_use", `firstKeyMove=${firstDecoKeyMove}, exp=${exp}`);
  }

  // Instability/keystone interaction: stabilize before keystone (I2)
  // If there were warnings and keystone solved and (by telemetry) instabilityActiveAtKeystoneSolve false,
  // infer they stabilized first.
  if (sawKeystoneSolved && instabilityActiveAtKeystoneSolve === false) {
    // Only meaningful if instability ever warned this level.
    if (firstInstabilitySeen) {
      applyFeature("I2_STABILIZE_BEFORE_KEYSTONE", BANK_CFG.FEATURES.I2_STABILIZE_BEFORE_KEYSTONE, "keystone_solved", "warnings occurred; keystone solved after stabilization");
    }
  }

  // Undo refinement (B2) if we have undos in level_end payload
  if (lastLevelEnd && Number.isFinite(lastLevelEnd.undos)) {
    const undos = lastLevelEnd.undos;
    if (undos >= 3 && illegalRate < 0.10) {
      applyFeature("B2_UNDO_REFINEMENT", BANK_CFG.FEATURES.B2_UNDO_REFINEMENT, "level_end", `undos=${undos}, illegalRate=${illegalRate.toFixed(3)}`);
    }
  }

  // ---------- Final probabilities ----------
  const probs = softmax(S, BANK_CFG.SOFTMAX_TAU);

  // ---------- Confidence (spec §5) ----------
  const meaningfulEvents = evs.filter(e => {
    const t = e.eventType || e.type;
    return ["cork_unlock","keystone_solved","deco_key_use","unknown_reveal","instability_warning","instability_reset","instability_collapse","pour_attempt","pour_execute"].includes(t);
  }).length;

  const base = clamp(Math.log(1 + meaningfulEvents) / Math.log(1 + 120), 0, 1);
  const competence = clamp(1 - illegalRate * 1.5, 0, 1);
  const sep = clamp(1 - entropy(probs), 0, 1);
  let confidence = base * competence * (0.55 + 0.45 * sep);

  // competence gate cap (spec §2)
  const inLearning = (totalPourAttempts < BANK_CFG.MIN_POURS_FOR_FULL_SIGNAL) || (illegalRate > BANK_CFG.ILLEGAL_RATE_HARD);
  if (inLearning) confidence = Math.min(confidence, BANK_CFG.CONFIDENCE_CAP_LEARNING);

  // ---------- Evidence top 3 ----------
  const topEvidence = evidenceLog
    .slice()
    .sort((a,b) => (b.magnitude - a.magnitude))
    .slice(0, 3)
    .map(e => ({
      featureId: e.featureId,
      weight: e.weight,
      delta: e.delta,
      note: e.note
    }));

  return {
    probabilities: probs,
    confidence,
    scores: S,
    evidence: topEvidence,
    diagnostics: {
      meaningfulEvents,
      totalPourAttempts,
      illegalPourAttempts,
      illegalRate,
      opportunities: opp,
      levelBand: inferLevelBand(lastLevelStart || {}),
    }
  };
}
// DEV ONLY: expose for console calibration
window.computeBankProfile = computeBankProfile;

