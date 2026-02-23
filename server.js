const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── System Prompt v0.9 — Back to v1 spirit, clean and direct ─────────
const SYS_PROMPT = `You are ClearSignals AI. The user pasted a raw email with a quoted thread history at the bottom (like a forwarded email).

STEP 1: Parse the email into individual messages. Identify each message by looking for patterns like "On [date], [person] wrote:", "From:", "Sent:", reply quote markers (> or |), or separator lines (----, ____). Extract: sender, date (if visible), and body for each message. Order them OLDEST first (bottom of thread = earliest).

STEP 2: Analyze the full thread and return this JSON:

{
  "contact_name": "primary prospect name",
  "company_name": "prospect company",
  "rep_name": "primary sales rep or team",
  "parsed_emails": [
    {"index":1,"from":"sender","date":"date if found","snippet":"first 80 chars","direction":"inbound|outbound"}
  ],
  "per_email": [
    {
      "email_num":1,
      "intent":2,
      "win_pct":10,
      "signals":[{"type":"intent|cultural|competitive|formality|drift","desc":"what this signal means","severity":"red|yellow|green","quote":"exact short quote"}],
      "summary":"What is this person really saying? What does this email mean for the deal?",
      "coaching":{"good":"what rep did well or should notice","better":"what rep could improve or risk they might miss"},
      "next_time":"If pivotal: what should rep have done differently here? null if not pivotal."
    }
  ],
  "final": {
    "signals":[{"type":"type","desc":"description","severity":"red|yellow|green","quote":"quote"}],
    "ryg":{"r":0,"y":0,"g":0},
    "intent":5,
    "win_pct":50,
    "coach":"specific actionable coaching summary",
    "summary":"2-3 sentences on deal status",
    "next_steps":"what should the rep do RIGHT NOW",
    "deal_stage":"prospecting|qualification|demo|proposal|negotiation|closed_won|closed_lost|no_decision"
  }
}

RULES:
- parsed_emails: ONE entry per email found. Count carefully. Do not skip any.
- per_email: ONE entry per email. Each gets progressive intent (1-10) and win_pct (0-100) that tell the STORY of the deal — rising, falling, shifting.
- per_email signals: At least one per email. Types: intent, cultural, competitive, formality, drift.
- per_email coaching: For EVERY email. Outbound: what rep did well / could improve. Inbound: what rep should notice / risk they might miss.
- per_email next_time: Only on pivotal emails where the rep could have changed the outcome. null otherwise.
- per_email summary: Explain what the person is REALLY saying, not just restate the email.
- final: Overall assessment after reading everything.
- If you can identify who is the rep vs prospect, mark direction. If unclear, best guess.

IMPORTANT: If the thread is long, prioritize completeness. Return ALL emails even if analysis must be briefer per email. Do NOT truncate the last emails — the deal outcome matters most.

METRICS:
- INTENT (1-10): 1=no interest, 3=aware, 5=evaluating, 7=shortlisted, 9=verbal commit, 10=signed
- WIN% (0-100): Must move meaningfully between emails

CULTURAL RULES: Japan(silence=contemplation, "consider"=no), Vietnam(relationship-first), Germany(Sie/du), Brazil/Mexico(casual=default, formality=warning), UK("not bad"=praise, "interesting"=dismissal), China(face-saving), Korea(hierarchy), Sweden(lagom), India("yes but"=no)

Return ONLY valid JSON. No markdown fences. No explanation.`;

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
        max_tokens: 16000,
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

    // Validate: warn if per_email count doesn't match parsed_emails
    const emailCount = (parsed.parsed_emails || []).length;
    const perCount = (parsed.per_email || []).length;
    const complete = emailCount === perCount;

    // Log for debugging
    console.log(`[ANALYZE] Model: ${modelId} | Emails parsed: ${emailCount} | Per-email entries: ${perCount} | Complete: ${complete} | Raw length: ${raw.length}`);
    if (!complete) {
      console.log(`[WARNING] Model skipped emails! parsed_emails has ${emailCount}, per_email has ${perCount}`);
      console.log(`[WARNING] parsed_emails indices: ${(parsed.parsed_emails||[]).map(e=>e.index).join(',')}`);
      console.log(`[WARNING] per_email nums: ${(parsed.per_email||[]).map(e=>e.email_num).join(',')}`);
    }

    res.json({ result: parsed, model: modelId, raw_length: raw.length, email_count: emailCount, analysis_count: perCount, complete });

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
  res.json({ status: 'ok', version: '0.9.0', hasKey: !!process.env.OPENROUTER_API_KEY });
});

app.listen(PORT, () => console.log('ClearSignals AI v0.9.0 on port ' + PORT));
