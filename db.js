// == ClearSignals AI - PostgreSQL Database Layer ==
// Handles thread persistence and differential analysis
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

// == Initialize tables ==
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS threads (
        id SERIAL PRIMARY KEY,
        contact_name TEXT,
        company_name TEXT,
        rep_name TEXT,
        deal_stage TEXT DEFAULT 'prospecting',
        intent INTEGER DEFAULT 1,
        win_pct INTEGER DEFAULT 0,
        deal_health TEXT DEFAULT 'healthy',
        trajectory TEXT DEFAULT 'stable',
        status TEXT DEFAULT 'active',
        last_analysis_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS thread_emails (
        id SERIAL PRIMARY KEY,
        thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE,
        email_index INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        sender TEXT,
        email_date TEXT,
        body TEXT,
        snippet TEXT,
        analyzed BOOLEAN DEFAULT FALSE,
        analysis JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS thread_context (
        id SERIAL PRIMARY KEY,
        thread_id INTEGER UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
        unresolved_items JSONB DEFAULT '[]',
        unengaged_stakeholders JSONB DEFAULT '[]',
        last_recommended_response TEXT,
        last_buyer_requests JSONB DEFAULT '[]',
        cumulative_signals JSONB DEFAULT '[]',
        response_time_trend TEXT,
        competitor_risk TEXT,
        tone_guidance TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_thread_emails_thread ON thread_emails(thread_id, email_index);
      CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status, updated_at DESC);

      -- == Portal API: Vendors ==
      CREATE TABLE IF NOT EXISTS portal_vendors (
        id SERIAL PRIMARY KEY,
        vendor_key TEXT UNIQUE NOT NULL,
        secret_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        product TEXT NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        solution_brief JSONB DEFAULT '{}',
        usage_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- == Portal API: Sessions ==
      CREATE TABLE IF NOT EXISTS portal_sessions (
        id SERIAL PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        vendor_id INTEGER REFERENCES portal_vendors(id) ON DELETE CASCADE,
        lead_data JSONB NOT NULL,
        usage_count INTEGER DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- == Portal API: Analysis log (de-identified, no PII) ==
      CREATE TABLE IF NOT EXISTS portal_analysis_log (
        id SERIAL PRIMARY KEY,
        analysis_id TEXT UNIQUE NOT NULL,
        vendor_id INTEGER REFERENCES portal_vendors(id) ON DELETE SET NULL,
        email_count INTEGER,
        deal_health_score INTEGER,
        deal_stage TEXT,
        pipeline TEXT,
        total_ms INTEGER,
        pii_purged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_portal_vendors_key ON portal_vendors(vendor_key);
      CREATE INDEX IF NOT EXISTS idx_portal_sessions_token ON portal_sessions(token);
      CREATE INDEX IF NOT EXISTS idx_portal_sessions_expires ON portal_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_portal_analysis_vendor ON portal_analysis_log(vendor_id, created_at DESC);
    `);
    console.log('[DB] Tables ready (including portal tables)');
  } finally {
    client.release();
  }
}

// == Thread operations ==

async function listThreads(status) {
  var where = status ? "WHERE status = $1" : "";
  var params = status ? [status] : [];
  var res = await pool.query(
    "SELECT t.*, COUNT(e.id) as email_count, MAX(e.created_at) as last_email_at " +
    "FROM threads t LEFT JOIN thread_emails e ON t.id = e.thread_id " +
    where + " GROUP BY t.id ORDER BY t.updated_at DESC",
    params
  );
  return res.rows;
}

async function getThread(threadId) {
  var res = await pool.query("SELECT * FROM threads WHERE id = $1", [threadId]);
  return res.rows[0] || null;
}

async function createThread(data) {
  var res = await pool.query(
    "INSERT INTO threads (contact_name, company_name, rep_name, deal_stage, intent, win_pct, deal_health, trajectory, last_analysis_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING *",
    [data.contact_name, data.company_name, data.rep_name,
     data.deal_stage || 'prospecting', data.intent || 1, data.win_pct || 0,
     data.deal_health || 'healthy', data.trajectory || 'stable']
  );
  // Also create context record
  await pool.query(
    "INSERT INTO thread_context (thread_id) VALUES ($1)",
    [res.rows[0].id]
  );
  return res.rows[0];
}

async function updateThread(threadId, data) {
  var fields = [];
  var vals = [];
  var idx = 1;
  var allowed = ['contact_name','company_name','rep_name','deal_stage','intent','win_pct','deal_health','trajectory','status','last_analysis_at'];
  for (var key of allowed) {
    if (data[key] !== undefined) {
      fields.push(key + ' = $' + idx);
      vals.push(data[key]);
      idx++;
    }
  }
  fields.push('updated_at = NOW()');
  if (fields.length === 1) return null; // nothing to update
  vals.push(threadId);
  var res = await pool.query(
    "UPDATE threads SET " + fields.join(', ') + " WHERE id = $" + idx + " RETURNING *",
    vals
  );
  return res.rows[0] || null;
}

// == Email operations ==

async function getThreadEmails(threadId) {
  var res = await pool.query(
    "SELECT * FROM thread_emails WHERE thread_id = $1 ORDER BY email_index ASC",
    [threadId]
  );
  return res.rows;
}

async function addEmails(threadId, emails) {
  // emails: [{email_index, direction, sender, email_date, body, snippet}]
  var results = [];
  for (var em of emails) {
    var res = await pool.query(
      "INSERT INTO thread_emails (thread_id, email_index, direction, sender, email_date, body, snippet) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [threadId, em.email_index, em.direction, em.sender, em.email_date, em.body, (em.body || '').substring(0, 80)]
    );
    results.push(res.rows[0]);
  }
  return results;
}

async function markEmailsAnalyzed(emailIds, analyses) {
  // analyses is an array matching emailIds, each is a JSON object
  for (var i = 0; i < emailIds.length; i++) {
    await pool.query(
      "UPDATE thread_emails SET analyzed = TRUE, analysis = $1 WHERE id = $2",
      [JSON.stringify(analyses[i]), emailIds[i]]
    );
  }
}

async function getUnanalyzedEmails(threadId) {
  var res = await pool.query(
    "SELECT * FROM thread_emails WHERE thread_id = $1 AND analyzed = FALSE ORDER BY email_index ASC",
    [threadId]
  );
  return res.rows;
}

async function getAnalyzedEmails(threadId) {
  var res = await pool.query(
    "SELECT * FROM thread_emails WHERE thread_id = $1 AND analyzed = TRUE ORDER BY email_index ASC",
    [threadId]
  );
  return res.rows;
}

// == Context operations ==

async function getContext(threadId) {
  var res = await pool.query(
    "SELECT * FROM thread_context WHERE thread_id = $1",
    [threadId]
  );
  return res.rows[0] || null;
}

async function updateContext(threadId, data) {
  var res = await pool.query(
    "UPDATE thread_context SET " +
    "unresolved_items = COALESCE($1, unresolved_items), " +
    "unengaged_stakeholders = COALESCE($2, unengaged_stakeholders), " +
    "last_recommended_response = COALESCE($3, last_recommended_response), " +
    "last_buyer_requests = COALESCE($4, last_buyer_requests), " +
    "cumulative_signals = COALESCE($5, cumulative_signals), " +
    "response_time_trend = COALESCE($6, response_time_trend), " +
    "competitor_risk = COALESCE($7, competitor_risk), " +
    "tone_guidance = COALESCE($8, tone_guidance), " +
    "updated_at = NOW() " +
    "WHERE thread_id = $9 RETURNING *",
    [
      data.unresolved_items ? JSON.stringify(data.unresolved_items) : null,
      data.unengaged_stakeholders ? JSON.stringify(data.unengaged_stakeholders) : null,
      data.last_recommended_response || null,
      data.last_buyer_requests ? JSON.stringify(data.last_buyer_requests) : null,
      data.cumulative_signals ? JSON.stringify(data.cumulative_signals) : null,
      data.response_time_trend || null,
      data.competitor_risk || null,
      data.tone_guidance || null,
      threadId
    ]
  );
  return res.rows[0] || null;
}

// == Differential helper ==
// Returns the batch of emails that need analysis:
// All unanalyzed emails (outbound + the new inbound trigger)

async function getDifferentialBatch(threadId) {
  // Get unanalyzed emails
  var unanalyzed = await getUnanalyzedEmails(threadId);
  if (unanalyzed.length === 0) return { emails: [], context: null };

  // Get stored context from prior analyses
  var context = await getContext(threadId);

  // Get the last few analyzed emails for continuity (just summaries)
  var analyzed = await getAnalyzedEmails(threadId);
  var recentAnalyzed = analyzed.slice(-3); // last 3 for context window

  return {
    emails: unanalyzed,
    context: context,
    prior_summary: recentAnalyzed.map(function(e) {
      var a = e.analysis || {};
      return {
        email_index: e.email_index,
        direction: e.direction,
        sender: e.sender,
        summary: a.summary || '',
        intent: a.intent,
        win_pct: a.win_pct
      };
    })
  };
}

module.exports = {
  pool,
  initDB,
  listThreads,
  getThread,
  createThread,
  updateThread,
  getThreadEmails,
  addEmails,
  markEmailsAnalyzed,
  getUnanalyzedEmails,
  getAnalyzedEmails,
  getContext,
  updateContext,
  getDifferentialBatch,
  // Portal API
  createVendor,
  getVendorByKey,
  updateVendorSolution,
  setVendorActive,
  incrementVendorUsage,
  listVendors,
  createSession,
  getSessionByToken,
  incrementSessionUsage,
  cleanExpiredSessions,
  logAnalysis,
  getVendorAnalytics
};

// ══════════════════════════════════════════════════════════════
// PORTAL API — Vendor operations
// ══════════════════════════════════════════════════════════════

async function createVendor(data) {
  var res = await pool.query(
    "INSERT INTO portal_vendors (vendor_key, secret_hash, name, product, solution_brief) " +
    "VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [data.vendor_key, data.secret_hash, data.name, data.product,
     JSON.stringify(data.solution_brief || {})]
  );
  return res.rows[0];
}

async function getVendorByKey(vendorKey) {
  var res = await pool.query(
    "SELECT * FROM portal_vendors WHERE vendor_key = $1",
    [vendorKey]
  );
  var row = res.rows[0] || null;
  if (row && typeof row.solution_brief === 'string') {
    try { row.solution_brief = JSON.parse(row.solution_brief); } catch(e) {}
  }
  return row;
}

async function updateVendorSolution(vendorKey, solutionBrief) {
  var res = await pool.query(
    "UPDATE portal_vendors SET solution_brief = $1, updated_at = NOW() " +
    "WHERE vendor_key = $2 RETURNING *",
    [JSON.stringify(solutionBrief), vendorKey]
  );
  return res.rows[0] || null;
}

async function setVendorActive(vendorKey, active) {
  var res = await pool.query(
    "UPDATE portal_vendors SET active = $1, updated_at = NOW() " +
    "WHERE vendor_key = $2 RETURNING *",
    [active, vendorKey]
  );
  return res.rows[0] || null;
}

async function incrementVendorUsage(vendorId) {
  await pool.query(
    "UPDATE portal_vendors SET usage_count = usage_count + 1 WHERE id = $1",
    [vendorId]
  );
}

async function listVendors() {
  var res = await pool.query(
    "SELECT id, vendor_key, name, product, active, usage_count, created_at, updated_at " +
    "FROM portal_vendors ORDER BY created_at DESC"
  );
  return res.rows;
}

// ══════════════════════════════════════════════════════════════
// PORTAL API — Session operations
// ══════════════════════════════════════════════════════════════

async function createSession(data) {
  var res = await pool.query(
    "INSERT INTO portal_sessions (token, vendor_id, lead_data, expires_at) " +
    "VALUES ($1, $2, $3, $4) RETURNING *",
    [data.token, data.vendor_id, JSON.stringify(data.lead_data), data.expires_at]
  );
  return res.rows[0];
}

async function getSessionByToken(token) {
  var res = await pool.query(
    "SELECT s.*, v.vendor_key, v.name as vendor_name, v.product as vendor_product, " +
    "v.active as vendor_active, v.solution_brief " +
    "FROM portal_sessions s " +
    "JOIN portal_vendors v ON s.vendor_id = v.id " +
    "WHERE s.token = $1",
    [token]
  );
  var row = res.rows[0] || null;
  if (row) {
    if (typeof row.lead_data === 'string') {
      try { row.lead_data = JSON.parse(row.lead_data); } catch(e) {}
    }
    if (typeof row.solution_brief === 'string') {
      try { row.solution_brief = JSON.parse(row.solution_brief); } catch(e) {}
    }
  }
  return row;
}

async function incrementSessionUsage(sessionId) {
  await pool.query(
    "UPDATE portal_sessions SET usage_count = usage_count + 1 WHERE id = $1",
    [sessionId]
  );
}

async function cleanExpiredSessions() {
  var res = await pool.query(
    "DELETE FROM portal_sessions WHERE expires_at < NOW() RETURNING id"
  );
  return res.rowCount;
}

// ══════════════════════════════════════════════════════════════
// PORTAL API — Analysis logging (de-identified, no PII)
// ══════════════════════════════════════════════════════════════

async function logAnalysis(data) {
  var res = await pool.query(
    "INSERT INTO portal_analysis_log (analysis_id, vendor_id, email_count, deal_health_score, deal_stage, pipeline, total_ms, pii_purged_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
    [data.analysis_id, data.vendor_id, data.email_count, data.deal_health_score,
     data.deal_stage, data.pipeline, data.total_ms, data.pii_purged_at]
  );
  return res.rows[0];
}

async function getVendorAnalytics(vendorId, days) {
  days = days || 30;
  var res = await pool.query(
    "SELECT COUNT(*) as total_analyses, " +
    "AVG(deal_health_score) as avg_health_score, " +
    "AVG(email_count) as avg_email_count, " +
    "AVG(total_ms) as avg_processing_ms, " +
    "COUNT(CASE WHEN deal_stage IN ('closed_won') THEN 1 END) as won_count, " +
    "COUNT(CASE WHEN deal_stage IN ('closed_lost') THEN 1 END) as lost_count " +
    "FROM portal_analysis_log WHERE vendor_id = $1 AND created_at > NOW() - ($2 || ' days')::interval",
    [vendorId, days.toString()]
  );
  return res.rows[0] || {};
}
