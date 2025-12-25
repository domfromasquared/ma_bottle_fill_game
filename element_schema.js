
/* =========================================================
   THE MARKETING ALCHEMIST — Periodic Table Schema (Canon)
   - Symbols are the source of truth (CL, PA, PR, etc.)
   - Designed for reasoning-driven generation
========================================================= */

/** Element Roles:
 * foundational | structural | catalyst | transmission | conversion | stabilizer | volatile
 */
export const ELEMENTS = {
  // --- Foundational Elements ---
  CL: {
    symbol: "CL",
    name: "Clarity",
    role: "foundational",
    color: "#38bdf8",
    stability: 0.95,
    volatility: 0.05,
    difficulty_weight: 1,
    bonds_with: ["PA", "PR", "ME", "FR"],
    conflicts_with: ["HO"],
    teaches: "precision",
    punishes: "vagueness"
  },
  PA: {
    symbol: "PA",
    name: "Pain",
    role: "foundational",
    color: "#ec4899",
    stability: 0.75,
    volatility: 0.25,
    difficulty_weight: 2,
    bonds_with: ["CL", "PR"],
    illegal_without: ["PR"], // Pain without Promise → Despair
    teaches: "relevance",
    punishes: "exploitation"
  },
  PR: {
    symbol: "PR",
    name: "Promise",
    role: "foundational",
    color: "#facc15",
    stability: 0.85,
    volatility: 0.15,
    difficulty_weight: 2,
    bonds_with: ["CL", "PA", "ME"],
    teaches: "outcomes",
    punishes: "ambiguity"
  },
  AU: {
    symbol: "AU",
    name: "Audience",
    role: "foundational",
    color: "#a78bfa",
    stability: 0.7,
    volatility: 0.3,
    difficulty_weight: 2,
    bonds_with: ["PO", "FR", "DI"],
    teaches: "constraints",
    punishes: "genericism"
  },
  TR: {
    symbol: "TR",
    name: "Truth",
    role: "foundational",
    color: "#34d399",
    stability: 0.9,
    volatility: 0.1,
    difficulty_weight: 2,
    bonds_with: ["EV", "RI"],
    conflicts_with: ["HO"],
    teaches: "trust",
    punishes: "bullshit"
  },

  // --- Structural Elements ---
  PO: {
    symbol: "PO",
    name: "Positioning",
    role: "structural",
    color: "#60a5fa",
    stability: 0.8,
    volatility: 0.2,
    difficulty_weight: 3,
    bonds_with: ["AU", "DI"],
    teaches: "context",
    punishes: "substitution"
  },
  FR: {
    symbol: "FR",
    name: "Framing",
    role: "structural",
    color: "#fb7185",
    stability: 0.75,
    volatility: 0.25,
    difficulty_weight: 2,
    bonds_with: ["CL", "PO"],
    teaches: "interpretation",
    punishes: "misread"
  },
  ME: {
    symbol: "ME",
    name: "Mechanism",
    role: "structural",
    color: "#22d3ee",
    stability: 0.9,
    volatility: 0.1,
    difficulty_weight: 3,
    bonds_with: ["CL", "PR"],
    teaches: "causality",
    punishes: "hand_waving"
  },
  DI: {
    symbol: "DI",
    name: "Differentiation",
    role: "structural",
    color: "#f472b6",
    stability: 0.7,
    volatility: 0.3,
    difficulty_weight: 3,
    bonds_with: ["PO", "AU"],
    teaches: "contrast",
    punishes: "commoditization"
  },
  CO: {
    symbol: "CO",
    name: "Constraints",
    role: "structural",
    color: "#94a3b8",
    stability: 0.85,
    volatility: 0.15,
    difficulty_weight: 2,
    bonds_with: ["AU", "PO"],
    teaches: "focus",
    punishes: "scope_creep"
  },

  // --- Catalysts ---
  UR: {
    symbol: "UR",
    name: "Urgency",
    role: "catalyst",
    color: "#f97316",
    stability: 0.3,
    volatility: 0.7,
    difficulty_weight: 4,
    requires: ["CL"],
    illegal_without: ["CL"], // Urgency without Clarity → Panic
    teaches: "timing",
    punishes: "panic"
  },
  EM: {
    symbol: "EM",
    name: "Emotion",
    role: "catalyst",
    color: "#f43f5e",
    stability: 0.45,
    volatility: 0.55,
    difficulty_weight: 3,
    bonds_with: ["PA", "TR"],
    teaches: "energy",
    punishes: "melodrama"
  },
  NO: {
    symbol: "NO",
    name: "Novelty",
    role: "catalyst",
    color: "#fde047",
    stability: 0.2,
    volatility: 0.8,
    difficulty_weight: 4,
    teaches: "spark",
    punishes: "dependency"
  },

  // --- Transmission ---
  CH: {
    symbol: "CH",
    name: "Channel",
    role: "transmission",
    color: "#93c5fd",
    stability: 0.55,
    volatility: 0.45,
    difficulty_weight: 2,
    bonds_with: ["FO", "TI"],
    teaches: "distribution",
    punishes: "platform_worship"
  },
  FO: {
    symbol: "FO",
    name: "Format",
    role: "transmission",
    color: "#67e8f9",
    stability: 0.6,
    volatility: 0.4,
    difficulty_weight: 2,
    bonds_with: ["CH"],
    teaches: "packaging",
    punishes: "random_content"
  },
  TI: {
    symbol: "TI",
    name: "Timing",
    role: "transmission",
    color: "#c7d2fe",
    stability: 0.55,
    volatility: 0.45,
    difficulty_weight: 3,
    bonds_with: ["UR"],
    teaches: "receptivity",
    punishes: "bad_timing"
  },

  // --- Conversion ---
  CT: {
    symbol: "CT",
    name: "Call to Action",
    role: "conversion",
    color: "#22c55e",
    stability: 0.7,
    volatility: 0.3,
    difficulty_weight: 3,
    bonds_with: ["JU", "RI"],
    teaches: "direction",
    punishes: "soft_ask"
  },
  JU: {
    symbol: "JU",
    name: "Justification",
    role: "conversion",
    color: "#86efac",
    stability: 0.75,
    volatility: 0.25,
    difficulty_weight: 2,
    bonds_with: ["EV", "TR"],
    teaches: "logic",
    punishes: "because_i_said_so"
  },
  RI: {
    symbol: "RI",
    name: "Risk Reversal",
    role: "conversion",
    color: "#bbf7d0",
    stability: 0.8,
    volatility: 0.2,
    difficulty_weight: 2,
    bonds_with: ["TR", "EV"],
    teaches: "safety",
    punishes: "unnecessary_risk"
  },

  // --- Stabilizers ---
  CS: {
    symbol: "CS",
    name: "Consistency",
    role: "stabilizer",
    color: "#fda4af",
    stability: 0.9,
    volatility: 0.1,
    difficulty_weight: 2,
    teaches: "repetition",
    punishes: "randomness"
  },
  EV: {
    symbol: "EV",
    name: "Evidence",
    role: "stabilizer",
    color: "#4ade80",
    stability: 0.92,
    volatility: 0.08,
    difficulty_weight: 2,
    bonds_with: ["TR", "JU", "RI"],
    teaches: "proof",
    punishes: "claims"
  },
  RE: {
    symbol: "RE",
    name: "Retention",
    role: "stabilizer",
    color: "#2dd4bf",
    stability: 0.88,
    volatility: 0.12,
    difficulty_weight: 3,
    teaches: "bonding",
    punishes: "leaky_funnel"
  },
  ST: {
    symbol: "ST",
    name: "Stabilizers",
    role: "stabilizer",
    color: "#5eead4",
    stability: 0.85,
    volatility: 0.15,
    difficulty_weight: 3,
    teaches: "durability",
    punishes: "fragility"
  },

  // --- Volatile ---
  HO: {
    symbol: "HO",
    name: "Hype",
    role: "volatile",
    color: "#ef4444",
    stability: 0.1,
    volatility: 0.95,
    difficulty_weight: 5,
    illegal_without: ["TR"], // Hype without Truth → Distrust
    conflicts_with: ["CL"],
    teaches: "fragility",
    punishes: "overconfidence"
  },
  VI: {
    symbol: "VI",
    name: "Virality",
    role: "volatile",
    color: "#fb923c",
    stability: 0.2,
    volatility: 0.9,
    difficulty_weight: 5,
    requires: ["ST"], // Virality without Stabilizers → Collapse
    illegal_without: ["ST"],
    teaches: "scale_risk",
    punishes: "premature_scaling"
  }
};

/* =========================================================
   Thesis templates (DM intent)
   - Controls missing elements + trap logic + default teaching goal
========================================================= */
export const THESES = {
  PA_without_PR: {
    key: "PA_without_PR",
    name: "Pain Without Promise",
    must_include: ["PA"],
    must_exclude: ["PR"],
    illegal_rule: { type: "missing_required", element: "PA", required: "PR", result: "DESPAIR" },
    default_teaching: "sequencing"
  },
  UR_without_CL: {
    key: "UR_without_CL",
    name: "Urgency Without Clarity",
    must_include: ["UR"],
    must_exclude: ["CL"],
    illegal_rule: { type: "missing_required", element: "UR", required: "CL", result: "PANIC" },
    default_teaching: "restraint"
  },
  Traffic_without_ME: {
    key: "Traffic_without_ME",
    name: "Traffic Without Mechanism",
    must_include: ["CH"],
    must_exclude: ["ME"],
    illegal_rule: { type: "missing_required", element: "CH", required: "ME", result: "INDIFFERENCE" },
    default_teaching: "precision"
  },
  HO_without_TR: {
    key: "HO_without_TR",
    name: "Hype Without Truth",
    must_include: ["HO"],
    must_exclude: ["TR"],
    illegal_rule: { type: "missing_required", element: "HO", required: "TR", result: "DISTRUST" },
    default_teaching: "risk_management"
  },
  VI_without_ST: {
    key: "VI_without_ST",
    name: "Virality Without Stabilizers",
    must_include: ["VI"],
    must_exclude: ["ST"],
    illegal_rule: { type: "missing_required", element: "VI", required: "ST", result: "COLLAPSE" },
    default_teaching: "risk_management"
  }
};

/* =========================================================
   DM Voice Pack (short, judgmental, useful)
========================================================= */
const VOICE = {
  intro: [
    "Try precision. It’s unfashionable, but effective.",
    "Same elements. Same laws. New excuse?",
    "Let’s see if you can avoid the obvious mistake this time.",
    "Go ahead. Make the move you *want* to make. Then regret it.",
    "This experiment fails quietly. Like most marketing."
  ],
  win: [
    "Stabilized. Predictable outcome when you stop guessing.",
    "Good. Reality remains undefeated.",
    "Clarity wins again. Shocking.",
    "You didn’t overthink it. Growth.",
    "The reaction obeyed the rules. As it always does."
  ],
  fail: [
    "Chemistry doesn’t negotiate.",
    "That wasn’t strategy. That was superstition.",
    "You can’t vibe your way through a reaction.",
    "You introduced chaos. Then acted surprised. Classic.",
    "Reset if you must. Denial is a phase."
  ]
};

export function pickLoreLine(kind, rng) {
  const arr = VOICE[kind] || VOICE.intro;
  return arr[Math.floor(rng.f() * arr.length)];
}
