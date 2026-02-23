import { useState, useEffect, useCallback, useRef } from "react";

const C = {
  navy: "#0B1929", navy2: "#112336", blue: "#1B4F8A", sky: "#2E8BC0",
  teal: "#0D7377", gold: "#C9A84C", gold2: "#F0CC6E", red: "#C0392B",
  yellow: "#E8A020", green: "#1A7A4A", white: "#F5F7FA", gray: "#8A9BAD",
  card: "rgba(255,255,255,0.04)", bdr: "rgba(255,255,255,0.08)"
};

// Robust JSON parser that handles common LLM output issues
function cleanAndParseJSON(raw) {
  let s = raw || "";
  // Strip markdown code fences
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  // Strip any leading/trailing non-JSON text
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found in response");
  s = s.slice(firstBrace, lastBrace + 1);
  // Try parsing as-is first
  try { return JSON.parse(s); } catch(e1) {
    // Fix trailing commas before } or ]
    let fixed = s.replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(fixed); } catch(e2) {
      // Fix unescaped newlines inside strings
      fixed = fixed.replace(/(?<=":[ ]*"[^"]*)\n/g, "\\n");
      try { return JSON.parse(fixed); } catch(e3) {
        // Fix unescaped quotes inside string values (aggressive)
        fixed = fixed.replace(/"([^"]*?)"/g, (match, inner) => {
          // Only fix if it looks like a value (not a key)
          const cleaned = inner.replace(/(?<!\\)"/g, '\\"');
          return `"${cleaned}"`;
        });
        try { return JSON.parse(fixed); } catch(e4) {
          // Last resort: try to extract the main structure manually
          // Find balanced braces
          let depth = 0; let start = -1; let end = -1;
          for (let i = 0; i < s.length; i++) {
            if (s[i] === "{") { if (depth === 0) start = i; depth++; }
            if (s[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
          }
          if (start >= 0 && end > start) {
            const extracted = s.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
            try { return JSON.parse(extracted); } catch(e5) {}
          }
          throw new Error(`Could not parse JSON from LLM response. First 200 chars: ${s.slice(0, 200)}...`);
        }
      }
    }
  }
}

const SYS_FULL = `You are ClearSignals AI, a communication intelligence engine. You analyze sales email threads one email at a time.

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

Return ONLY this JSON:
{"signals":[{"type":"intent|cultural|competitive|formality|drift","desc":"description","severity":"red|yellow|green","quote":"quote"}],"ryg":{"r":0,"y":0,"g":0},"intent":5,"win_pct":50,"coach":"actionable advice","summary":"2-3 sentences on deal status"}`;

const SYS_DECIDING = `You are ClearSignals AI. You receive a COMPLETE email thread. Analyze the DECIDING EMAIL (next to last) — the moment before the outcome crystallized.

Return ONLY this JSON:
{"signals":[{"type":"intent|cultural|competitive|formality|drift","desc":"description","severity":"red|yellow|green","quote":"quote"}],"ryg":{"r":0,"y":0,"g":0},"intent":5,"win_pct":50,"coach":"what rep should have done","summary":"what made this the turning point","trajectory":[{"email_num":1,"intent":0,"win_pct":0}],"retrospective":"2-3 key moments that determined the outcome"}

trajectory = one entry per email. ryg = total across entire thread.

CULTURAL RULES: Japan(silence=contemplation,"consider"=no), Vietnam(relationship-first), Germany(Sie/du transitions), Brazil/Mexico(casual=default,formality=warning), UK("not bad"=praise), China(face-saving), Korea(consensus), Sweden(lagom), India("yes but"=no)`;

const SYS_PASTE = `You are ClearSignals AI. The user pasted a raw email with a quoted thread history at the bottom (like a forwarded email).

STEP 1: Parse the email into individual messages. Identify each message by looking for patterns like "On [date], [person] wrote:", "From:", "Sent:", reply quote markers (> or |), or separator lines (----, ____). Extract: sender, date (if visible), and body for each message. Order them OLDEST first (bottom of thread = earliest).

STEP 2: Analyze the full thread and return this JSON:

{
  "parsed_emails": [
    {"index":1,"from":"sender","date":"date if found","snippet":"first 80 chars","direction":"inbound|outbound"}
  ],
  "per_email": [
    {"email_num":1,"intent":0,"win_pct":0,"signals":[{"type":"type","desc":"desc","severity":"sev","quote":"q"}],"summary":"one sentence"}
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

parsed_emails = the messages you extracted, oldest first.
per_email = progressive analysis at each email.
final = the overall assessment after reading everything.
next_time = 1-3 specific moments where the rep could have taken a different action for a better outcome. Reference the email number. If the rep handled everything well, return a single entry with suggestion "Well played" and why explaining what they did right. Be specific and actionable — not generic advice.

If you can identify which messages are from the sales rep vs the contact, mark direction. If unclear, make your best guess based on context.

CULTURAL RULES: Japan(silence=contemplation,"consider"=no), Vietnam(relationship-first), Germany(Sie/du), Brazil/Mexico(casual=default,formality=warning), UK("not bad"=praise), China(face-saving), Korea(consensus), Sweden(lagom), India("yes but"=no)

Return ONLY valid JSON.`;

function fmtEmail(em, idx, total) {
  return `EMAIL ${idx+1} of ${total}:
Direction: ${em.direction} | From: ${em.from} | To: ${em.to} | CC: ${em.cc?.join(", ")||"none"}
Date: ${em.date} | Response time: ${em.response_time_hours!=null?em.response_time_hours+"h":"First"}
Subject: ${em.subject}
${em.greeting}
${em.body}
${em.signoff}`;
}

async function saveResult(key, data) {
  try { await window.storage.set(`cs:${key}`, JSON.stringify(data)); } catch(e) {} 
}
async function loadResult(key) {
  try { const r = await window.storage.get(`cs:${key}`); return r ? JSON.parse(r.value) : null; } catch(e) { return null; }
}
async function loadAllKeys() {
  try { const r = await window.storage.list("cs:"); return r?.keys || []; } catch(e) { return []; }
}
async function clearAll() {
  try { const keys = await loadAllKeys(); for (const k of keys) { try { await window.storage.delete(k); } catch(e) {} } } catch(e) {}
}

function Gauge({ v, mx, label, sub, color }) {
  const p = Math.round((v / mx) * 100);
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ position: "relative", width: 56, height: 56, margin: "0 auto" }}>
        <svg width="56" height="56" viewBox="0 0 56 56">
          <circle cx="28" cy="28" r="24" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3.5" />
          <circle cx="28" cy="28" r="24" fill="none" stroke={color} strokeWidth="3.5"
            strokeDasharray={`${p*1.508} 151`} strokeLinecap="round"
            transform="rotate(-90 28 28)" style={{ transition: "stroke-dasharray 0.6s" }} />
        </svg>
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          fontSize: 15, fontWeight: 700, color, fontFamily: "Georgia,serif" }}>{v}</div>
      </div>
      <div style={{ fontSize: 9, color: C.white, marginTop: 2, fontWeight: 600 }}>{label}</div>
      {sub && <div style={{ fontSize: 7, color: C.gray, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function RYGBar({ r, y, g }) {
  const t = Math.max(r+y+g, 1);
  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: "#E74C3C" }}>● {r} Threats</span>
        <span style={{ fontSize: 10, color: "#F39C12" }}>● {y} Caution</span>
        <span style={{ fontSize: 10, color: "#2ECC71" }}>● {g} Trust</span>
      </div>
      <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "rgba(255,255,255,0.06)" }}>
        {r>0&&<div style={{ width:`${(r/t)*100}%`, background:"#E74C3C", transition:"width 0.5s" }} />}
        {y>0&&<div style={{ width:`${(y/t)*100}%`, background:"#F39C12", transition:"width 0.5s" }} />}
        {g>0&&<div style={{ width:`${(g/t)*100}%`, background:"#2ECC71", transition:"width 0.5s" }} />}
      </div>
    </div>
  );
}

function SignalCard({ s }) {
  const cols = {
    red: { bg:"rgba(192,57,43,0.13)", bd:"rgba(192,57,43,0.3)", tx:"#E74C3C" },
    yellow: { bg:"rgba(232,160,32,0.13)", bd:"rgba(232,160,32,0.3)", tx:"#F39C12" },
    green: { bg:"rgba(26,122,74,0.13)", bd:"rgba(26,122,74,0.3)", tx:"#2ECC71" }
  };
  const c = cols[s.severity] || cols.yellow;
  const labels = { intent:"INTENT", cultural:"CULTURE", competitive:"COMPETE", formality:"FORMAL", drift:"DRIFT" };
  return (
    <div style={{ background:c.bg, border:`1px solid ${c.bd}`, borderRadius:6, padding:"7px 10px", marginBottom:5 }}>
      <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:2 }}>
        <span style={{ fontSize:8, fontWeight:700, letterSpacing:"0.08em", color:c.tx,
          background:"rgba(0,0,0,0.2)", padding:"1px 4px", borderRadius:2 }}>{labels[s.type]||s.type?.toUpperCase()}</span>
      </div>
      <div style={{ fontSize:12, color:C.white, lineHeight:1.4 }}>{s.desc}</div>
      {s.quote && <div style={{ fontSize:10, color:C.gray, fontStyle:"italic", marginTop:2,
        borderLeft:`2px solid ${c.bd}`, paddingLeft:5 }}>"{s.quote}"</div>}
    </div>
  );
}

function TrajChart({ data, width=230, height=40 }) {
  if (!data || data.length < 2) return null;
  const mx = data.length;
  const xs = (width-20)/Math.max(mx-1,1);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {data.map((d,i) => {
        if (i===0) return null;
        const p = data[i-1];
        const x1=10+(i-1)*xs, x2=10+i*xs;
        const y1=height-4-(p.win_pct||50)*(height-8)/100;
        const y2=height-4-(d.win_pct||50)*(height-8)/100;
        const col=(d.win_pct||50)>=65?C.green:(d.win_pct||50)>=35?C.yellow:C.red;
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth="2" />;
      })}
      {data.map((d,i) => {
        const x=10+i*xs, y=height-4-(d.win_pct||50)*(height-8)/100;
        const col=(d.win_pct||50)>=65?C.green:(d.win_pct||50)>=35?C.yellow:C.red;
        return <circle key={i} cx={x} cy={y} r="3" fill={col} />;
      })}
    </svg>
  );
}

// ═══ PASTE MODE PANEL ═══
function PasteMode({ onBack }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [viewIdx, setViewIdx] = useState(-1); // -1 = final summary
  const panelRef = useRef(null);

  const analyze = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 8000, system: SYS_PASTE,
          messages: [{ role: "user", content: `Analyze this pasted email thread:\n\n${text}` }] })
      });
      const d = await resp.json();
      const raw = d.content?.map(b => b.text||"").join("")||"";
      const parsed = cleanAndParseJSON(raw);
      setResult(parsed);
      setViewIdx(-1);
      // Save to persistent storage
      const key = `paste-${Date.now()}`;
      await saveResult(key, { text: text.slice(0, 200), result: parsed, timestamp: new Date().toISOString() });
    } catch(ex) { setErr("Analysis failed: " + ex.message); }
    setBusy(false);
  };

  const curPerEmail = viewIdx >= 0 && result?.per_email?.[viewIdx];
  const curFinal = viewIdx === -1 && result?.final;
  const cur = curPerEmail || curFinal;
  const traj = result?.per_email?.map(e => ({ email_num: e.email_num, intent: e.intent, win_pct: e.win_pct }));

  return (
    <div style={{ display: "flex", height: "calc(100vh - 44px)" }}>
      {/* Left: paste area + parsed emails */}
      <div style={{ width: 320, borderRight: `1px solid ${C.bdr}`, overflowY: "auto", padding: 12, flexShrink: 0 }}>
        <button onClick={onBack} style={{ padding: "5px 10px", background: "rgba(255,255,255,0.05)",
          color: C.gray, border: `1px solid ${C.bdr}`, borderRadius: 4, fontSize: 10, cursor: "pointer", marginBottom: 8 }}>
          ← Back</button>

        {!result ? (
          <>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.12em", color: C.gray, marginBottom: 6 }}>
              PASTE EMAIL THREAD</div>
            <textarea value={text} onChange={e => setText(e.target.value)}
              placeholder={"Paste your email here.\n\nInclude the full thread — the quoted replies at the bottom are where the signals live.\n\nExample:\nHi Alex,\n\nThanks for the follow-up...\n\nBest,\nDavid\n\nOn Jan 15, Alex Morgan wrote:\n> Hi David,\n> Just wanted to check in on...\n> Best, Alex"}
              style={{
                width: "100%", height: 280, background: "rgba(255,255,255,0.03)",
                border: `1px solid ${C.bdr}`, borderRadius: 6, padding: 10,
                color: C.white, fontSize: 12, fontFamily: "monospace", lineHeight: 1.5,
                resize: "vertical", outline: "none", boxSizing: "border-box"
              }} />
            <button onClick={analyze} disabled={busy || !text.trim()} style={{
              width: "100%", padding: "10px 0", marginTop: 8,
              background: busy ? "rgba(255,255,255,0.05)" : C.gold,
              color: busy ? C.gray : C.navy, border: "none", borderRadius: 5,
              fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
              cursor: busy || !text.trim() ? "default" : "pointer" }}>
              {busy ? "Analyzing thread..." : "Analyze Thread"}
            </button>
            {err && <div style={{ color: C.red, fontSize: 11, marginTop: 6 }}>{err}</div>}
          </>
        ) : (
          <>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.12em", color: C.gray, marginBottom: 6 }}>
              PARSED THREAD ({result.parsed_emails?.length || 0} emails)</div>

            {/* Trajectory */}
            {traj && traj.length > 1 && (
              <div style={{ background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 5,
                padding: "6px 8px", marginBottom: 8 }}>
                <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.1em", color: C.gray, marginBottom: 2 }}>
                  WIN LIKELIHOOD</div>
                <TrajChart data={traj} width={285} height={40} />
              </div>
            )}

            {/* Final summary card */}
            <div onClick={() => setViewIdx(-1)} style={{
              background: viewIdx===-1 ? "rgba(201,168,76,0.1)" : C.card,
              border: `1px solid ${viewIdx===-1 ? C.gold : C.bdr}`,
              borderLeft: `3px solid ${C.gold}`, borderRadius: "0 5px 5px 0",
              padding: "7px 9px", marginBottom: 6, cursor: "pointer" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.gold }}>Overall Assessment</div>
              <div style={{ fontSize: 9, color: C.gray }}>
                Intent: {result.final?.intent}/10 · Win: {result.final?.win_pct}%</div>
            </div>

            {/* Per-email cards */}
            {result.parsed_emails?.map((em, idx) => {
              const pe = result.per_email?.[idx];
              const bc = !pe ? C.bdr : (pe.win_pct>=65?C.green:pe.win_pct>=35?C.yellow:C.red);
              return (
                <div key={idx} onClick={() => pe && setViewIdx(idx)} style={{
                  background: viewIdx===idx ? "rgba(255,255,255,0.07)" : C.card,
                  border: `1px solid ${viewIdx===idx ? C.gold : C.bdr}`,
                  borderLeft: `3px solid ${bc}`, borderRadius: "0 5px 5px 0",
                  padding: "6px 8px", marginBottom: 4, cursor: pe ? "pointer" : "default" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.06em",
                        color: em.direction==="inbound" ? C.sky : C.gold,
                        background: em.direction==="inbound" ? "rgba(46,139,192,0.15)" : "rgba(201,168,76,0.15)",
                        padding: "1px 4px", borderRadius: 2 }}>
                        {em.direction==="inbound"?"IN":em.direction==="outbound"?"OUT":"?"}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: C.white }}>#{em.index||idx+1}</span>
                    </div>
                    {pe && <span style={{ fontSize: 9, fontWeight: 600,
                      color: pe.win_pct>=65?C.green:pe.win_pct>=35?C.yellow:C.red }}>{pe.win_pct}%</span>}
                  </div>
                  <div style={{ fontSize: 9, color: C.gray, marginTop: 1 }}>
                    {em.from && <span>{em.from} </span>}
                    {em.date && <span style={{ opacity: 0.7 }}>· {em.date}</span>}
                  </div>
                  <div style={{ fontSize: 9, color: C.gray, marginTop: 1, whiteSpace: "nowrap",
                    overflow: "hidden", textOverflow: "ellipsis" }}>{em.snippet}</div>
                </div>
              );
            })}

            <button onClick={() => { setResult(null); setText(""); }} style={{
              width: "100%", padding: "7px 0", marginTop: 8, background: "rgba(255,255,255,0.05)",
              color: C.gray, border: `1px solid ${C.bdr}`, borderRadius: 4,
              fontSize: 10, cursor: "pointer" }}>Paste Another Email</button>
          </>
        )}
      </div>

      {/* Right: analysis panel */}
      <div ref={panelRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {cur ? (
          <>
            {/* Scores */}
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
              <Gauge v={cur.intent||5} mx={10} label="Buyer Intent" sub="Purchase readiness"
                color={(cur.intent||5)>=7?C.green:(cur.intent||5)>=4?C.yellow:C.red} />
              <Gauge v={cur.win_pct||50} mx={100} label="Win %" sub="Deal probability"
                color={(cur.win_pct||50)>=65?C.green:(cur.win_pct||50)>=35?C.yellow:C.red} />
              {(cur.ryg || curFinal?.ryg) && (
                <div style={{ flex: 1, paddingTop: 6 }}>
                  <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", color: C.gray, marginBottom: 3 }}>
                    CULTURAL ALIGNMENT</div>
                  <RYGBar r={(cur.ryg||curFinal?.ryg)?.r||0} y={(cur.ryg||curFinal?.ryg)?.y||0}
                    g={(cur.ryg||curFinal?.ryg)?.g||0} />
                </div>
              )}
            </div>

            {/* Summary */}
            {cur.summary && (
              <div style={{ background: "rgba(13,115,119,0.08)", border: `1px solid rgba(13,115,119,0.18)`,
                borderRadius: 5, padding: "8px 12px", marginBottom: 10 }}>
                <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.1em", color: C.teal, marginBottom: 3 }}>
                  {viewIdx===-1 ? "OVERALL DEAL STATUS" : `STATUS AT EMAIL ${viewIdx+1}`}</div>
                <div style={{ fontSize: 12, color: C.white, lineHeight: 1.6 }}>{cur.summary}</div>
              </div>
            )}

            {/* Next steps (paste final only) */}
            {viewIdx===-1 && curFinal?.next_steps && (
              <div style={{ background: "rgba(27,79,138,0.1)", border: `1px solid rgba(46,139,192,0.2)`,
                borderRadius: 5, padding: "8px 12px", marginBottom: 10 }}>
                <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.1em", color: C.sky, marginBottom: 3 }}>
                  RECOMMENDED NEXT STEPS</div>
                <div style={{ fontSize: 12, color: C.white, lineHeight: 1.6 }}>{curFinal.next_steps}</div>
              </div>
            )}

            {/* Next Time coaching (paste final only) */}
            {viewIdx===-1 && curFinal?.next_time?.length > 0 && (
              <div style={{ background: "rgba(201,168,76,0.06)", border: `1px solid rgba(201,168,76,0.15)`,
                borderRadius: 6, padding: "10px 14px", marginBottom: 10 }}>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.12em", color: C.gold, marginBottom: 8 }}>
                  {curFinal.next_time.length === 1 && curFinal.next_time[0].suggestion === "Well played"
                    ? "✓ GREAT JOB" : "NEXT TIME..."}</div>
                {curFinal.next_time.map((nt, i) => (
                  <div key={i} style={{ marginBottom: i < curFinal.next_time.length - 1 ? 10 : 0 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <div style={{ minWidth: 22, height: 22, borderRadius: "50%",
                        background: nt.suggestion === "Well played" ? "rgba(26,122,74,0.2)" : "rgba(201,168,76,0.15)",
                        border: `1px solid ${nt.suggestion === "Well played" ? "rgba(26,122,74,0.4)" : "rgba(201,168,76,0.3)"}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 9, fontWeight: 700, color: nt.suggestion === "Well played" ? C.green : C.gold,
                        marginTop: 1 }}>
                        {nt.at_email ? `#${nt.at_email}` : (i + 1)}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: C.gold2, fontWeight: 600, lineHeight: 1.4, marginBottom: 2 }}>
                          {nt.suggestion}</div>
                        <div style={{ fontSize: 11, color: C.gray, lineHeight: 1.5 }}>{nt.why}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Export button (paste final only) */}
            {viewIdx===-1 && result && (
              <button onClick={() => {
                const f = result.final || {};
                const emails = result.parsed_emails || [];
                const perEmail = result.per_email || [];
                const nt = f.next_time || [];
                
                let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ClearSignals Analysis</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f8f9fa; color: #333; }
  h1 { font-size: 18px; color: #0B1929; border-bottom: 3px solid #C9A84C; padding-bottom: 8px; }
  h2 { font-size: 14px; color: #1B4F8A; margin-top: 20px; }
  .scores { display: flex; gap: 30px; margin: 16px 0; padding: 16px; background: #0B1929; border-radius: 8px; }
  .score { text-align: center; }
  .score .val { font-size: 28px; font-weight: 700; font-family: Georgia, serif; }
  .score .lbl { font-size: 10px; color: #8A9BAD; text-transform: uppercase; letter-spacing: 0.1em; }
  .intent { color: ${(f.intent||5)>=7?'#1A7A4A':(f.intent||5)>=4?'#E8A020':'#C0392B'}; }
  .win { color: ${(f.win_pct||50)>=65?'#1A7A4A':(f.win_pct||50)>=35?'#E8A020':'#C0392B'}; }
  .ryg span { padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; margin-right: 6px; }
  .r { background: #fde8e8; color: #C0392B; } .y { background: #fef6e0; color: #E8A020; } .g { background: #e6f5ed; color: #1A7A4A; }
  .box { background: white; border: 1px solid #e0e0e0; border-radius: 6px; padding: 12px 16px; margin: 10px 0; }
  .box .title { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 6px; }
  .summary .title { color: #0D7377; } .coaching .title { color: #C9A84C; } .nextsteps .title { color: #1B4F8A; } .nexttime .title { color: #C9A84C; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12px; }
  th { background: #0B1929; color: white; padding: 6px 10px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
  td { padding: 6px 10px; border-bottom: 1px solid #e8e8e8; vertical-align: top; }
  tr:nth-child(even) { background: #f5f5f5; }
  .signal { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; margin: 1px; }
  .sig-red { background: #fde8e8; color: #C0392B; } .sig-yellow { background: #fef6e0; color: #E8A020; } .sig-green { background: #e6f5ed; color: #1A7A4A; }
  .nt-num { display: inline-block; width: 20px; height: 20px; border-radius: 50%; background: #fef6e0; color: #C9A84C; text-align: center; line-height: 20px; font-size: 10px; font-weight: 700; margin-right: 8px; }
  .footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 10px; color: #999; }
</style></head><body>`;
                
                html += `<h1>ClearSignals AI\u2122 — Thread Analysis</h1>`;
                html += `<div class="scores">
                  <div class="score"><div class="val intent">${f.intent||'?'}/10</div><div class="lbl">Buyer Intent</div></div>
                  <div class="score"><div class="val win">${f.win_pct||'?'}%</div><div class="lbl">Win Likelihood</div></div>
                  <div class="score"><div class="ryg"><span class="r">\u25CF ${f.ryg?.r||0} Threats</span><span class="y">\u25CF ${f.ryg?.y||0} Caution</span><span class="g">\u25CF ${f.ryg?.g||0} Trust</span></div><div class="lbl" style="margin-top:6px">Signal Summary</div></div>
                  <div class="score"><div class="val" style="color:#8A9BAD;font-size:16px">${f.deal_stage||'unknown'}</div><div class="lbl">Deal Stage</div></div>
                </div>`;
                
                html += `<div class="box summary"><div class="title">Deal Status</div>${f.summary||''}</div>`;
                html += `<div class="box coaching"><div class="title">Coaching</div>${f.coach||''}</div>`;
                if (f.next_steps) html += `<div class="box nextsteps"><div class="title">Next Steps</div>${f.next_steps}</div>`;
                
                if (nt.length > 0) {
                  html += `<div class="box nexttime"><div class="title">${nt.length===1 && nt[0].suggestion==='Well played' ? 'Great Job' : 'Next Time...'}</div>`;
                  nt.forEach(n => { html += `<div style="margin-bottom:8px"><span class="nt-num">${n.at_email||'?'}</span><strong>${n.suggestion}</strong><br><span style="color:#666;font-size:11px">${n.why}</span></div>`; });
                  html += `</div>`;
                }
                
                html += `<h2>Email-by-Email Progression</h2>`;
                html += `<table><tr><th>#</th><th>Dir</th><th>From</th><th>Date</th><th>Intent</th><th>Win%</th><th>Signals</th><th>Summary</th></tr>`;
                emails.forEach((em, i) => {
                  const pe = perEmail[i] || {};
                  const sigs = (pe.signals||[]).map(s => `<span class="signal sig-${s.severity}">${s.type}</span>`).join(' ');
                  html += `<tr><td>${em.index||i+1}</td><td>${(em.direction||'?').slice(0,3).toUpperCase()}</td><td>${em.from||''}</td><td style="white-space:nowrap">${em.date||''}</td><td style="text-align:center">${pe.intent||'-'}</td><td style="text-align:center">${pe.win_pct||'-'}%</td><td>${sigs||'-'}</td><td>${pe.summary||''}</td></tr>`;
                });
                html += `</table>`;
                
                if (f.signals?.length > 0) {
                  html += `<h2>All Signals Detected</h2><table><tr><th>Type</th><th>Severity</th><th>Description</th><th>Quote</th></tr>`;
                  f.signals.forEach(s => {
                    html += `<tr><td><span class="signal sig-${s.severity}">${s.type}</span></td><td>${s.severity}</td><td>${s.desc||s.description||''}</td><td style="font-style:italic;color:#666">${s.quote||''}</td></tr>`;
                  });
                  html += `</table>`;
                }
                
                html += `<div class="footer">Generated by ClearSignals AI\u2122 \u2014 ${new Date().toLocaleString()}</div></body></html>`;
                
                const blob = new Blob([html], { type: "text/html" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = `ClearSignals_Analysis_${new Date().toISOString().slice(0,10)}.html`;
                a.click(); URL.revokeObjectURL(url);
              }} style={{
                width: "100%", padding: "10px 0", marginTop: 6, marginBottom: 16,
                background: "rgba(27,79,138,0.15)", border: `1px solid rgba(46,139,192,0.3)`,
                color: C.sky, borderRadius: 5, fontSize: 11, fontWeight: 700,
                letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer" }}>
                Export Analysis Report
              </button>
            )}

            {/* Coaching */}
            {cur.coach && (
              <div style={{ background: "rgba(201,168,76,0.06)", border: `1px solid rgba(201,168,76,0.15)`,
                borderRadius: 5, padding: "8px 12px", marginBottom: 10 }}>
                <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.1em", color: C.gold, marginBottom: 3 }}>COACHING</div>
                <div style={{ fontSize: 12, color: C.gold2, lineHeight: 1.5 }}>{cur.coach}</div>
              </div>
            )}

            {/* Signals */}
            {cur.signals?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.1em", color: C.gray, marginBottom: 5 }}>
                  SIGNALS ({cur.signals.length})</div>
                {cur.signals.map((s,i) => <SignalCard key={i} s={s} />)}
              </div>
            )}
          </>
        ) : busy ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 14, color: C.gold, marginBottom: 6 }}>Analyzing pasted thread...</div>
              <div style={{ fontSize: 11, color: C.gray }}>Parsing emails, detecting signals, scoring deal health</div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%" }}>
            <div style={{ fontSize: 36, opacity: 0.15, marginBottom: 8 }}>📋</div>
            <p style={{ color: C.gray, fontSize: 13, textAlign: "center", maxWidth: 300 }}>
              Paste an email with thread history and click Analyze.<br/><br/>
              Include the full quoted thread at the bottom — that's where the relationship signals live.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══ DATABASE MODE ═══
function DatabaseMode({ data, contacts, savedResults, setSavedResults, onBack }) {
  const [sel, setSel] = useState(null);
  const [thread, setThread] = useState(null);
  const [viewIdx, setViewIdx] = useState(0);
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [history, setHistory] = useState([]);
  const [mode, setMode] = useState(null);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef(false);
  const panelRef = useRef(null);

  const pick = useCallback((c) => {
    setSel(c); setThread(c.thread); setViewIdx(0);
    setMode(null); setPlaying(false); setErr(null); setHistory([]);
    const saved = savedResults[c.id];
    if (saved) { setResults(saved.results||{}); setMode(saved.mode||null); }
    else { setResults({}); }
  }, [savedResults]);

  useEffect(() => {
    if (!sel || !mode || Object.keys(results).length === 0) return;
    const payload = { mode, results, timestamp: new Date().toISOString() };
    saveResult(sel.id, payload);
    setSavedResults(prev => ({ ...prev, [sel.id]: payload }));
  }, [results, sel, mode, setSavedResults]);

  const totalEmails = thread?.emails?.length || 0;
  const decidingIdx = Math.max(0, totalEmails - 2);
  const nDone = Object.keys(results).filter(k=>k!=="deciding").length;
  const allDone = mode === "all" && nDone === totalEmails;
  const decidingDone = mode === "deciding" && results["deciding"];

  const analyzeNext = useCallback(async () => {
    if (!thread || busy) return;
    const idx = Object.keys(results).filter(k=>k!=="deciding").length;
    if (idx >= totalEmails) return;
    setBusy(true); setErr(null);
    try {
      const em = thread.emails[idx];
      const txt = fmtEmail(em, idx, totalEmails);
      const msgs = [...history, { role: "user", content: txt }];
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 2000, system: SYS_FULL, messages: msgs })
      });
      const d = await resp.json();
      const raw = d.content?.map(b=>b.text||"").join("")||"";
      const parsed = cleanAndParseJSON(raw);
      setResults(prev => ({ ...prev, [idx]: parsed }));
      setHistory([...msgs, { role: "assistant", content: raw }]);
      setViewIdx(idx);
      setTimeout(() => panelRef.current?.scrollTo({ top:0, behavior:"smooth" }), 100);
    } catch(ex) { setErr("Error: " + ex.message); }
    setBusy(false);
  }, [thread, results, busy, history, totalEmails]);

  const analyzeDeciding = useCallback(async () => {
    if (!thread || busy) return;
    setBusy(true); setErr(null);
    try {
      const allEmails = thread.emails.map((em,i) => fmtEmail(em,i,totalEmails)).join("\n\n---\n\n");
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 3000, system: SYS_DECIDING,
          messages: [{ role: "user", content: `Thread (${totalEmails} emails). Deciding = #${decidingIdx+1}.\n\n${allEmails}` }] })
      });
      const d = await resp.json();
      const raw = d.content?.map(b=>b.text||"").join("")||"";
      const parsed = cleanAndParseJSON(raw);
      setResults({ deciding: parsed }); setViewIdx(decidingIdx); setMode("deciding");
      setTimeout(() => panelRef.current?.scrollTo({ top:0, behavior:"smooth" }), 100);
    } catch(ex) { setErr("Error: " + ex.message); }
    setBusy(false);
  }, [thread, busy, totalEmails, decidingIdx]);

  useEffect(() => { playRef.current = playing; }, [playing]);
  useEffect(() => {
    if (!playing||busy||!thread||mode!=="all") return;
    if (Object.keys(results).filter(k=>k!=="deciding").length >= totalEmails) { setPlaying(false); return; }
    const t = setTimeout(() => { if (playRef.current) analyzeNext(); }, 600);
    return () => clearTimeout(t);
  }, [playing, busy, results, thread, mode, totalEmails, analyzeNext]);

  const cur = mode==="deciding" ? results["deciding"] : results[viewIdx];
  const ak = thread?.answer_key;
  const traj = mode==="all"
    ? Object.keys(results).filter(k=>k!=="deciding").sort((a,b)=>a-b).map(k=>({ email_num:parseInt(k)+1, intent:results[k]?.intent||5, win_pct:results[k]?.win_pct||50 }))
    : mode==="deciding"&&results["deciding"]?.trajectory ? results["deciding"].trajectory : [];

  return (
    <div style={{ display: "flex", height: "calc(100vh - 44px)" }}>
      {/* Sidebar */}
      <div style={{ width: 220, borderRight: `1px solid ${C.bdr}`, overflowY: "auto", background: C.navy2, flexShrink: 0 }}>
        <div style={{ padding: "8px 10px" }}>
          <button onClick={onBack} style={{ padding: "4px 8px", background: "rgba(255,255,255,0.05)",
            color: C.gray, border: `1px solid ${C.bdr}`, borderRadius: 3, fontSize: 9, cursor: "pointer", marginBottom: 6 }}>
            ← Home</button>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.12em", color: C.gray }}>CONTACTS</div>
        </div>
        {contacts.map(c => {
          const hasSaved = !!savedResults[c.id];
          return (
            <div key={c.id} onClick={() => pick(c)} style={{
              padding: "7px 10px", cursor: "pointer", borderBottom: `1px solid ${C.bdr}`,
              background: sel?.id===c.id ? "rgba(201,168,76,0.08)" : "transparent",
              borderLeft: sel?.id===c.id ? `3px solid ${C.gold}` : "3px solid transparent" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: C.white }}>{c.id}</span>
                {hasSaved && <span style={{ fontSize: 7, color: C.green, fontWeight: 700,
                  background: "rgba(26,122,74,0.2)", padding: "1px 3px", borderRadius: 2 }}>✓</span>}
              </div>
              <div style={{ fontSize: 9, color: C.gray }}>{c.eCount} emails · Exp: {c.expReady}/10</div>
            </div>
          );
        })}
      </div>

      {/* Main area */}
      {!thread ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <p style={{ color: C.gray }}>← Select a contact</p></div>
      ) : (
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Email list */}
          <div style={{ width: 250, borderRight: `1px solid ${C.bdr}`, overflowY: "auto", padding: 10, flexShrink: 0 }}>
            {!mode && (
              <div style={{ marginBottom: 10 }}>
                <button onClick={() => { setMode("all"); setResults({}); setHistory([]); setViewIdx(0); setPlaying(true); }}
                  disabled={busy} style={{ width: "100%", padding: "9px 10px", background: "rgba(13,115,119,0.15)",
                  border: `1px solid rgba(13,115,119,0.3)`, borderRadius: 5, cursor: "pointer", textAlign: "left", marginBottom: 5 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.teal }}>▶ Analyze All</div>
                  <div style={{ fontSize: 9, color: C.gray }}>Email by email, watch scores evolve</div>
                </button>
                <button onClick={() => { setMode("deciding"); setResults({}); setHistory([]); analyzeDeciding(); }}
                  disabled={busy} style={{ width: "100%", padding: "9px 10px", background: "rgba(201,168,76,0.1)",
                  border: `1px solid rgba(201,168,76,0.25)`, borderRadius: 5, cursor: "pointer", textAlign: "left" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.gold }}>⎯ Deciding Email</div>
                  <div style={{ fontSize: 9, color: C.gray }}>Email #{decidingIdx+1} — the turning point</div>
                </button>
              </div>
            )}

            {mode && (
              <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                <button onClick={() => { setMode(null); setResults({}); setHistory([]); setPlaying(false); }}
                  style={{ padding: "4px 8px", background: "rgba(255,255,255,0.05)", color: C.gray,
                    border: `1px solid ${C.bdr}`, borderRadius: 3, fontSize: 9, cursor: "pointer" }}>←</button>
                {mode==="all" && <>
                  <button onClick={analyzeNext} disabled={busy||allDone} style={{
                    flex: 1, padding: "5px 0", background: busy?"rgba(255,255,255,0.05)":C.teal,
                    color: busy?C.gray:C.white, border: "none", borderRadius: 3,
                    fontSize: 9, fontWeight: 700, cursor: busy||allDone?"default":"pointer", opacity: allDone?0.4:1 }}>
                    {busy?"...":allDone?"Done":`#${nDone+1}`}</button>
                  <button onClick={()=>setPlaying(!playing)} disabled={allDone} style={{
                    padding: "5px 10px", background: playing?C.red:"rgba(255,255,255,0.06)",
                    color: C.white, border: `1px solid ${C.bdr}`, borderRadius: 3,
                    fontSize: 9, cursor: allDone?"default":"pointer", opacity: allDone?0.4:1 }}>
                    {playing?"■":"▶"}</button>
                </>}
                {mode==="deciding" && busy && <span style={{ fontSize: 10, color: C.gold, padding: "4px 0" }}>Analyzing...</span>}
              </div>
            )}

            {traj.length>1 && (
              <div style={{ background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 4, padding: "5px 7px", marginBottom: 6 }}>
                <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.1em", color: C.gray, marginBottom: 2 }}>TRAJECTORY</div>
                <TrajChart data={traj} width={220} height={36} />
              </div>
            )}

            {thread.emails.map((em, idx) => {
              const isDeciding = idx===decidingIdx;
              const isLast = idx===totalEmails-1;
              const a = mode==="all"?results[idx]:(mode==="deciding"&&isDeciding?results["deciding"]:null);
              const bc = !a?C.bdr:(a.win_pct>=65?C.green:a.win_pct>=35?C.yellow:C.red);
              return (
                <div key={idx} onClick={() => { if(mode==="all"&&results[idx]) setViewIdx(idx); if(mode==="deciding"&&isDeciding) setViewIdx(idx); }}
                  style={{ background: viewIdx===idx&&a?"rgba(255,255,255,0.07)":C.card,
                    border: `1px solid ${viewIdx===idx&&a?C.gold:C.bdr}`,
                    borderLeft: `3px solid ${isDeciding&&mode==="deciding"?C.gold:bc}`,
                    borderRadius: "0 4px 4px 0", padding: "5px 7px", marginBottom: 3,
                    cursor: a?"pointer":"default", opacity: a?1:0.35, transition: "all 0.2s" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      <span style={{ fontSize: 7, fontWeight: 700, color: em.direction==="inbound"?C.sky:C.gold,
                        background: em.direction==="inbound"?"rgba(46,139,192,0.15)":"rgba(201,168,76,0.15)",
                        padding: "0 3px", borderRadius: 2 }}>{em.direction==="inbound"?"IN":"OUT"}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: C.white }}>#{idx+1}</span>
                      {isDeciding&&<span style={{ fontSize: 6, color: C.gold, fontWeight: 700 }}>DECIDING</span>}
                      {isLast&&<span style={{ fontSize: 6, color: C.gray, fontWeight: 700 }}>FINAL</span>}
                    </div>
                    {a&&<span style={{ fontSize: 8, fontWeight: 600, color: a.win_pct>=65?C.green:a.win_pct>=35?C.yellow:C.red }}>{a.win_pct}%</span>}
                  </div>
                  <div style={{ fontSize: 8, color: C.gray, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {em.body?.slice(0,45)}...</div>
                </div>
              );
            })}
          </div>

          {/* Analysis */}
          <div ref={panelRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            {err && <div style={{ background:"rgba(192,57,43,0.15)", border:`1px solid rgba(192,57,43,0.3)`,
              borderRadius:5, padding:"8px 12px", marginBottom:10, fontSize:11, color:"#E74C3C" }}>{err}</div>}
            {cur ? (
              <>
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
                  <Gauge v={cur.intent||5} mx={10} label="Buyer Intent" sub="Purchase readiness"
                    color={(cur.intent||5)>=7?C.green:(cur.intent||5)>=4?C.yellow:C.red} />
                  <Gauge v={cur.win_pct||50} mx={100} label="Win %" sub="Deal probability"
                    color={(cur.win_pct||50)>=65?C.green:(cur.win_pct||50)>=35?C.yellow:C.red} />
                  <div style={{ flex:1, paddingTop:6 }}>
                    <div style={{ fontSize:8, fontWeight:700, letterSpacing:"0.1em", color:C.gray, marginBottom:3 }}>CULTURAL ALIGNMENT</div>
                    <RYGBar r={cur.ryg?.r||0} y={cur.ryg?.y||0} g={cur.ryg?.g||0} />
                  </div>
                </div>
                {cur.summary && (
                  <div style={{ background:"rgba(13,115,119,0.08)", border:`1px solid rgba(13,115,119,0.18)`, borderRadius:5, padding:"8px 12px", marginBottom:10 }}>
                    <div style={{ fontSize:7, fontWeight:700, letterSpacing:"0.1em", color:C.teal, marginBottom:3 }}>
                      {mode==="deciding"?"TURNING POINT":`STATUS — EMAIL ${viewIdx+1}`}</div>
                    <div style={{ fontSize:12, color:C.white, lineHeight:1.6 }}>{cur.summary}</div>
                  </div>
                )}
                {cur.retrospective && (
                  <div style={{ background:"rgba(27,79,138,0.1)", border:`1px solid rgba(46,139,192,0.2)`, borderRadius:5, padding:"8px 12px", marginBottom:10 }}>
                    <div style={{ fontSize:7, fontWeight:700, letterSpacing:"0.1em", color:C.sky, marginBottom:3 }}>WHAT DETERMINED THE OUTCOME</div>
                    <div style={{ fontSize:12, color:C.white, lineHeight:1.6 }}>{cur.retrospective}</div>
                  </div>
                )}
                {cur.coach && (
                  <div style={{ background:"rgba(201,168,76,0.06)", border:`1px solid rgba(201,168,76,0.15)`, borderRadius:5, padding:"8px 12px", marginBottom:10 }}>
                    <div style={{ fontSize:7, fontWeight:700, letterSpacing:"0.1em", color:C.gold, marginBottom:3 }}>COACHING</div>
                    <div style={{ fontSize:12, color:C.gold2, lineHeight:1.5 }}>{cur.coach}</div>
                  </div>
                )}
                {cur.signals?.length>0 && (
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:7, fontWeight:700, letterSpacing:"0.1em", color:C.gray, marginBottom:5 }}>SIGNALS ({cur.signals.length})</div>
                    {cur.signals.map((s,i) => <SignalCard key={i} s={s} />)}
                  </div>
                )}
                {/* Email content for db mode */}
                {thread.emails[viewIdx] && (
                  <div style={{ background:C.card, border:`1px solid ${C.bdr}`, borderRadius:5, padding:"10px 14px", marginBottom:10 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                      <span style={{ fontSize:10, color:C.gray }}>{thread.emails[viewIdx].from}</span>
                      <span style={{ fontSize:9, color:C.gray }}>{thread.emails[viewIdx].date?.split("T")[0]}</span>
                    </div>
                    <div style={{ fontSize:12, color:C.white, lineHeight:1.7, whiteSpace:"pre-wrap" }}>
                      <strong>{thread.emails[viewIdx].greeting}</strong>{"\n\n"}{thread.emails[viewIdx].body}{"\n\n"}
                      <em style={{color:C.gray}}>{thread.emails[viewIdx].signoff}</em>
                    </div>
                  </div>
                )}
                {(allDone||decidingDone)&&ak && (
                  <div style={{ background:"rgba(27,79,138,0.08)", border:`1px solid rgba(46,139,192,0.15)`, borderRadius:5, padding:"10px 14px" }}>
                    <div style={{ fontSize:7, fontWeight:700, letterSpacing:"0.1em", color:C.sky, marginBottom:8 }}>ANSWER KEY</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                      <div><div style={{ fontSize:9, color:C.gray }}>AI Intent</div>
                        <div style={{ fontSize:18, fontWeight:700, color:C.white, fontFamily:"Georgia,serif" }}>{cur.intent||"?"}/10</div></div>
                      <div><div style={{ fontSize:9, color:C.gray }}>Expected</div>
                        <div style={{ fontSize:18, fontWeight:700, color:C.sky, fontFamily:"Georgia,serif" }}>{ak.expected_final_readiness}/10</div></div>
                      <div><div style={{ fontSize:9, color:C.gray }}>Delta</div>
                        {(()=>{ const d=Math.abs((cur.intent||5)-(ak.expected_final_readiness||5));
                          return <div style={{ fontSize:18, fontWeight:700, fontFamily:"Georgia,serif",
                            color:d<=1?C.green:d<=2?C.yellow:C.red }}>±{d}</div>; })()}</div>
                    </div>
                  </div>
                )}
              </>
            ) : busy ? (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%" }}>
                <div style={{ fontSize:13, color:C.gold }}>Analyzing...</div></div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%" }}>
                <div style={{ fontSize:32, opacity:0.15, marginBottom:6 }}>📊</div>
                <p style={{ color:C.gray, fontSize:12 }}>Choose analysis mode to start</p></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ MAIN APP ═══
export default function App() {
  const [screen, setScreen] = useState("home"); // home | paste | database
  const [data, setData] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [savedResults, setSavedResults] = useState({});

  useEffect(() => { loadAllKeys().then(keys => {
    const loaded = {};
    Promise.all(keys.filter(k=>k.startsWith("cs:")).map(async k => {
      const r = await loadResult(k.replace("cs:",""));
      if (r) loaded[k.replace("cs:","")] = r;
    })).then(() => setSavedResults(loaded));
  }); }, []);

  const handleFile = useCallback((e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const d = JSON.parse(ev.target.result);
        setData(d);
        setContacts(d.contacts.map(c => {
          const lt = c.threads[c.threads.length-1];
          return { id:c.contact_id, name:c.name||c.contact_id, thread:lt,
            tCount:c.threads.length, eCount:lt.emails.length,
            expReady:lt.answer_key?.expected_final_readiness };
        }));
        setScreen("database");
      } catch(ex) { alert("Parse error: " + ex.message); }
    };
    r.readAsText(f);
  }, []);

  const handleClear = async () => { await clearAll(); setSavedResults({}); };

  // ═══ HEADER (shared) ═══
  const Header = () => (
    <div style={{ background:"rgba(11,25,41,0.95)", borderBottom:`1px solid ${C.bdr}`,
      padding:"0 16px", height:44, display:"flex", alignItems:"center", justifyContent:"space-between",
      position:"sticky", top:0, zIndex:100, backdropFilter:"blur(12px)" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }} onClick={()=>setScreen("home")}>
        <span style={{ fontFamily:"Georgia,serif", fontSize:14, color:C.gold2 }}>
          Clear<span style={{ color:C.white }}>Signals</span></span>
        <span style={{ fontSize:8, color:C.teal, fontWeight:700, letterSpacing:"0.12em",
          background:"rgba(13,115,119,0.15)", padding:"2px 6px", borderRadius:3 }}>MVP</span>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        {data && <span style={{ fontSize:10, color:C.gray }}>{data.metadata?.total_contacts} contacts loaded</span>}
        <button onClick={handleClear} style={{ fontSize:8, color:C.gray, background:"none",
          border:`1px solid ${C.bdr}`, borderRadius:3, padding:"2px 6px", cursor:"pointer" }}>Clear Saved</button>
      </div>
    </div>
  );

  // ═══ HOME ═══
  if (screen === "home") {
    return (
      <div style={{ minHeight:"100vh", background:C.navy, color:C.white, fontFamily:"'DM Sans',-apple-system,sans-serif" }}>
        <Header />
        <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"calc(100vh - 44px)" }}>
          <div style={{ textAlign:"center", maxWidth:520 }}>
            <div style={{ fontSize:12, fontWeight:600, letterSpacing:"0.2em", color:C.teal, marginBottom:8 }}>CLEARSIGNALS AI™</div>
            <h1 style={{ fontSize:28, fontWeight:700, marginBottom:4, fontFamily:"Georgia,serif" }}>Communication Intelligence</h1>
            <p style={{ fontSize:13, color:C.gray, lineHeight:1.7, marginBottom:28 }}>
              Detect buyer intent, cultural misalignment, competitive threats, and relationship drift from email communication.</p>

            <div style={{ display:"flex", gap:12, justifyContent:"center", marginBottom:32 }}>
              {/* Paste option */}
              <div onClick={()=>setScreen("paste")} style={{
                width:200, padding:"20px 16px", background:C.card, border:`1px solid ${C.bdr}`,
                borderRadius:8, cursor:"pointer", textAlign:"left", transition:"all 0.2s" }}>
                <div style={{ fontSize:24, marginBottom:8 }}>📋</div>
                <div style={{ fontSize:14, fontWeight:700, color:C.gold, marginBottom:4 }}>Paste an Email</div>
                <div style={{ fontSize:11, color:C.gray, lineHeight:1.5 }}>
                  Paste any email with its thread history. Get instant analysis.</div>
              </div>

              {/* Database option */}
              <label style={{
                width:200, padding:"20px 16px", background:C.card, border:`1px solid ${C.bdr}`,
                borderRadius:8, cursor:"pointer", textAlign:"left", transition:"all 0.2s", display:"block" }}>
                <div style={{ fontSize:24, marginBottom:8 }}>📊</div>
                <div style={{ fontSize:14, fontWeight:700, color:C.teal, marginBottom:4 }}>Load Test Database</div>
                <div style={{ fontSize:11, color:C.gray, lineHeight:1.5 }}>
                  Upload JSON database. Analyze last thread per contact.</div>
                <input type="file" accept=".json" onChange={handleFile} style={{ display:"none" }} />
              </label>
            </div>

            {/* Metric definitions */}
            <div style={{ background:C.card, border:`1px solid ${C.bdr}`, borderRadius:8, padding:16,
              textAlign:"left", maxWidth:440, margin:"0 auto" }}>
              <div style={{ fontSize:9, fontWeight:700, letterSpacing:"0.12em", color:C.teal, marginBottom:8 }}>WHAT WE MEASURE</div>
              <div style={{ fontSize:12, color:C.white, marginBottom:8, lineHeight:1.6 }}>
                <strong style={{ color:C.gold2 }}>Buyer Intent (1-10)</strong> — How close to purchasing? Based on commitment language, hedging, stakeholder moves, question depth.</div>
              <div style={{ fontSize:12, color:C.white, marginBottom:8, lineHeight:1.6 }}>
                <strong style={{ color:C.gold2 }}>Win Likelihood (0-100%)</strong> — Overall probability the deal closes, combining all signal types.</div>
              <div style={{ fontSize:12, color:C.white, lineHeight:1.6 }}>
                <strong style={{ color:C.gold2 }}>Cultural Alignment (RYG)</strong><br/>
                <span style={{ color:"#E74C3C" }}>● Red = Threats</span> — Cultural violations, competitor danger, trust damage<br/>
                <span style={{ color:"#F39C12" }}>● Yellow = Caution</span> — Ambiguous signals, minor misalignment<br/>
                <span style={{ color:"#2ECC71" }}>● Green = Trust</span> — Relationship builders, positive cultural signals</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═══ PASTE MODE ═══
  if (screen === "paste") {
    return (
      <div style={{ minHeight:"100vh", background:C.navy, color:C.white, fontFamily:"'DM Sans',-apple-system,sans-serif" }}>
        <Header />
        <PasteMode onBack={()=>setScreen("home")} />
      </div>
    );
  }

  // ═══ DATABASE MODE ═══
  if (screen === "database" && data) {
    return (
      <div style={{ minHeight:"100vh", background:C.navy, color:C.white, fontFamily:"'DM Sans',-apple-system,sans-serif" }}>
        <Header />
        <DatabaseMode data={data} contacts={contacts} savedResults={savedResults}
          setSavedResults={setSavedResults} onBack={()=>setScreen("home")} />
      </div>
    );
  }

  return null;
}
