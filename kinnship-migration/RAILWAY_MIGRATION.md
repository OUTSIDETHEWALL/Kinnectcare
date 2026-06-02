# Kinnship Backend Migration — Emergent Preview → Railway

**Goal:** stable always-on backend at a permanent URL (no more preview spin-downs causing 404s) before beta testing.

**Current dataset:** 611 documents, ~516 KB. Easily fits in MongoDB Atlas M0 free tier (512 MB).

**Estimated cost:** $5/mo Railway Hobby + $0 MongoDB Atlas M0 = **$5/mo total**.

---

## PART A — MongoDB Atlas (free, do this first so you have the connection string)

1. Go to https://cloud.mongodb.com/ → sign up (use Google sign-in for speed)
2. Build a cluster → choose **M0 (free)** → AWS / **us-east-1** region (closest to Railway's default)
3. Create database user (Database Access tab):
   - Username: `kinnship_app`
   - Password: generate a strong one and copy it
   - Built-in role: `Atlas admin` (or `readWrite` on db `kinnship`)
4. Network access (Network Access tab):
   - Add IP `0.0.0.0/0` (Allow access from anywhere) — required because Railway IPs are dynamic
5. Click **Connect → Drivers → Python** → copy the connection string. It looks like:
   ```
   mongodb+srv://kinnship_app:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   Replace `<password>` with the password from step 3.

**Save this connection string** — you'll paste it into Railway as `MONGO_URL` later.

---

## PART B — Restore your existing data into Atlas

Your data is exported at: `/app/kinnship-migration/mongo-dump/test_database/`

**On your local machine** (you'll need `mongorestore` — install via `brew install mongodb-database-tools` on macOS):

1. Download the dump folder from the Emergent dev environment:
   ```bash
   # From your local machine — using the file browser in Emergent OR scp if available
   # The dump is at: /app/kinnship-migration/mongo-dump/
   ```
2. Run the restore (replace the URI):
   ```bash
   mongorestore \
     --uri="mongodb+srv://kinnship_app:<PW>@cluster0.xxxxx.mongodb.net" \
     --db=kinnship \
     /path/to/mongo-dump/test_database/
   ```
3. Verify in Atlas UI → Collections → you should see `users`, `family_groups`, `members`, `reminders`, etc.

---

## PART C — Push backend code to GitHub

The Railway deployment will pull from `OUTSIDETHEWALL/kinnship` on GitHub.

1. Make sure your local clone of `OUTSIDETHEWALL/kinnship` is up to date with all the v6.11.5/6 backend code (the `backend/` folder from `/app/backend/` in the Emergent dev environment).
2. **New files I just added that you NEED in the repo's `backend/` folder:**
   - `backend/Procfile` — tells Railway to run `uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001}`
   - `backend/railway.json` — explicit Railway config with healthcheck
   - `backend/.python-version` — pins Python 3.11
3. Commit + push:
   ```bash
   cd /path/to/kinnship
   git add backend/Procfile backend/railway.json backend/.python-version
   git commit -m "Railway deployment config"
   git push origin main
   ```

---

## PART D — Deploy on Railway

1. https://railway.app → New Project → **Deploy from GitHub repo** → select `OUTSIDETHEWALL/kinnship`
2. Railway will detect Python and start building. **However, your repo has a `backend/` subfolder**, so:
   - Click the new service → **Settings → Root Directory** → set to `backend`
   - Railway will rebuild from `backend/Procfile`
3. **Set environment variables** (Settings → Variables, click "Raw Editor" and paste the block below — replace placeholders):
   ```
   MONGO_URL=mongodb+srv://kinnship_app:<PW>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   DB_NAME=kinnship
   JWT_SECRET=EH6FTkNfLdNm7z-BL-kShqJqbUSWAOn75ODHNGf5Vkm2gRUHzN0gtiLoAn-Nj0sDFgqRHFr9oLgdAKK5VREqMw
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=finalcut71@gmail.com
   SMTP_PASSWORD=kbic bqcd nmmk xfsu
   SMTP_FROM=finalcut71@gmail.com
   STRIPE_SECRET_KEY=<your live Stripe secret key>
   STRIPE_PUBLISHABLE_KEY=<your live Stripe publishable key>
   STRIPE_WEBHOOK_SECRET=<your Stripe webhook secret>
   PAID_PLAN_PRICE_ID=<your Stripe price id>
   PAID_PLAN_AMOUNT=499
   PAID_PLAN_CURRENCY=usd
   PAID_PLAN_INTERVAL=month
   PAID_PLAN_PRODUCT_NAME=Kinnship Premium
   GOOGLE_MAPS_API_KEY=<your Google Maps API key>
   ```
   *(I have the exact values in `/app/backend/.env` — I'll send them in the next message if you want me to.)*
4. **Generate a public URL** → Settings → Networking → "Generate Domain" → you'll get something like `kinnship-backend-production.up.railway.app`
5. **Verify the deployment** — visit `https://<your-url>/api/health` in a browser. Should return `{"ok": true, "service": "kinnship-api"}`.
6. *(Optional later)* Add a custom domain like `api.kinnship.app` — Settings → Networking → Custom Domain.

---

## PART E — Point the app at Railway

**Tell me the new Railway URL** (e.g. `https://kinnship-backend-production.up.railway.app`) and I will:
1. Update `eas.json` `production.env.EXPO_PUBLIC_BACKEND_URL`
2. Bump `version` to `1.1.7`
3. Trigger a new production AAB build
4. Give you the AAB to upload to Play Store

---

## PART F — Cutover

The moment you flip `EXPO_PUBLIC_BACKEND_URL` and ship v1.1.7:
- New installs hit Railway
- Existing v1.1.5/6 installs keep hitting the Emergent preview backend
- You can keep both backends running for a transition period (data lives in Atlas in both cases since both backends will be configured to point at Atlas)
- Once your beta testers are all on v1.1.7+, the Emergent preview backend can be shut down

If you want a clean cutover, ALSO update the Emergent preview backend's `.env` `MONGO_URL` to point at the same Atlas cluster. Then both old-and-new apps hit the same data — no migration window where users see two different worlds.

---

## Verification checklist after Railway is live

- [ ] `https://<railway-url>/api/health` → 200 OK
- [ ] `POST https://<railway-url>/api/auth/request-otp` with valid email → 200 OK, email arrives
- [ ] `https://<railway-url>/api/billing/health` → 200 (Stripe configured)
- [ ] Login from a new v1.1.7 build → full flow works
- [ ] Medication scheduler still firing (Railway logs show `med_scheduler tick` every 15s)
