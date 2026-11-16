"""Accessible, senior-friendly invitation email and browser fallback pages."""

from __future__ import annotations

import html
import os
import re
from datetime import datetime
from typing import Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


DEFAULT_WEB_BASE = "https://kinnectcare-production.up.railway.app"
DEFAULT_PLAY_STORE_URL = (
    "https://play.google.com/store/apps/details?id=app.kinnship.client"
)
_TOKEN_CHARS = re.compile(r"[^A-Za-z0-9-]")


def _safe_token(token: str) -> str:
    """Keep only characters supported by invitation IDs and deep links."""
    return _TOKEN_CHARS.sub("", token or "")[:128]


def _web_base() -> str:
    return (
        os.environ.get("KINNSHIP_WEB_BASE")
        or os.environ.get("BACKEND_BASE_URL")
        or DEFAULT_WEB_BASE
    ).rstrip("/")


def _play_store_url(token: str) -> str:
    """Add the install referrer while preserving configured query parameters."""
    configured = os.environ.get("KINNSHIP_PLAY_STORE_URL") or DEFAULT_PLAY_STORE_URL
    parts = urlsplit(configured)
    query = parse_qsl(parts.query, keep_blank_values=True)
    query.append(("referrer", f"invite_token={token}"))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _expiry_date(expires_at: datetime) -> str:
    return expires_at.strftime("%B %d, %Y")


def invite_email_body(
    *,
    inviter_name: str,
    group_name: str,
    token: str,
    invitee_name: str,
    expires_at: datetime,
    relationship: Optional[str] = None,
) -> Tuple[str, str, str]:
    """Return subject, plain-text body, and accessible HTML invitation."""
    safe_token = _safe_token(token)
    subject = f"{inviter_name} invited you to join Kinnship"
    inviter_possessive = f"{inviter_name}'s"
    join_url = f"{_web_base()}/invite/{safe_token}"
    store_url = _play_store_url(safe_token)
    expiry = _expiry_date(expires_at)
    relationship_text = f" as their {relationship}" if relationship else ""
    family_name = group_name or f"{inviter_possessive} family"

    text_body = (
        f"Hi {invitee_name},\n\n"
        f"{inviter_name} invited you to join {family_name} on Kinnship"
        f"{relationship_text}.\n\n"
        "1. If Kinnship is not installed, download it using the link below "
        "and install the app. If it is already installed, go straight to step 2.\n"
        "2. Open Kinnship, return to this same email, and choose Join "
        f"{inviter_possessive} Family.\n\n"
        "You do not need to enter an invitation code or share your password "
        "with anyone. The invitation link is for joining the family only.\n\n"
        f"Download Kinnship: {store_url}\n"
        f"Join {inviter_possessive} Family: {join_url}\n\n"
        f"This invitation expires on {expiry}. If you did not expect this "
        "email, you can ignore it.\n"
    )

    e = html.escape
    safe_subject = e(subject)
    safe_invitee = e(invitee_name)
    safe_inviter = e(inviter_name)
    safe_family = e(family_name)
    safe_relationship = e(relationship_text)
    safe_expiry = e(expiry)
    safe_join_url = e(join_url, quote=True)
    safe_store_url = e(store_url, quote=True)
    safe_inviter_possessive = e(inviter_possessive)

    html_body = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{safe_subject}</title>
</head>
<body style="margin:0;padding:0;background:#f2f5f0;color:#20352b;font-family:Arial,sans-serif;line-height:1.6;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f5f0;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#fffdf8;border:1px solid #dce6dc;border-radius:16px;">
        <tr><td style="padding:28px 28px 12px;background:#e8f0e6;border-radius:16px 16px 0 0;">
          <p style="margin:0;color:#28583f;font-size:16px;font-weight:700;letter-spacing:.04em;">KINNSHIP</p>
          <h1 style="margin:16px 0 8px;color:#20352b;font-size:28px;line-height:1.2;">A family invitation</h1>
          <p style="margin:0 0 16px;font-size:18px;">Hi {safe_invitee},</p>
        </td></tr>
        <tr><td style="padding:16px 28px 8px;">
          <p style="margin:0 0 18px;font-size:18px;">{safe_inviter} invited you to join <strong>{safe_family}</strong> on Kinnship{safe_relationship}.</p>
          <p style="margin:0 0 12px;font-size:17px;font-weight:700;">Two simple steps</p>
          <ol style="margin:0 0 22px;padding-left:26px;font-size:17px;">
            <li style="padding:0 0 8px;">If Kinnship is not installed, download and install it. If it is already installed, go straight to step 2.</li>
            <li>Open Kinnship, return to this same email, and choose “Join {safe_inviter_possessive} Family.”</li>
          </ol>
        </td></tr>
        <tr><td align="center" style="padding:4px 28px 12px;">
          <a href="{safe_store_url}" style="display:block;box-sizing:border-box;width:100%;padding:17px 20px;border-radius:12px;background:#28583f;color:#ffffff;text-align:center;text-decoration:none;font-size:19px;font-weight:700;line-height:1.35;">Download Kinnship</a>
        </td></tr>
        <tr><td align="center" style="padding:4px 28px 22px;">
          <a href="{safe_join_url}" style="display:block;box-sizing:border-box;width:100%;padding:17px 20px;border:2px solid #28583f;border-radius:12px;background:#fffdf8;color:#214a35;text-align:center;text-decoration:none;font-size:19px;font-weight:700;line-height:1.35;">Join {safe_inviter_possessive} Family</a>
        </td></tr>
        <tr><td style="padding:0 28px 22px;">
          <p style="margin:0 0 12px;font-size:16px;">If Kinnship is already installed, skip the download and go straight to Join. If not, install it, then come back to this same email and tap the join button. You do not need to type a code or share a password.</p>
          <p style="margin:0;color:#52675b;font-size:15px;">This invitation expires on <strong>{safe_expiry}</strong>. If you did not expect it, you can ignore this email.</p>
        </td></tr>
        <tr><td style="padding:16px 28px;background:#f5f7f1;border-top:1px solid #e1e8df;border-radius:0 0 16px 16px;">
          <p style="margin:0;color:#52675b;font-size:14px;">Kinnship family care</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""
    return subject, text_body, html_body


def invite_landing_html(token: str) -> str:
    """Render an explicit-choice browser fallback; loading it never consumes an invite."""
    safe_token = _safe_token(token)
    app_url = f"kinnship://invite/{safe_token}"
    store_url = _play_store_url(safe_token)
    safe_app_url = html.escape(app_url, quote=True)
    safe_store_url = html.escape(store_url, quote=True)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your Kinnship invitation</title>
  <style>
    * {{ box-sizing:border-box; }}
    body {{ margin:0; min-height:100vh; padding:24px 16px; display:flex; align-items:center; justify-content:center; background:#f2f5f0; color:#20352b; font-family:Arial,sans-serif; line-height:1.6; }}
    main {{ width:100%; max-width:460px; overflow:hidden; background:#fffdf8; border:1px solid #dce6dc; border-radius:18px; }}
    header {{ padding:26px 28px 22px; background:#e8f0e6; }}
    .brand {{ margin:0; color:#28583f; font-size:16px; font-weight:700; letter-spacing:.04em; }}
    h1 {{ margin:18px 0 0; font-size:28px; line-height:1.2; }}
    section {{ padding:22px 28px 28px; }}
    p {{ margin:0 0 16px; font-size:17px; }}
    a {{ display:block; margin-top:14px; padding:17px 18px; border-radius:12px; background:#28583f; color:#fff; text-align:center; text-decoration:none; font-size:19px; font-weight:700; }}
    a.secondary {{ border:2px solid #28583f; background:#fffdf8; color:#214a35; }}
    a:focus-visible {{ outline:4px solid #bd6b38; outline-offset:3px; }}
    .note {{ margin:20px 0 0; color:#52675b; font-size:15px; }}
    @media (max-width:420px) {{ header, section {{ padding-left:22px; padding-right:22px; }} }}
  </style>
</head>
<body>
  <main>
    <header><p class="brand">KINNSHIP</p><h1>Your family invitation</h1></header>
    <section>
      <p>If Kinnship is already installed, open the invitation from your same email and choose <strong>Join</strong>. A verified App Link normally opens Kinnship directly when your device supports it.</p>
      <a href="{safe_app_url}">Open Kinnship</a>
      <p style="margin-top:22px;">If you need the app, download and install it, then return to the same invitation email and tap the join link.</p>
      <a class="secondary" href="{safe_store_url}">Download Kinnship</a>
      <p class="note">This page does not accept or use your invitation by itself. You do not need to enter a code or share a password.</p>
    </section>
  </main>
</body>
</html>"""
