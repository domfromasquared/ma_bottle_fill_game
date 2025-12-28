🧪 Marketing Alchemist — Bottle Fill (Quest DM) — Player README (v0)

A browser-based puzzle game inspired by classic water-sort / bottle-fill mechanics—except every few levels a live Dungeon Master (the Marketing Alchemist) shows up to roast your decisions, nudge your strategy, and sometimes “brew” a modifier that changes the next experiment.

At this stage, the game is focused on:

Clean, deterministic puzzle gameplay

A “chemical meaning” legend that makes each color matter (elements have roles, behaviors, and failure modes) 

element_schema

An LLM DM that adapts its tone based on your current B.A.N.K profile (non-financial) 

index

Early-game simplicity, with advanced “illegal reaction” play delayed to later levels 

index

🎮 Game Objective

Each level is a set of bottles filled with colored segments (“elements”).

You win when every non-empty bottle is:

full, and

all one color (same element from bottom to top)

Empty bottles are allowed.

🕹️ How to Play

Controls

Tap/click a bottle to select it.

Tap/click another bottle to pour into it.

Pour rules

You can only pour from a non-empty bottle.

You can only pour into a bottle with space remaining.

You can only pour if the destination is empty or its top segment matches the source’s top segment.

Strategy basics

Use empties as “buffers” to uncover blocked colors.

Don’t trap a needed color under mixed stacks.

Stabilize a bottle early (make one complete color stack) to reduce chaos.

🧙 Who is the DM / Marketing Alchemist?

The Marketing Alchemist (MA) is the sarcastic lab master running the experiments.

He is not the game engine:

He doesn’t solve the puzzle for you.

He doesn’t change the current board mid-move.

He does narrate consequences and sometimes alters future conditions through modifiers.

His voice and “chemistry metaphor” framing are part of the canon of the game’s world (short, judgmental, useful). The element system itself is also canonized as a “periodic table of marketing chemistry.” 

element_schema

🧠 B.A.N.K (Personality) — What it means in this game

B.A.N.K here is NOT finance. It’s a personality framework used to tailor the DM’s commentary.

B = Blueprint (structure, predictability)

A = Action (speed, momentum)

N = Nurturing (safety, reassurance)

K = Knowledge (logic, mastery)

Your current BANK status is inferred from how you play (pace, invalid pours, resets), and shown in the UI 

index

.

👣 DM Visits, Foreshadowing, and Modifiers
When the DM appears

The DM appears randomly every 3–6 levels (seeded per run), shown as “Next DM: L#” in the UI 

index

.

Minor vs Major DM visits

Minor DM visit: story + directive, no modifier brewed

Major DM visit: happens on every 5th DM appearance (“major on #5, #10…”) and the DM brews a modifier that affects the next level 

index

Modifiers (what can change)

On a major DM visit, the modifier can adjust:

bottles

colors

capacity

empty bottles

locked bottles

wildcard slots

The UI summarizes the brewed modifier in shorthand (e.g., cap+1 empty-1 locks+1) 

index

.

Soft foreshadowing (early warning, no spoilers)

The game intentionally delays “complex play”:

Foreshadow window: levels 10–14

Advanced illegal-reaction trap window: level 15+ 

index

During foreshadowing, MA warns you (in BANK-specific language) about consequences you’ll face later—without introducing new mechanics yet.

🚫 Illegal Reaction Trap (Later Levels)

Some “thesis” experiments describe an illegal condition: an element that should have its stabilizing counterpart, but doesn’t.

Example thesis: Urgency Without Clarity (UR_without_CL) 

element_schema

UR is volatile and is marked as illegal_without: ["CL"] 

element_schema


In later levels, this becomes a special trap:

UR can be in play,

CL exists, but is locked behind a “Stabilizer” bottle mechanic (introduced later in progression).

(Players are intentionally not expected to master this early. The DM will foreshadow it first.)

🧬 The Element Legend (Chemical Meaning)

Each color is an element with:

role (foundational / structural / catalyst / transmission / conversion / stabilizer / volatile) 

element_schema

teaches (what good play feels like)

punishes (common mistake it exposes)

sometimes: bonds_with, conflicts_with, requires, illegal_without

Element list (current)

Foundational

CL — Clarity (teaches: precision; punishes: vagueness) bonds: PA/PR/ME/FR; conflicts: HO 

element_schema

PA — Pain (teaches: relevance; punishes: exploitation) bonds: CL/PR; illegal_without: PR 

element_schema

PR — Promise (teaches: outcomes; punishes: ambiguity) bonds: CL/PA/ME 

element_schema

AU — Audience (teaches: constraints; punishes: genericism) bonds: PO/FR/DI 

element_schema

TR — Truth (teaches: trust; punishes: bullshit) bonds: EV/RI; conflicts: HO 

element_schema

Structural

PO — Positioning (teaches: context; punishes: substitution) bonds: AU/DI 

element_schema

FR — Framing (teaches: interpretation; punishes: misread) bonds: CL/PO 

element_schema

ME — Mechanism (teaches: causality; punishes: hand_waving) bonds: CL/PR 

element_schema

DI — Differentiation (teaches: contrast; punishes: commoditization) bonds: PO/AU 

element_schema

CO — Constraints (teaches: focus; punishes: scope_creep) bonds: AU/PO 

element_schema

Catalysts

UR — Urgency (teaches: timing; punishes: panic) requires: CL; illegal_without: CL 

element_schema

EM — Emotion (teaches: energy; punishes: melodrama) bonds: PA/TR 

element_schema

NO — Novelty (teaches: spark; punishes: dependency) 

element_schema

Transmission

CH — Channel (teaches: distribution; punishes: platform_worship) bonds: FO/TI 

element_schema

FO — Format (teaches: packaging; punishes: random_content) bonds: CH 

element_schema

TI — Timing (teaches: receptivity; punishes: bad_timing) bonds: UR 

element_schema

Conversion

CT — Call to Action (teaches: direction; punishes: soft_ask) bonds: JU/RI 

element_schema

JU — Justification (teaches: logic; punishes: because_i_said_so) bonds: EV/TR 

element_schema

RI — Risk Reversal (teaches: safety; punishes: unnecessary_risk) bonds: TR/EV 

element_schema

Stabilizers

CS — Consistency (teaches: repetition; punishes: randomness) 

element_schema

EV — Evidence (teaches: proof; punishes: claims) bonds: TR/JU/RI 

element_schema

RE — Retention (teaches: bonding; punishes: leaky_funnel) 

element_schema

ST — Stabilizers (teaches: durability; punishes: fragility) 

element_schema

Volatile

HO — Hype (teaches: fragility; punishes: overconfidence) conflicts: CL; illegal_without: TR 

element_schema

VI — Virality (teaches: scale_risk; punishes: premature_scaling) requires: ST; illegal_without: ST 

element_schema

🧪 Thesis Experiments (Current Set)

Theses describe the intent of a level (what’s missing, what’s being tested). Current templates include: 

element_schema

Pain Without Promise (PA_without_PR) → DESPAIR

Urgency Without Clarity (UR_without_CL) → PANIC

Traffic Without Mechanism (Traffic_without_ME) → INDIFFERENCE

Hype Without Truth (HO_without_TR) → DISTRUST

Virality Without Stabilizers (VI_without_ST) → COLLAPSE

🧭 What a player needs to know right now (v0)

Solve the bottles. That’s the core.

Read the legend. It’s not flavor—elements teach/punish behaviors.

DM shows up sometimes. Major DM visits can change the next level.

Don’t worry about “illegal reactions” yet. You’ll be warned before the game starts enforcing advanced consequences.
