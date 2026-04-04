@echo off
REM ================================================================
REM ClearSignals Portal API - Test Script (PostgreSQL-backed)
REM Full flow: register vendor - create session - analyze
REM
REM Requires: curl, python3
REM Set CS_ADMIN_KEY in .env before running
REM ================================================================

set BASE=http://localhost:3000/api
set ADMIN_KEY=your-admin-key-here

echo.
echo ===============================================
echo   ClearSignals Portal API - Test Suite
echo   (PostgreSQL-backed - permanent storage)
echo ===============================================
echo.

REM -- 1. Health Check --
echo [1/4] Health Check
curl -s "%BASE%/v1/health" | python -m json.tool
echo.

REM -- 2. Register Demo Vendor --
echo [2/4] Register Demo Vendor (Apex Cloud Solutions)
echo      POST %BASE%/v1/admin/vendors
echo.

curl -s -X POST "%BASE%/v1/admin/vendors" ^
  -H "Content-Type: application/json" ^
  -H "X-CS-Admin-Key: %ADMIN_KEY%" ^
  -d "{\"name\":\"Apex Cloud Solutions\",\"product\":\"Apex Unified Communications Platform\",\"solution_brief\":{\"product_name\":\"Apex Unified Communications Platform\",\"description\":\"Enterprise UCaaS platform with native healthcare integrations\",\"key_differentiators\":[\"Only UCaaS with native Epic EHR integration (FHIR R4)\",\"HIPAA-certified with BAA included\",\"30-day implementation vs 90-day industry avg\"],\"common_objections\":{\"price\":\"40%% lower TCO including BAA and compliance\",\"integration\":\"Native FHIR R4 - zero middleware needed\"},\"competitive_positioning\":{\"RingCentral\":\"No native EHR integration\",\"Microsoft Teams\":\"Healthcare compliance is add-on\"},\"case_studies\":[{\"client\":\"Lakewood Health\",\"vertical\":\"Healthcare\",\"result\":\"40%% reduction in clinical communication time\"}]}}" > vendor_response.json

type vendor_response.json | python -m json.tool

for /f "delims=" %%K in ('python -c "import json; f=open('vendor_response.json'); d=json.load(f); print(d.get('vendor_key',''))"') do set VENDOR_KEY=%%K

echo.
echo      Vendor Key: %VENDOR_KEY%
echo.

REM -- 3. Create Session --
echo [3/4] Create Session
echo      POST %BASE%/v1/sessions
echo.

curl -s -X POST "%BASE%/v1/sessions" ^
  -H "Content-Type: application/json" ^
  -H "X-CS-Vendor-Key: %VENDOR_KEY%" ^
  -d "{\"lead\":{\"company\":\"Meridian Health Systems\",\"contact_name\":\"Sarah Chen\",\"contact_title\":\"VP of Clinical Operations\",\"estimated_value\":\"$84,000 ARR\",\"stage\":\"Demo Scheduling\"}}" > session_response.json

type session_response.json | python -m json.tool

for /f "delims=" %%T in ('python -c "import json; f=open('session_response.json'); d=json.load(f); print(d.get('session_token',''))"') do set TOKEN=%%T

echo.
echo      Token: %TOKEN%
echo.

REM -- 4. Analyze Thread --
echo [4/4] Analyze Thread (15-30 seconds)
echo      POST %BASE%/v1/analyze
echo.

curl -s -X POST "%BASE%/v1/analyze" ^
  -H "Content-Type: application/json" ^
  -H "X-CS-Session-Token: %TOKEN%" ^
  -d "{\"thread_text\":\"From: James Rivera <j.rivera@techbridge.com>\nTo: Sarah Chen <s.chen@meridianhealth.com>\nDate: March 12, 2026\n\nHi Sarah, I saw Meridian Health is expanding telehealth to 12 new states. We work with Apex Cloud Solutions and their platform has native Epic EHR integration. Lakewood Health cut clinical communication time by 40%% after switching. Worth a quick chat?\n\nJames Rivera, TechBridge Partners\n\n---\n\nFrom: Sarah Chen <s.chen@meridianhealth.com>\nTo: James Rivera\nDate: March 14, 2026\n\nJames, thanks for reaching out. We are evaluating our communications stack. Epic integration is a big deal for us. Can you tell me more about how Apex handles HL7 messaging?\n\nSarah\n\n---\n\nFrom: James Rivera\nTo: Sarah Chen\nDate: March 15, 2026\n\nSarah, Apex has full FHIR R4 compliance so Epic integration is native. Attached spec sheet and Lakewood Health case study. Happy to set up a demo.\n\nJames\n\n---\n\nFrom: Sarah Chen\nTo: James Rivera\nCC: Mark Liu <m.liu@meridianhealth.com>\nDate: March 19, 2026\n\nJames, this looks promising. Looping in our CTO Mark Liu. He will want to see the technical side. Mark, can you look at the spec sheet?\n\nSarah\n\n---\n\nFrom: James Rivera\nTo: Sarah Chen\nCC: Mark Liu\nDate: March 21, 2026\n\nHi Sarah, happy to demo. Time slots: Tue Mar 24 2pm ET, Wed Mar 25 10am ET, Thu Mar 26 3pm ET. Let me know.\n\nJames\n\n---\n\nFrom: James Rivera\nTo: Sarah Chen\nCC: Mark Liu\nDate: March 28, 2026\n\nHi Sarah, just checking in on those time slots. Happy to find other options.\n\nJames\",\"options\":{\"include_coaching\":true,\"include_company_research\":true}}" | python -m json.tool

echo.
echo ===============================================
echo   Test complete - data persisted in PostgreSQL
echo ===============================================
echo.

del vendor_response.json 2>nul
del session_response.json 2>nul
pause
