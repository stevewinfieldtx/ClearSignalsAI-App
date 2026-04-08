// == ClearSignals AI - Thread Management Routes ==
// Persistent deal tracking with differential analysis
const express = require('express');
const router = express.Router();
const db = require('./db');
const { DIFFERENTIAL_PROMPT } = require('./prompts-differential');

// Models (from environment)
const MODELS = {
  'haiku': process.env.MODEL_HAIKU || 'anthropic/claude-3.5-haiku',
  'sonnet': process.env.MODEL_SONNET || 'anthropic/claude-sonnet-4',
  'flash-lite': process.env.MODEL_FLASH_LITE || 'google/gemini-2.5-flash-lite',
  'flash': process.env.MODEL_FLASH || 'google/gemini-2.5-flash',
  'pro': process.env.MODEL_PRO || 'google/gemini-2.5-pro'
};

// Stage 1 preprocessor prompt (same as main)
const STAGE1_PROMPT = `You are an email thread preprocessor. Your ONLY job is to parse a raw pasted email into clean individual messages.
PARSE the email thread by finding patterns like "On [date], [person] wrote:", "From:", "Sent:", reply quote markers (> or |), separator lines (----, ____).
For EACH message, extract:
- from: sender name
- date: date/time if found
- direction: "inbound" or "outbound" (guess based on context - who is selling vs buying)
- body: the ACTUAL message body only
STRIP: signatures, disclaimers, footers, quoted text, HTML artifacts.
Order messages OLDEST FIRST.
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

// LLM caller
async function callLLM(modelId, systemPrompt, userMessage, maxTokens) {
  var apiKey = process.env.OPENROUTER_API_KEY;
  var response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
    var errText = await response.text();
    throw new Error('OpenRouter ' + response.status + ': ' + errText.slice(0, 300));
  }
  var data = await response.json();
  var raw = data.choices?.[0]?.message?.content || '';
  if (!raw) throw new Error('Empty response from model');
  return { raw, parsed: cleanJSON(raw) };
}

function cleanJSON(raw) {
  var s = (raw || '');
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  var f = s.indexOf('{'); var l = s.lastIndexOf('}');
  if (f < 0 || l < 0) throw new Error('No JSON object found');
  s = s.slice(f, l + 1);
  try { return JSON.parse(s); } catch(e) {}
  var fix = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(fix); } catch(e) {}
  fix = fix.replace(/[\x00-\x1f]/g, function(c) {
    if (c === '\n') return '\\n'; if (c === '\r') return '\\r'; if (c === '\t') return '\\t'; return '';
  });
  try { return JSON.parse(fix); } catch(e) {}
  throw new Error('JSON parse failed');
}

// == Pre-flight diagnostic: check thread state before LLM analysis ==
// Returns a preflight object with flags the frontend can surface immediately,
// before (and independently of) the coaching output.
function buildPreflight(thread, storedCtx) {
  var flags = [];
  var mode = 'normal'; // normal | warning | critical

  // Trajectory check
  if (thread.trajectory === 'declining') {
    flags.push({ type: 'trajectory', severity: 'red', message: 'Thread trajectory is DECLINING — deal is losing momentum' });
    mode = 'critical';
  } else if (thread.trajectory === 'stalled') {
    flags.push({ type: 'trajectory', severity: 'yellow', message: 'Thread trajectory is STALLED — no meaningful progress' });
    if (mode !== 'critical') mode = 'warning';
  }

  // Win% drop check (requires prior_win_pct if available — flag if critically low)
  if (thread.win_pct !== null && thread.win_pct <= 20) {
    flags.push({ type: 'win_pct', severity: 'red', message: 'Win probability is critically low at ' + thread.win_pct + '%' });
    mode = 'critical';
  } else if (thread.win_pct !== null && thread.win_pct <= 40) {
    flags.push({ type: 'win_pct', severity: 'yellow', message: 'Win probability is low at ' + thread.win_pct + '%' });
    if (mode !== 'critical') mode = 'warning';
  }

  // Deal health check
  if (thread.deal_health === 'critical') {
    flags.push({ type: 'deal_health', severity: 'red', message: 'Deal health is CRITICAL' });
    mode = 'critical';
  } else if (thread.deal_health === 'at_risk') {
    flags.push({ type: 'deal_health', severity: 'yellow', message: 'Deal health is AT RISK' });
    if (mode !== 'critical') mode = 'warning';
  }

  // Unresolved items accumulating
  var unresolved = (storedCtx && storedCtx.unresolved_items) ? storedCtx.unresolved_items : [];
  if (unresolved.length >= 3) {
    flags.push({ type: 'unresolved', severity: 'red', message: unresolved.length + ' buyer requests are unresolved — rep has been missing asks', items: unresolved });
    mode = 'critical';
  } else if (unresolved.length > 0) {
    flags.push({ type: 'unresolved', severity: 'yellow', message: unresolved.length + ' unresolved buyer request(s) carried into this email', items: unresolved });
    if (mode !== 'critical') mode = 'warning';
  }

  // Competitor risk
  if (storedCtx && storedCtx.competitor_risk && storedCtx.competitor_risk.toLowerCase().startsWith('high')) {
    flags.push({ type: 'competitor', severity: 'red', message: 'High competitor risk detected: ' + storedCtx.competitor_risk });
    mode = 'critical';
  } else if (storedCtx && storedCtx.competitor_risk && storedCtx.competitor_risk.toLowerCase().startsWith('medium')) {
    flags.push({ type: 'competitor', severity: 'yellow', message: 'Medium competitor risk: ' + storedCtx.competitor_risk });
    if (mode !== 'critical') mode = 'warning';
  }

  // Unengaged stakeholders
  var unengaged = (storedCtx && storedCtx.unengaged_stakeholders) ? storedCtx.unengaged_stakeholders : [];
  if (unengaged.length > 0) {
    flags.push({ type: 'stakeholders', severity: 'yellow', message: 'Unengaged stakeholders: ' + unengaged.join(', ') });
    if (mode !== 'critical') mode = 'warning';
  }

  return { mode: mode, flags: flags };
}

// ============================================================
// ROUTES
// ============================================================

// == List all threads ==
router.get('/threads', async function(req, res) {
  try {
    var status = req.query.status || null; // 'active', 'closed', or null for all
    var threads = await db.listThreads(status);
    res.json({ threads: threads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// == Get single thread with all emails ==
router.get('/threads/:id', async function(req, res) {
  try {
    var thread = await db.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    var emails = await db.getThreadEmails(req.params.id);
    var context = await db.getContext(req.params.id);
    res.json({ thread: thread, emails: emails, context: context });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// == Create new thread from pasted text ==
router.post('/threads', async function(req, res) {
  var text = req.body.text;
  var model = req.body.model || 'sonnet';
  if (!text || !text.trim()) return res.status(400).json({ error: 'No email text provided' });

  var analysisModel = MODELS[model] || MODELS['sonnet'];
  var preprocessModel = MODELS['flash-lite'];

  try {
    // Stage 1: Parse emails
    var t1 = Date.now();
    var stage1 = await callLLM(preprocessModel, STAGE1_PROMPT, text, 8000);
    var s1 = stage1.parsed;
    var t1ms = Date.now() - t1;
    var emailCount = (s1.emails || []).length;
    console.log('[THREAD NEW] Parsed ' + emailCount + ' emails in ' + t1ms + 'ms');

    if (emailCount === 0) return res.status(400).json({ error: 'No emails found in text' });

    // Create thread record
    var thread = await db.createThread({
      contact_name: s1.contact_name || '',
      company_name: s1.company_name || '',
      rep_name: s1.rep_name || ''
    });

    // Store all emails
    var emailRecords = await db.addEmails(thread.id, (s1.emails || []).map(function(em) {
      return {
        email_index: em.index,
        direction: em.direction,
        sender: em.from,
        email_date: em.date,
        body: em.body
      };
    }));

    var cleanThread = (s1.emails || []).map(function(em) {
      return 'EMAIL ' + em.index + ' of ' + emailCount + ':\n' +
        'Direction: ' + em.direction + ' | From: ' + em.from + ' | Date: ' + (em.date || 'unknown') + '\n' +
        em.body;
    }).join('\n\n---\n\n');

    var diffInput = 'STORED CONTEXT: This is a brand new thread. No prior analysis exists.\n\n' +
      'NEW EMAIL BATCH (' + emailCount + ' emails — analyze ALL of them):\n\n' + cleanThread;

    var t2 = Date.now();
    var stage2 = await callLLM(analysisModel, DIFFERENTIAL_PROMPT, diffInput, 16000);
    var s2 = stage2.parsed;
    var t2ms = Date.now() - t2;
    console.log('[THREAD NEW] Analysis in ' + t2ms + 'ms');

    var batchAnalysis = s2.batch_analysis || [];
    for (var i = 0; i < batchAnalysis.length; i++) {
      var ba = batchAnalysis[i];
      var matchRecord = emailRecords.find(function(r) { return r.email_index === ba.email_index; });
      if (matchRecord) {
        await db.markEmailsAnalyzed([matchRecord.id], [ba]);
      }
    }

    var ctx = s2.updated_context || {};
    await db.updateThread(thread.id, {
      deal_stage: ctx.deal_stage || 'prospecting',
      intent: ctx.intent || 1,
      win_pct: ctx.win_pct || 0,
      deal_health: ctx.deal_health || 'healthy',
      trajectory: ctx.trajectory || 'stable',
      last_analysis_at: new Date().toISOString()
    });

    await db.updateContext(thread.id, {
      unresolved_items: ctx.unresolved_items || [],
      unengaged_stakeholders: ctx.unengaged_stakeholders || [],
      last_recommended_response: ctx.last_recommended_response || '',
      last_buyer_requests: ctx.last_buyer_requests || [],
      cumulative_signals: (batchAnalysis || []).reduce(function(acc, ba) {
        return acc.concat(ba.signals || []);
      }, []),
      response_time_trend: ctx.response_time_trend || '',
      competitor_risk: ctx.competitor_risk || '',
      tone_guidance: ctx.tone_guidance || ''
    });

    var updatedThread = await db.getThread(thread.id);
    var allEmails = await db.getThreadEmails(thread.id);
    var updatedCtx = await db.getContext(thread.id);

    res.json({
      thread: updatedThread,
      emails: allEmails,
      context: updatedCtx,
      coach: ctx.coach || '',
      recommended_actions: ctx.recommended_actions || [],
      stage1_ms: t1ms,
      stage2_ms: t2ms
    });

  } catch (err) {
    console.error('[THREAD NEW ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// == Add new email(s) to existing thread + differential analysis ==
router.post('/threads/:id/emails', async function(req, res) {
  var threadId = req.params.id;
  var text = req.body.text;
  var model = req.body.model || 'sonnet';

  if (!text || !text.trim()) return res.status(400).json({ error: 'No email text provided' });

  var thread = await db.getThread(threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  var analysisModel = MODELS[model] || MODELS['sonnet'];
  var preprocessModel = MODELS['flash-lite'];

  try {
    // == PRE-FLIGHT DIAGNOSTIC ==
    // Runs before the LLM — surfaces guaranteed flags from stored state
    // so critical thread conditions are never buried inside coaching output.
    var existingContext = await db.getContext(threadId);
    var preflight = buildPreflight(thread, existingContext);
    console.log('[PREFLIGHT] mode=' + preflight.mode + ' flags=' + preflight.flags.length);

    // Get current email count to set correct indices
    var existingEmails = await db.getThreadEmails(threadId);
    var nextIndex = existingEmails.length + 1;

    // Parse the new email(s)
    var t1 = Date.now();
    var stage1 = await callLLM(preprocessModel, STAGE1_PROMPT, text, 8000);
    var s1 = stage1.parsed;
    var t1ms = Date.now() - t1;
    var newCount = (s1.emails || []).length;
    console.log('[THREAD ADD] Parsed ' + newCount + ' new emails in ' + t1ms + 'ms');

    if (newCount === 0) return res.status(400).json({ error: 'No emails found in pasted text' });

    // Re-index to continue from existing thread
    var newEmails = (s1.emails || []).map(function(em, i) {
      return {
        email_index: nextIndex + i,
        direction: em.direction,
        sender: em.from,
        email_date: em.date,
        body: em.body
      };
    });

    // Store new emails (unanalyzed)
    var newRecords = await db.addEmails(threadId, newEmails);

    // Get differential batch (includes stored context)
    var batch = await db.getDifferentialBatch(threadId);

    // Build context string for the LLM
    var storedCtx = batch.context || {};
    var contextStr = 'STORED CONTEXT FROM PRIOR ANALYSIS:\n';
    contextStr += '- Deal stage: ' + (thread.deal_stage || 'unknown') + '\n';
    contextStr += '- Current intent: ' + (thread.intent || '?') + '/10\n';
    contextStr += '- Current win%: ' + (thread.win_pct || '?') + '%\n';
    contextStr += '- Deal health: ' + (thread.deal_health || 'unknown') + '\n';
    contextStr += '- Trajectory: ' + (thread.trajectory || 'unknown') + '\n';
    if (storedCtx.unresolved_items && storedCtx.unresolved_items.length) {
      contextStr += '- Unresolved buyer requests: ' + JSON.stringify(storedCtx.unresolved_items) + '\n';
    }
    if (storedCtx.last_buyer_requests && storedCtx.last_buyer_requests.length) {
      contextStr += '- Last buyer requests: ' + JSON.stringify(storedCtx.last_buyer_requests) + '\n';
    }
    if (storedCtx.last_recommended_response) {
      contextStr += '- Last recommended response for rep: ' + storedCtx.last_recommended_response + '\n';
    }
    if (storedCtx.unengaged_stakeholders && storedCtx.unengaged_stakeholders.length) {
      contextStr += '- Unengaged stakeholders: ' + JSON.stringify(storedCtx.unengaged_stakeholders) + '\n';
    }
    if (storedCtx.competitor_risk) contextStr += '- Competitor risk: ' + storedCtx.competitor_risk + '\n';
    if (storedCtx.tone_guidance) contextStr += '- Tone guidance: ' + storedCtx.tone_guidance + '\n';

    // Add recent prior email summaries for continuity
    if (batch.prior_summary && batch.prior_summary.length) {
      contextStr += '\nRECENT PRIOR EMAILS (already analyzed, for context):\n';
      for (var ps of batch.prior_summary) {
        contextStr += '- Email #' + ps.email_index + ' (' + ps.direction + ', ' + ps.sender + '): ' + ps.summary + ' [Intent: ' + ps.intent + ', Win: ' + ps.win_pct + '%]\n';
      }
    }

    // Build new email batch string
    var batchStr = '\n\nNEW EMAIL BATCH (' + batch.emails.length + ' emails — analyze ALL of them):\n\n';
    for (var be of batch.emails) {
      batchStr += 'EMAIL ' + be.email_index + ':\n';
      batchStr += 'Direction: ' + be.direction + ' | From: ' + be.sender + ' | Date: ' + (be.email_date || 'unknown') + '\n';
      batchStr += be.body + '\n\n---\n\n';
    }

    // Run differential analysis
    var t2 = Date.now();
    var stage2 = await callLLM(analysisModel, DIFFERENTIAL_PROMPT, contextStr + batchStr, 16000);
    var s2 = stage2.parsed;
    var t2ms = Date.now() - t2;
    console.log('[THREAD DIFF] Analysis in ' + t2ms + 'ms for ' + batch.emails.length + ' emails');

    // Store per-email analysis
    var batchAnalysis = s2.batch_analysis || [];
    for (var i = 0; i < batchAnalysis.length; i++) {
      var ba = batchAnalysis[i];
      var matchRecord = batch.emails.find(function(r) { return r.email_index === ba.email_index; });
      if (matchRecord) {
        await db.markEmailsAnalyzed([matchRecord.id], [ba]);
      }
    }

    // Update thread scores
    var ctx = s2.updated_context || {};
    await db.updateThread(threadId, {
      deal_stage: ctx.deal_stage || thread.deal_stage,
      intent: ctx.intent || thread.intent,
      win_pct: ctx.win_pct || thread.win_pct,
      deal_health: ctx.deal_health || thread.deal_health,
      trajectory: ctx.trajectory || thread.trajectory,
      last_analysis_at: new Date().toISOString()
    });

    // Update stored context
    await db.updateContext(threadId, {
      unresolved_items: ctx.unresolved_items,
      unengaged_stakeholders: ctx.unengaged_stakeholders,
      last_recommended_response: ctx.last_recommended_response,
      last_buyer_requests: ctx.last_buyer_requests,
      response_time_trend: ctx.response_time_trend,
      competitor_risk: ctx.competitor_risk,
      tone_guidance: ctx.tone_guidance
    });

    // Return updated thread
    var updatedThread = await db.getThread(threadId);
    var allEmails = await db.getThreadEmails(threadId);
    var updatedCtx = await db.getContext(threadId);

    res.json({
      thread: updatedThread,
      emails: allEmails,
      context: updatedCtx,
      preflight: preflight,
      new_analysis: batchAnalysis,
      coach: ctx.coach || '',
      recommended_actions: ctx.recommended_actions || [],
      differential: true,
      batch_size: batch.emails.length,
      stage1_ms: t1ms,
      stage2_ms: t2ms
    });

  } catch (err) {
    console.error('[THREAD DIFF ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// == Update thread status (active/closed) ==
router.patch('/threads/:id', async function(req, res) {
  try {
    var updated = await db.updateThread(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Thread not found' });
    res.json({ thread: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
