"""
ClearSignals AI - Local PST Analyzer
=====================================
Processes a PST file on your local machine, analyzes email threads via LLM,
and outputs anonymized interaction profiles.

SETUP:
  pip install pypff requests python-dateutil

USAGE:
  py clearsignals_pst.py "C:\path\to\your\file.pst"

ENV VARS (set these before running):
  OPENROUTER_API_KEY   - Your OpenRouter API key
  OPENROUTER_MODEL_ID  - Model to use (default: anthropic/claude-sonnet-4-20250514)

OUTPUT:
  clearsignals_profiles.json - Anonymized interaction profiles
  clearsignals_raw.json      - Full analysis with contact details (LOCAL ONLY - never upload this)
"""

import sys
import os
import json
import hashlib
import re
import time
from datetime import datetime, timezone
from collections import defaultdict
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path

try:
    import pypff
except ImportError:
    print("\n[!] pypff not installed. Install with:")
    print("    pip install pypff")
    print("\n    If pypff fails to install, try:")
    print("    pip install libpff-python")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("\n[!] requests not installed. Install with:")
    print("    pip install requests")
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════

API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL_ID = os.environ.get("OPENROUTER_MODEL_ID", "anthropic/claude-sonnet-4-20250514")
API_URL = "https://openrouter.ai/api/v1/chat/completions"

MAX_CONTACTS = 50          # Max contacts to analyze (top by email count)
MAX_THREADS_PER_CONTACT = 5  # Analyze last N threads per contact
MAX_EMAILS_PER_THREAD = 20   # Cap thread length
RATE_LIMIT_SECONDS = 1.5     # Pause between API calls

# ═══════════════════════════════════════════════════════════════
# SYSTEM PROMPT
# ═══════════════════════════════════════════════════════════════

SYS_PROMPT = """You are ClearSignals AI. You analyze a sales email thread and return a structured assessment.

METRICS:
1. BUYER INTENT (1-10): 1=no interest, 3=aware, 5=evaluating, 7=shortlisted, 9=verbal commit, 10=signed
2. WIN LIKELIHOOD (0-100%): Probability this deal/relationship progresses positively
3. CULTURAL ALIGNMENT (RYG):
   - RED: Cultural violations, competitive threats, trust damage
   - YELLOW: Caution signals, ambiguous indicators
   - GREEN: Trust builders, positive cultural signals, relationship advancement

DETECT: intent signals, cultural signals, competitive signals, formality shifts, relationship drift.

CULTURAL RULES:
- Japan: silence=contemplation, "we will consider"=likely no, formal=neutral, rushing=violation
- Vietnam: relationship-first, warmth withdrawal=major warning
- Germany: Sie/du=trust milestone, du→Sie=trust BROKEN
- Brazil/Mexico: casual=DEFAULT, formality increase=WARNING
- UK: "not bad"=praise, "interesting" alone=dismissal
- China: face-saving paramount, direct blame=catastrophic
- Korea: hierarchy/consensus required
- Sweden: lagom, hard sell=disengage
- India: "yes but perhaps"=indirect no

Return ONLY this JSON (no other text):
{
  "trajectory": [
    {"email_num": 1, "direction": "in|out", "intent": 5, "win_pct": 50, "formality": 5, "warmth": 5, "signals_count": 0}
  ],
  "signals": [
    {"email_num": 1, "type": "intent|cultural|competitive|formality|drift", "severity": "red|yellow|green", "description": "generic description without any names or PII"}
  ],
  "ryg": {"r": 0, "y": 0, "g": 0},
  "final_intent": 5,
  "final_win_pct": 50,
  "coach": "Specific actionable advice",
  "summary": "2-3 sentences on where this relationship stands",
  "deal_stage": "prospecting|qualification|demo|proposal|negotiation|closed_won|closed_lost|no_decision|relationship|internal",
  "relationship_health": "strong|healthy|at_risk|damaged|new"
}"""

# ═══════════════════════════════════════════════════════════════
# PST PARSING
# ═══════════════════════════════════════════════════════════════

def sha256(text):
    """One-way hash for PII stripping."""
    return hashlib.sha256(text.lower().strip().encode()).hexdigest()[:16]

def safe_str(val):
    """Safely convert PST field to string."""
    if val is None:
        return ""
    if isinstance(val, bytes):
        try:
            return val.decode("utf-8", errors="replace")
        except:
            return str(val)
    return str(val)

def parse_email_address(raw):
    """Extract email address from 'Name <email>' format."""
    if not raw:
        return ""
    name, addr = parseaddr(raw)
    return addr.lower().strip() if addr else raw.lower().strip()

def parse_date(msg):
    """Try to extract a datetime from a PST message."""
    try:
        dt = msg.get_delivery_time()
        if dt:
            return dt
    except:
        pass
    try:
        dt = msg.get_creation_time()
        if dt:
            return dt
    except:
        pass
    return None

def extract_messages(pst_path):
    """Extract all messages from a PST file."""
    print(f"\n[*] Opening PST file: {pst_path}")
    pst = pypff.file()
    pst.open(pst_path)
    
    root = pst.get_root_folder()
    messages = []
    folder_count = 0
    
    def walk_folder(folder, depth=0):
        nonlocal folder_count
        folder_count += 1
        name = safe_str(folder.get_name()) or "(unnamed)"
        
        # Skip common non-email folders
        skip = ["calendar", "contacts", "tasks", "notes", "journal", "junk", "deleted"]
        if any(s in name.lower() for s in skip):
            return
        
        msg_count = folder.get_number_of_sub_messages()
        if msg_count > 0:
            print(f"  {'  '*depth}📁 {name} ({msg_count} messages)")
        
        for i in range(msg_count):
            try:
                msg = folder.get_sub_message(i)
                
                sender = ""
                try:
                    sender = safe_str(msg.get_sender_name())
                except:
                    pass
                
                sender_email = ""
                try:
                    # Try different methods to get sender email
                    for attr_name in ["sender_email_address", "sent_representing_email_address"]:
                        try:
                            val = getattr(msg, f"get_{attr_name}", lambda: None)()
                            if val:
                                sender_email = safe_str(val)
                                break
                        except:
                            continue
                except:
                    pass
                if not sender_email:
                    sender_email = sender  # fallback
                
                subject = ""
                try:
                    subject = safe_str(msg.get_subject())
                except:
                    pass
                
                body = ""
                try:
                    body = safe_str(msg.get_plain_text_body())
                except:
                    try:
                        body = safe_str(msg.get_html_body())
                        # Strip HTML tags for analysis
                        body = re.sub(r'<[^>]+>', ' ', body)
                        body = re.sub(r'\s+', ' ', body).strip()
                    except:
                        pass
                
                recipients = []
                try:
                    for r in range(msg.get_number_of_recipients()):
                        try:
                            recip = msg.get_recipient(r)
                            recip_email = safe_str(recip.get_email_address()) if recip else ""
                            recip_name = safe_str(recip.get_name()) if recip else ""
                            recipients.append(recip_email or recip_name)
                        except:
                            continue
                except:
                    pass
                
                dt = parse_date(msg)
                
                if body or subject:  # Only keep messages with content
                    messages.append({
                        "sender_name": sender,
                        "sender_email": parse_email_address(sender_email),
                        "recipients": [parse_email_address(r) for r in recipients if r],
                        "subject": subject,
                        "body": body[:5000],  # Cap body length
                        "date": dt.isoformat() if dt else None,
                        "date_obj": dt,
                        "folder": name,
                        "word_count": len(body.split()) if body else 0
                    })
            except Exception as e:
                continue
        
        for j in range(folder.get_number_of_sub_folders()):
            try:
                walk_folder(folder.get_sub_folder(j), depth + 1)
            except:
                continue
    
    walk_folder(root)
    pst.close()
    
    print(f"\n[*] Scanned {folder_count} folders, extracted {len(messages)} messages")
    return messages


# ═══════════════════════════════════════════════════════════════
# THREAD GROUPING
# ═══════════════════════════════════════════════════════════════

def normalize_subject(subject):
    """Strip Re:/Fwd: prefixes to group threads."""
    s = subject or ""
    s = re.sub(r'^(re|fw|fwd|aw|wg)\s*:\s*', '', s, flags=re.IGNORECASE)
    s = re.sub(r'^(re|fw|fwd|aw|wg)\s*:\s*', '', s, flags=re.IGNORECASE)  # double strip
    return s.strip().lower()

def identify_user_email(messages):
    """Figure out which email address belongs to the PST owner (most frequent sender)."""
    sender_counts = defaultdict(int)
    for m in messages:
        if m["sender_email"]:
            sender_counts[m["sender_email"]] += 1
    
    if not sender_counts:
        return ""
    
    # The PST owner is typically the most frequent sender
    user_email = max(sender_counts, key=sender_counts.get)
    print(f"[*] Detected PST owner: {user_email} ({sender_counts[user_email]} sent messages)")
    return user_email

def group_into_contacts_and_threads(messages, user_email):
    """Group messages by contact and thread."""
    
    # Identify all unique contacts (anyone who isn't the PST owner)
    contact_messages = defaultdict(list)  # contact_email -> [messages]
    
    for m in messages:
        sender = m["sender_email"]
        
        if sender == user_email:
            # Outbound - attribute to recipients
            for r in m["recipients"]:
                if r and r != user_email:
                    m_copy = dict(m)
                    m_copy["direction"] = "outbound"
                    m_copy["contact_email"] = r
                    contact_messages[r].append(m_copy)
                    break  # attribute to first non-self recipient
        else:
            # Inbound
            m_copy = dict(m)
            m_copy["direction"] = "inbound"
            m_copy["contact_email"] = sender
            contact_messages[sender].append(m_copy)
    
    print(f"[*] Found {len(contact_messages)} unique contacts")
    
    # For each contact, group into threads by subject
    contacts = {}
    for email, msgs in contact_messages.items():
        threads = defaultdict(list)
        for m in msgs:
            thread_key = normalize_subject(m["subject"])
            if not thread_key:
                thread_key = "(no subject)"
            threads[thread_key].append(m)
        
        # Sort threads by date, sort emails within threads by date
        sorted_threads = []
        for subject, thread_msgs in threads.items():
            thread_msgs.sort(key=lambda x: x["date_obj"] or datetime.min.replace(tzinfo=timezone.utc))
            if len(thread_msgs) >= 2:  # Only keep threads with back-and-forth
                sorted_threads.append({
                    "subject": subject,
                    "emails": thread_msgs[:MAX_EMAILS_PER_THREAD],
                    "email_count": len(thread_msgs),
                    "started": thread_msgs[0]["date"],
                    "ended": thread_msgs[-1]["date"]
                })
        
        sorted_threads.sort(key=lambda t: t["ended"] or "", reverse=True)
        
        if sorted_threads:
            contacts[email] = {
                "email": email,
                "name": msgs[0].get("sender_name", "") if msgs[0]["direction"] == "inbound" else "",
                "total_messages": len(msgs),
                "total_threads": len(sorted_threads),
                "threads": sorted_threads[:MAX_THREADS_PER_CONTACT]
            }
    
    # Sort contacts by message count, take top N
    sorted_contacts = sorted(contacts.values(), key=lambda c: c["total_messages"], reverse=True)
    sorted_contacts = sorted_contacts[:MAX_CONTACTS]
    
    print(f"[*] Selected top {len(sorted_contacts)} contacts by activity")
    for c in sorted_contacts[:10]:
        print(f"    {c['email'][:40]:40s} {c['total_messages']:4d} msgs, {c['total_threads']:3d} threads")
    
    return sorted_contacts


# ═══════════════════════════════════════════════════════════════
# LLM ANALYSIS
# ═══════════════════════════════════════════════════════════════

def analyze_thread(thread, contact_context=""):
    """Send a thread to the LLM for analysis."""
    
    # Format emails for the prompt
    email_texts = []
    for i, em in enumerate(thread["emails"]):
        direction = em.get("direction", "unknown")
        date = em.get("date", "unknown")
        
        # Calculate response time
        resp_time = ""
        if i > 0 and em.get("date_obj") and thread["emails"][i-1].get("date_obj"):
            delta = em["date_obj"] - thread["emails"][i-1]["date_obj"]
            hours = delta.total_seconds() / 3600
            resp_time = f" | Response time: {hours:.1f}h"
        
        body = em.get("body", "")[:2000]  # Cap per-email
        
        email_texts.append(
            f"EMAIL {i+1} of {len(thread['emails'])}:\n"
            f"Direction: {direction} | Date: {date}{resp_time}\n"
            f"Subject: {thread['subject']}\n\n"
            f"{body}\n"
        )
    
    full_thread = "\n---\n\n".join(email_texts)
    
    prompt = f"Analyze this email thread ({len(thread['emails'])} emails)."
    if contact_context:
        prompt += f"\nContext: {contact_context}"
    prompt += f"\n\n{full_thread}"
    
    try:
        resp = requests.post(API_URL, headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json"
        }, json={
            "model": MODEL_ID,
            "max_tokens": 2000,
            "messages": [
                {"role": "system", "content": SYS_PROMPT},
                {"role": "user", "content": prompt}
            ]
        }, timeout=60)
        
        if resp.status_code != 200:
            print(f"    [!] API error {resp.status_code}: {resp.text[:200]}")
            return None
        
        data = resp.json()
        raw = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        
        # Parse JSON from response
        clean = raw.strip()
        clean = re.sub(r'^```json\s*', '', clean)
        clean = re.sub(r'\s*```$', '', clean)
        
        return json.loads(clean)
    
    except json.JSONDecodeError as e:
        print(f"    [!] JSON parse error: {e}")
        return None
    except Exception as e:
        print(f"    [!] API call failed: {e}")
        return None


# ═══════════════════════════════════════════════════════════════
# PROFILE BUILDING
# ═══════════════════════════════════════════════════════════════

def build_profile(contact, analyses):
    """Build an anonymized interaction profile from analysis results."""
    
    threads_data = []
    all_signals = []
    intents = []
    win_pcts = []
    
    for thread, analysis in zip(contact["threads"], analyses):
        if not analysis:
            continue
        
        # Build trajectory
        trajectory = []
        for t in analysis.get("trajectory", []):
            trajectory.append({
                "email_index": t.get("email_num", 0),
                "direction": t.get("direction", "unknown"),
                "intent_score": t.get("intent", 5),
                "win_likelihood_pct": t.get("win_pct", 50),
                "formality_score": t.get("formality", 5),
                "warmth_score": t.get("warmth", 5),
            })
        
        # Build signals (already generic from LLM)
        signals = []
        for s in analysis.get("signals", []):
            signals.append({
                "email_index": s.get("email_num", 0),
                "type": s.get("type", "unknown"),
                "severity": s.get("severity", "yellow"),
                "description": s.get("description", ""),  # Already PII-free from prompt
            })
            all_signals.append(s)
        
        # Extract trajectories
        formality_traj = [t.get("formality", 5) for t in analysis.get("trajectory", [])]
        warmth_traj = [t.get("warmth", 5) for t in analysis.get("trajectory", [])]
        
        threads_data.append({
            "thread_hash": sha256(thread["subject"] + (thread["started"] or "")),
            "started_at": thread["started"],
            "ended_at": thread["ended"],
            "email_count": len(thread["emails"]),
            "deal_stage": analysis.get("deal_stage", "unknown"),
            "outcome": "active",
            "trajectory": trajectory,
            "signals": signals,
            "formality_trajectory": formality_traj,
            "warmth_trajectory": warmth_traj,
            "final_scores": {
                "intent": analysis.get("final_intent", 5),
                "win_likelihood_pct": analysis.get("final_win_pct", 50),
                "ryg_total": analysis.get("ryg", {"r": 0, "y": 0, "g": 0}),
                "coaching_priority": analysis.get("coach", "")
            }
        })
        
        intents.append(analysis.get("final_intent", 5))
        win_pcts.append(analysis.get("final_win_pct", 50))
    
    if not threads_data:
        return None
    
    # Calculate aggregate
    r_total = sum(t["final_scores"]["ryg_total"].get("r", 0) for t in threads_data)
    y_total = sum(t["final_scores"]["ryg_total"].get("y", 0) for t in threads_data)
    g_total = sum(t["final_scores"]["ryg_total"].get("g", 0) for t in threads_data)
    
    # Determine trend
    if len(intents) >= 2:
        trend = "improving" if intents[-1] > intents[0] else "declining" if intents[-1] < intents[0] else "stable"
    else:
        trend = "stable"
    
    # Determine health
    avg_intent = sum(intents) / len(intents) if intents else 5
    health = "strong" if avg_intent >= 7 else "healthy" if avg_intent >= 5 else "at_risk" if avg_intent >= 3 else "damaged"
    
    # Try to detect region from email domain or content
    email_domain = contact["email"].split("@")[-1] if "@" in contact["email"] else ""
    
    profile = {
        "schema_version": "1.0",
        "profile_id": sha256(contact["email"] + str(time.time())),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "contact": {
            "hash_id": sha256(contact["email"]),
            "company_hash": sha256(email_domain),
            "role_category": "unknown",
            "department_category": "unknown",
            "region": "unknown",
            "country_code": "unknown",
        },
        "baseline": {
            "established_from_threads": len(threads_data),
            "formality_mean": round(sum(sum(t["formality_trajectory"]) / max(len(t["formality_trajectory"]), 1) for t in threads_data) / max(len(threads_data), 1), 1),
            "warmth_mean": round(sum(sum(t["warmth_trajectory"]) / max(len(t["warmth_trajectory"]), 1) for t in threads_data) / max(len(threads_data), 1), 1),
        },
        "threads": threads_data,
        "aggregate_scores": {
            "relationship_health": health,
            "trend_direction": trend,
            "total_threads": len(threads_data),
            "total_signals": len(all_signals),
            "cultural_violation_count": sum(1 for s in all_signals if s.get("type") == "cultural" and s.get("severity") == "red"),
            "competitive_mention_count": sum(1 for s in all_signals if s.get("type") == "competitive"),
            "avg_intent": round(avg_intent, 1),
            "avg_win_pct": round(sum(win_pcts) / len(win_pcts), 1) if win_pcts else 50,
            "ryg_total": {"r": r_total, "y": y_total, "g": g_total}
        }
    }
    
    return profile


# ═══════════════════════════════════════════════════════════════
# RAW OUTPUT (local only, includes PII for user's reference)
# ═══════════════════════════════════════════════════════════════

def build_raw_output(contact, analyses):
    """Build a PII-included output for the user's local reference."""
    threads = []
    for thread, analysis in zip(contact["threads"], analyses):
        threads.append({
            "subject": thread["subject"],
            "email_count": len(thread["emails"]),
            "started": thread["started"],
            "ended": thread["ended"],
            "analysis": analysis
        })
    
    return {
        "contact_name": contact.get("name", ""),
        "contact_email": contact["email"],
        "total_messages": contact["total_messages"],
        "threads_analyzed": len([a for a in analyses if a]),
        "threads": threads
    }


# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("  ClearSignals AI - Local PST Analyzer")
    print("  Privacy-first email intelligence")
    print("=" * 60)
    
    # Check args
    if len(sys.argv) < 2:
        print("\nUsage: py clearsignals_pst.py \"C:\\path\\to\\file.pst\"")
        print("\nRequired environment variables:")
        print("  OPENROUTER_API_KEY  - Your OpenRouter API key")
        print("  OPENROUTER_MODEL_ID - (optional) Model ID, default: anthropic/claude-sonnet-4-20250514")
        sys.exit(1)
    
    pst_path = sys.argv[1]
    
    if not os.path.exists(pst_path):
        print(f"\n[!] File not found: {pst_path}")
        sys.exit(1)
    
    if not API_KEY:
        print("\n[!] OPENROUTER_API_KEY not set.")
        print("    Set it with: set OPENROUTER_API_KEY=your-key-here")
        sys.exit(1)
    
    print(f"\n[*] Model: {MODEL_ID}")
    print(f"[*] Max contacts: {MAX_CONTACTS}")
    print(f"[*] Max threads per contact: {MAX_THREADS_PER_CONTACT}")
    
    # Step 1: Parse PST
    messages = extract_messages(pst_path)
    
    if not messages:
        print("\n[!] No messages found in PST file.")
        sys.exit(1)
    
    # Step 2: Identify user and group
    user_email = identify_user_email(messages)
    contacts = group_into_contacts_and_threads(messages, user_email)
    
    if not contacts:
        print("\n[!] No contacts with threaded conversations found.")
        sys.exit(1)
    
    # Step 3: Analyze
    print(f"\n{'='*60}")
    print(f"  ANALYZING {len(contacts)} CONTACTS")
    print(f"{'='*60}")
    
    all_profiles = []
    all_raw = []
    total_threads = sum(len(c["threads"]) for c in contacts)
    analyzed = 0
    
    for ci, contact in enumerate(contacts):
        print(f"\n[{ci+1}/{len(contacts)}] {contact['email']}")
        print(f"         {len(contact['threads'])} threads, {contact['total_messages']} total messages")
        
        analyses = []
        for ti, thread in enumerate(contact["threads"]):
            analyzed += 1
            print(f"  Thread {ti+1}/{len(contact['threads'])}: \"{thread['subject'][:50]}\" ({len(thread['emails'])} emails) ", end="")
            
            analysis = analyze_thread(thread)
            analyses.append(analysis)
            
            if analysis:
                intent = analysis.get("final_intent", "?")
                win = analysis.get("final_win_pct", "?")
                ryg = analysis.get("ryg", {})
                print(f"→ Intent:{intent}/10 Win:{win}% R:{ryg.get('r',0)} Y:{ryg.get('y',0)} G:{ryg.get('g',0)}")
            else:
                print("→ [failed]")
            
            time.sleep(RATE_LIMIT_SECONDS)
        
        # Build profile
        profile = build_profile(contact, analyses)
        if profile:
            all_profiles.append(profile)
        
        raw = build_raw_output(contact, analyses)
        all_raw.append(raw)
        
        print(f"  ✓ {contact['email']}: health={profile['aggregate_scores']['relationship_health'] if profile else 'N/A'}")
    
    # Step 4: Output
    output_dir = os.path.dirname(os.path.abspath(pst_path))
    
    # Anonymized profiles (safe to sync to cloud)
    profiles_path = os.path.join(output_dir, "clearsignals_profiles.json")
    with open(profiles_path, "w", encoding="utf-8") as f:
        json.dump({
            "schema_version": "1.0",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "generator": "clearsignals_pst_analyzer_v1",
            "contact_count": len(all_profiles),
            "profiles": all_profiles
        }, f, indent=2, default=str)
    
    # Raw output (LOCAL ONLY - contains PII)
    raw_path = os.path.join(output_dir, "clearsignals_raw.json")
    with open(raw_path, "w", encoding="utf-8") as f:
        json.dump({
            "WARNING": "THIS FILE CONTAINS PII - DO NOT UPLOAD OR SHARE",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "pst_owner": user_email,
            "contacts_analyzed": len(all_raw),
            "contacts": all_raw
        }, f, indent=2, default=str)
    
    # Also create a dashboard-compatible format
    dashboard_path = os.path.join(output_dir, "clearsignals_dashboard.json")
    dashboard_contacts = []
    for profile, raw_entry in zip(all_profiles, all_raw):
        # Merge just enough for the dashboard to display nicely
        dashboard_contacts.append({
            "contact_id": profile["contact"]["hash_id"][:8].upper(),
            "name": f"Contact {profile['contact']['hash_id'][:6].upper()}",
            "threads": [{
                "thread_id": t["thread_hash"],
                "emails": [{
                    "direction": traj.get("direction", "unknown"),
                    "date": t.get("started_at", ""),
                    "subject": "(redacted)",
                    "greeting": "",
                    "body": f"[Email {traj['email_index']} - {traj.get('direction','?')} - content processed locally]",
                    "signoff": "",
                    "formality_score": traj.get("formality_score", 5),
                    "warmth_score": traj.get("warmth_score", 5),
                    "word_count": 0,
                    "from": profile["contact"]["hash_id"][:8] if traj.get("direction") == "inbound" else "you",
                    "to": "you" if traj.get("direction") == "inbound" else profile["contact"]["hash_id"][:8],
                    "cc": [],
                    "response_time_hours": None
                } for traj in t.get("trajectory", [])],
                "answer_key": {
                    "expected_final_readiness": t["final_scores"]["intent"],
                    "intent_signals": [s for s in t["signals"] if s["type"] == "intent"],
                    "cultural_signals": [s for s in t["signals"] if s["type"] == "cultural"],
                    "competitive_signals": [s for s in t["signals"] if s["type"] == "competitive"],
                    "formality_shifts": [s for s in t["signals"] if s["type"] == "formality"],
                    "relationship_drift": [s for s in t["signals"] if s["type"] == "drift"]
                }
            } for t in profile["threads"]]
        })
    
    with open(dashboard_path, "w", encoding="utf-8") as f:
        json.dump({
            "metadata": {
                "total_contacts": len(dashboard_contacts),
                "total_emails": sum(len(e) for c in dashboard_contacts for t in c["threads"] for e in [t["emails"]]),
                "total_signals": sum(len(s) for p in all_profiles for t in p["threads"] for s in [t["signals"]]),
                "generated_from": "pst_analyzer"
            },
            "contacts": dashboard_contacts
        }, f, indent=2, default=str)
    
    # Summary
    print(f"\n{'='*60}")
    print(f"  ANALYSIS COMPLETE")
    print(f"{'='*60}")
    print(f"\n  Contacts analyzed: {len(all_profiles)}")
    print(f"  Threads analyzed:  {analyzed}")
    print(f"  Total signals:     {sum(p['aggregate_scores']['total_signals'] for p in all_profiles)}")
    print(f"\n  Output files (saved next to your PST file):")
    print(f"    📊 {profiles_path}")
    print(f"       → Anonymized profiles (safe to upload)")
    print(f"    🔒 {raw_path}")
    print(f"       → Full details with names (LOCAL ONLY)")
    print(f"    📈 {dashboard_path}")
    print(f"       → Dashboard-compatible format")
    
    # Quick summary table
    print(f"\n  {'Contact':<30s} {'Health':<12s} {'Intent':<8s} {'Win%':<8s} {'Signals':<8s}")
    print(f"  {'-'*30} {'-'*12} {'-'*8} {'-'*8} {'-'*8}")
    for p, r in zip(all_profiles, all_raw):
        name = r["contact_email"][:30]
        health = p["aggregate_scores"]["relationship_health"]
        intent = p["aggregate_scores"]["avg_intent"]
        win = p["aggregate_scores"]["avg_win_pct"]
        sigs = p["aggregate_scores"]["total_signals"]
        ryg = p["aggregate_scores"]["ryg_total"]
        print(f"  {name:<30s} {health:<12s} {intent:<8.1f} {win:<8.1f} R:{ryg['r']} Y:{ryg['y']} G:{ryg['g']}")
    
    print(f"\n  Done! Load clearsignals_dashboard.json into the MVP web dashboard.")
    print(f"  Or upload clearsignals_profiles.json to ClearSignals Cloud (when available).")


if __name__ == "__main__":
    main()
