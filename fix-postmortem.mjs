// fix-postmortem.mjs
// Run from C:\Users\steve\Documents\ClearSignalsAI with: node fix-postmortem.mjs
//
// Fixes two issues:
// 1. cleanJSON() fails on truncated LLM responses (JSON parse failed)
// 2. Postmortem mode needs more tokens than 16000

import { readFileSync, writeFileSync } from 'fs';

// =========================================
// FIX server.js
// =========================================
let src = readFileSync('server.js', 'utf8');

// --- FIX 1: Replace cleanJSON with truncation-resilient version ---
// Find exact boundaries
const cjStart = src.indexOf('\nfunction cleanJSON(raw) {');
if (cjStart === -1) { console.error('ERROR: Cannot find cleanJSON in server.js'); process.exit(1); }

// Find the closing of the function - it ends with the throw line + }
const throwLine = "throw new Error('JSON parse failed. First 300: ' + s.slice(0, 300));\n}";
const cjEnd = src.indexOf(throwLine, cjStart);
if (cjEnd === -1) { console.error('ERROR: Cannot find end of cleanJSON in server.js'); process.exit(1); }

const oldFn = src.slice(cjStart + 1, cjEnd + throwLine.length); // +1 to skip leading \n

const newFn = `function cleanJSON(raw) {
  var s = (raw || '');
  s = s.replace(/\`\`\`json\\s*/gi, '').replace(/\`\`\`/g, '').trim();
  var f = s.indexOf('{');
  var l = s.lastIndexOf('}');
  if (f < 0 || l < 0) throw new Error('No JSON object found in response');
  s = s.slice(f, l + 1);

  // Attempt 1: direct parse
  try { return JSON.parse(s); } catch(e) {}

  // Attempt 2: fix trailing commas
  var fix = s.replace(/,\\s*([}\\]])/g, '$1');
  try { return JSON.parse(fix); } catch(e) {}

  // Attempt 3: escape control chars
  fix = fix.replace(/[\\x00-\\x1f]/g, function(c) {
    if (c === '\\n') return '\\\\n'; if (c === '\\r') return '\\\\r'; if (c === '\\t') return '\\\\t'; return '';
  });
  try { return JSON.parse(fix); } catch(e) {}

  // Attempt 4: repair truncated JSON (model ran out of tokens mid-response)
  var repaired = fix;
  var inStr = false, esc = false, braces = 0, brackets = 0;
  for (var i = 0; i < repaired.length; i++) {
    var c = repaired[i];
    if (esc) { esc = false; continue; }
    if (c === '\\\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') braces++;
    if (c === '}') braces--;
    if (c === '[') brackets++;
    if (c === ']') brackets--;
  }
  // Close open string
  if (inStr) repaired += '"';
  // Strip dangling partial values
  repaired = repaired.replace(/,\\s*"[^"]*"\\s*:\\s*"[^"]*$/, '');
  repaired = repaired.replace(/,\\s*"[^"]*"\\s*:\\s*$/, '');
  repaired = repaired.replace(/,\\s*"[^"]*$/, '');
  repaired = repaired.replace(/,\\s*$/, '');
  // Close open brackets then braces
  for (var a = 0; a < brackets; a++) repaired += ']';
  for (var b = 0; b < braces; b++) repaired += '}';
  try {
    var result = JSON.parse(repaired);
    console.log('[cleanJSON] Repaired truncated JSON successfully');
    return result;
  } catch(e) {}

  throw new Error('JSON parse failed. First 300: ' + s.slice(0, 300));
}`;

src = src.replace(oldFn, newFn);
console.log('[server.js] Replaced cleanJSON with truncation-repair version');

// --- FIX 2: Bump postmortem tokens ---
// Two-stage path: the callLLM for stage2 uses 16000
// Change to dynamic based on mode
src = src.replace(
  `'Analyze this ' + emailCount + '-email thread. Return exactly ' + emailCount + ' per_email entries:\\n\\n' + cleanThread,
        16000)`,
  `'Analyze this ' + emailCount + '-email thread. Return exactly ' + emailCount + ' per_email entries:\\n\\n' + cleanThread,
        mode === 'postmortem' ? 32000 : 16000)`
);

// Fallback path
src = src.replace(
  `'Analyze this pasted email thread:\\n\\n' + text, 16000)`,
  `'Analyze this pasted email thread:\\n\\n' + text, mode === 'postmortem' ? 32000 : 16000)`
);

console.log('[server.js] Postmortem max_tokens bumped to 32000');

writeFileSync('server.js', src, 'utf8');
console.log('[server.js] Saved\\n');

// =========================================
// FIX routes-threads.js
// =========================================
let rt = readFileSync('routes-threads.js', 'utf8');

const rtStart = rt.indexOf('\nfunction cleanJSON(raw) {');
if (rtStart === -1) {
  console.log('[routes-threads.js] No cleanJSON found, skipping');
} else {
  const rtThrow = "throw new Error('JSON parse failed');\n}";
  const rtEnd = rt.indexOf(rtThrow, rtStart);
  if (rtEnd === -1) {
    console.log('[routes-threads.js] Cannot find end of cleanJSON, skipping');
  } else {
    const oldRtFn = rt.slice(rtStart + 1, rtEnd + rtThrow.length);
    const newRtFn = newFn.replace(
      "throw new Error('JSON parse failed. First 300: ' + s.slice(0, 300));",
      "throw new Error('JSON parse failed');"
    );
    rt = rt.replace(oldRtFn, newRtFn);
    writeFileSync('routes-threads.js', rt, 'utf8');
    console.log('[routes-threads.js] Replaced cleanJSON with truncation-repair version');
  }
}

console.log('\\n✅ Done. Now commit and push to Railway:');
console.log('   git add server.js routes-threads.js');
console.log('   git commit -m "fix: harden JSON parser for truncated postmortem responses + bump tokens"');
console.log('   git push');
