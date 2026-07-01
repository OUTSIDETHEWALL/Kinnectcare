# Build #50 — Phase 1 Fall Detection Removal · Cleanup Report

## Files DELETED (5)
| File | Purpose |
|---|---|
| `frontend/src/fallDetector.ts` | Empty stub (removed with callers) |
| `frontend/src/fallTelemetry.ts` | Empty stub (removed with callers) |
| `frontend/src/FallDetectionOverlay.tsx` | (Deleted in previous session) |
| `frontend/app/fall-detection-test.tsx` | (Deleted in previous session) |
| `backend_test_fall.py` | Legacy fall-detection unit test |

## Files MODIFIED (9)
| File | Change |
|---|---|
| `frontend/package.json` | Removed `expo-sensors` dep (`yarn` re-linked lockfile) |
| `frontend/app/settings.tsx` | Removed Fall Detection UI section (row + switch + Test link) + fall state hooks + fallDetector imports + related styles |
| `frontend/app/diagnostics.tsx` | Removed `fallTelemetry` import + fall live-state + fall arm/clear callbacks + ENTIRE Fall Detection live/telemetry section (~130 lines) + fall wording in "Clear ALL" copy |
| `frontend/app/member/[id].tsx` | Removed `isFallEnabled` import + `fallOn` state + Active Safety card JSX + related feature-card styles + fall wording in Emergency-Contact help |
| `frontend/app/_layout.tsx` | Removed `'fall_detected'` from notification deep-link type check + comment cleanup |
| `frontend/src/push.ts` | Removed `fall_detected` from `stableNotificationId`, sticky-repost type filter, channel routing, and Android notification color logic |
| `frontend/src/routeDiagnostics.ts` | Removed `'fall_detected'` from diagnostics type union comment |
| `frontend/src/store/memberStore.ts` | Cleaned up dev doc-comment mentioning `fallTelemetry.ts` |
| `frontend/app/(tabs)/alerts.tsx` | Removed `isFallAlert` helper + fall wording in Clear-All copy + fall/SOS map-label ternary → always shows 🆘 SOS |
| `frontend/app/alert/[id].tsx` | Stubbed `isFallAlert(_a)` → `false` (this file is fully replaced in Phase 2) + doc-block comment cleanup |
| `backend/server.py` | Removed `SOSRequest.fall_detected` Pydantic field + `fall_prefix` push-title logic + `fall_detected` key in push_data + `fall_detected` key in SOS response payload + `fall_detected` from Quiet-Hours `BYPASS_TYPES` set + comment cleanup on Quiet-Hours doc-block |

## Verification
- Backend syntax: `ruff` — 0 errors
- Frontend Metro bundle: rebuilt cleanly (1163 web modules, 1110 SSR)
- App boots to Welcome/disclaimer screen on `http://localhost:3000`
- Backend `/api/` returns `{"message":"Kinnship API","status":"ok"}`
- Grep sweep: **zero** remaining references to `fallDetector`, `fallTelemetry`, `isFallEnabled`, `setFallEnabled`, `isFallAvailable`, `clearAllFallLogs`, `armSampleCapture`, `readLiveStateSync`, `subscribeLiveState`, or `expo-sensors` (excluding `node_modules` and archived test reports)
- All pre-existing lint warnings remain (unused `_e` catches, react-unescaped-entities); no NEW errors introduced.

## Notes
- Backend `fall_detected` fully purged (per user directive — no backward-compat shim).
- If any pre-Build-50 client sends `fall_detected=true` in `/api/sos`, Pydantic will now reject with `422 Extra inputs are not permitted`. Since OTA replaces the JS bundle in-place, next-launch clients will send the new shape.
- Placeholder `isFallAlert` in `alert/[id].tsx` will disappear entirely when Phase 2 rebuilds that screen.
