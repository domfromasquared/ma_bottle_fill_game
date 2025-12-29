import express from "express";

const router = express.Router();

/**
 * Lightweight safety: block obvious hate/harassment inputs.
 * You can expand this list over time.
 */
function isDisallowedName(raw) {
  const s = String(raw || "").toLowerCase().trim();

  // hard blocks (examples)
  const banned = [
    "hitler", "nazi", "kkk",
    // add slurs here privately if needed
  ];

  if (!s) return true;
  if (s.length > 14) return true;
  if (banned.some(b => s.includes(b))) return true;

  return false;
}

/**
 * Provide a deterministic fallback reference set if LLM fails.
 * Use “reference-y” lines without hate/harassment.
 */
function fallbackRoast(name) {
  const n = String(name || "").trim();
  const lines = [
    `“${n}”? That name enters the room like it’s about to pitch a mastermind with no slides.`,
    `“${n}”… bold. It has “main character energy” and “supporting character execution.”`,
    `“${n}”? That’s a name that sounds expensive… and under-tested.`,
    `“${n}”… okay. You better pour like you mean it.`,
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

/**
 * Optional: a tiny “name → domain” hint map.
 * This helps the model pick the right lane (sports/politics/anime/etc.)
 */
function domainHint(name) {
  const s = String(name || "").toLowerCase();
  const hints = [
    { k: "lebron", hint: "basketball, NBA, clutch, legacy" },
    { k: "obama", hint: "politics, president, speeches, campaigns" },
    { k: "goku", hint: "anime, Dragon Ball, training arcs, power-ups" },
    { k: "batman", hint: "comics, Gotham, brooding hero, prep time" },
    { k: "taylor", hint: "pop star, stadium tour, eras, fandom" },
  ];
  const found = hints.find(h => s.includes(h.k));
  return found?.hint || "";
}

/**
 * LLM call (OpenAI example). If you use a different model/provider,
 * swap out the client and return a string.
 */
async function generateRoastLLM({ name, hint }) {
  // Use YOUR env var name; example:
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  // Minimal OpenAI fetch (no SDK required)
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.95,
      messages: [
        {
          role: "system",
          content:
`You are "The Marketing Alchemist" (MA): pompous, cheeky, clean roast humor (no profanity).
Task: Produce ONE short line (max 25 words) reacting to the player’s chosen name.
Requirements:
- Must reference real culture if relevant (sports/politics/characters/events) WITHOUT hateful content.
- Roast the *choice* of name, not protected traits.
- If the name matches a public figure, keep it playful and non-defamatory.
- No slurs, no harassment, no sexual content, no calls for harm.
- Output ONLY the line, no quotes.`
        },
        {
          role: "user",
          content:
`Player chose name: "${name}"
Hint (optional): ${hint || "none"}
Write the MA’s one-liner.`
        }
      ]
    })
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`LLM error ${resp.status}: ${t}`);
  }

  const json = await resp.json();
  const line = json?.choices?.[0]?.message?.content?.trim();
  if (!line) throw new Error("No LLM content");
  return line;
}

router.post("/name-roast", async (req, res) => {
  try {
    const name = String(req.body?.candidateName || "").trim();

    if (isDisallowedName(name)) {
      return res.json({
        payload: {
          roast: `That name is not permitted in my protocol. Choose again.`,
          blocked: true
        }
      });
    }

    const hint = domainHint(name);

    // Try LLM → fallback
    let roast = "";
    try {
      roast = await generateRoastLLM({ name, hint });
    } catch {
      roast = fallbackRoast(name);
    }

    res.json({ payload: { roast, blocked: false } });
  } catch (err) {
    res.status(500).json({
      error: "name_roast_failed",
      detail: String(err?.message || err)
    });
  }
});

export default router;
