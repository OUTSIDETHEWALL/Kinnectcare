# KinnectCare — Product Requirements Document

## Overview
KinnectCare is an Expo (React Native) family safety and senior wellness mobile app for caregivers aged 35-75. It keeps families connected, tracks loved ones' wellbeing, and provides quick emergency response.

## Tech Stack
- Frontend: Expo SDK 54 + Expo Router (file-based routing), @expo/vector-icons, expo-location, expo-secure-store
- Backend: FastAPI + Motor (async MongoDB) + bcrypt + PyJWT
- Storage: MongoDB
- Auth: Email/password with bcrypt + JWT (7-day expiry)

## Features
1. **Welcome / Splash** — Branded landing with "Get Started" CTA → signup, secondary "Sign in" link.
2. **Email/Password Auth** — Signup (auto-seeds Gregory + James + reminders + alerts) and Login screens.
3. **Family Dashboard** — Greeting, family member cards (avatar + status dot green/amber), seniors vs family sections, summary stats, medication reminders, persistent red SOS button.
4. **SOS Emergency** — Confirmation dialog → logs alert in backend → initiates `tel:911` call via Linking.
5. **Real GPS** — On dashboard mount, request permission and update first member's location.
6. **Alerts Screen** — Active vs cleared lists, severity-themed cards (missed_checkin, low_battery, medication, sos), one-tap Acknowledge.
7. **Check-In Confirmation** — Animated green checkmark screen with "Done" button.
8. **Add Family Member** — Form (name, age, phone, gender pill picker); age ≥ 60 auto-tagged as senior.
9. **Member Detail** — Avatar + status, location map (OSM static map), phone (tap-to-call), care reminders list, check-in CTA, remove.

## Brand & Design
- Dark green #1B5E35, Medium #2D8C55, Light #EAF3DE, Warm white #F9F5F0
- "Organic & earthy" archetype: warm, high-contrast for 35-75 demographic, 56px+ touch targets, rounded cards, soft green-tinted shadows.

## API (prefixed `/api`)
- POST /auth/signup, /auth/login; GET /auth/me
- GET/POST/DELETE /members; PUT /members/{id}/location
- GET /alerts; POST /alerts/{id}/ack
- GET/POST /reminders; POST /reminders/{id}/toggle; GET /reminders/member/{id}
- POST /checkins; GET /checkins/member/{id}
- POST /sos

## Business Enhancement Idea
**Family Premium Plan** — A subscription tier (e.g., $4.99/mo) unlocks live GPS tracking, geofence alerts ("Dad left home"), unlimited members, 24/7 emergency dispatch routing, and pharmacy auto-refill integration. Strong recurring revenue driver because peace of mind for aging parents is high-LTV.
