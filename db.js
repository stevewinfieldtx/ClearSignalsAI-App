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
    `);
    console.log('[DB] Tables ready');
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
  getDifferentialBatch
};
