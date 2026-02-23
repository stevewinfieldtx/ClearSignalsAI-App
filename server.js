const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── System Prompt (from v3 — the good one) ──────────────────────────
const SYS_PROMPT = `You are ClearSignals AI. The user pasted a raw email with a quoted thread history (like a forwarded email).

STEP 1: Parse the email into individual messages. Identify each message by looking for patterns like "On [date], [person] wrote:", "From:", "Sent:", reply quote markers (> or |), or separator lines (----, ____). Extract: sender, date (if visible), and body for each message. Order them OLDEST first (bottom of thread = earliest).

STEP 2: For EVERY outbound email (from the rep/seller), provide coaching:
- "good": what the rep did well (or null)
- "better": what the rep could improve (or null)
Inbound emails can have null coaching.

STEP 3: Analyze the full thread and return this JSON:

{
  "parsed_emails": [
    {"index":1,"from":"sender","date":"date if found","snippet":"first 80 chars","direction":"inbound|outbound"}
  ],
  "per_email": [
    {"email_num":1,"intent":0,"win_pct":0,"signals":[{"type":"type","desc":"desc","severity":"sev","quote":"q"}],"summary":"one sentence about what this email means for the deal","coaching":{"good":"what rep did well or null","better":"what rep could improve or null"}}
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
      {"at_email":3,"suggestion":"What the rep could have done differently","why":"Why this would have mattered"}
    ]
  }
}

METRICS:
1. BUYER INTENT (1-10): 1=no interest, 3=aware, 5=evaluating, 7=shortlisted, 9=verbal commit, 10=signed
2. WIN LIKELIHOOD (0-100%): Probability this deal closes
3. CULTURAL ALIGNMENT (RYG cumulative):
   - RED: Cultural violations, competitive threats, trust damage
   - YELLOW: Caution signals, ambiguous indicators
   - GREEN: Trust builders, positive cultural signals

DETECT: intent signals, cultural signals, competitive signals, formality shifts, relationship drift.

CULTURAL RULES:
- Japan: silence=contemplation, "we will consider"=no, formal=neutral, rushing=violation
- Vietnam: relationship-first, warmth withdrawal=major warning
- Germany: Sie/du=trust milestone, du→Sie=trust BROKEN
- Brazil/Mexico: casual=DEFAULT, formality increase=WARNING
- UK: "not bad"=praise, "interesting" alone=dismissal
- China: face-saving paramount, direct blame=catastrophic
- Korea: hierarchy/consensus required
- Sweden: lagom, hard sell=disengage
- India: "yes but perhaps"=indirect no

parsed_emails = the messages you extracted, oldest first.
per_email = progressive analysis at each email with running intent/win_pct scores. EVERY email gets signals and summary. Outbound emails ALWAYS get coaching.
final = the overall assessment after reading everything.
next_time = 1-3 specific moments where the rep could have taken a different action. If the rep handled everything well, return suggestion "Well played".

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

  const modelId = MODELS[model] || MODELS['haiku'];

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
        max_tokens: 4000,
        messages: [
          { role: 'system', content: SYS_PROMPT },
          { role: 'user', content: text }
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

    // Parse JSON from LLM response
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
    try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch(e2) {
      // Try fixing unescaped newlines in strings
      let fix = s.replace(/(?<=":[ ]*"[^"]*)\n/g, '\\n');
      try { return JSON.parse(fix); } catch(e3) {
        throw new Error('JSON parse failed');
      }
    }
  }
}

// ── Health check ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '0.8.0', hasKey: !!process.env.OPENROUTER_API_KEY });
});

app.listen(PORT, () => console.log('ClearSignals AI v0.8.0 on port ' + PORT));
