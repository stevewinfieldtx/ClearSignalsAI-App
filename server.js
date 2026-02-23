const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── STAGE 1 PROMPT: Cheap/fast preprocessor ──────────────────────────
const STAGE1_PROMPT = `You are an email thread preprocessor. Your ONLY job is to parse a raw pasted email into clean individual messages.

PARSE the email thread by finding patterns like "On [date], [person] wrote:", "From:", "Sent:", reply quote markers (> or |), separator lines (----, ____).

For EACH message, extract:
- from: sender name
- date: date/time if found
- direction: "inbound" or "outbound" (guess based on context — who is selling vs buying)
- body: the ACTUAL message body only

STRIP from each body:
- Email signatures (name, title, phone, address blocks)
- Legal disclaimers / confidentiality notices
- "Sent from my iPhone" type footers
- Repeated quoted text from previous replies
- Image placeholders, tracking pixels, HTML artifacts

Order messages OLDEST FIRST (bottom of thread = earliest).

Return ONLY this JSON:
{
  "contact_name": "primary prospect/buyer name",
  "company_name": "prospect company",
  "rep_name": "primary sales rep or team",
  "emails": [
    {"index":1,"from":"sender name","date":"date string","direction":"inbound|outbound","body":"cleaned message body"}
  ]
}

Return ONLY valid JSON. No markdown fences.`;

// ── STAGE 2 PROMPT: Deep analysis on clean data ──────────────────────
const STAGE2_PROMPT = `You are ClearSignals AI, an elite sales intelligence engine. You receive a PRE-PARSED email thread with clean message bodies. Analyze every single email.

For EACH email provide:
- What the sender is REALLY saying (intent behind the words)
- Running intent score and win probability at that point in the thread
- Signals detected in THIS specific email
- Coaching: For outbound (rep) emails — what they did well / could improve. For inbound (prospect) emails — what the rep should notice / risk they might miss.
- next_time: If this is a pivotal moment where the rep could have changed the outcome, say what they should have done differently. null if not pivotal.

Return ONLY this JSON:
{
  "per_email": [
    {
      "email_num":1,
      "intent":2,
      "win_pct":10,
      "signals":[{"type":"intent|cultural|competitive|formality|drift","desc":"what this signal means","severity":"red|yellow|green","quote":"short quote from email"}],
      "summary":"What is this person really saying? What does this email mean for the deal?",
      "coaching":{"good":"what rep did well or should notice","better":"what rep could improve or risk they might miss"},
      "next_time":"what should rep have done differently here, or null"
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
- per_email: ONE entry per email. Do NOT skip any. You will receive N emails, return N per_email entries.
- intent (1-10): 1=no interest, 3=aware, 5=evaluating, 7=shortlisted, 9=verbal commit, 10=signed
- win_pct (0-100): Must change meaningfully between emails — tell the STORY of the deal
- signals: At least one per email. Types: intent, cultural, competitive, formality, drift
- coaching: On EVERY email. Outbound: good/better for rep. Inbound: what rep should notice/risk.
- summary: Explain what the person REALLY means, don't just restate.
- next_time: Only on pivotal moments. null otherwise.

CULTURAL RULES: Japan(silence=contemplation, "consider"=no), Vietnam(relationship-first), Germany(Sie/du), Brazil/Mexico(casual=default, formality=warning), UK("not bad"=praise, "interesting"=dismissal), China(face-saving), Korea(hierarchy), Sweden(lagom), India("yes but"=no)

Return ONLY valid JSON. No markdown fences.`;

// ── Available models ─────────────────────────────────────────────────
const MODELS = {
  'haiku': 'anthropic/claude-3.5-haiku',
  'sonnet': 'anthropic/claude-sonnet-4',
  'flash-lite': 'google/gemini-2.5-flash-lite',
  'flash': 'google/gemini-2.5-flash',
  'pro': 'google/gemini-2.5-pro'
};

// ── OpenRouter API call helper ───────────────────────────────────────
async function callLLM(modelId, systemPrompt, userMessage, maxTokens) {
  const apiKey = process.env.OPENROUTER_API_KEY;
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
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('OpenRouter ' + response.status + ': ' + errText.slice(0, 300));
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || '';
  if (!raw) throw new Error('Empty response from model');
  return { raw, parsed: cleanJSON(raw) };
}

// ── Analyze endpoint — two-stage pipeline ────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { text, model } = req.body;
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'Server missing OPENROUTER_API_KEY' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'No email text provided' });

  const analysisModel = MODELS[model] || MODELS['sonnet'];
  const preprocessModel = MODELS['flash-lite']; // Always cheap/fast for stage 1

  try {
    // ── STAGE 1: Preprocess with cheap model ─────────────────────────
    const t1 = Date.now();
    const stage1 = await callLLM(preprocessModel, STAGE1_PROMPT, text, 8000);
    const s1 = stage1.parsed;
    const t1ms = Date.now() - t1;

    const emailCount = (s1.emails || []).length;
    console.log(`[STAGE 1] ${preprocessModel} | ${emailCount} emails parsed | ${t1ms}ms | ${stage1.raw.length} chars`);

    if (!emailCount) {
      return res.status(400).json({ error: 'Stage 1 failed to parse any emails from the thread' });
    }

    // Build clean input for stage 2
    const cleanThread = (s1.emails || []).map(function(em) {
      return 'EMAIL ' + em.index + ' of ' + emailCount + ':\n' +
        'Direction: ' + em.direction + ' | From: ' + em.from + ' | Date: ' + (em.date || 'unknown') + '\n' +
        em.body;
    }).join('\n\n---\n\n');

    // ── STAGE 2: Deep analysis with smart model ──────────────────────
    const t2 = Date.now();
    const stage2 = await callLLM(analysisModel, STAGE2_PROMPT,
      'Analyze this ' + emailCount + '-email thread. Return exactly ' + emailCount + ' per_email entries:\n\n' + cleanThread,
      16000);
    const s2 = stage2.parsed;
    const t2ms = Date.now() - t2;

    const perCount = (s2.per_email || []).length;
    console.log(`[STAGE 2] ${analysisModel} | ${perCount} per_email entries | ${t2ms}ms | ${stage2.raw.length} chars`);

    if (emailCount !== perCount) {
      console.log(`[WARNING] Mismatch! ${emailCount} emails but ${perCount} analyses`);
    }

    // ── Merge stage 1 + stage 2 into final response ──────────────────
    const result = {
      contact_name: s1.contact_name || '',
      company_name: s1.company_name || '',
      rep_name: s1.rep_name || '',
      parsed_emails: (s1.emails || []).map(function(em) {
        return {
          index: em.index,
          from: em.from,
          date: em.date,
          snippet: (em.body || '').substring(0, 80),
          direction: em.direction
        };
      }),
      per_email: s2.per_email || [],
      final: s2.final || {}
    };

    res.json({
      result: result,
      model: analysisModel,
      preprocess_model: preprocessModel,
      stage1_ms: t1ms,
      stage2_ms: t2ms,
      total_ms: t1ms + t2ms,
      email_count: emailCount,
      analysis_count: perCount,
      complete: emailCount === perCount
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
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
  res.json({ status: 'ok', version: '1.0.0', hasKey: !!process.env.OPENROUTER_API_KEY });
});

app.listen(PORT, () => console.log('ClearSignals AI v1.0.0 on port ' + PORT));
