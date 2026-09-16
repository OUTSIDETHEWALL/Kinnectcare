s.append({"member_id": {"$in": member_ids}})
    loc_clauses.append({"writer_user_id": user_id})
    if family_group_id:
        loc_clauses.append({"family_group_id": family_group_id})
    deleted["location_ingest_log"] = await _wipe(
        "location_ingest_log", {"$or": loc_clauses}
    )
    loc_hist_clauses: List[dict] = []
    if member_ids:
        loc_hist_clauses.append({"member_id": {"$in": member_ids}})
    if family_group_id:
        loc_hist_clauses.append({"family_group_id": family_group_id})
    deleted["location_history"] = await _wipe(
        "location_history",
        {"$or": loc_hist_clauses} if loc_hist_clauses else {"member_id": {"$in": []}},
    )

    # Scheduler bookkeeping
    deleted["med_notifications"] = await _wipe("med_notifications", _member_or_user_query())

    # Activity / history collections
    deleted["medication_logs"] = await _wipe("medication_logs", _member_or_user_query())
    deleted["checkins"]        = await _wipe("checkins",        _member_or_user_query())
    deleted["alerts"]          = await _wipe("alerts",          _member_or_user_query())
    deleted["reminders"]       = await _wipe("reminders",       _member_or_user_query())

    # Checkin requests — target member OR requester/target user
    cr_clauses: List[dict] = [
        {"requester_id": user_id},
        {"target_user_id": user_id},
    ]
    if member_ids:
        cr_clauses.append({"member_id": {"$in": member_ids}})
    if family_group_id:
        cr_clauses.append({"family_group_id": family_group_id})
    deleted["checkin_requests"] = await _wipe("checkin_requests", {"$or": cr_clauses})

    # Members
    deleted["members"] = await _wipe(
        "members",
        {"$or": [{"owner_id": user_id}, {"user_id": user_id}]},
    )

    # Family invites — sent by, accepted by, sent to (by email), or scoped to group
    inv_clauses: List[dict] = [
        {"invited_by_user_id": user_id},
        {"accepted_by_user_id": user_id},
        {"invitee_email": email},
    ]
    if family_group_id:
        inv_clauses.append({"family_group_id": family_group_id})
    deleted["family_invites"] = await _wipe("family_invites", {"$or": inv_clauses})

    # Family group — only delete if this user is the sole remaining member.
    # Guard against wiping a shared group that contains other users' data.
    deleted["family_groups"] = 0
    if family_group_id:
        other_users_in_group = await db.users.count_documents(
            {"family_group_id": family_group_id, "id": {"$ne": user_id}}
        )
        if other_users_in_group == 0:
            deleted["family_groups"] = await _wipe(
                "family_groups", {"id": family_group_id}
            )
        else:
            logger.warning(
                f"reset_test_user: family_group {family_group_id} has "
                f"{other_users_in_group} other user(s) — skipping group deletion."
            )
            deleted["family_groups_skipped_reason"] = (
                f"Group {family_group_id} still has {other_users_in_group} "
                "other user(s); not deleted."
            )

    # User account — last
    deleted["users"] = await _wipe("users", {"id": user_id})

    # ── Verification ────────────────────────────────────────────────────────
    # After deletion, confirm zero documents remain that reference any of the
    # user's identifiers.  Any non-zero count means orphaned data is present.
    verification_checks = {
        "otp_codes":          {"email": email},
        "location_ingest_log": {"$or": [{"writer_user_id": user_id}] + (
            [{"member_id": {"$in": member_ids}}] if member_ids else []
        )},
        "location_history":   {"$or": ([{"member_id": {"$in": member_ids}}] if member_ids else [{"member_id": "__no_members__"}])},
        "med_notifications":  _member_or_user_query(),
        "medication_logs":    _member_or_user_query(),
        "checkins":           _member_or_user_query(),
        "alerts":             _member_or_user_query(),
        "reminders":          _member_or_user_query(),
        "checkin_requests":   {"$or": cr_clauses},
        "members":            {"$or": [{"owner_id": user_id}, {"user_id": user_id}]},
        "family_invites":     {"$or": inv_clauses},
        "family_groups":      {"owner_user_id": user_id},
        "users":              {"id": user_id},
    }
    leftovers: dict = {}
    for coll, query in verification_checks.items():
        try:
            n = await db[coll].count_documents(query)
            if n > 0:
                leftovers[coll] = n
        except Exception as exc:
            logger.warning(f"reset_test_user verification: {coll} count failed — {exc}")

    verification_ok = len(leftovers) == 0
    verification_lines = (
        "✓ No remaining references found"
        if verification_ok
        else "\n".join(f"✗ {c}: {n} document(s) still present" for c, n in leftovers.items())
    )

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    deleted_lines = "\n".join(
        f"  {k}: {v}" for k, v in deleted.items() if isinstance(v, int) and v > 0
    ) or "  (nothing deleted)"
    if verification_ok:
        verification_audit = "  ✓ No remaining references found"
    else:
        verification_audit = "\n".join(
            f"  ✗ {c}: {n} document(s) still present" for c, n in leftovers.items()
        )
    leftover_section = (
        ""
        if verification_ok
        else (
            "\nLeftovers:\n"
            + "\n".join(f"  {c}: {n}" for c, n in leftovers.items())
        )
    )
    logger.warning(
        "[ADMIN] reset-test-user\n"
        f"  Timestamp    : {ts}\n"
        f"  Email        : {email}\n"
        f"  Requested By : X-Admin-Secret authenticated\n"
        f"  Status       : {'SUCCESS' if verification_ok else 'INCOMPLETE'}\n"
        "\nDeleted:\n"
        f"{deleted_lines}\n"
        "\nVerification:\n"
        f"{verification_audit}"
        f"{leftover_section}"
    )

    return {
        "status": "SUCCESS" if verification_ok else "INCOMPLETE",
        "email": email,
        "identifiers": {
            "user_id": user_id,
            "family_group_id": family_group_id,
            "member_ids": member_ids,
        },
        "deleted": deleted,
        "verification": {
            "ok": verification_ok,
            "summary": verification_lines,
            "leftovers": leftovers,
        },
    }


# Register family group routes (multi-user family invite & membership)
api_router.include_router(fg.build_router(db, get_current_user, push_to_user=push_to_user, send_email=send_email_via_resend_async))


app.include_router(api_router)


# ============================================================================
# Build #60 — Public invite landing page (NOT under /api prefix).
#
# This route serves plain HTML at ``https://<railway>/invite/{token}``.  It's
# the URL the Kinnship invite email now points its big green "Accept
# Invitation" button at (see family_group._invite_email_body).  The page's
# only job is to route the recipient into the app REGARDLESS of whether
# Kinnship is already installed on their phone:
#
#   • Installed  → the tiny <script> immediately redirects to the
#                  ``kinnship://invite/{token}`` custom scheme, which
#                  expo-router picks up and forwards to /app/invite/[token].
#                  A JavaScript setTimeout is the standard "did the custom
#                  scheme succeed?" pattern — if the browser is still on
#                  this page after 1500ms, the app clearly didn't open, so
#                  fall through to the Play Store CTA.
#
#   • Not installed → the visible Play Store button is the primary CTA.
#                     We also auto-redirect after 4 seconds so a 75-year-
#                     old user who taps the email button and just stares
#                     at the screen still ends up at Play Store on their
#                     own with no additional taps.
#
# The invite token is embedded twice: once in the ``kinnship://`` URL for
# the scheme handoff, and once in the Play Store ``?referrer=`` query so
# the newly-installed app can pick it up via Google Play Install Referrer
# on first launch through the app's Play Install Referrer integration.
#
# Why this lives INSIDE server.py rather than as a static file: it needs
# to embed the token dynamically, and we don't want a second hosting
# surface (S3/CDN) for a 40-line HTML string that runs once per invite.
# ============================================================================

from fastapi.responses import HTMLResponse  # noqa: E402


@app.get("/invite/{token}", response_class=HTMLResponse, include_in_schema=False)
async def invite_landing_page(token: str):
    """HTML bridge: tries the custom scheme, falls back to Play Store.

    Serves regardless of whether the token is valid — an invalid token
    still needs to open the app so the app can show a friendly
    "Invitation not valid" message rather than a browser 404.  If we
    404'd invalid tokens here, we'd break the semantic contract that
    every email link goes SOMEWHERE.
    """
    # Sanitize — keep only the alnum + hyphen chars an invite token can
    # ever legitimately contain.  Prevents HTML injection via crafted
    # URL like /invite/<script>alert(1)</script>.
    safe = "".join(ch for ch in (token or "") if ch.isalnum() or ch == "-")[:64]

    play_store_url = (
        os.environ.get("KINNSHIP_PLAY_STORE_URL")
        or "https://play.google.com/store/apps/details?id=app.kinnship.client"
    )
    # Play Store install-referrer carries the token so a fresh install
    # can auto-resume the invite on first launch.
    referrer = f"invite_token%3D{safe}"
    if "?" in play_store_url:
        play_store_url_with_referrer = f"{play_store_url}&referrer={referrer}"
    else:
        play_store_url_with_referrer = f"{play_store_url}?referrer={referrer}"

    app_scheme_url = f"kinnship://invite/{safe}"

    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Accept your Kinnship invitation</title>
<style>
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; padding: 0; height: 100%; }}
  body {{
    font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background: #f4f6f4;
    color: #1a1a1a;
    -webkit-text-size-adjust: 100%;
  }}
  .wrap {{
    min-height: 100%;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 32px 20px;
  }}
  .card {{
    width: 100%; max-width: 380px;
    background: #fff; border-radius: 20px;
    box-shadow: 0 4px 20px rgba(27,94,53,0.10);
    overflow: hidden;
  }}
  .header {{
    background: #1B5E35; color: #fff;
    text-align: center; padding: 32px 24px 26px;
  }}
  .brand {{
    font-size: 30px; font-weight: 800; letter-spacing: -0.5px;
  }}
  .tagline {{
    color: #a5d6a7; font-size: 12px;
    letter-spacing: 1px; text-transform: uppercase;
    margin-top: 6px;
  }}
  .body {{ padding: 36px 24px 32px; text-align: center; }}
  h1 {{
    margin: 0 0 8px; font-size: 18px;
    color: #1B5E35; font-weight: 700;
  }}
  /* CSS spinner */
  .spinner {{
    width: 44px; height: 44px;
    border: 4px solid #d4e8d4;
    border-top-color: #1B5E35;
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
    margin: 20px auto 8px;
  }}
  @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
  /* Play Store button — hidden until JS reveals it */
  .store-btn {{
    display: none;
    margin-top: 24px; width: 100%;
    padding: 16px 20px;
    background: #1B5E35; color: #fff;
    font-size: 16px; font-weight: 700;
    text-align: center; text-decoration: none;
    border-radius: 14px;
    box-shadow: 0 4px 14px rgba(27,94,53,0.22);
  }}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="header">
      <div class="brand">Kinnship</div>
      <div class="tagline">Family safety · Senior wellness</div>
    </div>
    <div class="body">
      <h1 id="heading">Opening Kinnship…</h1>
      <div class="spinner" id="spinner"></div>
      <a id="storeBtn" class="store-btn" href="{play_store_url_with_referrer}">
        Open in Play Store
      </a>
    </div>
  </div>
</div>

<script>
  (function() {{
    var scheme  = "{app_scheme_url}";
    var store   = "{play_store_url_with_referrer}";
    var heading = document.getElementById("heading");
    var spinner = document.getElementById("spinner");
    var storeBtn = document.getElementById("storeBtn");

    var didBackground = false;
    document.addEventListener("visibilitychange", function() {{
      if (document.hidden) didBackground = true;
    }});

    // Try the custom scheme. If the app is installed, it opens and the
    // page is backgrounded. We detect success via visibilitychange.
    setTimeout(function() {{ window.location.href = scheme; }}, 120);

    // After 2 s, if still foreground, the app isn't installed.
    // Reveal the Play Store button and auto-navigate after a brief pause
    // so the user sees where they're going.
    setTimeout(function() {{
      if (!didBackground) {{
        if (spinner)  spinner.style.display  = "none";
        if (heading)  heading.textContent    = "Get Kinnship from Google Play";
        if (storeBtn) storeBtn.style.display = "block";
        setTimeout(function() {{ window.location.href = store; }}, 1800);
      }}
    }}, 2000);
  }})();
</script>
</body>
</html>"""
    return HTMLResponse(content=html, status_code=200)

app.add_middleware(
    CORSMiddleware, allow_credentials=True, allow_origins=["*"],
    allow_methods=["*"], allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@app.on_event("startup")
async def _init_billing():
    if billing.init_stripe():
        logger.info("Stripe initialized.")
    else:
        logger.info("Stripe NOT initialized (no secret key).")


@app.on_event("startup")
async def _migrate_legacy_reminders():
    """One-time backfill for legacy reminder docs missing category/status fields."""
    try:
        await db.reminders.update_many(
            {"category": {"$exists": False}}, {"$set": {"category": "medication"}}
        )
        await db.reminders.update_many(
            {"status": {"$exists": False}}, {"$set": {"status": "pending"}}
        )
        await db.reminders.update_many(
            {"times": {"$exists": False}}, {"$set": {"times": []}}
        )
    except Exception as e:
        logger.warning(f"Legacy reminder migration skipped: {e}")


@app.on_event("startup")
async def _migrate_family_groups():
    """Backfill family_group_id on every legacy user + their owned data.

    For each user without a family_group_id we create a brand-new solo family
    group (named after the user), then tag all of their owned data in
    members/reminders/alerts/checkins/medication_logs with that group id.
    Idempotent: running this on an already-migrated DB is a no-op.
    """
    try:
        cursor = db.users.find(
            {"family_group_id": {"$exists": False}},
            {"_id": 0, "id": 1, "full_name": 1, "email": 1},
        )
        legacy = await cursor.to_list(10000)
        if not legacy:
            return
        logger.info(f"Backfilling family_group_id for {len(legacy)} legacy users…")
        for user in legacy:
            try:
                group = await fg.create_group_for_user(db, user)
                gid = group["id"]
                # Backfill data
                for coll in fg.DATA_COLLECTIONS:
                    await db[coll].update_many(
                        {"owner_id": user["id"], "family_group_id": {"$exists": False}},
                        {"$set": {"family_group_id": gid}},
                    )
            except Exception as e:
                logger.warning(f"Migration failed for user {user.get('id')}: {e}")
        logger.info("Family group migration complete.")
    except Exception as e:
        logger.warning(f"Family group migration skipped: {e}")


@app.on_event("shutdown")
async def shutdown_db_client():
    global _med_scheduler, _med_scheduler_ready
    _med_scheduler_ready = False
    if _med_scheduler:
        try:
            await _med_scheduler.stop()
        except Exception:
            pass
    client.close()


@app.on_event("startup")
async def _start_med_scheduler():
    """Start the medication-escalation background worker and ensure indexes."""
    global _med_scheduler, _med_scheduler_ready
    _med_scheduler_ready = False
    _med_scheduler = None
    try:
        await med_scheduler.ensure_indexes(db)
    except Exception as e:
        # These indexes are correctness prerequisites for occurrence-level
        # idempotency and the T+15 race guard.  Fail closed: never start a
        # race-unsafe escalation worker.
        logger.error(f"med_scheduler safety indexes unavailable; worker disabled: {e}")
        return
    try:
        _med_scheduler = med_scheduler.MedicationScheduler(
            db,
            push_to_user=push_to_user,
            push_to_family_group=push_to_family_group,
        )
        _med_scheduler.start()
        _med_scheduler_ready = True
        logger.info("Medication scheduler started.")
    except Exception as e:
        _med_scheduler = None
        logger.warning(f"Medication scheduler failed to start: {e}")


@app.on_event("startup")
async def _ensure_geocode_cache_indexes():
    """TTL + lookup indexes for the backend geocoding cache."""
    await geocoding.ensure_indexes(db)


@app.on_event("startup")
async def _ensure_location_history_index():
    """Compound index on location_history for efficient per-member queries."""
    try:
        await db.location_history.create_index(
            [("member_id", 1), ("accepted_at", -1)],
            name="member_history",
        )
        logger.info("location_history.member_history index ensured")
    except Exception as e:
        logger.warning(f"location_history index skipped: {e}")


@app.on_event("startup")
async def _ensure_alert_dedup_index():
    """Create the unique partial index that makes alert generation race-safe.

    Without this index, concurrent polls of /api/alerts and /api/summary
    from every device in a family group (caregivers + senior + others)
    can ALL win the find-then-insert race against `detect_missed_checkins`
    and create N duplicate alerts, each of which fans out a push to every
    family member.  Result: a missed-check-in alert appears 15+ times in
    the same minute.

    The index is PARTIAL — only enforced on documents that carry a
    `slot_key` field (i.e. missed_checkin alerts created by the new
    race-safe path).  Legacy alert docs without `slot_key` are left
    alone, so the index creation is safe to deploy on a populated DB.
    """
    try:
        await db.alerts.create_index(
            [
                ("family_group_id", 1),
                ("member_id", 1),
                ("type", 1),
                ("slot_key", 1),
            ],
            unique=True,
            partialFilterExpression={"slot_key": {"$exists": True}},
            name="uniq_alert_slot",
        )
        logger.info("alerts uniq_alert_slot index ensured.")
    except Exception as e:
        logger.warning(f"alerts uniq_alert_slot index ensure skipped: {e}")

    # ── Low-battery dedup index ──────────────────────────────────────────────
    # Partial unique index on (family_group_id, member_id) scoped exclusively
    # to unresolved low_battery alerts.  This causes the second concurrent
    # insert_one() in check_low_battery() to raise DuplicateKeyError, which
    # that helper already catches to skip the duplicate push.
    #
    # The filter is intentionally narrow: only documents where
    # type=="low_battery" AND resolved==False are covered.  All other alert
    # types (missed_checkin, sos, medication, etc.) are unaffected — they are
    # excluded from the index's partial filter and therefore never block each
    # other.
    #
    # Pre-migration: before creating either tier's index, resolve leftover
    # duplicate unresolved low-battery docs from the same
    # (family_group_id, member_id, type) tuple.  Without this step, index
    # creation on a populated DB would fail with "E11000 duplicate key".
    # Warning and critical are grouped separately so one tier never resolves
    # the other while the migration is making the indexes safe.
    try:
        pipeline = [
            {
                "$match": {
                    "type": {"$in": ["low_battery", "low_battery_warning"]},
                    "resolved": False,
                }
            },
            {
                "$sort": {"created_at": -1}
            },
            {
                "$group": {
                    "_id": {
                        "family_group_id": "$family_group_id",
                        "member_id": "$member_id",
                        "type": "$type",
                    },
                    "ids": {"$push": "$id"},
                }
            },
        ]
        async for group in db.alerts.aggregate(pipeline):
            duplicate_ids = group["ids"][1:]  # keep [0] (newest), resolve the rest
            if duplicate_ids:
                now_utc = datetime.now(timezone.utc)
                res = await db.alerts.update_many(
                    {"id": {"$in": duplicate_ids}},
                    {"$set": {"resolved": True, "resolved_at": now_utc}},
                )
                logger.info(
                    f"low_battery dedup pre-migration: resolved {res.modified_count} "
                    f"duplicate(s) for member={group['_id']['member_id']} "
                    f"type={group['_id'].get('type', 'low_battery')}"
                )
    except Exception as e:
        logger.warning(f"low_battery dedup pre-migration skipped: {e}")

    try:
        await db.alerts.create_index(
            [
                ("family_group_id", 1),
                ("member_id", 1),
            ],
            unique=True,
            partialFilterExpression={"type": "low_battery", "resolved": False},
            name="uniq_active_low_battery_per_member",
        )
        logger.info("alerts uniq_active_low_battery_per_member index ensured.")
    except Exception as e:
        logger.warning(f"alerts uniq_active_low_battery_per_member index ensure skipped: {e}")

    # ── Low-battery-warning dedup index ──────────────────────────────────────
    # Same pattern as the low_battery index above but scoped to
    # type=="low_battery_warning" (the 20 % early-warning tier).
    # Guarantees at most one concurrent insert wins per discharge cycle.
    try:
        await db.alerts.create_index(
            [
                ("family_group_id", 1),
                ("member_id", 1),
            ],
            unique=True,
            partialFilterExpression={"type": "low_battery_warning", "resolved": False},
            name="uniq_active_low_battery_warning_per_member",
        )
        logger.info("alerts uniq_active_low_battery_warning_per_member index ensured.")
    except Exception as e:
        logger.warning(f"alerts uniq_active_low_battery_warning_per_member index ensure skipped: {e}")

    # ============================================================
    #  P5 of beta stabilization sprint: AUTOMATIC DATA RETENTION
    # ============================================================
    #
    # Four MongoDB TTL indexes keep collection growth bounded
    # without requiring scheduled jobs.  Mongo's background TTL
    # monitor sweeps every ~60s and deletes documents whose
    # indexed datetime field is older than expireAfterSeconds.
    # All four are idempotent — re-running on a populated DB is
    # safe.  Partial indexes are used where we only want SOME
    # documents to expire (e.g. only RESOLVED alerts, not active
    # ones).
    #
    # Tuning rationale:
    #   otp_codes:           10 min   — short-lived secrets
    #   checkins:            90 days  — long enough for trend UI
    #   resolved alerts:     30 days  — audit trail + ack history
    #   med_notifications:   30 days  — escalation history
    ttl_indexes = [
        # OTP codes — expire from their own expires_at field
        # (already populated server-side at issuance).  Using
        # expireAfterSeconds=0 makes Mongo delete the doc the
        # moment expires_at is in the past.
        ("otp_codes",          "expires_at", 0,             None),
        # Check-ins — 90 days after creation
        ("checkins",           "created_at", 90 * 86400,    None),
        # Alerts — 30 days after RESOLUTION (resolved_at must
        # exist, so partial-filter on that)
        ("alerts",             "resolved_at", 30 * 86400,   {"resolved_at": {"$exists": True}}),
        # Medication notifications — 30 days after creation
        ("med_notifications",  "created_at", 30 * 86400,    None),
        # Build 53 — Location ingest diagnostic log + blank-push drops.
        # 24 h retention is enough for post-mortem within an active
        # debugging session; nothing here is needed longer.
        ("location_ingest_log", "at",         86400,        None),
        ("blank_push_drops",    "at",         86400,        None),
        # Build XX — GPS quality history: 7 days covers multi-day field-test
        # sessions without accumulating indefinitely.  Only accepted writes
        # are stored so collection growth is bounded by upload frequency.
        ("location_history",    "accepted_at", 7 * 86400,   None),
    ]
    for coll_name, field, ttl_seconds, partial_filter in ttl_indexes:
        try:
            kwargs = {"expireAfterSeconds": ttl_seconds, "name": f"ttl_{field}"}
            if partial_filter:
                kwargs["partialFilterExpression"] = partial_filter
            await db[coll_name].create_index([(field, 1)], **kwargs)
            logger.info(f"TTL index ensured: {coll_name}.{field} expireAfterSeconds={ttl_seconds}")
        except Exception as e:
            logger.warning(f"TTL index skipped for {coll_name}.{field}: {e}")

    # Build 53 — wire expo_push's blank-drop ring buffer to a persistent
    # Mongo collection so post-mortem diagnosis survives pod restart.
    async def _persist_blank_drop(entry: dict) -> None:
        try:
            entry_copy = dict(entry)
            entry_copy["at"] = datetime.now(timezone.utc)
            await db.blank_push_drops.insert_one(entry_copy)
        except Exception as e:
            logger.warning(f"persist_blank_drop failed: {e}")
    register_blank_drop_sink(_persist_blank_drop)
    logger.info("blank_push_drops sink registered.")


@app.on_event("startup")
async def _migrate_dedupe_push_tokens():
    """One-time migration: collapse accumulated ghost push tokens.

    Background: an earlier `$addToSet`-based registration path accumulated
    DIFFERENT-VALUED tokens whenever Expo rotated the token (which it does
    on app reinstall, dev/prod signature flip, or certain FCM events).
    Real-world impact: one caregiver had 28 tokens, another user had 5 — every push
    fanned out to N ghosts, causing notification floods.

    This migration is conservative — it only DEDUPES exact duplicates
    inside each user's push_tokens array (in case any slipped in around
    $addToSet semantics) AND removes empty / null entries.  It does NOT
    decide which of several DIFFERENT tokens is "current" — that's
    impossible without device fingerprinting.  Real ghost cleanup
    happens organically via the new `register_push_token` (which now
    wipes-and-sets to [token] on every login), and the existing
    `push_to_user` prune-on-DeviceNotRegistered path.

    Idempotent — running it multiple times is a no-op once cleaned.
    """
    try:
        # MongoDB 4.4+ aggregation pipeline update — collapses each
        # user.push_tokens to its set of non-empty unique values.
        result = await db.users.update_many(
            {"push_tokens": {"$exists": True, "$type": "array"}},
            [
                {
                    "$set": {
                        "push_tokens": {
                            "$setUnion": [
                                {
                                    "$filter": {
                                        "input": {"$ifNull": ["$push_tokens", []]},
                                        "as": "t",
                                        "cond": {
                                            "$and": [
                                                {"$ne": ["$$t", None]},
                                                {"$ne": ["$$t", ""]},
                                            ]
                                        },
                                    }
                                },
                                [],
                            ]
                        }
                    }
                }
            ],
        )
        if result.modified_count:
            logger.info(
                f"push_tokens dedupe migration: cleaned {result.modified_count} user(s)"
            )
    except Exception as e:
        logger.warning(f"push_tokens dedupe migration skipped: {e}")


# =========================================================================
# Build 50 hotfix — Alerts backfill + ancient-cleanup migration.
#
# Problem observed in the field: pre-Build-50 SOS alerts stored in Mongo
# have no `resolved` field.  The frontend auto-resume detector treats
# every SOS with `resolved` != true as "unresolved", so any legacy
# record (from days-old testing) was being resurfaced on cold-start,
# trapping the user on an incident screen for an alert nobody was
# handling.
#
# SAFETY MODEL — this migration must NEVER accidentally mark a truly
# active unresolved SOS as resolved.  Two safeguards:
#
#   A. SENTINEL DOC — a marker in the `migrations` collection.  When
#      present, the migration short-circuits on subsequent boots (true
#      one-shot semantics).  Even if the marker is manually removed
#      (e.g. for a re-run in a dev env), safeguard B still holds.
#
#   B. SAFETY WINDOW — the promotion step (acknowledged → resolved)
#      ONLY affects SOS alerts older than 1 hour.  A genuine emergency
#      response completes in minutes; anything acknowledged-but-not-
#      resolved after 1 h is stale.  This bounds the worst-case damage
#      even if the sentinel is deleted AND the migration is re-run
#      moments after a caregiver ack'd a real SOS via a legacy bundle.
#
# Steps (each idempotent independently, so re-running is safe):
#   1. DELETE alerts older than 30 days (opportunistic housekeeping —
#      Kinnship maintains a clean DB; obsolete test data serves no
#      caregiver purpose).
#   2. BACKFILL `resolved: False` on any alert missing the field.
#   3. MARK legacy `sos` alerts that are (acknowledged AND created ≥1h
#      ago) as `resolved: True` with `resolved_at = created_at`.
#      Missed-checkin / medication / routine alerts are NOT affected —
#      they use `acknowledged` semantics only.
# =========================================================================
MIGRATION_ID_ALERTS_V50 = "alerts_backfill_v50"
MIGRATION_PROMOTE_MIN_AGE = timedelta(hours=1)


@app.on_event("startup")
async def _migrate_alerts_backfill_v50():
    try:
        # Safeguard A — sentinel doc.  If this migration has already
        # completed on this deployment, short-circuit.
        marker = await db.migrations.find_one({"_id": MIGRATION_ID_ALERTS_V50})
        if marker:
            return

        now = datetime.now(timezone.utc)

        # 1. Housekeeping — delete alerts older than 30 days.
        cutoff = now - timedelta(days=30)
        del_res = await db.alerts.delete_many({"created_at": {"$lt": cutoff}})
        if del_res.deleted_count:
            logger.info(
                f"alerts housekeeping: removed {del_res.deleted_count} alert(s) "
                f"older than 30 days"
            )

        # 2. Backfill `resolved: False` on any record missing the field.
        backfill_res = await db.alerts.update_many(
            {"resolved": {"$exists": False}},
            {"$set": {"resolved": False}},
        )
        if backfill_res.modified_count:
            logger.info(
                f"alerts backfill: set resolved=False on "
                f"{backfill_res.modified_count} legacy alert(s)"
            )

        # 3. Mark legacy acknowledged SOS as resolved — WITH SAFETY WINDOW.
        #    Only touches alerts older than 1 hour, so an active
        #    caregiver response ack'd in the last few minutes is never
        #    accidentally promoted to "resolved".
        promote_cutoff = now - MIGRATION_PROMOTE_MIN_AGE
        promote_res = await db.alerts.update_many(
            {
                "type": "sos",
                "acknowledged": True,
                "resolved": {"$in": [False, None]},
                "created_at": {"$lt": promote_cutoff},
            },
            [
                {
                    "$set": {
                        "resolved": True,
                        "resolved_at": "$created_at",
                        "resolved_by_name": "Legacy (pre-Build-50)",
                    }
                }
            ],
        )
        if promote_res.modified_count:
            logger.info(
                f"alerts backfill: promoted {promote_res.modified_count} legacy "
                f"acknowledged SOS to resolved (safety window: ≥1h old)"
            )

        # Record completion so subsequent boots short-circuit (safeguard A).
        await db.migrations.update_one(
            {"_id": MIGRATION_ID_ALERTS_V50},
            {
                "$set": {
                    "_id": MIGRATION_ID_ALERTS_V50,
                    "run_at": now,
                    "deleted": del_res.deleted_count,
                    "backfilled": backfill_res.modified_count,
                    "promoted": promote_res.modified_count,
                }
            },
            upsert=True,
        )
    except Exception as e:
        logger.warning(f"alerts backfill migration skipped: {e}")


# =========================================================================
# Build 48 — One-time backfill of member_phone onto existing low_battery alerts.
#
# Problem: member_phone was added to the Alert model in Build 28 and is only
# written on newly-created low_battery alerts.  Pre-existing unacknowledged
# low_battery alerts have no member_phone so caregivers never see the Call
# button for those older rows.
#
# Fix: at startup, sweep every low_battery alert that is missing member_phone,
# look up the corresponding member doc by member_id, and copy member.phone.
#
# Safety model:
#   A. SENTINEL DOC — short-circuits on every subsequent boot.
#   B. Only writes when member.phone is non-empty; never sets a blank string.
#   C. Never crashes startup — any exception is caught and logged.
# =========================================================================
@app.on_event("startup")
async def _migrate_alerts_phone_backfill_v48():
    try:
        if await db.migrations.find_one({"_id": MIGRATION_ID_ALERTS_PHONE_BACKFILL_V48}):
            return

        now = datetime.now(timezone.utc)
        updated = 0

        # Find all low_battery alerts where member_phone is absent or null.
        cursor = db.alerts.find(
            {"type": "low_battery", "member_phone": {"$in": [None, ""]}}
        )
        async for alert in cursor:
            member_id = alert.get("member_id")
            if not member_id:
                continue
            member = await db.family_members.find_one({"id": member_id})
            if not member:
                continue
            phone = (member.get("phone") or "").strip()
            if not phone:
                continue
            res = await db.alerts.update_one(
                {"_id": alert["_id"]},
                {"$set": {"member_phone": phone}},
            )
            if res.modified_count:
                updated += 1

        logger.info(
            f"[startup] alerts phone backfill v48: backfilled member_phone on "
            f"{updated} low_battery alert(s)"
        )

        await db.migrations.update_one(
            {"_id": MIGRATION_ID_ALERTS_PHONE_BACKFILL_V48},
            {"$set": {"_id": MIGRATION_ID_ALERTS_PHONE_BACKFILL_V48, "run_at": now, "updated": updated}},
            upsert=True,
        )
    except Exception as e:
        logger.warning(f"alerts phone backfill v48 migration skipped: {e}")


# =========================================================================
# Build 62 — One-time ghost-invite heal migration.
#
# Problem: the Build #61 live ghost-heal inside GET /family-group/invites
# had no minimum-age guard.  The moment Charles opened the invites screen
# after creating a fresh invite for an existing family member, the GET
# handler consumed the brand-new token — before the recipient could ever
# enter it.  Backend correctly rejected it as "already used."
#
# Fix: the live heal is removed from the GET endpoint entirely.  GET must
# never mutate state.  All remaining historical ghost-pending invites
# (left by the pre-Build-59 bookkeeping gap) are cleaned up here, once,
# at startup.
#
# Safety model:
#   A. SENTINEL DOC — migration short-circuits on every subsequent boot.
#   B. MINIMUM AGE (24 h) — only heals invites created more than 24 hours
#      before this boot.  Any invite created after this deployment is
#      never touched, even if the sentinel were somehow deleted and the
#      migration re-ran.
# =========================================================================
MIGRATION_ID_ALERTS_PHONE_BACKFILL_V48 = "alerts_phone_backfill_v48"

MIGRATION_ID_INVITE_GHOST_HEAL_V62 = "invite_ghost_heal_v62"


@app.on_event("startup")
async def _migrate_invite_ghost_heal_v62():
    try:
        # Safeguard A — sentinel doc.
        if await db.migrations.find_one({"_id": MIGRATION_ID_INVITE_GHOST_HEAL_V62}):
            return

        now = datetime.now(timezone.utc)
        # Safeguard B — minimum age: only touch invites older than 24 h.
        age_cutoff = now - timedelta(hours=24)

        pending = await db.family_invites.find(
            {"status": "pending", "created_at": {"$lt": age_cutoff}},
            {"_id": 0, "id": 1, "invitee_email": 1, "family_group_id": 1},
        ).to_list(10_000)

        if not pending:
            await db.migrations.update_one(
                {"_id": MIGRATION_ID_INVITE_GHOST_HEAL_V62},
                {"$set": {"_id": MIGRATION_ID_INVITE_GHOST_HEAL_V62,
                           "run_at": now, "healed": 0}},
                upsert=True,
            )
            return

        # Group by family_group_id so we fetch member emails once per group.
        groups: dict[str, list[dict]] = {}
        for inv in pending:
            gid = inv.get("family_group_id")
            if gid and inv.get("invitee_email"):
                groups.setdefault(gid, []).append(inv)

        healed = 0
        for gid, invites in groups.items():
            member_emails: set[str] = set()
            async for u in db.users.find(
                {"family_group_id": gid}, {"_id": 0, "email": 1}
            ):
                em = (u.get("email") or "").lower().strip()
                if em:
                    member_emails.add(em)

            for inv in invites:
                iv_email = (inv.get("invitee_email") or "").lower().strip()
                if not iv_email or iv_email not in member_emails:
                    continue
                try:
                    res = await db.family_invites.update_one(
                        {"id": inv["id"], "status": "pending"},
                        {"$set": {"status": "accepted", "accepted_at": now}},
                    )
                    if res.modified_count:
                        healed += 1
                        logger.info(
                            f"[invite-ghost-heal-v62] healed {iv_email} "
                            f"(id={inv['id']}, group={gid[:8]})"
                        )
                except Exception as e:
                    logger.warning(
                        f"[invite-ghost-heal-v62] failed for {inv['id']}: {e}"
                    )

        await db.migrations.update_one(
            {"_id": MIGRATION_ID_INVITE_GHOST_HEAL_V62},
            {"$set": {"_id": MIGRATION_ID_INVITE_GHOST_HEAL_V62,
                       "run_at": now, "healed": healed}},
            upsert=True,
        )
        logger.info(
            f"[invite-ghost-heal-v62] complete — healed {healed} ghost invite(s)"
        )
    except Exception as e:
        logger.warning(f"[invite-ghost-heal-v62] migration skipped: {e}")


@app.on_event("startup")
async def _migrate_iso_string_timestamps_to_date():
    """One-time migration: convert string-typed `created_at` to BSON Date.

    THE BUG WE'RE REPAIRING (P4 of beta stabilization sprint):
      Pydantic v2 @field_serializer with the default `when_used='always'`
      runs during model_dump() in BOTH Python and JSON modes.  Our
      `_to_utc_iso` serializer was therefore converting `created_at` to
      an ISO STRING before the dict reached MongoDB via insert_one(
      model.model_dump()).  Every CheckIn / Alert / Reminder / Member
      created via that path stored `created_at` as a String, not a
      BSON Date.

      Range queries like `{"created_at": {"$gte": day_start_utc}}`
      compare a Date query against a String field.  In BSON's type
      ordering Strings and Dates are non-comparable, so the query
      silently returns zero documents.  Visible symptom: the
      dashboard "Checked in N/M" counter stayed at 0/1 forever even
      though POST /checkins succeeded and the push notification fanned
      out (those code paths don't filter by created_at).  Collateral
      damage: `detect_missed_checkins` fixed-time mode would fire
      "missed check-in" alerts even after the senior had checked in;
      missed-checkin alert ack-after-checkin silently no-op'd.

      Fix at the model layer is the four `when_used='json'` edits on
      the @field_serializer decorators (server.py:222, 266, 335, 351).
      That repairs ALL NEW writes from this deploy forward.  But pre-
      existing rows in Mongo still have String created_at and would
      continue to be invisible to range queries.  This migration
      converts those rows to BSON Date so the historical data lines
      back up with the going-forward writes.

    SCOPE:
      - checkins.created_at       (P4 root cause)
      - alerts.created_at         (collateral damage — see server.py:1954, 2091, 2129)
      - reminders.created_at      (used by some compliance queries)
      - reminders.last_marked_at  (medication scheduler reads this as a Date)
      - members.last_seen         (used by location-staleness UI elsewhere)
      - members.created_at        (less critical, but converted for consistency)

    SAFETY:
      - Idempotent.  Each pass converts only documents where the field
        is currently a String (`$type: "string"`).  Subsequent runs
        find zero matches and exit immediately.
      - Per-doc try/except.  If a single doc has a malformed ISO string
        we skip it and log the id, never crash startup.
      - No collection scans without an index — every match-stage uses
        `{$type: "string"}` which Mongo evaluates as a type-bracketed
        scan, and the affected collections are bounded by TTL (90d for
        checkins, 30d for alerts).  Beta-sized DB: completes in seconds.
    """
    targets = [
        ("checkins",  "created_at"),
        ("alerts",    "created_at"),
        ("reminders", "created_at"),
        ("reminders", "last_marked_at"),
        ("members",   "last_seen"),
        ("members",   "created_at"),
    ]
    for coll_name, field in targets:
        try:
            cursor = db[coll_name].find(
                {field: {"$type": "string"}},
                {"_id": 1, "id": 1, field: 1},
            )
            converted = 0
            failed = 0
            async for doc in cursor:
                raw = doc.get(field)
                if not isinstance(raw, str):
                    continue
                try:
                    # Python's fromisoformat handles "+00:00" and naive
                    # strings.  "Z" suffix needs a tiny patch since
                    # only 3.11+ understands it natively — be defensive.
                    s = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
                    parsed = datetime.fromisoformat(s)
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=timezone.utc)
                    parsed_utc = parsed.astimezone(timezone.utc)
                    await db[coll_name].update_one(
                        {"_id": doc["_id"]},
                        {"$set": {field: parsed_utc}},
                    )
                    converted += 1
                except Exception as e:
                    failed += 1
                    logger.warning(
                        f"iso→date migration: failed to convert "
                        f"{coll_name}/{doc.get('id') or doc.get('_id')}.{field}: {e}"
                    )
            if converted or failed:
                logger.info(
                    f"iso→date migration: {coll_name}.{field} converted={converted} failed={failed}"
                )
        except Exception as e:
            logger.warning(f"iso→date migration skipped for {coll_name}.{field}: {e}")


@app.on_event("startup")
async def _purge_legacy_demo_data():
    """v1.1.7 one-time DB cleanup.

    Earlier builds (<=v6.11.7) seeded every new user with two demo family
    members — Gregory and James — plus medications/routines/alerts/check-ins
    on those members. From the user's perspective they "had no medications
    saved" yet the medication scheduler still fired notifications on the
    seeded demo data multiple times a day.

    The seed itself has now been removed (see seed_demo_data above) but
    accounts created before v1.1.7 still carry the demo records.  This
    handler runs once per process start and PERMANENTLY DELETES every
    legacy demo member plus all documents that referenced them across
    every collection (cascading delete).

    Idempotent — once the demo rows are gone subsequent runs find zero
    matches and exit immediately.  Safe to leave in place forever.

    Identification is fingerprint-based to minimise false positives:
      • Gregory: name=="Gregory" AND phone=="+1-555-0142"
      • James:   name=="James"   AND phone=="+1-555-0178"
    Plus the original Unsplash avatar URLs as a third confirmation signal.
    Real Kinnship users will not match all three fields by accident.
    """
    try:
        gregory_fingerprint = {
            "name": "Gregory",
            "phone": "+1-555-0142",
        }
        james_fingerprint = {
            "name": "James",
            "phone": "+1-555-0178",
        }
        targets = await db.members.find(
            {"$or": [gregory_fingerprint, james_fingerprint]},
            {"_id": 0, "id": 1, "family_group_id": 1, "name": 1, "owner_id": 1},
        ).to_list(5000)
        if not targets:
            return
        total_counts: dict = {
            "members": 0,
            "reminders": 0,
            "checkins": 0,
            "alerts": 0,
            "medication_logs": 0,
            "med_notifications": 0,
        }
        for m in targets:
            mid = m.get("id")
            fgid = m.get("family_group_id")
            if not mid:
                continue
            # member itself
            res = await db.members.delete_one({"id": mid})
            total_counts["members"] += res.deleted_count
            # everything referencing the member id (cascade)
            for coll in (
                "reminders",
                "checkins",
                "alerts",
                "medication_logs",
                "med_notifications",
            ):
                q: dict = {"member_id": mid}
                if fgid:
                    q["family_group_id"] = fgid
                try:
                    r = await db[coll].delete_many(q)
                    total_counts[coll] += r.deleted_count
                except Exception as e:
                    logger.warning(f"purge {coll} for member={mid} failed: {e}")
        # ALSO purge alerts/reminders that were inserted referencing James/Gregory
        # but whose member_id has already been removed (orphans from prior partial
        # cleanups). Match by member_name as a fallback.
        for coll, label in (
            ("alerts", "member_name"),
            ("reminders", "member_name"),
        ):
            try:
                r = await db[coll].delete_many({label: {"$in": ["Gregory", "James"]}})
                if r.deleted_count:
                    total_counts.setdefault(f"{coll}_by_name", 0)
                    total_counts[f"{coll}_by_name"] += r.deleted_count
            except Exception as e:
                logger.warning(f"purge {coll} by name failed: {e}")
        if total_counts["members"] > 0 or any(v > 0 for v in total_counts.values()):
            logger.info(
                f"v1.1.7 demo-data purge complete. Deleted: {total_counts}"
            )
    except Exception as e:
        logger.warning(f"_purge_legacy_demo_data skipped: {e}")


@app.on_event("startup")
async def _backfill_location_sharing_flag():
    """Build #57 — one-time backfill.

    Build #55 introduced ``users.location_sharing_enabled`` (default True).
    Build #56 extended it to the member docs so family clients could render
    a "🔒 Location Sharing Off" state without a second round-trip.  But
    docs created before Build #56 don't have the field at all — which in
    turn means the frontend renders the pill as "🟢 Tracking Healthy"
    even for users who have flipped their preference OFF, because
    Pydantic supplies the default True during response serialization.

    This handler flips every member doc that's MISSING the field to
    ``True`` (matching the default) so subsequent reads are unambiguous.
    Docs that DO have the field are untouched.  Fully idempotent — after
    the first run, `modified_count` will be 0 on every subsequent boot.
    """
    try:
        res = await db.members.update_many(
            {"location_sharing_enabled": {"$exists": False}},
            {"$set": {"location_sharing_enabled": True}},
        )
        if res.modified_count:
            logger.info(
                f"Build #57 backfill: location_sharing_enabled set on "
                f"{res.modified_count} pre-existing member doc(s)."
            )
        else:
            logger.info("Build #57 backfill: no members needed migration.")
    except Exception as e:
        logger.warning(f"_backfill_location_sharing_flag skipped: {e}")


@app.on_event("startup")
async def _sync_user_sharing_pref_to_members():
    """Build #59 — one-time consistency sweep (per-account isolation).

    Re-syncs every user's own personal member row(s) to the current
    ``users.location_sharing_enabled`` value.  MATCH IS user_id ONLY
    (not owner_id) — matching on owner_id would incorrectly wipe
    location on rows this user created FOR OTHER PEOPLE (their
    parents, spouse, etc.).  That was the exact P3 blocker fixed in
    Build #59: one caregiver turning sharing OFF was also wiping another
    member's location because that row had the caregiver as owner.

    When the preference is OFF we also null the coord fields so no
    stale location leaks.  Idempotent.
    """
    try:
        # Users who have explicitly disabled sharing but whose member
        # doc(s) still carry True (or missing the flag).
        cursor = db.users.find(
            {"location_sharing_enabled": False},
            {"_id": 0, "id": 1},
        )
        n_users = 0
        n_members = 0
        async for u in cursor:
            uid = u.get("id")
            if not uid:
                continue
            n_users += 1
            res = await db.members.update_many(
                {"user_id": uid},
                {"$set": {
                    "location_sharing_enabled": False,
                    "latitude": None,
                    "longitude": None,
                    "location_name": "Location Sharing Off",
                }},
            )
            n_members += res.modified_count
        if n_users:
            logger.info(
                f"Build #57 consistency sweep: {n_users} users had sharing OFF; "
                f"re-mirrored to {n_members} member doc(s)."
            )
    except Exception as e:
        logger.warning(f"_sync_user_sharing_pref_to_members skipped: {e}")


@app.on_event("startup")
async def _heal_cross_user_sharing_leaks():
    """Build #59 — one-time heal for the Build #56–58 location-sharing
    cross-contamination bug.

    Prior sweeps used ``$or: [{user_id: X}, {owner_id: X}]`` which
    over-matched: any member row that Caregiver X had created for
    another person (e.g. a member row created by a caregiver) got its
    ``location_sharing_enabled`` incorrectly flipped to False and
    coords wiped.

    Heal condition:
        member.user_id is set (has a real linked account)
        AND member.user_id != member.owner_id  (row belongs to
             someone OTHER than the caregiver who created it)
        AND member.location_sharing_enabled is False
        AND linked users.location_sharing_enabled is True (the
             actual owner of the row never asked to disable)
      → set member.location_sharing_enabled = True and unset the
        "Location Sharing Off" placeholder so real coords stream in
        on the next upload.

    Idempotent.  Only runs once per boot; if there's nothing to heal,
    no writes happen.
    """
    try:
        cursor = db.members.find(
            {
                "location_sharing_enabled": False,
                "user_id": {"$ne": None, "$exists": True},
            },
            {"_id": 0, "id": 1, "user_id": 1, "owner_id": 1},
        )
        candidates = []
        async for m in cursor:
            uid = m.get("user_id")
            oid = m.get("owner_id")
            if not uid or uid == oid:
                continue  # legit self-toggle; not a cross-user leak
            candidates.append(m)

        if not candidates:
            logger.info("Build #59 heal: no cross-user sharing leaks to fix.")
            return

        healed = 0
        for m in candidates:
            uid = m["user_id"]
            u = await db.users.find_one(
                {"id": uid}, {"_id": 0, "location_sharing_enabled": 1}
            )
            if not u:
                continue
            user_pref = u.get("location_sharing_enabled")
            # None/missing => default True.  Only heal if the linked
            # user's own preference says they want sharing ON.
            if user_pref is False:
                continue
            await db.members.update_one(
                {"id": m["id"]},
                {
                    "$set": {"location_sharing_enabled": True},
                    "$unset": {"location_name": ""},
                },
            )
            healed += 1

        logger.info(
            f"Build #59 heal: repaired {healed} cross-user "
            f"location-sharing leak(s) out of {len(candidates)} candidates."
        )
    except Exception as e:
        logger.warning(f"_heal_cross_user_sharing_leaks skipped: {e}")


@app.on_event("startup")
async def _heal_missing_self_member_rows():
    """Build #62 — one-time heal for the "caregiver has no self-member
    row" bug.  Every user in ``db.users`` who has a ``family_group_id``
    but does NOT have a corresponding row in ``db.members`` with
    ``user_id == user.id`` in that same group is a victim of the
    pre-Build-#62 signup path that skipped ``ensure_self_member_row``
    for fresh solo signups.  Their dashboard shows nothing for
    themselves and nobody else sees them either.

    Fix: on backend startup, sweep every user, find those missing a
    self-row, and create one via ``fg.ensure_self_member_row``.
    Idempotent (the helper is a no-op if a row already exists).

    Runs once per process boot.  On Railway that means every deploy
    fires this once — cheap ~O(n_users) scan with the members
    check being a per-user index lookup.  For a family safety app
    with a few thousand users this is milliseconds.
    """
    try:
        n_users = 0
        n_healed = 0
        cursor = db.users.find(
            {"family_group_id": {"$ne": None, "$exists": True}},
            {"_id": 0},
        )
        async for u in cursor:
            n_users += 1
            gid = u.get("family_group_id")
            uid = u.get("id")
            if not gid or not uid:
                continue
            existing = await db.members.find_one(
                {"family_group_id": gid, "user_id": uid},
                {"_id": 0, "id": 1},
            )
            if existing:
                continue
            # No self-member row — heal it.
            try:
                await fg.ensure_self_member_row(db, u, gid, None, caller="startup_migration")
                n_healed += 1
            except Exception as e:
                logger.error(
                    f"[self-member heal] user={uid[:8]} in group={gid[:8]} FAILED: {e}",
                    exc_info=True,
                )
        logger.info(
            f"[startup] self-member-row heal: scanned {n_users} users, "
            f"created missing rows for {n_healed}"
        )
        # Write result to migrations so we can verify it ran and what it found.
        await db.migrations.insert_one({
            "key": "self_member_row_heal",
            "scanned": n_users,
            "healed": n_healed,
            "run_at": datetime.now(timezone.utc),
        })
    except Exception as e:
        logger.warning(f"_heal_missing_self_member_rows skipped: {e}")

async def deliver_welfare_response_notification(
    request: dict,
    checkin_id: str,
    location_name: Optional[str] = None,
) -> None:
    """Atomically claim and deliver one confirmation to the requester."""
    claimed_at = datetime.now(timezone.utc)
    stale_before = claimed_at - timedelta(seconds=30)
    claim = await db.checkin_requests.update_one(
        {
            "id": request["id"],
            "family_group_id": request["family_group_id"],
            "status": "responded",
            "$or": [
                {"response_notification_status": "pending"},
                {
                    "response_notification_status": "sending",
                    "response_notification_claimed_at": {"$lt": stale_before},
                },
            ],
        },
        {
            "$set": {
                "response_notification_status": "sending",
                "response_notification_claimed_at": claimed_at,
            }
        },
    )
    if claim.modified_count != 1:
        return

    member_name = request["member_name"]
    loc_str = f" from {location_name}" if location_name else ""
    try:
        await push_to_user(
            request["requester_id"],
            f"✅ {member_name} is OK",
            f"{member_name} confirmed they are okay{loc_str}.",
            {
                "type": "are_you_ok_response",
                "member_id": request["member_id"],
                "checkin_id": checkin_id,
                "request_id": request["id"],
            },
        )
    except Exception as error:
        logger.warning(f"welfare response notify failed; delivery remains retryable: {error}")
        await db.checkin_requests.update_one(
            {
                "id": request["id"],
                "family_group_id": request["family_group_id"],
                "response_notification_status": "sending",
                "response_notification_claimed_at": claimed_at,
            },
            {
                "$set": {"response_notification_status": "pending"},
                "$unset": {"response_notification_claimed_at": ""},
            },
        )
        return

    await db.checkin_requests.update_one(
        {
            "id": request["id"],
            "family_group_id": request["family_group_id"],
            "response_notification_status": "sending",
            "response_notification_claimed_at": claimed_at,
        },
        {
            "$set": {
                "response_notification_status": "sent",
                "response_notification_sent_at": datetime.now(timezone.utc),
            },
            "$unset": {"response_notification_claimed_at": ""},
        },
    )
