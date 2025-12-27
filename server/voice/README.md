Absolutely — here is the **final, clean, authoritative README.md** you can copy-paste directly into your repo.
This version is tightened, explicit, and aligned with everything you’ve actually built (no aspirational fluff).

---

# 🧪 Marketing Alchemist — Bottle Fill Quest Game

A browser-based puzzle game inspired by mobile **bottle-fill / water-sort mechanics**, powered by a live **LLM Dungeon Master** called **The Marketing Alchemist**.

This project combines:

* Deterministic puzzle gameplay
* Quest-based progression
* AI-generated narrative + gameplay modifiers
* Strict character voice enforcement
* Personality-driven personalization using the **B.A.N.K framework** (non-financial)

---

## 🗂 Repository Structure

```
ma_bottle_fill_game/
│
├─ index.html                  # Frontend (GitHub Pages)
├─ element_schema.js           # Element / periodic-table logic
│
├─ server/                     # Backend API (Render)
│  ├─ index.js                 # Express server (ONLY runtime file)
│  ├─ package.json
│  ├─ package-lock.json
│  └─ voice/
│     ├─ ma_voice_lock.v1.txt  # Marketing Alchemist voice canon (authoritative)
│     └─ ma_fewshots.v1.json   # Voice anchors (bad → good examples)
│
└─ README.md
```

---

## 🎮 Gameplay Overview

* Core gameplay is a **bottle fill puzzle**
* Levels are grouped into **quest arcs**
* Every **5th level**:

  * The LLM generates a **Quest Node**
  * The Quest Node returns a **modifier**
  * That modifier alters the **next level only**
* Levels in between are **deterministic filler** (no LLM calls)

This ensures:

* Predictable gameplay
* Controlled costs
* Meaningful narrative beats
* No AI spam or randomness fatigue

---

## 🧠 AI Design Philosophy

### The LLM is NOT the game engine

The LLM:

* Does **not** run the puzzle
* Does **not** determine success/failure
* Does **not** control moment-to-moment gameplay

The LLM ONLY:

* Acts as a **Dungeon Master**
* Narrates consequences
* Introduces constraints
* Modifies future levels via bounded deltas

---

## 🧬 The Marketing Alchemist Voice System

The Marketing Alchemist is a **hard-locked character**, not a “vibe prompt.”

### `server/voice/ma_voice_lock.v1.txt`

This file is the **single source of truth** for:

* Persona
* Tone
* Forbidden topics
* Required metaphors
* Output rhythm
* Catchphrases
* B.A.N.K definitions

It is injected into **every** LLM request.

### `server/voice/ma_fewshots.v1.json`

Small “bad → good” examples that:

* Prevent generic narration
* Lock cadence and attitude
* Reduce tone drift dramatically

---

## 🧠 B.A.N.K Framework (IMPORTANT)

**B.A.N.K does NOT mean banking or finance.**

It is a personality framework ONLY:

```
B = Blueprint   (structure, clarity, predictability)
A = Action      (speed, momentum, urgency)
N = Nurturing   (safety, reassurance, encouragement)
K = Knowledge   (logic, proof, mastery)
```

The server **actively rejects** any finance, money, or corporate language.

---

## 🔒 Voice Drift Protection

The server enforces:

* Required signature token: `[SIG:MA_V1]`
* Forbidden-topic scanning (finance, corporate jargon, ROI, etc.)
* Strict JSON schema validation
* Hard failure on tone violations

If the LLM drifts → the response is rejected → gameplay remains intact.

---

## 🌐 Deployment

### Frontend (GitHub Pages)

* `index.html` at repo root
* Hosted via GitHub Pages
* Automatically selects API base:

  * Local → `http://localhost:8787`
  * Production → Render URL

### Backend (Render)

* Root directory: `/server`
* Start command:

  ```
  npm start
  ```
* Required environment variable:

  ```
  OPENAI_API_KEY=sk-...
  ```

Health check:

```
GET /health
```

---

## 🔁 API Endpoints

### `POST /api/quest-node`

* Called every 5th level
* Returns:

  * Quest title
  * DM narrative (voice-locked)
  * Gameplay modifier for next level

### `POST /api/level-recipe`

* Called once per level
* Uses:

  * Player context
  * BANK profile
  * Optional modifier
* Returns a full puzzle recipe (schema-validated)

---

## 🧯 Cost & Rate Safety

Built-in protections:

* Client-side single-flight + cooldown
* Server-side IP rate limiting
* Request de-duplication
* Token caps per request

Prevents:

* Accidental API spam
* Retry storms
* Runaway costs

---

## 🧪 Local Development

```
cd server
npm install
npm start
```

Then open `index.html` in your browser
(Live Server or local static server recommended).

---

## 🧠 Design Philosophy

> “The LLM is not the hero.
> It’s the sarcastic lab assistant that slaps your hand when you reach for chaos.”

---

## 🚧 Planned Extensions

* Quest log UI
* Modifier visualization
* Artifact system (persistent effects)
* Periodic-table compound unlocks
* Multi-act campaign arcs
* Player memory callbacks

---

If you want the next step, I recommend **visualizing modifiers directly on the puzzle UI** so players *feel* the quest consequences immediately.
