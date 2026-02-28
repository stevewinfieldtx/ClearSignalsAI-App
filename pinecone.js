// ============================================================
// ClearSignals AI — Pinecone Vector Memory Service
// Handles: Deal pattern storage, similarity search,
//          CPP profile storage, Intent signal matching
// ============================================================

const { Pinecone } = require('@pinecone-database/pinecone');

// Index names
const INDEXES = {
  DEALS:   'clearsignals-deals',    // Closed-won/lost deal patterns
  CPP:     'clearsignals-cpp',      // Creator Personality Profiles
  INTENTS: 'clearsignals-intents',  // Intent signal patterns
};

// Embedding dimension for text-embedding-3-small (OpenAI via OpenRouter)
const EMBED_DIM = 1536;

let pc = null;

// ── Init ─────────────────────────────────────────────────────
function getPinecone() {
  if (!pc) {
    const key = process.env.PINECONE_API_KEY;
    if (!key) throw new Error('PINECONE_API_KEY not set in environment');
    pc = new Pinecone({ apiKey: key });
  }
  return pc;
}

// ── Embed text via OpenRouter (text-embedding-3-small) ───────
async function embedText(text) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://clearsignals.ai',
      'X-Title': 'ClearSignals AI'
    },
    body: JSON.stringify({
      model: 'openai/text-embedding-3-small',
      input: text.slice(0, 8000) // safe token limit
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Embedding API error: ' + err.slice(0, 200));
  }

  const data = await response.json();
  return data.data[0].embedding;
}

// ── Ensure indexes exist (run once on startup) ────────────────
async function initIndexes() {
  const client = getPinecone();
  const existing = await client.listIndexes();
  const existingNames = (existing.indexes || []).map(i => i.name);

  for (const [key, name] of Object.entries(INDEXES)) {
    if (!existingNames.includes(name)) {
      console.log('[Pinecone] Creating index:', name);
      await client.createIndex({
        name,
        dimension: EMBED_DIM,
        metric: 'cosine',
        spec: { serverless: { cloud: 'aws', region: 'us-east-1' } }
      });
      console.log('[Pinecone] Index created:', name);
    } else {
      console.log('[Pinecone] Index exists:', name);
    }
  }
}

// ── Store a completed deal analysis ──────────────────────────
// Call this after every /api/analyze that has a final.deal_stage
async function storeDeal(threadId, analysisResult, emailText) {
  try {
    const client = getPinecone();
    const index = client.index(INDEXES.DEALS);
    const final = analysisResult.final || {};
    const dealStage = final.deal_stage || 'unknown';

    // Build a rich text summary to embed — captures the "story" of the deal
    const dealSummary = [
      'Deal Stage: ' + dealStage,
      'Intent Score: ' + (final.intent || 0),
      'Win Probability: ' + (final.win_pct || 0) + '%',
      'Contact: ' + (analysisResult.contact_name || ''),
      'Company: ' + (analysisResult.company_name || ''),
      'Summary: ' + (final.summary || ''),
      'Coaching: ' + (final.coach || ''),
      'Signals: ' + (final.signals || []).map(s => s.desc).join('. '),
      'Outcome context: ' + (final.next_steps || '')
    ].join('\n');

    const vector = await embedText(dealSummary);

    await index.upsert([{
      id: threadId,
      values: vector,
      metadata: {
        thread_id: threadId,
        deal_stage: dealStage,
        intent: final.intent || 0,
        win_pct: final.win_pct || 0,
        contact_name: analysisResult.contact_name || '',
        company_name: analysisResult.company_name || '',
        rep_name: analysisResult.rep_name || '',
        summary: (final.summary || '').slice(0, 500),
        coach: (final.coach || '').slice(0, 500),
        email_count: (analysisResult.parsed_emails || []).length,
        stored_at: new Date().toISOString(),
        is_won: dealStage === 'closed_won',
        is_lost: dealStage === 'closed_lost'
      }
    }]);

    console.log('[Pinecone] Stored deal:', threadId, '|', dealStage);
    return { success: true, thread_id: threadId };
  } catch (err) {
    console.error('[Pinecone] storeDeal error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Find similar deals to a live thread ──────────────────────
// Returns top matches with won/lost context
async function findSimilarDeals(analysisResult, topK = 5) {
  try {
    const client = getPinecone();
    const index = client.index(INDEXES.DEALS);
    const final = analysisResult.final || {};

    const queryText = [
      'Summary: ' + (final.summary || ''),
      'Signals: ' + (final.signals || []).map(s => s.desc).join('. '),
      'Deal Stage: ' + (final.deal_stage || ''),
      'Intent: ' + (final.intent || 0),
      'Coach notes: ' + (final.coach || '')
    ].join('\n');

    const vector = await embedText(queryText);

    const results = await index.query({
      vector,
      topK,
      includeMetadata: true
    });

    const matches = (results.matches || []).map(m => ({
      thread_id: m.id,
      similarity: Math.round(m.score * 100) / 100,
      deal_stage: m.metadata.deal_stage,
      is_won: m.metadata.is_won,
      is_lost: m.metadata.is_lost,
      contact_name: m.metadata.contact_name,
      company_name: m.metadata.company_name,
      intent: m.metadata.intent,
      win_pct: m.metadata.win_pct,
      summary: m.metadata.summary,
      coach: m.metadata.coach,
      email_count: m.metadata.email_count
    }));

    // Split into won/lost for clarity
    const won = matches.filter(m => m.is_won);
    const lost = matches.filter(m => m.is_lost);
    const other = matches.filter(m => !m.is_won && !m.is_lost);

    return {
      success: true,
      total_matches: matches.length,
      won_matches: won.length,
      lost_matches: lost.length,
      won,
      lost,
      other,
      all: matches
    };
  } catch (err) {
    console.error('[Pinecone] findSimilarDeals error:', err.message);
    return { success: false, error: err.message, won: [], lost: [], other: [], all: [] };
  }
}

// ── Store Creator Personality Profile (CPP) ──────────────────
async function storeCPP(userId, cppData) {
  try {
    const client = getPinecone();
    const index = client.index(INDEXES.CPP);

    const profileText = [
      'Writing style: ' + (cppData.style_summary || ''),
      'Vocabulary level: ' + (cppData.vocabulary_level || ''),
      'Avg sentence length: ' + (cppData.avg_sentence_length || ''),
      'Formality score: ' + (cppData.formality_score || ''),
      'Warmth score: ' + (cppData.warmth_score || ''),
      'Signature phrases: ' + (cppData.signature_phrases || []).join(', '),
      'Punctuation patterns: ' + (cppData.punctuation_patterns || ''),
      'Sample text: ' + (cppData.sample || '')
    ].join('\n');

    const vector = await embedText(profileText);

    await index.upsert([{
      id: 'cpp_' + userId,
      values: vector,
      metadata: {
        user_id: userId,
        ...cppData,
        updated_at: new Date().toISOString()
      }
    }]);

    console.log('[Pinecone] Stored CPP for user:', userId);
    return { success: true, user_id: userId };
  } catch (err) {
    console.error('[Pinecone] storeCPP error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Retrieve CPP for a user ───────────────────────────────────
async function getCPP(userId) {
  try {
    const client = getPinecone();
    const index = client.index(INDEXES.CPP);
    const result = await index.fetch(['cpp_' + userId]);
    const record = result.records?.['cpp_' + userId];
    if (!record) return { success: false, error: 'No CPP found for user: ' + userId };
    return { success: true, user_id: userId, metadata: record.metadata };
  } catch (err) {
    console.error('[Pinecone] getCPP error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Pinecone stats (for health/debug) ────────────────────────
async function getStats() {
  try {
    const client = getPinecone();
    const stats = {};
    for (const [key, name] of Object.entries(INDEXES)) {
      try {
        const idx = client.index(name);
        const s = await idx.describeIndexStats();
        stats[key] = {
          name,
          total_vectors: s.totalVectorCount || 0,
          dimension: s.dimension || EMBED_DIM
        };
      } catch(e) {
        stats[key] = { name, error: e.message };
      }
    }
    return { success: true, indexes: stats };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  initIndexes,
  storeDeal,
  findSimilarDeals,
  storeCPP,
  getCPP,
  getStats,
  embedText
};
