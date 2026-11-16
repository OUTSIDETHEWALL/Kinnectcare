import importlib.util
import pathlib
import unittest
from datetime import datetime
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "invitation_presentation",
    pathlib.Path(__file__).parents[1] / "backend/invitation_presentation.py",
)
presentation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(presentation)


class InvitationPresentationTests(unittest.TestCase):
    def test_email_has_two_large_ctas_and_clear_install_then_return_steps(self):
        subject, text, body = presentation.invite_email_body(
            inviter_name="Avery", group_name="Avery's Family", token="Abc-123",
            invitee_name="Morgan", expires_at=datetime(2026, 7, 4),
        )
        self.assertEqual(subject, "Avery invited you to join Kinnship")
        self.assertEqual(body.count("<a href="), 2)
        self.assertIn(">Download Kinnship</a>", body)
        self.assertIn(">Join Avery&#x27;s Family</a>", body)
        self.assertIn("1. If Kinnship is not installed", text)
        self.assertIn("already installed, go straight to step 2", text)
        self.assertIn("2. Open Kinnship, return to this same email", text)
        self.assertIn("return to this same email", body.lower())
        self.assertNotIn("manual", text.lower())
        self.assertNotIn("password", text.lower().replace("share your password", ""))
        self.assertNotIn("&#10003;", body)

    def test_email_escapes_untrusted_values_and_sanitizes_token(self):
        _, text, body = presentation.invite_email_body(
            inviter_name="<Avery & Co>",
            group_name="<Family>",
            token='safe"><script>alert(1)</script>',
            invitee_name="<Morgan>",
            expires_at=datetime(2026, 1, 2),
            relationship="<caregiver>",
        )
        self.assertIn("&lt;Morgan&gt;", body)
        self.assertIn("&lt;Avery &amp; Co&gt;", body)
        self.assertNotIn("<script>", body)
        self.assertIn("/invite/safescriptalert1script", body)
        self.assertIn("/invite/safescriptalert1script", text)

    def test_urls_use_environment_and_encode_store_referrer(self):
        with patch.dict(
            "os.environ",
            {
                "KINNSHIP_WEB_BASE": "https://web.example.test/root/",
                "BACKEND_BASE_URL": "https://ignored.example.test",
                "KINNSHIP_PLAY_STORE_URL": "https://store.example.test/app?source=email",
            },
            clear=False,
        ):
            _, text, body = presentation.invite_email_body(
                inviter_name="Lee", group_name="Lee's Family", token="a-b",
                invitee_name="Sam", expires_at=datetime(2026, 8, 9),
            )
        self.assertIn("https://web.example.test/root/invite/a-b", text)
        self.assertIn("https://store.example.test/app?source=email&amp;referrer=invite_token%3Da-b", body)

    def test_landing_page_requires_explicit_tap_and_has_no_auto_redirect(self):
        page = presentation.invite_landing_html("abc-123")
        self.assertIn(">Open Kinnship</a>", page)
        self.assertIn(">Download Kinnship</a>", page)
        self.assertIn("return to the same invitation email", page)
        self.assertIn("kinnship://invite/abc-123", page)
        self.assertNotIn("<script", page.lower())
        self.assertNotIn("window.location", page)
        self.assertNotIn("settimeout", page.lower())

    def test_landing_page_safely_encodes_and_escapes_configured_store_url(self):
        with patch.dict(
            "os.environ",
            {"KINNSHIP_PLAY_STORE_URL": 'https://store.example.test/app?x="&'},
            clear=False,
        ):
            page = presentation.invite_landing_html('x"><script>')
        self.assertNotIn("<script>", page)
        self.assertIn("kinnship://invite/xscript", page)
        self.assertIn("&amp;", page)
        self.assertIn("referrer=invite_token%3Dxscript", page)


if __name__ == "__main__":
    unittest.main()
