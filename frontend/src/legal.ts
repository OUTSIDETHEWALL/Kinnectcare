// Static legal content for Kinnship LLC. Used by both the Privacy Policy
// and Terms of Service screens, and from the auth/settings entry points.

export const COMPANY_NAME = 'Kinnship LLC';
export const APP_NAME = 'Kinnship';
export const CONTACT_EMAIL = 'support@kinnship.app';
export const LEGAL_EFFECTIVE_DATE = 'May 13, 2026';

export type LegalSection = {
  heading: string;
  body: string;
};

export const PRIVACY_POLICY: LegalSection[] = [
  {
    heading: '1. Who We Are',
    body:
      `${APP_NAME} is operated by ${COMPANY_NAME} ("Kinnship", "we", "us", or "our"). ` +
      `${APP_NAME} is a family safety and senior wellness application that helps families ` +
      `stay connected with loved ones through check-ins, medication reminders, daily routines, ` +
      `and emergency alerts. This Privacy Policy explains what information we collect, how we ` +
      `use it, and the choices you have. By using ${APP_NAME}, you agree to the practices ` +
      `described below.`,
  },
  {
    heading: '2. Information We Collect',
    body:
      `Account information: name, email address, and password (stored as a one-way hashed value). ` +
      `Family member profiles: names, ages, roles, optional phone numbers, and an optional daily ` +
      `check-in time you configure. Health & routine data: medication titles, dosages, scheduled ` +
      `times, completion history, daily routine items, and check-in records. Location data: when ` +
      `you use SOS or share a check-in, we record the device’s GPS coordinates at that moment ` +
      `(latitude, longitude, and timestamp). We do not continuously track location in the background. ` +
      `Device & push data: Expo push notification tokens, time zone, and limited diagnostic logs. ` +
      `We do not knowingly collect personal information from children under the age of 13.`,
  },
  {
    heading: '3. How We Use Your Information',
    body:
      `We use the information you provide to (a) deliver core ${APP_NAME} features such as ` +
      `reminders, check-ins, the family dashboard, and SOS alerts; (b) compute medication compliance ` +
      `statistics for your own household; (c) send push notifications you have opted into; ` +
      `(d) maintain account security; and (e) improve the service and resolve issues. We do not ` +
      `sell personal data, and we do not use your health or location data for advertising.`,
  },
  {
    heading: '4. How We Share Information',
    body:
      `We only share information as needed to operate ${APP_NAME}: (a) with service providers ` +
      `that host our infrastructure or deliver push notifications (e.g., Expo); (b) when required ` +
      `by law, legal process, or to protect the safety of a user or the public; and (c) in connection ` +
      `with a business transfer (merger, acquisition, or sale of assets), in which case affected ` +
      `users will be notified. We never sell your data to advertisers or data brokers.`,
  },
  {
    heading: '5. SOS & Emergency Data',
    body:
      `When you trigger an SOS, ${APP_NAME} records the affected family member, their current ` +
      `GPS coordinates, and a timestamp, and sends a push notification to family members linked to ` +
      `your account so they can respond. ${APP_NAME} is not a replacement for emergency services — ` +
      `if you are in immediate danger, please call 911 (or your local emergency number).`,
  },
  {
    heading: '6. Data Retention & Security',
    body:
      `We keep your data for as long as your account is active. You can delete a family member, a ` +
      `reminder, or your entire account at any time, after which the associated data is removed from ` +
      `our production database within 30 days. We use industry-standard safeguards including ` +
      `encryption in transit (TLS), hashed passwords, and access controls. No system is perfectly ` +
      `secure, and we cannot guarantee absolute security of information transmitted to us.`,
  },
  {
    heading: '7. Your Choices & Rights',
    body:
      `You can review and update your profile, family members, and reminders inside the app. You ` +
      `may opt out of push notifications via your device settings. Depending on where you live, you ` +
      `may have additional rights under laws such as the GDPR or CCPA, including the right to access, ` +
      `correct, delete, or port your personal data. To exercise these rights, contact us at ` +
      `${CONTACT_EMAIL}.`,
  },
  {
    heading: '8. Children’s Privacy',
    body:
      `${APP_NAME} is designed for adults caring for their family members. We do not knowingly ` +
      `create accounts for, or collect personal information from, children under 13. If you believe ` +
      `a child has provided us with personal information, please contact us so we can remove it.`,
  },
  {
    heading: '9. Changes to This Policy',
    body:
      `We may update this Privacy Policy from time to time. We will post the new effective date at ` +
      `the top of this screen and, where appropriate, send an in-app notice. Continued use of ` +
      `${APP_NAME} after a change takes effect means you accept the revised policy.`,
  },
  {
    heading: '10. Contact Us',
    body:
      `Questions, requests, or concerns? Email ${CONTACT_EMAIL} or write to ${COMPANY_NAME}, ` +
      `Attn: Privacy.`,
  },
];

export const TERMS_OF_SERVICE: LegalSection[] = [
  {
    heading: '1. Acceptance of Terms',
    body:
      `These Terms of Service ("Terms") are a binding agreement between you and ${COMPANY_NAME} ` +
      `("Kinnship", "we", "us", or "our"). By creating an account, accessing, or using ${APP_NAME}, ` +
      `you agree to these Terms and our Privacy Policy. If you do not agree, please do not use the ` +
      `service.`,
  },
  {
    heading: '2. The Service',
    body:
      `${APP_NAME} is a family safety and senior wellness platform. It provides tools such as a ` +
      `shared family dashboard, medication and routine reminders, daily check-ins, medication ` +
      `compliance tracking, and an SOS button that can capture GPS coordinates and notify family ` +
      `members. Features may evolve over time as we improve the product.`,
  },
  {
    heading: '3. Not a Medical or Emergency Service',
    body:
      `${APP_NAME} is provided for informational and organizational purposes only. It is not a ` +
      `medical device and does not provide medical advice, diagnosis, or treatment. Reminders and ` +
      `compliance statistics are tools to support — not replace — guidance from licensed healthcare ` +
      `professionals. In an emergency, dial 911 (or your local emergency number) immediately. ` +
      `${APP_NAME} cannot guarantee delivery of any alert.`,
  },
  {
    heading: '4. Eligibility & Accounts',
    body:
      `You must be at least 18 years old, or the age of majority in your jurisdiction, to create an ` +
      `account. You agree to provide accurate, current information, and to keep your password secure. ` +
      `You are responsible for all activity that occurs under your account. Notify us promptly if ` +
      `you suspect unauthorized use.`,
  },
  {
    heading: '5. Family Members & Consent',
    body:
      `If you add another person’s information (name, age, phone, location preferences, medications, ` +
      `etc.) to your account, you represent that you have authority and the necessary consent to do ` +
      `so, and that you will respect that person’s privacy. You are responsible for keeping their ` +
      `information accurate and removing it when they no longer wish to be tracked.`,
  },
  {
    heading: '6. Acceptable Use',
    body:
      `You agree not to: (a) misuse the SOS feature for non-emergencies or pranks; (b) reverse engineer, ` +
      `decompile, or interfere with the service; (c) attempt to access another user’s data without ` +
      `permission; (d) use the service to harass, stalk, threaten, or harm any individual; or (e) ` +
      `violate any applicable law or regulation. We may suspend or terminate accounts that violate ` +
      `these rules.`,
  },
  {
    heading: '7. Intellectual Property',
    body:
      `${APP_NAME}, the Kinnship name and logo, and all related content other than user content ` +
      `are owned by ${COMPANY_NAME} or its licensors. We grant you a limited, non-exclusive, ` +
      `non-transferable, revocable license to use the app for personal, non-commercial purposes ` +
      `consistent with these Terms.`,
  },
  {
    heading: '8. Your Content',
    body:
      `You retain ownership of the information you submit (family members, medications, check-ins, ` +
      `etc.). You grant ${COMPANY_NAME} a worldwide, royalty-free license to host, store, and ` +
      `process that content solely to operate and improve ${APP_NAME}. You are responsible for ` +
      `the legality and accuracy of what you submit.`,
  },
  {
    heading: '9. Disclaimers',
    body:
      `${APP_NAME} is provided "as is" and "as available", without warranties of any kind, whether ` +
      `express, implied, or statutory. We do not warrant that the service will be uninterrupted, ` +
      `timely, secure, or error-free, or that any alert, reminder, or notification will be delivered ` +
      `on time or at all. You use ${APP_NAME} at your own risk.`,
  },
  {
    heading: '10. Limitation of Liability',
    body:
      `To the maximum extent permitted by law, ${COMPANY_NAME} and its affiliates will not be liable ` +
      `for any indirect, incidental, special, consequential, or punitive damages, or any loss of ` +
      `profits, revenue, data, or goodwill, arising out of or related to your use of ${APP_NAME}. ` +
      `Our total liability for any claim related to the service is limited to the greater of (a) ` +
      `the amount you paid us in the 12 months before the claim, or (b) USD $50.`,
  },
  {
    heading: '11. Indemnification',
    body:
      `You agree to defend, indemnify, and hold harmless ${COMPANY_NAME}, its officers, directors, ` +
      `employees, and agents from any claims, damages, or expenses (including reasonable attorneys’ ` +
      `fees) arising out of your use of ${APP_NAME}, your content, your violation of these Terms, ` +
      `or your violation of any rights of another person.`,
  },
  {
    heading: '12. Termination',
    body:
      `You may stop using ${APP_NAME} at any time and delete your account from within the app. We ` +
      `may suspend or terminate accounts that violate these Terms or where required by law. Sections ` +
      `that by their nature should survive termination (e.g., disclaimers, limitations of liability) ` +
      `will survive.`,
  },
  {
    heading: '13. Governing Law',
    body:
      `These Terms are governed by the laws of the State of Delaware, United States, without regard ` +
      `to conflict-of-laws principles. Any dispute will be resolved in the state or federal courts ` +
      `located in Delaware, and you consent to personal jurisdiction there, except where applicable ` +
      `law gives you the right to bring a claim in your local jurisdiction.`,
  },
  {
    heading: '14. Changes',
    body:
      `We may update these Terms from time to time. When we do, we will post the new effective date ` +
      `at the top of this screen and, where appropriate, notify you in the app. Continued use of ` +
      `${APP_NAME} after a change means you accept the updated Terms.`,
  },
  {
    heading: '15. Contact',
    body:
      `Questions about these Terms? Email ${CONTACT_EMAIL} or write to ${COMPANY_NAME}, Attn: Legal.`,
  },
];
