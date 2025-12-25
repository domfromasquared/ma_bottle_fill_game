// src/level_reasoner.js
export function makeRng(seedStr) {
  // xmur3 + mulberry32: deterministic RNG from string seed
  function xmur3(str){
    let h = 1779033703 ^ str.length;
    for (let i=0; i<str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function() {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= (h >>> 16)) >>> 0;
    };
  }
  function mulberry32(a){
    return function() {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const seed = xmur3(seedStr)();
  const rand = mulberry32(seed);

  return {
    f: () => rand(),
    int: (min, max) => Math.floor(rand() * (max - min + 1)) + min,
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    shuffle: (arr) => {
      const a = arr.slice();
      for (let i=a.length-1; i>0; i--) {
        const j = Math.floor(rand() * (i+1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
  };
}

// --- Core thesis templates (DM intent)
export const THESES = {
  UR_without_CL: {
    name: "Urgency Without Clarity",
    must_include: ["UR"],
    must_exclude: ["CL"],
    illegal_rule: { type: "missing_required", element: "UR", required: "CL", result: "PANIC" },
    default_teaching: "restraint"
  },
  PA_without_PR: {
    name: "Pain Without Promise",
    must_include: ["PA"],
    must_exclude: ["PR"],
    illegal_rule: { type: "missing_required", element: "PA", required: "PR", result: "DESPAIR" },
    default_teaching: "sequencing"
  }
  // add more
};

export function difficultyScore(elements, elementSchema, constraints, thesis) {
  const base = elements.reduce((s, sym) => s + (elementSchema[sym]?.difficulty_weight ?? 2), 0);
  const volatility = elements.reduce((s, sym) => s + (elementSchema[sym]?.volatility ?? 0.3), 0) / Math.max(1, elements.length);

  const illegalRisk = thesis?.illegal_rule ? 1.2 : 0;
  const safety = (constraints.empties * 0.9) + (constraints.locks ? -0.2 * constraints.locks : 0);

  const score = base * 0.35 + volatility * 2.2 + illegalRisk - safety * 0.4;
  return { score: Math.max(1, score), volatility };
}

// --- Campaign → Quest → Experiment pipeline
export function generateExperiment({ act, quest, index, elementSchema, thesisKey, rng }) {
  const thesis = THESES[thesisKey];
  const teaching_goal = thesis.default_teaching;

  // Assemble element set
  const elements = assembleElements({ act, thesis, elementSchema, rng });

  // Constraints from teaching goal
  const constraints = deriveConstraints({ act, teaching_goal, rng });

  // Difficulty
  const diff = difficultyScore(elements, elementSchema, constraints, thesis);

  // Board init
  const board_init = generateBoard({ elements, constraints, thesis, rng });

  // Lore + bonuses
  const lore = generateLore({ act, quest, index, thesis, elements, rng });
  const bonuses = generateBonuses({ teaching_goal, diff, rng });

  return {
    id: `${act.id}-${quest.id}-E${String(index).padStart(2,"0")}`,
    act: act.id,
    quest: quest.id,
    thesis: thesisKey,
    teaching_goal,
    elements_in_play: elements,
    difficulty: {
      score: Number(diff.score.toFixed(2)),
      volatility: Number(diff.volatility.toFixed(2))
    },
    constraints,
    bonuses,
    lore,
    board_init
  };
}

function assembleElements({ act, thesis, elementSchema, rng }) {
  // Start with thesis requirements
  let set = new Set([...(thesis.must_include || [])]);

  // Role-based pool
  const keys = Object.keys(elementSchema);
  const foundational = keys.filter(k => elementSchema[k].role === "foundational");
  const structural   = keys.filter(k => elementSchema[k].role === "structural");
  const catalysts    = keys.filter(k => elementSchema[k].role === "catalyst");
  const volatile     = keys.filter(k => elementSchema[k].role === "volatile");
  const stabilizer   = keys.filter(k => elementSchema[k].role === "stabilizer");

  // Act-based composition
  const actTier = act.tier ?? 1; // 1..4
  const wantFound = actTier <= 2 ? 2 : 1;
  const wantStruct = 1;
  const wantCat = actTier >= 2 ? 1 : 0;
  const wantVol = actTier >= 3 ? 1 : 0;
  const wantStab = actTier >= 3 ? 1 : 0;

  const addFrom = (pool, n) => {
    const shuffled = rng.shuffle(pool);
    for (const sym of shuffled) {
      if (set.size >= 6) break;
      if (n <= 0) break;
      if (thesis.must_exclude?.includes(sym)) continue;
      set.add(sym);
      n--;
    }
  };

  addFrom(foundational, wantFound);
  addFrom(structural, wantStruct);
  addFrom(catalysts, wantCat);
  addFrom(volatile, wantVol);
  addFrom(stabilizer, wantStab);

  return [...set];
}

function deriveConstraints({ act, teaching_goal, rng }) {
  const tier = act.tier ?? 1;
  let vessels = 4 + (tier >= 2 ? 1 : 0) + (tier >= 3 ? 1 : 0);
  let capacity = tier >= 3 ? 5 : 4;

  let empties = teaching_goal === "restraint" ? 1 : 2;
  if (tier >= 3) empties = Math.max(1, empties - 1);

  const locks = tier >= 4 ? rng.int(0,1) : 0;
  const contamination = tier >= 3;

  return { vessels, capacity, empties, locks, contamination };
}

function generateBoard({ elements, constraints, thesis, rng }) {
  // Simple constructive generator (v1):
  // - Choose 3-4 "active" elements for the board fill
  // - Create intended stable groups
  // - Scatter with interference
  const active = rng.shuffle(elements).slice(0, Math.min(4, elements.length));
  const { vessels, capacity, empties } = constraints;

  const board = Array.from({ length: vessels }, () => []);

  // Reserve empty vessels
  for (let i=0; i<empties; i++) board[vessels - 1 - i] = [];

  // Build target piles (rough)
  const totalFillVessels = vessels - empties;
  const totalSlots = totalFillVessels * capacity;
  const per = Math.floor(totalSlots / active.length);

  let pool = [];
  for (const sym of active) {
    for (let i=0; i<per; i++) pool.push(sym);
  }
  // Pad if needed
  while (pool.length < totalSlots - capacity) pool.push(rng.pick(active));

  pool = rng.shuffle(pool);

  // Fill with interference: avoid too many already-solved stacks
  let pi = 0;
  for (let v=0; v<totalFillVessels; v++) {
    for (let s=0; s<capacity; s++) {
      if (pi >= pool.length) break;
      board[v].push(pool[pi++]);
    }
    // introduce a top-layer “temptation” if thesis wants it
    if (thesis.must_include?.length) {
      const t = thesis.must_include[0];
      if (!thesis.must_exclude?.includes(t) && board[v].length) {
        // occasionally place thesis element on top
        if (rng.f() < 0.35) board[v][board[v].length - 1] = t;
      }
    }
  }

  return { capacity, vessels: board };
}

function generateLore({ act, quest, index, thesis, elements, rng }) {
  const n = String(index).padStart(2,"0");
  const title = `Experiment ${n}: ${thesis.name}`;
  const intros = [
    `Let’s see if you can avoid the obvious mistake this time.`,
    `Same elements. Same laws. New excuse?`,
    `Try precision. It’s unfashionable, but effective.`
  ];
  const wins = [
    `Stabilized. Predictable outcome when you stop guessing.`,
    `Good. The reaction obeyed reality. As usual.`,
    `Clarity wins again. Shocking.`
  ];
  const fails = [
    `Chemistry doesn’t negotiate.`,
    `You can’t “vibe” your way through a reaction.`,
    `That wasn’t strategy. That was superstition.`
  ];

  return {
    title,
    intro_line: rng.pick(intros),
    win_line: rng.pick(wins),
    fail_line: rng.pick(fails)
  };
}

function generateBonuses({ teaching_goal, diff, rng }) {
  const bonuses = [];
  if (teaching_goal === "restraint") {
    bonuses.push({ id: "BONUS_MIN_TRANSFERS", label: "Minimal Transfers", threshold: 12 });
    bonuses.push({ id: "BONUS_NO_INVALID", label: "No Invalid Pours", rule: "no_invalid_pours" });
  } else if (teaching_goal === "sequencing") {
    bonuses.push({ id: "BONUS_FIRST_STABILIZE", label: "Stabilize One Vessel First", rule: "stabilize_any_vessel_within_6_moves" });
  } else {
    bonuses.push({ id: "BONUS_NO_ILLEGAL", label: "No Illegal Reactions", rule: "no_illegal_compounds" });
  }
  // Scale a threshold with difficulty
  if (diff.score > 4) bonuses.push({ id:"BONUS_NO_RESET", label:"No Resets", rule:"no_resets" });
  return bonuses;
}
