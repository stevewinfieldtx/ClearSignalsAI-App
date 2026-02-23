const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── System Prompt — EXACT v3 prompt that worked ─────────────────────
const SYS_PROMPT = `You are ClearSignals AI. The user pasted a raw email with a quoted thread history at the bottom (like a forwarded email).

STEP 1: Parse the email into individual messages. Identify each message by looking for patterns like "On [date], [person] wrote:", "From:", "Sent:", reply quote markers (> or |), or separator lines (----, ____). Extract: sender, date (if visible), and body for each message. Order them OLDEST first (bottom of thread = earliest).

STEP 2: Analyze the full thread and return this JSON:

{
  "parsed_emails": [
    {"index":1,"from":"sender","date":"date if found","snippet":"first 80 chars","direction":"inbound|outbound"}
  ],
  "per_email": [
    {"email_num":1,"intent":0,"win_pct":0,"signals":[{"type":"type","desc":"desc","severity":"sev","quote":"q"}],"summary":"one sentence","coaching":{"good":"what rep did well or null","better":"what rep could improve or null"}}
  ],
  "final": {
    "signals":[{"type":"type","desc":"description","severity":"red|yellow|green","quote":"quote"}],
    "ryg":{"r":0,"y":0,"g":0},
    "intent":5,
    "win_pct":50,
    "coach":"specific actionable advice for the rep right now",
    "summary":"2-3 sentences on where this deal stands",
    "next_steps":"what should the rep do next based on the signals",
    "deal_stage":"prospecting|qualification|demo|proposal|negotiation|closed_won|closed_lost|no_decision",
    "next_time":[
      {"at_email":3,"suggestion":"What the rep could have done differently at this specific point","why":"Why this would have mattered"}
    ]
  }
}

CRITICAL RULES:
- parsed_emails: Extract EVERY message. You MUST return one entry per email found. Do NOT skip any.
- per_email: You MUST return one entry for EVERY email. Each gets intent, win_pct (progressive/running scores), signals, and a summary sentence. Do NOT skip any emails.
- per_email signals: Find at least one signal per email. Types: intent, cultural, competitive, formality, drift. Every email has something worth noting.
- per_email coaching: For OUTBOUND emails (from the rep/seller), ALWAYS include coaching with "good" and/or "better". For inbound, coaching can be null.
- final signals: Comprehensive list of ALL significant signals across the thread.
- final ryg: Total counts across entire thread.
- next_time: 1-3 specific moments where the rep could have taken a different action for a better outcome. Reference the email number. If the rep handled everything well, return a single entry with suggestion "Well played" and why explaining what they did right. Be specific and actionable — not generic advice.
- direction: If you can identify which messages are from the sales rep vs the contact, mark direction. If unclear, make your best guess based on context.

METRICS:
1. BUYER INTENT (1-10): 1=no interest, 3=aware, 5=evaluating, 7=shortlisted, 9=verbal commit, 10=signed
2. WIN LIKELIHOOD (0-100%): Probability this deal closes. Must change meaningfully between emails.
3. CULTURAL ALIGNMENT (RYG cumulative):
   - RED: Cultural violations, competitive threats, trust damage
   - YELLOW: Caution signals, ambiguous indicators
   - GREEN: Trust builders, positive cultural signals

CULTURAL RULES:
- Japan: silence=contemplation, "we will consider"=no, formal=neutral, rushing=violation
- Vietnam: relationship-first, warmth withdrawal=major warning
- Germany: Sie/du=trust milestone, du to Sie=trust BROKEN
- Brazil/Mexico: casual=DEFAULT, formality increase=WARNING
- UK: "not bad"=praise, "interesting" alone=dismissal
- China: face-saving paramount, direct blame=catastrophic
- Korea: hierarchy/consensus required
- Sweden: lagom, hard sell=disengage
- India: "yes but perhaps"=indirect no

Return ONLY valid JSON. No markdown fences. No explanation outside JSON.`;

// ── Available models ─────────────────────────────────────────────────
const MODELS = {
  'haiku': 'anthropic/claude-3.5-haiku',
  'sonnet': 'anthropic/claude-sonnet-4',
  'flash-lite': 'google/gemini-2.5-flash-lite',
  'flash': 'google/gemini-2.5-flash',
  'pro': 'google/gemini-2.5-pro'
};

// ── Analyze endpoint ─────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { text, model } = req.body;
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'Server missing OPENROUTER_API_KEY' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'No email text provided' });

  const modelId = MODELS[model] || MODELS['sonnet'];

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://clearsignals.ai',
        'X-Title': 'ClearSignals AI'
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 8000,
        messages: [
          { role: 'system', content: SYS_PROMPT },
          { role: 'user', content: 'Analyze this pasted email thread:\n\n' + text }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'OpenRouter: ' + errText.slice(0, 300) });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';

    if (!raw) return res.status(502).json({ error: 'Empty response from model' });

    const parsed = cleanJSON(raw);
    res.json({ result: parsed, model: modelId, raw_length: raw.length });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── JSON cleaner ─────────────────────────────────────────────────────
function cleanJSON(raw) {
  let s = (raw || '').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  const f = s.indexOf('{');
  const l = s.lastIndexOf('}');
  if (f < 0 || l < 0) throw new Error('No JSON in response');
  s = s.slice(f, l + 1);
  try { return JSON.parse(s); } catch(e) {
    let fix = s.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(fix); } catch(e2) {
      fix = fix.replace(/(?<=":[ ]*"[^"]*)\n/g, '\\n');
      try { return JSON.parse(fix); } catch(e3) {
        throw new Error('JSON parse failed');
      }
    }
  }
}

// ── Health check ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '0.8.1', hasKey: !!process.env.OPENROUTER_API_KEY });
});

app.listen(PORT, () => console.log('ClearSignals AI v0.8.1 on port ' + PORT));
