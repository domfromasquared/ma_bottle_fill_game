// server/level_recipe.js

export function buildLevelRecipeMessages({
  bankPrimary,
  bankConfidence,
  sinTags,
  performanceSummary,
  act,
  seed
}) {
  const sins = Array.isArray(sinTags) ? sinTags.join(", ") : "none";
  const conf = Number(bankConfidence || 0).toFixed(2);

  return [
    {
      role: "system",
      content:
        "You are the Marketing Alchemist’s level designer.\n" +
        "You output ONLY valid JSON for a LEVEL RECIPE (not a board layout).\n" +
        "No spoilers, no solutions, no puzzle hints.\n" +
        "Theme: chemistry lab + marketing sins + alchemy.\n" +
        "Output must match the required schema exactly."
    },
    {
      role: "user",
      content:
        `Seed: ${seed}\n` +
        `Act: ${act}\n` +
        `BANK target: ${bankPrimary} (confidence ${conf})\n` +
        `Sin tags: ${sins}\n` +
        `Telemetry: ${JSON.stringify(performanceSummary || {})}\n\n` +
        "Return JSON with keys exactly:\n" +
        "version,title,lore,difficulty,bank_target,elements,colors,bottleCount,emptyBottles,lockedBottles,wildcardSlots,chaosFactor,scrambleMoves,rules,bonuses,constraints\n\n" +
        "Rules:\n" +
        "- version must be recipe.v1\n" +
        "- difficulty 1..10\n" +
        "- chaosFactor 0..1\n" +
        "- scrambleMoves 30..250\n" +
        "- bottleCount 6..12\n" +
        "- emptyBottles 1..5\n" +
        "- lockedBottles 0..3\n" +
        "- wildcardSlots 0..2\n" +
        "- colors 4..10\n" +
        "- elements must be >= colors, use short element-like ids"
    }
  ];
}

export function validateRecipeOrThrow(r) {
  const errs = [];
  const isObj = r && typeof r === "object" && !Array.isArray(r);
  if (!isObj) throw Object.assign(new Error("Recipe must be an object"), { details: ["recipe: not an object"] });

  const reqStr = (k) => {
    if (typeof r[k] !== "string" || !r[k].trim()) errs.push(`${k}: required string`);
    else r[k] = r[k].trim();
  };

  const reqInt = (k, a, b) => {
    const n = Number(r[k]);
    if (!Number.isFinite(n) || Math.floor(n) !== n || n < a || n > b) errs.push(`${k}: must be int in [${a},${b}]`);
    else r[k] = n;
  };

  const reqNum = (k, a, b) => {
    const n = Number(r[k]);
    if (!Number.isFinite(n) || n < a || n > b) errs.push(`${k}: must be number in [${a},${b}]`);
    else r[k] = n;
  };

  const reqArrStr = (k, min, max) => {
    if (!Array.isArray(r[k])) errs.push(`${k}: must be array`);
    else {
      const arr = r[k].filter(x => typeof x === "string" && x.trim()).map(s => s.trim());
      if (arr.length < min) errs.push(`${k}: must have at least ${min}`);
      if (arr.length > max) errs.push(`${k}: max ${max}`);
      r[k] = arr;
    }
  };

  reqStr("version");
  if (r.version !== "recipe.v1") errs.push("version: must be 'recipe.v1'");
  reqStr("title");
  reqStr("lore");

  reqInt("difficulty", 1, 10);

  reqStr("bank_target");
  if (!["A", "B", "N", "K"].includes(r.bank_target)) errs.push("bank_target: must be A|B|N|K");

  reqArrStr("elements", 4, 24);
  reqInt("colors", 4, 10);
  if (r.elements.length < r.colors) errs.push("elements: length must be >= colors");

  reqInt("bottleCount", 6, 12);
  reqInt("emptyBottles", 1, 5);
  reqInt("lockedBottles", 0, 3);
  reqInt("wildcardSlots", 0, 2);

  reqNum("chaosFactor", 0, 1);
  reqInt("scrambleMoves", 30, 250);

  if (!r.rules || typeof r.rules !== "object") errs.push("rules: required object");
  else {
    if (!["standard", "strict", "complex", "lenient"].includes(r.rules.reactionRules)) errs.push("rules.reactionRules: invalid");
    if (!["low", "medium", "high", "very_high"].includes(r.rules.forgiveness)) errs.push("rules.forgiveness: invalid");
  }

  reqArrStr("bonuses", 0, 10);
  reqArrStr("constraints", 0, 10);

  if (r.emptyBottles >= r.bottleCount - 1) errs.push("emptyBottles: too many for bottleCount");

  if (errs.length) throw Object.assign(new Error("Level recipe failed validation"), { details: errs });
  return r;
}
