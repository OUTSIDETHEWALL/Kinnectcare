# Kinnship — Product Requirements Document

## Overview
Kinnship is an Expo (React Native) family safety & senior wellness mobile app for caregivers aged 35-75. It keeps families connected, tracks loved ones' wellbeing, manages medications & daily routines, and provides quick emergency response.

## Tech Stack
- Frontend: Expo SDK 54 + Expo Router (file-based routing), @expo/vector-icons-replaced with emoji `Icon` component, expo-location, expo-secure-store
- Backend: FastAPI + Motor (async MongoDB) + bcrypt + PyJWT
- Storage: MongoDB
- Auth: Email/password with bcrypt + JWT (7-day expiry)

## Features
1. **Welcome / Splash** — Branded landing using real Kinnship logo image, Get Started + Sign-in.
2. **Email/Password Auth** — Signup auto-seeds Gregory + James (senior, 09:00 daily check-in) + 3 medications + 4 routine items + 2 alerts.
3. **Family Dashboard** — Greeting, per-member cards w/ status dot + med summary chips ("X of Y taken", "N missed", "✅ Checked in"). Each card has its own **Check In** button. Persistent red 🆘 SOS button.
4. **SOS Emergency** — Confirmation → backend SOS alert (includes lat/lon + timestamp) → tel:911 via Linking. Alert visible to all family members on this account in the alerts feed.
5. **Real GPS** — `expo-location` permission flow on dashboard mount + SOS + check-in.
6. **Alerts Screen** — Active vs cleared, severity themes; SOS cards display 📍 coordinates and full timestamp; one-tap Acknowledge.
7. **Check-In Confirmation** — Spring-animated green checkmark screen with member name.
8. **Add Family Member** — Form (name, age, phone, gender). Age ≥60 auto-tagged senior + auto-default 09:00 daily check-in.
9. **Member Detail** —
   - Profile + status emoji dot
   - Location card with coordinates + Get Directions (maps:/geo:/Google Maps)
   - **Daily Check-in setting** — choose expected HH:MM or disable; backend uses this to auto-create missed_checkin alerts
   - **💊 Medications section** — list with mark-taken (✅) / mark-missed (✕) / delete; add via modal w/ Morning/Afternoon/Evening/Bedtime slots + dosage
   - **🌿 Daily Routine section** — hydration / exercise / meals checklist with same mark/delete actions and presets (Drink water, Walk, Breakfast, Lunch, Dinner, Stretching)
   - Daily reset of statuses at midnight UTC
10. **Auto missed-detection** —
    - Missed check-in: GET /alerts and /summary lazily detect seniors past their expected time without a check-in today and create a deduped alert.
    - Missed medication/routine: when user taps "Missed", backend creates a `medication` or `routine` alert.

## Brand & Design
- Dark green #1B5E35, Medium #2D8C55, Light #EAF3DE, Warm white #F9F5F0, text #1A2E20 / #5A6B5E
- Real Kinnship shield logo on Welcome (220×220) and Login (140×140)
- All icons are emoji rendered via `<Icon name="...">` (text-based, no font dependency)

## API (prefixed `/api`)
- Auth: `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`
- Members: `GET/POST /members`, `GET /members/{id}`, `DELETE /members/{id}`, `PUT /members/{id}/location`, `PUT /members/{id}/checkin-settings`
- Reminders: `GET /reminders`, `GET /reminders/member/{id}`, `POST /reminders`, `POST /reminders/{id}/mark`, `POST /reminders/{id}/toggle`, `DELETE /reminders/{id}`
- Alerts: `GET /alerts` (also runs missed-checkin detection), `POST /alerts/{id}/ack`
- Check-ins: `POST /checkins`, `GET /checkins/member/{id}`, `GET /checkins/recent`
- SOS: `POST /sos`
- Summary: `GET /summary` (per-member med + routine + check-in status)

## Data Model Extensions
- `FamilyMember.daily_checkin_time` (HH:MM UTC or null)
- `Reminder.category` (medication | routine), `dosage`, `times: List[str]`, `status` (pending|taken|missed), `last_marked_date`
- `Alert.latitude/longitude` (for SOS)

## Business Enhancement Idea
**Kinnship Premium** ($4.99/mo) — geofence alerts ("Dad left home"), 24/7 emergency dispatch, unlimited members, pharmacy auto-refill — high-LTV recurring revenue around peace-of-mind for aging parents.
