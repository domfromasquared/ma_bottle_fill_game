#!/usr/bin/env node
/**
 * BANK Calibration Harness (Node)
 *
 * Usage:
 *   node bankHarness.mjs ./telemetry.json
 *   node bankHarness.mjs ./telemetry.json --levels 5-12
 *   node bankHarness.mjs ./telemetry.json --last 3
 *   node bankHarness.mjs ./telemetry.json --per-level
 *
 * Requirements:
 *  - bankInference.js exports computeBankProfile(events)
 *  - telemetry.json is an array of events (what maExportTelemetry() produces)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Adjust if your path differs:
import { computeBankProfile } from "./src/game/bankInference.js";

function parseArgs(argv) {
  const args = { file: null, levels: null, last: null, perLevel: false };
  const rest = argv.slice(2);

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a) continue;

    if (!args.file && !a.startsWith("--")) {
      args.file = a;
      continue;
    }

    if (a === "--per-level") {
      args.perLevel = true;
      continue;
    }

    if (a === "--levels") {
      const v = rest[++i];
      if (!v) throw new Error("Missing value for --levels (example: 5-12)");
      const m = String(v).match(/^(\d+)\s*-\s*(\d+)$/);
      if (!m) throw new Error("Bad --levels format. Use like 5-12");
      args.levels = { min: Number(m[1]), max: Number(m[2]) };
      continue;
    }

    if (a === "--last") {
      const v = rest[++i];
      if (!v) throw new Error("Missing value for --last (example: 3)");
      args.last = Number(v);
      continue;
    }

    throw new Error(`Unknown arg: ${a}`);
  }

  if (!args.file) throw new Error("Provide telemetry file path. Example: node bankHarness.mjs ./telemetry.json");
  return args;
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function top2(prob) {
  const entries = Object.entries(prob).sort((a, b) => b[1] - a[1]);
  return entries.slice(0, 2).map(([k, v]) => `${k} ${pct(v)}`).join(" / ");
}

function formatProb(prob) {
  const order = ["Blueprint", "Action", "Nurturing", "Knowledge"];
  return order.map(k => `${k[0]}:${pct(prob[k] ?? 0)}`).join("  ");
}

function groupRuns(events) {
  // A "run" = between level_start and next level_start
  const runs = [];
  let cur = [];

  for (const e of events) {
    if ((e.eventType || e.type) === "level_start") {
      if (cur.length) runs.push(cur);
      cur = [e];
    } else {
      cur.push(e);
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

function getLevelFromRun(run) {
  const ls = run.find(e => (e.eventType || e.type) === "level_start");
  const lvl = ls?.level ?? ls?.levelId ?? null;
  return Number.isFinite(Number(lvl)) ? Number(lvl) : null;
}

function filterLevels(runs, range) {
  if (!range) return runs;
  return runs.filter(r => {
    const lvl = getLevelFromRun(r);
    if (lvl == null) return false;
    return lvl >= range.min && lvl <= range.max;
  });
}

function lastNRuns(runs, n) {
  if (!n || n <= 0) return runs;
  return runs.slice(Math.max(0, runs.length - n));
}

function countEvent(run, name) {
  return run.filter(e => (e.eventType || e.type) === name).length;
}

function renderRunHeader(i, run) {
  const lvl = getLevelFromRun(run);
  const moves = run.find(e => (e.eventType || e.type) === "level_end")?.moves ?? "—";
  const result = run.find(e => (e.eventType || e.type) === "level_end")?.result ?? "—";
  const corkUnlock = run.find(e => (e.eventType || e.type) === "cork_unlock");
  const unlock = corkUnlock?.method ? `unlock:${corkUnlock.method}` : "";
  return `Run ${i + 1}  level:${lvl ?? "?"}  moves:${moves}  end:${result}  ${unlock}`.trim();
}

function main() {
  const args = parseArgs(process.argv);

  const filePath = path.resolve(process.cwd(), args.file);
  const raw = fs.readFileSync(filePath, "utf-8");
  const events = JSON.parse(raw);

  if (!Array.isArray(events)) {
    throw new Error("telemetry.json must be an array of events");
  }

  // Sort deterministically
  events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  const runsAll = groupRuns(events);
  const runsFiltered = lastNRuns(filterLevels(runsAll, args.levels), args.last);

  if (!runsFiltered.length) {
    console.log("No runs matched your filter.");
    return;
  }

  // Overall profile on selected runs combined
  const combined = runsFiltered.flat();
  const overall = computeBankProfile(combined);

  console.log("\n=== OVERALL (selected runs combined) ===");
  console.log(`Top: ${top2(overall.probabilities)}   confidence: ${pct(overall.confidence)}`);
  console.log(formatProb(overall.probabilities));
  console.log("Evidence:", overall.evidence?.map(e => `${e.featureId} (${e.note || ""})`).join(" | ") || "—");
  console.log("Diagnostics:", overall.diagnostics);

  if (args.perLevel) {
    console.log("\n=== PER RUN ===");
    runsFiltered.forEach((run, i) => {
      const res = computeBankProfile(run);
      console.log("\n" + renderRunHeader(i, run));
      console.log(`Top: ${top2(res.probabilities)}   confidence: ${pct(res.confidence)}`);
      console.log(formatProb(res.probabilities));
      const warns = countEvent(run, "instability_warning");
      const reveals = countEvent(run, "unknown_reveal");
      const illegal = (() => {
        const attempts = run.filter(e => (e.eventType || e.type) === "pour_attempt");
        const bad = attempts.filter(e => e.legal === false).length;
        return attempts.length ? (bad / attempts.length) : 0;
      })();
      console.log(`Signals: reveals=${reveals}, warnings=${warns}, illegalRate=${pct(illegal)}`);
      console.log("Evidence:", res.evidence?.map(e => `${e.featureId} (${e.note || ""})`).join(" | ") || "—");
    });
  }
}

main();
