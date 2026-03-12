const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// == Pinecone vector memory ==
const pinecone = require('./pinecone');

// Init Pinecone indexes on startup (non-blocking)
if (process.env.PINECONE_API_KEY) {
  pinecone.initIndexes()
    .then(() => console.log('[Pinecone] Indexes ready'))
    .catch(e => console.error('[Pinecone] Init error:', e.message));
} else {
  console.log('[Pinecone] PINECONE_API_KEY not set — vector memory disabled');
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// == STAGE 1 PROMPT: Cheap/fast preprocessor (same for both modes) ==
const STAGE1_PROMPT = `You are an email thread preprocessor. Your ONLY job is to parse a raw pasted email into clean individual messages.

PARSE the email thread by finding patterns like "On [date], [person] wrote:", "From:", "Sent:", reply quote markers (> or |), separator lines (----, ____).

For EACH message, extract:
- from: sender name
- date: date/time if found
- direction: "inbound" or "outbound" (guess based on context - who is selling vs buying)
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

Return ONLY valid JSON. No markdown fences. No explanation.`;

// == STAGE 2 PROMPT: POSTMORTEM MODE (grading what happened) ==
const STAGE2_POSTMORTEM_PROMPT = `You are ClearSignals AI, an elite sales intelligence engine running in POSTMORTEM MODE. This thread is COMPLETE — the deal is over. Your job is to tell the story of what happened and identify where things went right or wrong.

You receive a PRE-PARSED email thread with clean message bodies. Analyze every single email.

For EACH email provide:
- What the sender is REALLY saying (intent behind the words)
- Running intent score and win probability at that point in the thread
- Signals detected in THIS specific email
- Coaching: For outbound (rep) emails - what they did well / could improve. For inbound (prospect) emails - what the rep should notice / risk they might miss.
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
    "coach":"specific actionable coaching summary — what were the KEY mistakes or wins across this entire thread?",
    "summary":"2-3 sentences on what happened in this deal and why it ended the way it did",
    "next_steps":"what lessons should the rep carry forward to future deals",
    "deal_stage":"prospecting|qualification|demo|proposal|negotiation|closed_won|closed_lost|no_decision"
  }
}

RULES:
- per_email: ONE entry per email. Do NOT skip any. You will receive N emails, return N per_email entries.
- intent (1-10): 1=no interest, 3=aware, 5=evaluating, 7=shortlisted, 9=verbal commit, 10=signed
- win_pct (0-100): Must change meaningfully between emails - tell the STORY of the deal
- signals: At least one per email. Types: intent, cultural, competitive, formality, drift
- coaching: On EVERY email. Outbound: good/better for rep. Inbound: what rep should notice/risk.
- summary: Explain what the person REALLY means, don't just restate.
- next_time: Only on pivotal moments. null otherwise.
- POSTMORTEM FOCUS: You are analyzing a completed thread. Be direct about what went wrong and what went right. Identify the exact turning points. The goal is learning, not diplomacy.

CULTURAL RULES: Japan(silence=contemplation, "consider"=no), Vietnam(relationship-first), Germany(Sie/du), Brazil/Mexico(casual=default, formality=warning), UK("not bad"=praise, "interesting"=dismissal), China(face-saving), Korea(hierarchy), Sweden(lagom), India("yes but"=no)

Return ONLY valid JSON. No markdown fences. No explanation.`;

// == STAGE 2 PROMPT: COACHING MODE (forward-looking guidance) ==
const STAGE2_COACHING_PROMPT = `You are ClearSignals AI, an elite sales intelligence engine running in COACHING MODE. This thread is STILL IN PROGRESS — the deal is live. Your job is to analyze what has happened so far and provide actionable forward-looking guidance for the rep's next move.

You receive a PRE-PARSED email thread with clean message bodies. Analyze every single email to understand the full trajectory, then focus your guidance on WHAT TO DO NEXT.

TRAJECTORY ANALYSIS — examine the full arc for:
- Response time patterns: Are they speeding up (engagement) or slowing down (fading interest)?
- Tone shifts: Has the buyer's language changed from warm to cold, formal to terse, detailed to brief?
- Unresolved items: What questions or requests were raised and NEVER answered?
- Stakeholder mentions: Were new people named who haven't been engaged?
- Competitive signals: Any hints of alternative evaluations ("looking at options", "other vendors", timeline pressure)?
- Power dynamics: Who is driving the conversation? Has control shifted?
- Commitment level: Is the buyer giving specifics (budget, timeline, stakeholders) or staying vague?

For EACH email provide:
- What the sender is REALLY saying (intent behind the words)
- Running intent score and win probability at that point
- Signals detected in THIS specific email
- Coaching: What the rep should notice about this email — especially cues that might be easy to miss

Return ONLY this JSON:
{
  "per_email": [
    {
      "email_num":1,
      "intent":2,
      "win_pct":10,
      "signals":[{"type":"intent|cultural|competitive|formality|drift|timing","desc":"what this signal means","severity":"red|yellow|green","quote":"short quote from email"}],
      "summary":"What is this person really saying? What does this email mean for the deal?",
      "coaching":{"good":"what's going well or what the rep should notice","better":"what the rep might be missing or should watch for"}
    }
  ],
  "final": {
    "signals":[{"type":"type","desc":"description","severity":"red|yellow|green","quote":"quote"}],
    "ryg":{"r":0,"y":0,"g":0},
    "intent":5,
    "win_pct":50,
    "deal_health":"healthy|at_risk|critical|lost_momentum",
    "trajectory":"improving|stable|declining|stalled",
    "unresolved_items":["list of specific questions/requests from the buyer that were never addressed"],
    "unengaged_stakeholders":["names of people mentioned but never directly engaged"],
    "response_time_trend":"description of how response times have changed across the thread",
    "competitor_risk":"none|low|medium|high — with brief explanation",
    "coach":"What is the SINGLE MOST IMPORTANT thing the rep needs to do right now?",
    "recommended_actions":[
      {"priority":1,"action":"specific action to take","reasoning":"why this matters right now"},
      {"priority":2,"action":"specific action to take","reasoning":"why this matters"},
      {"priority":3,"action":"specific action to take","reasoning":"why this matters"}
    ],
    "tone_guidance":"How should the rep's next email sound? Match the buyer's style — specify formality level, length, and approach.",
    "timing_guidance":"How quickly should the rep respond? Based on the thread's response patterns and current urgency.",
    "summary":"2-3 sentences on where this deal stands RIGHT NOW and what trajectory it's on",
    "deal_stage":"prospecting|qualification|demo|proposal|negotiation|closed_won|closed_lost|no_decision"
  }
}

RULES:
- per_email: ONE entry per email. Do NOT skip any. You will receive N emails, return N per_email entries.
- intent (1-10): 1=no interest, 3=aware, 5=evaluating, 7=shortlisted, 9=verbal commit, 10=signed
- win_pct (0-100): Must change meaningfully between emails - tell the STORY of the deal so far
- signals: At least one per email. Types: intent, cultural, competitive, formality, drift, timing
- COACHING FOCUS: Every piece of analysis should serve the question "What should the rep do NEXT?" Be specific and actionable. Don't just identify problems — tell them exactly how to fix it in their next email.
- recommended_actions: Give 2-4 specific, prioritized actions. Not generic advice. Reference specific things from THIS thread.
- unresolved_items: Be exhaustive. Scan every inbound email for questions or requests that never got answered.
- tone_guidance: Be specific. "Match his formal style" is too vague. "Use structured numbered responses to match his organized communication style, avoid casual language like 'hey' or exclamation points" is good.

CULTURAL RULES: Japan(silence=contemplation, "consider"=no), Vietnam(relationship-first), Germany(Sie/du), Brazil/Mexico(casual=default, formality=warning), UK("not bad"=praise, "interesting"=dismissal), China(face-saving), Korea(hierarchy), Sweden(lagom), India("yes but"=no)

Return ONLY valid JSON. No markdown fences. No explanation.`;

// == SINGLE-CALL FALLBACK PROMPT - POSTMORTEM ==
const FALLBACK_POSTMORTEM_PROMPT = `You are ClearSignals AI running in POSTMORTEM MODE. The user pasted a raw email with a quoted thread history. This thread is COMPLETE.

STEP 1: Parse the email into individual messages. Identify each message by looking for patterns like "On [date], [person] wrote:", "From:", "Sent:", reply quote markers (> or |), or separator lines (----, ____). Extract: sender, date (if visible), and body for each message. Order them OLDEST first.

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
      "summary":"What is this person really saying?",
      "coaching":{"good":"what rep did well or should notice","better":"what rep could improve or risk they might miss"},
      "next_time":"If pivotal: what should rep have done differently? null if not pivotal."
    }
  ],
  "final": {
    "signals":[{"type":"type","desc":"description","severity":"red|yellow|green","quote":"quote"}],
    "ryg":{"r":0,"y":0,"g":0},
    "intent":5,
    "win_pct":50,
    "coach":"specific actionable coaching summary",
    "summary":"2-3 sentences on what happened and why",
    "next_steps":"what lessons to carry forward",
    "deal_stage":"prospecting|qualification|demo|proposal|negotiation|closed_won|closed_lost|no_decision"
  }
}

RULES:
- parsed_emails: ONE entry per email found. Do not skip any.
- per_email: ONE entry per email with progressive intent and win_pct.
- signals: At least one per email.
- coaching: On EVERY email.
- next_time: Only on pivotal moments. null otherwise.
- INTENT (1-10): 1=no interest, 3=aware, 5=evaluating, 7=shortlisted, 9=verbal commit, 10=signed
- WIN% (0-100): Must move meaningfully between emails

CULTURAL RULES: Japan(silence=contemplation, "consider"=no), Vietnam(relationship-first), Germany(Sie/du), Brazil/Mexico(casual=default, formality=warning), UK("not bad"=praise, "interesting"=dismissal), China(face-saving), Korea(hierarchy), Sweden(lagom), India("yes but"=no)

Return ONLY valid JSON. No markdown fences. No explanation.`;

// == SINGLE-CALL FALLBACK PROMPT - COACHING ==
const FALLBACK_COACHING_PROMPT = `You are ClearSignals AI running in COACHING MODE. The user pasted a raw email thread. This thread is STILL IN PROGRESS — the deal is live.

STEP 1: Parse the email into individual messages. Order them OLDEST first.

STEP 2: Analyze the trajectory and return forward-looking guidance:

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
      "signals":[{"type":"intent|cultural|competitive|formality|drift|timing","desc":"what this signal means","severity":"red|yellow|green","quote":"exact short quote"}],
      "summary":"What is this person really saying?",
      "coaching":{"good":"what's going well","better":"what might be missed"}
    }
  ],
  "final": {
    "signals":[{"type":"type","desc":"description","severity":"red|yellow|green","quote":"quote"}],
    "ryg":{"r":0,"y":0,"g":0},
    "intent":5,
    "win_pct":50,
    "deal_health":"healthy|at_risk|critical|lost_momentum",
    "trajectory":"improving|stable|declining|stalled",
    "unresolved_items":["buyer questions/requests never addressed"],
    "unengaged_stakeholders":["people mentioned but not engaged"],
    "response_time_trend":"how response times have changed",
    "competitor_risk":"none|low|medium|high — with explanation",
    "coach":"SINGLE MOST IMPORTANT thing to do right now",
    "recommended_actions":[
      {"priority":1,"action":"specific action","reasoning":"why it matters now"},
      {"priority":2,"action":"specific action","reasoning":"why it matters"},
      {"priority":3,"action":"specific action","reasoning":"why it matters"}
    ],
    "tone_guidance":"how the next email should sound",
    "timing_guidance":"how quickly to respond",
    "summary":"2-3 sentences on where this deal stands RIGHT NOW",
    "deal_stage":"prospecting|qualification|demo|proposal|negotiation|closed_won|closed_lost|no_decision"
  }
}

RULES:
- parsed_emails: ONE entry per email found. Do not skip any.
- per_email: ONE entry per email with progressive intent and win_pct.
- signals: At least one per email.
- coaching: On EVERY email.
- COACHING FOCUS: Everything serves "What should the rep do NEXT?"
- recommended_actions: 2-4 specific prioritized actions referencing THIS thread.
- unresolved_items: Scan every inbound email for unanswered questions.
- INTENT (1-10): 1=no interest, 3=aware, 5=evaluating, 7=shortlisted, 9=verbal commit, 10=signed
- WIN% (0-100): Must move meaningfully between emails

CULTURAL RULES: Japan(silence=contemplation, "consider"=no), Vietnam(relationship-first), Germany(Sie/du), Brazil/Mexico(casual=default, formality=warning), UK("not bad"=praise, "interesting"=dismissal), China(face-saving), Korea(hierarchy), Sweden(lagom), India("yes but"=no)

Return ONLY valid JSON. No markdown fences. No explanation.`;

// == Available models ==
const MODELS = {
  'haiku': 'anthropic/claude-3.5-haiku',
  'sonnet': 'anthropic/claude-sonnet-4',
  'flash-lite': 'google/gemini-2.5-flash-lite',
  'flash': 'google/gemini-2.5-flash',
  'pro': 'google/gemini-2.5-pro'
};

// == OpenRouter API call helper ==
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

// == JSON cleaner (aggressive) ==
function cleanJSON(raw) {
  var s = (raw || '');
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  var f = s.indexOf('{');
  var l = s.lastIndexOf('}');
  if (f < 0 || l < 0) throw new Error('No JSON object found in response');
  s = s.slice(f, l + 1);

  try { return JSON.parse(s); } catch(e) {}

  var fix = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(fix); } catch(e) {}

  fix = fix.replace(/[\x00-\x1f]/g, function(c) {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return '';
  });
  try { return JSON.parse(fix); } catch(e) {}

  var depth = 0, start = -1, end = -1;
  for (var i = 0; i < raw.length; i++) {
    if (raw[i] === '{') { if (depth === 0) start = i; depth++; }
    if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (start >= 0 && end > start) {
    var ex = raw.slice(start, end + 1);
    ex = ex.replace(/,\s*([}\]])/g, '$1');
    ex = ex.replace(/[\x00-\x1f]/g, function(c) {
      if (c === '\n') return '\\n'; if (c === '\r') return '\\r'; if (c === '\t') return '\\t'; return '';
    });
    try { return JSON.parse(ex); } catch(e) {}
  }

  throw new Error('JSON parse failed. First 300: ' + s.slice(0, 300));
}

// == Analyze endpoint - two-stage with fallback, supports coaching + postmortem ==
app.post('/api/analyze', async function(req, res) {
  var text = req.body.text;
  var model = req.body.model;
  var mode = req.body.mode || 'coaching';
  var apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'Server missing OPENROUTER_API_KEY' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'No email text provided' });

  var stage2Prompt = mode === 'postmortem' ? STAGE2_POSTMORTEM_PROMPT : STAGE2_COACHING_PROMPT;
  var fallbackPrompt = mode === 'postmortem' ? FALLBACK_POSTMORTEM_PROMPT : FALLBACK_COACHING_PROMPT;

  var analysisModel = MODELS[model] || MODELS['sonnet'];
  var preprocessModel = MODELS['flash-lite'];

  console.log('[ANALYZE] Mode: ' + mode + ' | Model: ' + analysisModel);

  try {
    var t1 = Date.now();
    var s1, t1ms, emailCount;

    try {
      var stage1 = await callLLM(preprocessModel, STAGE1_PROMPT, text, 8000);
      s1 = stage1.parsed;
      t1ms = Date.now() - t1;
      emailCount = (s1.emails || []).length;
      console.log('[STAGE 1] ' + preprocessModel + ' | ' + emailCount + ' emails | ' + t1ms + 'ms');
    } catch (s1err) {
      console.log('[STAGE 1 FAILED] ' + s1err.message + ' - falling back to single call');
      s1 = null;
    }

    if (s1 && emailCount > 0) {
      var cleanThread = (s1.emails || []).map(function(em) {
        return 'EMAIL ' + em.index + ' of ' + emailCount + ':\n' +
          'Direction: ' + em.direction + ' | From: ' + em.from + ' | Date: ' + (em.date || 'unknown') + '\n' +
          em.body;
      }).join('\n\n---\n\n');

      var t2 = Date.now();
      var stage2 = await callLLM(analysisModel, stage2Prompt,
        'Analyze this ' + emailCount + '-email thread. Return exactly ' + emailCount + ' per_email entries:\n\n' + cleanThread,
        16000);
      var s2 = stage2.parsed;
      var t2ms = Date.now() - t2;
      var perCount = (s2.per_email || []).length;
      console.log('[STAGE 2] ' + mode.toUpperCase() + ' | ' + analysisModel + ' | ' + perCount + ' analyses | ' + t2ms + 'ms');

      var result = {
        contact_name: s1.contact_name || '',
        company_name: s1.company_name || '',
        rep_name: s1.rep_name || '',
        parsed_emails: (s1.emails || []).map(function(em) {
          return { index: em.index, from: em.from, date: em.date, snippet: (em.body || '').substring(0, 80), direction: em.direction };
        }),
        per_email: s2.per_email || [],
        final: s2.final || {}
      };

      var memoryResult = { stored: false, similar: null };
      if (process.env.PINECONE_API_KEY && result.final && result.final.deal_stage) {
        var threadId = 'thread_' + Date.now();
        var [storeRes, similarRes] = await Promise.all([
          pinecone.storeDeal(threadId, result, text),
          pinecone.findSimilarDeals(result, 5)
        ]);
        memoryResult = { stored: storeRes.success, thread_id: threadId, similar: similarRes };
      }

      return res.json({
        result: result,
        mode: mode,
        model: analysisModel,
        preprocess_model: preprocessModel,
        pipeline: 'two-stage',
        stage1_ms: t1ms,
        stage2_ms: t2ms,
        total_ms: t1ms + t2ms,
        email_count: emailCount,
        analysis_count: perCount,
        complete: emailCount === perCount,
        memory: memoryResult
      });
    }

    console.log('[FALLBACK] ' + mode.toUpperCase() + ' | Using single-call with ' + analysisModel);
    var tf = Date.now();
    var fallback = await callLLM(analysisModel, fallbackPrompt, 'Analyze this pasted email thread:\n\n' + text, 16000);
    var fb = fallback.parsed;
    var tfms = Date.now() - tf;
    var fbEmailCount = (fb.parsed_emails || []).length;
    var fbPerCount = (fb.per_email || []).length;
    console.log('[FALLBACK] ' + analysisModel + ' | ' + fbEmailCount + ' emails, ' + fbPerCount + ' analyses | ' + tfms + 'ms');

    var fbMemory = { stored: false, similar: null };
    if (process.env.PINECONE_API_KEY && fb.final && fb.final.deal_stage) {
      var fbThreadId = 'thread_' + Date.now();
      var [fbStore, fbSimilar] = await Promise.all([
        pinecone.storeDeal(fbThreadId, fb, text),
        pinecone.findSimilarDeals(fb, 5)
      ]);
      fbMemory = { stored: fbStore.success, thread_id: fbThreadId, similar: fbSimilar };
    }

    return res.json({
      result: fb,
      mode: mode,
      model: analysisModel,
      pipeline: 'fallback-single',
      total_ms: tfms,
      email_count: fbEmailCount,
      analysis_count: fbPerCount,
      complete: fbEmailCount === fbPerCount,
      memory: fbMemory
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// == Health check ==
app.get('/api/health', async function(req, res) {
  var pineconeStats = process.env.PINECONE_API_KEY ? await pinecone.getStats() : { enabled: false };
  res.json({
    status: 'ok',
    version: '1.2.0',
    hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,
    hasPineconeKey: !!process.env.PINECONE_API_KEY,
    pinecone: pineconeStats,
    modes: ['coaching', 'postmortem']
  });
});

// == Pinecone endpoints (unchanged) ==
app.post('/api/memory/similar', async function(req, res) {
  if (!process.env.PINECONE_API_KEY) return res.status(503).json({ error: 'Pinecone not configured' });
  try {
    var result = await pinecone.findSimilarDeals(req.body, req.body.top_k || 5);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/memory/cpp', async function(req, res) {
  if (!process.env.PINECONE_API_KEY) return res.status(503).json({ error: 'Pinecone not configured' });
  var userId = req.body.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id required' });
  try {
    var result = await pinecone.storeCPP(userId, req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memory/cpp/:userId', async function(req, res) {
  if (!process.env.PINECONE_API_KEY) return res.status(503).json({ error: 'Pinecone not configured' });
  try {
    var result = await pinecone.getCPP(req.params.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memory/stats', async function(req, res) {
  if (!process.env.PINECONE_API_KEY) return res.status(503).json({ error: 'Pinecone not configured' });
  try {
    var result = await pinecone.getStats();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, function() { console.log('ClearSignals AI v1.2.0 on port ' + PORT); });
