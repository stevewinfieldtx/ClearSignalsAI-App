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
from email.utils import parseaddr
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

MAX_CONTACTS = 50
MAX_THREADS_PER_CONTACT = 5
MAX_EMAILS_PER_THREAD = 20
RATE_LIMIT_SECONDS = 1.5

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
- Germany: Sie/du=trust milestone, du->Sie=trust BROKEN
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
    return hashlib.sha256(text.lower().strip().encode()).hexdigest()[:16]

def safe_str(val):
    if val is None:
        return ""
    if isinstance(val, bytes):
        try:
            return val.decode("utf-8", errors="replace")
        except:
            return str(val)
    return str(val)

def parse_email_address(raw):
    if not raw:
        return ""
    name, addr = parseaddr(raw)
    return addr.lower().strip() if addr else raw.lower().strip()

def parse_date(msg):
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
        
        skip = ["calendar", "contacts", "tasks", "notes", "journal", "junk", "deleted"]
        if any(s in name.lower() for s in skip):
            return
        
        msg_count = folder.get_number_of_sub_messages()
        if msg_count > 0:
            print(f"  {'  '*depth}  {name} ({msg_count} messages)")
        
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
                    sender_email = sender
                
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
                
                if body or subject:
                    messages.append({
                        "sender_name": sender,
                        "sender_email": parse_email_address(sender_email),
                        "recipients": [parse_email_address(r) for r in recipients if r],
                        "subject": subject,
                        "body": body[:5000],
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
    s = subject or ""
    s = re.sub(r'^(re|fw|fwd|aw|wg)\s*:\s*', '', s, flags=re.IGNORECASE)
    s = re.sub(r'^(re|fw|fwd|aw|wg)\s*:\s*', '', s, flags=re.IGNORECASE)
    return s.strip().lower()

def identify_user_email(messages):
    sender_counts = defaultdict(int)
    for m in messages:
        if m["sender_email"]:
            sender_counts[m["sender_email"]] += 1
    
    if not sender_counts:
        return ""
    
    user_email = max(sender_counts, key=sender_counts.get)
    print(f"[*] Detected PST owner: {user_email} ({sender_counts[user_email]} sent messages)")
    return user_email

def group_into_contacts_and_threads(messages, user_email):
    contact_messages = defaultdict(list)
    
    for m in messages:
        sender = m["sender_email"]
        
        if sender == user_email:
            for r in m["recipients"]:
                if r and r != user_email:
                    m_copy = dict(m)
                    m_copy["direction"] = "outbound"
                    m_copy["contact_email"] = r
                    contact_messages[r].append(m_copy)
                    break
        else:
            m_copy = dict(m)
            m_copy["direction"] = "inbound"
            m_copy["contact_email"] = sender
            contact_messages[sender].append(m_copy)
    
    print(f"[*] Found {len(contact_messages)} unique contacts")
    
    contacts = {}
    for email, msgs in contact_messages.items():
        threads = defaultdict(list)
        for m in msgs:
            thread_key = normalize_subject(m["subject"])
            if not thread_key:
                thread_key = "(no subject)"
            threads[thread_key].append(m)
        
        sorted_threads = []
        for subject, thread_msgs in threads.items():
            thread_msgs.sort(key=lambda x: x["date_obj"] or datetime.min.replace(tzinfo=timezone.utc))
            if len(thread_msgs) >= 2:
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
    
    sorted_contacts = sorted(contacts.values(), key=lambda c: c["total_messages"], reverse=True)
    sorted_contacts = sorted_contacts[:MAX_CONTACTS]
    
    print(f"[*] Selected top {len(sorted_contacts)} contacts by activity")
    for c in sorted_contacts[:10]:
        print(f"    {c['email'][:40]:40s} {c['total_messages']:4d} msgs, {c['total_threads']:3d} threads")
    
    return sorted_contacts


# ═══════════════════════════════════════════════════════════════
# LLM ANALYSIS
# ═══════════════════════════════════════════════════════════════

def analyze_thread(thread):
    email_texts = []
    for i, em in enumerate(thread["emails"]):
        direction = em.get("direction", "unknown")
        date = em.get("date", "unknown")
        
        resp_time = ""
        if i > 0 and em.get("date_obj") and thread["emails"][i-1].get("date_obj"):
            delta = em["date_obj"] - thread["emails"][i-1]["date_obj"]
            hours = delta.total_seconds() / 3600
            resp_time = f" | Response time: {hours:.1f}h"
        
        body = em.get("body", "")[:2000]
        
        email_texts.append(
            f"EMAIL {i+1} of {len(thread['emails'])}:\n"
            f"Direction: {direction} | Date: {date}{resp_time}\n"
            f"Subject: {thread['subject']}\n\n"
            f"{body}\n"
        )
    
    full_thread = "\n---\n\n".join(email_texts)
    prompt = f"Analyze this email thread ({len(thread['emails'])} emails).\n\n{full_thread}"
    
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
    threads_data = []
    all_signals = []
    intents = []
    win_pcts = []
    
    for thread, analysis in zip(contact["threads"], analyses):
        if not analysis:
            continue
        
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
        
        signals = []
        for s in analysis.get("signals", []):
            signals.append({
                "email_index": s.get("email_num", 0),
                "type": s.get("type", "unknown"),
                "severity": s.get("severity", "yellow"),
                "description": s.get("description", ""),
            })
            all_signals.append(s)
        
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
    
    r_total = sum(t["final_scores"]["ryg_total"].get("r", 0) for t in threads_data)
    y_total = sum(t["final_scores"]["ryg_total"].get("y", 0) for t in threads_data)
    g_total = sum(t["final_scores"]["ryg_total"].get("g", 0) for t in threads_data)
    
    avg_intent = sum(intents) / len(intents) if intents else 5
    
    if len(intents) >= 2:
        trend = "improving" if intents[-1] > intents[0] else "declining" if intents[-1] < intents[0] else "stable"
    else:
        trend = "stable"
    
    health = "strong" if avg_intent >= 7 else "healthy" if avg_intent >= 5 else "at_risk" if avg_intent >= 3 else "damaged"
    
    email_domain = contact["email"].split("@")[-1] if "@" in contact["email"] else ""
    
    return {
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


# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("  ClearSignals AI - Local PST Analyzer")
    print("  Privacy-first email intelligence")
    print("=" * 60)
    
    if len(sys.argv) < 2:
        print('\nUsage: py clearsignals_pst.py "C:\\path\\to\\file.pst"')
        print("\nRequired environment variables:")
        print("  OPENROUTER_API_KEY  - Your OpenRouter API key")
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
    
    # Step 1: Parse PST
    messages = extract_messages(pst_path)
    if not messages:
        print("\n[!] No messages found in PST file.")
        sys.exit(1)
    
    # Step 2: Group
    user_email = identify_user_email(messages)
    contacts = group_into_contacts_and_threads(messages, user_email)
    if not contacts:
        print("\n[!] No threaded conversations found.")
        sys.exit(1)
    
    # Step 3: Analyze
    print(f"\n{'='*60}")
    print(f"  ANALYZING {len(contacts)} CONTACTS")
    print(f"{'='*60}")
    
    all_profiles = []
    all_raw = []
    
    for ci, contact in enumerate(contacts):
        print(f"\n[{ci+1}/{len(contacts)}] {contact['email']}")
        print(f"         {len(contact['threads'])} threads, {contact['total_messages']} total messages")
        
        analyses = []
        for ti, thread in enumerate(contact["threads"]):
            print(f"  Thread {ti+1}/{len(contact['threads'])}: \"{thread['subject'][:50]}\" ({len(thread['emails'])} emails) ", end="")
            
            analysis = analyze_thread(thread)
            analyses.append(analysis)
            
            if analysis:
                intent = analysis.get("final_intent", "?")
                win = analysis.get("final_win_pct", "?")
                ryg = analysis.get("ryg", {})
                print(f"-> Intent:{intent}/10 Win:{win}% R:{ryg.get('r',0)} Y:{ryg.get('y',0)} G:{ryg.get('g',0)}")
            else:
                print("-> [failed]")
            
            time.sleep(RATE_LIMIT_SECONDS)
        
        profile = build_profile(contact, analyses)
        if profile:
            all_profiles.append(profile)
        
        all_raw.append({
            "contact_name": contact.get("name", ""),
            "contact_email": contact["email"],
            "total_messages": contact["total_messages"],
            "threads": [{"subject": t["subject"], "email_count": len(t["emails"]),
                         "analysis": a} for t, a in zip(contact["threads"], analyses)]
        })
    
    # Step 4: Output
    output_dir = os.path.dirname(os.path.abspath(pst_path))
    
    # Anonymized profiles
    profiles_path = os.path.join(output_dir, "clearsignals_profiles.json")
    with open(profiles_path, "w", encoding="utf-8") as f:
        json.dump({
            "schema_version": "1.0",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "contact_count": len(all_profiles),
            "profiles": all_profiles
        }, f, indent=2, default=str)
    
    # Raw (LOCAL ONLY)
    raw_path = os.path.join(output_dir, "clearsignals_raw.json")
    with open(raw_path, "w", encoding="utf-8") as f:
        json.dump({
            "WARNING": "THIS FILE CONTAINS PII - DO NOT UPLOAD OR SHARE",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "pst_owner": user_email,
            "contacts": all_raw
        }, f, indent=2, default=str)
    
    # Summary
    print(f"\n{'='*60}")
    print(f"  COMPLETE")
    print(f"{'='*60}")
    print(f"\n  Contacts: {len(all_profiles)}")
    print(f"\n  Output:")
    print(f"    {profiles_path}  (anonymized - safe to upload)")
    print(f"    {raw_path}  (has PII - LOCAL ONLY)")
    
    print(f"\n  {'Contact':<30s} {'Health':<12s} {'Intent':<8s} {'Win%':<8s} {'RYG'}")
    print(f"  {'-'*70}")
    for p, r in zip(all_profiles, all_raw):
        name = r["contact_email"][:30]
        agg = p["aggregate_scores"]
        ryg = agg["ryg_total"]
        print(f"  {name:<30s} {agg['relationship_health']:<12s} {agg['avg_intent']:<8.1f} {agg['avg_win_pct']:<8.1f} R:{ryg['r']} Y:{ryg['y']} G:{ryg['g']}")


if __name__ == "__main__":
    main()
