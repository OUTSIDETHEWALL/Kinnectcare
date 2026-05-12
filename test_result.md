#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: |
  KinnectCare is a family safety and senior wellness mobile app (Expo + FastAPI + MongoDB).
  Validate the latest feature: flexible time picker for medications. The Reminder schema now
  uses `times: List[TimeSlot]` where each TimeSlot is `{time: "HH:MM", label?: str}`. A new
  endpoint `PUT /api/reminders/{id}` was added to support editing an existing medication's
  title/dosage/times. Also validate there are no regressions in auth, members, summary, SOS,
  alerts, check-ins, and existing reminder endpoints.

backend:
  - task: "TimeSlot schema + POST /api/reminders accepts custom HH:MM with optional label"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Updated Reminder/ReminderCreate to use List[TimeSlot]. Coercion supports legacy list-of-strings too. POST should accept e.g. {member_id, title, dosage, category:'medication', times:[{time:'07:30', label:'Morning'},{time:'21:00'}]}."
      - working: true
        agent: "testing"
        comment: "PASS. POST /api/reminders with times=[{time:'07:30',label:'Morning'},{time:'21:00'}] returns 200 with times as list of TimeSlot dicts (label preserved/null). Backward-compat list-of-strings ['08:00','20:00'] is coerced to [{time:'08:00',label:null},{time:'20:00',label:null}]. Invalid time '25:99' correctly returns 400 with detail 'Invalid time format: 25:99'."

  - task: "PUT /api/reminders/{id} endpoint"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: "New endpoint allows updating title/dosage/times for an existing reminder owned by the current user. Should reject invalid HH:MM and unknown ids."
      - working: true
        agent: "testing"
        comment: "PASS. PUT updates title, dosage and times to [{time:'06:00',label:'Dawn'}] and is reflected in subsequent GET /api/reminders/member/{id}. Negative cases: invalid time '9999' -> 400, unknown id -> 404, missing Authorization header -> 403. All expected status codes returned correctly."

  - task: "GET /api/reminders/member/{member_id} returns new TimeSlot list shape"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Should return reminders with times as list of {time,label}."
      - working: true
        agent: "testing"
        comment: "PASS. Endpoint returns list of reminders; each item's times field is a list of objects each containing time (HH:MM) and optional label. Validated structure across 2+ reminders created during the test run."

  - task: "Regression: auth (signup/login), /api/me, members CRUD, summary, SOS, alerts, check-ins, reminders mark/toggle/delete, history"
    implemented: true
    working: false
    file: "/app/backend/server.py"
    stuck_count: 1
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Run regression after TimeSlot refactor to ensure no other endpoint broke."
      - working: false
        agent: "testing"
        comment: |
          REGRESSION ISSUE: GET /api/summary returns 500 Internal Server Error for the demo user (demo@kinnectcare.app).
          Root cause (from backend logs at server.py:862):
              KeyError: 'category'
              m_meds = [r for r in rems if r["member_id"] == mid and r["category"] == "medication"]
          The demo user has 5 reminders in Mongo; 3 of them are legacy documents missing the `category` field
          (keys: id, owner_id, member_id, member_name, title, time, taken, created_at — no category). The
          dashboard_summary endpoint indexes r["category"] directly, raising KeyError on those legacy docs.
          Note: /api/summary works correctly for freshly created users (their seed reminders all include category=medication),
          but breaks for any account that has legacy reminder documents predating the schema change.
          Suggested fix: use r.get("category") in dashboard_summary's list comprehensions (and any similar field access),
          and/or run a one-time migration to backfill `category="medication"` on legacy reminder docs.
          All other regression endpoints PASS:
            - POST /api/auth/login (demo) -> 200, returns access_token + user
            - POST /api/auth/signup (new random email) -> 200 (requires real TLD; pydantic EmailStr rejects .test/.example)
            - GET /api/auth/me -> 200
            - PUT /api/auth/timezone -> 200 (set America/Los_Angeles, restored UTC)
            - POST /api/auth/push-token: invalid token -> 200 {ok:false}; valid ExponentPushToken[...] -> 200 {ok:true}
            - GET /api/members, POST /api/members, GET /api/members/{id} -> 200
            - POST /api/sos with coords -> 200 (alert_id returned)
            - GET /api/alerts -> 200, includes the new SOS alert
            - POST /api/checkins, GET /api/checkins/member/{id}, GET /api/checkins/recent -> 200
            - POST /api/reminders/{id}/mark (taken & missed) -> 200, both statuses accepted
            - POST /api/reminders/{id}/toggle -> 200
            - DELETE /api/reminders/{id} -> 200
            - GET /api/history/member/{id}?days=7 -> 200, series length 7, totals + compliance_percent present

metadata:
  created_by: "main_agent"
  version: "1.6"
  test_sequence: 6
  run_ui: false

test_plan:
  current_focus:
    - "Regression: auth (signup/login), /api/me, members CRUD, summary, SOS, alerts, check-ins, reminders mark/toggle/delete, history"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: |
      Please test the new flexible medication time slot system end-to-end on backend only.
      Use credentials from /app/memory/test_credentials.md (demo@kinnectcare.app / password123).
      Backend base URL: read EXPO_BACKEND_URL from /app/frontend/.env (append /api).
      Focus tests:
        1) POST /api/reminders with new shape: times=[{time:"07:30", label:"Morning"}, {time:"21:00"}]
        2) PUT /api/reminders/{id} updating title, dosage, and times. Verify HH:MM validation rejects "25:99".
        3) GET /api/reminders/member/{member_id} returns times as list of objects with time+label.
        4) Backward compatibility: POST with legacy times=["08:00","20:00"] should still work.
        5) Regression on auth, /api/me, /api/summary, members CRUD, SOS, alerts, check-ins,
           reminders mark/toggle/delete, history endpoints.
      Do NOT test frontend.
  - agent: "testing"
    message: |
      Backend testing complete. 27/28 checks passing.

      All new TimeSlot feature work is GREEN:
        - POST /api/reminders with new [{time,label}] shape ✓
        - POST /api/reminders backward-compat with ["HH:MM",...] coerced to TimeSlot objects ✓
        - POST validation rejects "25:99" with 400 ✓
        - PUT /api/reminders/{id} updates title/dosage/times, reflected in GET ✓
        - PUT validation rejects "9999" with 400, unknown id returns 404, missing token returns 403 ✓
        - GET /api/reminders/member/{id} returns times as list of {time,label} objects ✓

      Regression suite mostly PASSING (login, signup, /auth/me, /auth/timezone, /auth/push-token,
      members CRUD, SOS, /alerts, /checkins (POST/member/recent), /reminders mark/toggle/delete,
      /history/member/{id}?days=7).

      ONE CRITICAL REGRESSION BUG:
        GET /api/summary -> 500 for the demo user.
        Backend log shows: KeyError: 'category' at server.py:862
          m_meds = [r for r in rems if r["member_id"] == mid and r["category"] == "medication"]
        I queried Mongo: demo user has 5 reminders, 3 of which lack the `category` field
        (legacy docs predating the schema change). Endpoint works fine for users with only
        new-format reminders (verified with a freshly created account).

        Fix (main agent): in dashboard_summary, use r.get("category") (and r.get("status"))
        defensively, OR run a one-time migration to backfill category="medication" on legacy
        reminder docs in the demo account / production. Recommend BOTH — defensive read in code
        plus a migration so legacy users don't keep tripping it.

        I have NOT modified production code. Please apply the fix, then re-test only /api/summary.