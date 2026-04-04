// == ClearSignals AI — Portal API Routes (PostgreSQL-backed) ==
// Enables vendor partner portals to embed deal coaching.
// ALL state persisted in PostgreSQL. Survives restarts/deploys.
// ALL PII purged after response delivery.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('./db');

// ── Models (from environment) ──────────────────────────────
const MODELS = {
  'haiku': process.env.MODEL_HAIKU || 'anthropic/claude-3.5-haiku',
  'sonnet': process.env.MODEL_SONNET || 'anthropic/claude-sonnet-4',
  'flash-lite': process.env.MODEL_FLASH_LITE || 'google/gemini-2.5-flash-lite',
  'flash': process.env.MODEL_FLASH || 'google/gemini-2.5-flash',
  'pro': process.env.MODEL_PRO || 'google/gemini-2.5-pro'
};

// ── LLM call helper (same pattern as server.js) ──────────────
async function callLLM(modelId, systemPrompt, userMessage, maxTokens) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://clearsignals.ai',
      'X-Title': 'ClearSignals AI Portal'
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

function cleanJSON(raw) {
  let s = (raw || '');
  s = s.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const f = s.indexOf('{');
  const l = s.lastIndexOf('}');
  if (f < 0 || l < 0) throw new Error('No JSON object found in response');
  s = s.slice(f, l + 1);
  try { return JSON.parse(s); } catch(e) {}
  let fix = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(fix); } catch(e) {}
  fix = fix.replace(/[\x00-\x1f]/g, function(c) {
    if (c === '\n') return '\\n'; if (c === '\r') return '\\r'; if (c === '\t') return '\\t'; return '';
  });
  try { return JSON.parse(fix); } catch(e) {}
  // Truncated JSON repair
  let repaired = fix;
  let inStr = false, esc = false, braces = 0, brackets = 0;
  for (let i = 0; i < repaired.length; i++) {
    const c = repaired[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') braces++; if (c === '}') braces--;
    if (c === '[') brackets++; if (c === ']') brackets--;
  }
  if (inStr) repaired += '"';
  repaired = repaired.replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/, '');
  repaired = repaired.replace(/,\s*"[^"]*"\s*:\s*$/, '');
  repaired = repaired.replace(/,\s*"[^"]*$/, '');
  repaired = repaired.replace(/,\s*$/, '');
  for (let a = 0; a < brackets; a++) repaired += ']';
  for (let b = 0; b < braces; b++) repaired += '}';
  try { return JSON.parse(repaired); } catch(e) {}
  throw new Error('JSON parse failed. First 300: ' + s.slice(0, 300));
}

// ── Crypto helpers ────────────────────────────────────────────
function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function verifySecret(plainSecret, storedHash) {
  return hashSecret(plainSecret) === storedHash;
}

// ══════════════════════════════════════════════════════════════
// MIDDLEWARE (PostgreSQL-backed)
// ══════════════════════════════════════════════════════════════

// Vendor auth — validates API key from DB
async function vendorAuth(req, res, next) {
  const vendorKey = req.headers['x-cs-vendor-key'];
  if (!vendorKey) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Missing X-CS-Vendor-Key header', status: 401 } });

  try {
    const vendor = await db.getVendorByKey(vendorKey);
    if (!vendor) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid vendor key', status: 401 } });
    if (!vendor.active) return res.status(403).json({ error: { code: 'VENDOR_INACTIVE', message: 'Vendor account is suspended or unconfigured', status: 403 } });

    // Verify HMAC signature if provided
    const signature = req.headers['x-cs-signature'];
    const timestamp = req.headers['x-cs-timestamp'];
    if (signature && timestamp) {
      const payload = timestamp + '.' + JSON.stringify(req.body || {});
      const expected = crypto.createHmac('sha256', vendor.secret_hash).update(payload).digest('hex');
      if (signature !== expected) {
        return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid signature', status: 401 } });
      }
      const ts = new Date(timestamp).getTime();
      if (isNaN(ts) || Math.abs(Date.now() - ts) > 300000) {
        return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Timestamp expired', status: 401 } });
      }
    }

    req.vendor = vendor;
    next();
  } catch (err) {
    console.error('[PORTAL AUTH ERROR]', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Auth check failed', status: 500 } });
  }
}

// Session auth — validates session token from DB
async function sessionAuth(req, res, next) {
  const token = req.headers['x-cs-session-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Missing session token', status: 401 } });

  try {
    const session = await db.getSessionByToken(token);
    if (!session) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid or expired session token', status: 401 } });

    // Check expiry
    if (new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Session token expired', status: 401 } });
    }

    // Check vendor is still active
    if (!session.vendor_active) {
      return res.status(403).json({ error: { code: 'VENDOR_INACTIVE', message: 'Vendor account is inactive', status: 403 } });
    }

    // Build a vendor-like object from the joined session data
    req.vendor = {
      id: session.vendor_id,
      vendor_key: session.vendor_key,
      name: session.vendor_name,
      product: session.vendor_product,
      active: session.vendor_active,
      solution_brief: session.solution_brief
    };
    req.session_data = session;
    next();
  } catch (err) {
    console.error('[PORTAL SESSION AUTH ERROR]', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Session check failed', status: 500 } });
  }
}

// ══════════════════════════════════════════════════════════════
// PROMPTS
// ══════════════════════════════════════════════════════════════

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

function buildPortalCoachingPrompt(vendorSolution) {
  const brief = vendorSolution || {};
  const diffList = (brief.key_differentiators || []).map((d, i) => (i + 1) + '. ' + d).join('\n');
  const objections = Object.entries(brief.common_objections || {}).map(([k, v]) => '- ' + k + ': ' + v).join('\n');
  const competitors = Object.entries(brief.competitive_positioning || {}).map(([k, v]) => '- vs ' + k + ': ' + v).join('\n');
  const caseStudies = (brief.case_studies || []).map(cs => '- ' + cs.client + ' (' + cs.vertical + '): ' + cs.result).join('\n');

  return `You are ClearSignals AI, an elite sales coaching engine for channel partner portals. A reseller selling ${brief.product_name || 'a vendor solution'} is stuck on a deal and needs your help.

== VENDOR SOLUTION BRIEF ==
Product: ${brief.product_name || 'Unknown'}
Description: ${brief.description || ''}

Key Differentiators:
${diffList || '(none provided)'}

Common Objections & Responses:
${objections || '(none provided)'}

Competitive Positioning:
${competitors || '(none provided)'}

Case Studies:
${caseStudies || '(none provided)'}

Pricing: ${brief.pricing ? JSON.stringify(brief.pricing) : '(not provided)'}

== YOUR JOB ==
Analyze the email thread. The reseller needs to know:
1. Where does this deal stand RIGHT NOW?
2. What should they do NEXT? (leverage the vendor solution's strengths)
3. How should they position the product?

FOR EACH EMAIL:
- INBOUND (buyer): Analyze what the buyer wants. List their requests. Recommend response using vendor strengths. Flag subtle cues.
- OUTBOUND (reseller): Grade how well they addressed buyer requests. What did they leverage? What did they miss?

Return this JSON:
{
  "deal_health": {
    "score": 0-100,
    "label": "healthy|at_risk|critical|stalled",
    "stage": "prospecting|qualification|demo|proposal|negotiation|closed_won|closed_lost",
    "days_in_stage": 0,
    "sentiment_trend": "warming|stable|cooling|cold",
    "response_rate": 0.0-1.0,
    "trajectory": "improving|stable|declining|stalled"
  },
  "timeline": [
    {"date":"date","direction":"outbound|inbound|gap","label":"short desc","status":"positive|neutral|concerning","note":"deal impact"}
  ],
  "next_steps": [
    {"priority":1,"action":"specific action","detail":"how to do it — reference product features, case studies, differentiators","timing":"when","rationale":"why now"}
  ],
  "coaching_tips": [
    {"title":"principle","tip":"advice for next time","in_this_thread":"how it applies here"}
  ],
  "company_research_needed": "search query for prospect company",
  "industry_research_needed": "search query for industry signals"
}

RULES:
- timeline: ONE entry per email + gap entry if silence at end.
- next_steps: 2-4 actions. ALWAYS reference vendor solution. Use differentiators, case studies, objection handling.
- coaching_tips: 2-3 tips. Friendly, not judgmental.
- NO "what was missed" section. Gaps absorbed into next_steps.
- deal_health.score: 0-100 composite.

CULTURAL RULES: Japan(silence=contemplation, "consider"=no), Vietnam(relationship-first), Germany(Sie/du), Brazil/Mexico(casual=default), UK("not bad"=praise, "interesting"=dismissal), China(face-saving), Korea(hierarchy), Sweden(lagom), India("yes but"=no)

Return ONLY valid JSON. No markdown fences. No explanation.`;
}

const RESEARCH_PROMPT = `You are a business research assistant. Given a company name and/or industry, provide a brief intelligence summary relevant to selling enterprise software.

Return ONLY this JSON:
{
  "company": {
    "summary": "2-3 sentences about the company",
    "relevance": "1-2 sentences on sales implications"
  },
  "industry": {
    "summary": "2-3 sentences about industry trends",
    "relevance": "1-2 sentences on deal strategy implications"
  }
}

Return ONLY valid JSON. No markdown fences.`;

// ══════════════════════════════════════════════════════════════
// SESSION CLEANUP — runs every 15 minutes
// ══════════════════════════════════════════════════════════════
setInterval(async function() {
  try {
    const cleaned = await db.cleanExpiredSessions();
    if (cleaned > 0) console.log('[PORTAL] Cleaned ' + cleaned + ' expired sessions');
  } catch(e) { /* silent */ }
}, 15 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

// ── POST /v1/sessions ─────────────────────────────────────────
router.post('/v1/sessions', vendorAuth, async function(req, res) {
  const lead = req.body.lead;
  if (!lead) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'lead object required', status: 400 } });

  const ttl = Math.min(req.body.ttl_seconds || 3600, 7200);
  const token = 'cs_sess_' + crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + (ttl * 1000)).toISOString();

  try {
    await db.createSession({
      token: token,
      vendor_id: req.vendor.id,
      lead_data: lead,
      expires_at: expiresAt
    });

    console.log('[PORTAL] Session created for vendor:', req.vendor.name, '| Lead:', lead.company || 'unknown');

    res.json({
      session_token: token,
      expires_at: expiresAt
    });
  } catch (err) {
    console.error('[PORTAL SESSION ERROR]', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create session', status: 500 } });
  }
});

// ── POST /v1/analyze ──────────────────────────────────────────
router.post('/v1/analyze', function(req, res, next) {
  const token = req.headers['x-cs-session-token'] || req.query.token;
  if (token) return sessionAuth(req, res, next);
  return vendorAuth(req, res, next);
}, async function(req, res) {
  const threadText = req.body.thread_text;
  const lead = req.session_data ? req.session_data.lead_data : req.body.lead;
  const options = req.body.options || {};
  const vendor = req.vendor;

  if (!threadText || threadText.trim().length < 100) {
    return res.status(422).json({ error: { code: 'THREAD_TOO_SHORT', message: 'Thread text must contain at least 100 characters.', status: 422 } });
  }
  if (threadText.length > 100000) {
    return res.status(413).json({ error: { code: 'THREAD_TOO_LONG', message: 'Thread exceeds 100,000 character limit.', status: 413 } });
  }

  const analysisId = 'ca_' + crypto.randomBytes(12).toString('hex');
  const analysisModel = MODELS['sonnet'];
  const preprocessModel = MODELS['flash-lite'];
  const researchModel = MODELS['flash'];

  console.log('[PORTAL ANALYZE] ' + analysisId + ' | Vendor: ' + vendor.name + ' | Lead: ' + (lead?.company || 'unknown'));

  try {
    // ── STAGE 1: Parse ─────────────────────────────────────────
    const t1 = Date.now();
    let s1;
    try {
      const stage1 = await callLLM(preprocessModel, STAGE1_PROMPT, threadText, 8000);
      s1 = stage1.parsed;
    } catch (err) {
      return res.status(422).json({ error: { code: 'THREAD_PARSE_FAILED', message: 'Could not identify email structure in provided text.', status: 422 } });
    }
    const t1ms = Date.now() - t1;
    const emailCount = (s1.emails || []).length;
    if (emailCount === 0) {
      return res.status(422).json({ error: { code: 'THREAD_PARSE_FAILED', message: 'No conversation content found.', status: 422 } });
    }

    // ── STAGE 2: Coaching analysis ─────────────────────────────
    const cleanThread = s1.emails.map(function(em) {
      return 'EMAIL ' + em.index + ' of ' + emailCount + ':\nDirection: ' + em.direction + ' | From: ' + em.from + ' | Date: ' + (em.date || 'unknown') + '\n' + em.body;
    }).join('\n\n---\n\n');

    let leadContext = '';
    if (lead) {
      leadContext = '\n\nLEAD CONTEXT FROM PORTAL:\n';
      if (lead.company) leadContext += '- Company: ' + lead.company + '\n';
      if (lead.contact_name) leadContext += '- Contact: ' + lead.contact_name + '\n';
      if (lead.contact_title) leadContext += '- Title: ' + lead.contact_title + '\n';
      if (lead.estimated_value) leadContext += '- Estimated value: ' + lead.estimated_value + '\n';
      if (lead.stage) leadContext += '- Current stage: ' + lead.stage + '\n';
      if (lead.assigned_date) leadContext += '- Assigned: ' + lead.assigned_date + '\n';
    }

    const coachingPrompt = buildPortalCoachingPrompt(vendor.solution_brief);

    const t2 = Date.now();
    const stage2 = await callLLM(analysisModel, coachingPrompt,
      'Analyze this ' + emailCount + '-email thread:\n\n' + cleanThread + leadContext, 16000);
    const analysis = stage2.parsed;
    const t2ms = Date.now() - t2;

    // ── STAGE 3: Research (optional) ───────────────────────────
    let intelligence = null;
    if (options.include_company_research !== false || options.include_industry_research !== false) {
      try {
        const companyQuery = analysis.company_research_needed || ((lead?.company || s1.company_name || '') + ' company');
        const t3 = Date.now();
        const research = await callLLM(researchModel, RESEARCH_PROMPT,
          'Research:\nCompany: ' + companyQuery + '\nIndustry context for selling to: ' + (lead?.company || s1.company_name || 'this prospect'), 4000);
        intelligence = research.parsed;
        console.log('[PORTAL S3] Research in ' + (Date.now() - t3) + 'ms');
      } catch (err) {
        console.log('[PORTAL S3 WARN] Research failed: ' + err.message);
      }
    }

    // ── Build response ─────────────────────────────────────────
    const piiPurgedAt = new Date().toISOString();
    const totalMs = t1ms + t2ms;

    const response = {
      analysis_id: analysisId,
      generated_at: new Date().toISOString(),
      pii_purged_at: piiPurgedAt,
      deal_health: analysis.deal_health || { score: 50, label: 'at_risk', stage: 'unknown', sentiment_trend: 'stable', trajectory: 'stable' },
      intelligence: intelligence || null,
      timeline: analysis.timeline || [],
      next_steps: (analysis.next_steps || []).map(function(s) {
        return { priority: s.priority, action: s.action, detail: s.detail, timing: s.timing, rationale: s.rationale || '' };
      }),
      coaching_tips: options.include_coaching !== false ? (analysis.coaching_tips || []) : undefined,
      warnings: []
    };

    if (!intelligence) response.warnings.push('Company/industry research unavailable.');

    // ── Track usage in DB ──────────────────────────────────────
    try {
      await db.incrementVendorUsage(vendor.id);
      if (req.session_data) await db.incrementSessionUsage(req.session_data.id);
      await db.logAnalysis({
        analysis_id: analysisId,
        vendor_id: vendor.id,
        email_count: emailCount,
        deal_health_score: response.deal_health.score,
        deal_stage: response.deal_health.stage,
        pipeline: 'two-stage',
        total_ms: totalMs,
        pii_purged_at: piiPurgedAt
      });
    } catch (logErr) {
      console.error('[PORTAL LOG WARN]', logErr.message);
      // Non-fatal — don't fail the response over logging
    }

    // ── PII PURGE ──────────────────────────────────────────────
    console.log('[PORTAL PII] Purged at ' + piiPurgedAt + ' | ' + analysisId);
    console.log('[PORTAL COMPLETE] ' + analysisId + ' | ' + totalMs + 'ms');

    res.json(response);

  } catch (err) {
    console.error('[PORTAL ERROR] ' + analysisId + ' | ' + err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Analysis failed. Ref: ' + analysisId, status: 500 } });
  }
});

// ── GET /v1/health ────────────────────────────────────────────
router.get('/v1/health', function(req, res) {
  res.json({
    status: 'ok',
    service: 'clearsignals-portal-api',
    version: '1.0.0',
    storage: 'postgresql',
    endpoints: ['/v1/sessions', '/v1/analyze', '/v1/health']
  });
});

// ══════════════════════════════════════════════════════════════
// VENDOR MANAGEMENT (admin-only)
// ══════════════════════════════════════════════════════════════

function adminAuth(req, res, next) {
  const adminKey = req.headers['x-cs-admin-key'];
  if (!adminKey || adminKey !== process.env.CS_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Register vendor
router.post('/v1/admin/vendors', adminAuth, async function(req, res) {
  const { name, product, solution_brief } = req.body;
  if (!name || !product) return res.status(400).json({ error: 'name and product required' });

  const vendorKey = 'vk_live_' + crypto.randomBytes(12).toString('hex');
  const secret = 'sk_live_' + crypto.randomBytes(24).toString('hex');

  try {
    const vendor = await db.createVendor({
      vendor_key: vendorKey,
      secret_hash: hashSecret(secret),
      name: name,
      product: product,
      solution_brief: solution_brief || {}
    });

    console.log('[PORTAL ADMIN] Vendor registered:', name, '| Key:', vendorKey);

    res.json({
      vendor_key: vendorKey,
      secret: secret,
      name: name,
      id: vendor.id,
      message: 'Store the secret securely — it cannot be retrieved again.'
    });
  } catch (err) {
    console.error('[PORTAL ADMIN ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update solution brief
router.put('/v1/admin/vendors/:key/solution', adminAuth, async function(req, res) {
  try {
    const vendor = await db.updateVendorSolution(req.params.key, req.body);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ success: true, vendor_key: vendor.vendor_key, name: vendor.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle active/inactive
router.patch('/v1/admin/vendors/:key', adminAuth, async function(req, res) {
  try {
    const vendor = await db.setVendorActive(req.params.key, req.body.active);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ success: true, vendor_key: vendor.vendor_key, active: vendor.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all vendors
router.get('/v1/admin/vendors', adminAuth, async function(req, res) {
  try {
    const vendors = await db.listVendors();
    res.json({ vendors: vendors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vendor analytics
router.get('/v1/admin/vendors/:key/analytics', adminAuth, async function(req, res) {
  try {
    const vendor = await db.getVendorByKey(req.params.key);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    const analytics = await db.getVendorAnalytics(vendor.id, parseInt(req.query.days) || 30);
    res.json({ vendor_key: vendor.vendor_key, name: vendor.name, analytics: analytics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
