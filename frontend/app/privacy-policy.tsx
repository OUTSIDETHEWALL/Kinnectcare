import { LegalScreen } from '../src/LegalScreen';
import { PRIVACY_POLICY, APP_NAME, COMPANY_NAME } from '../src/legal';

export default function PrivacyPolicyScreen() {
  return (
    <LegalScreen
      title="Privacy Policy"
      intro={`This Privacy Policy explains how ${COMPANY_NAME} collects, uses, and protects ` +
        `information when you use ${APP_NAME}. Please read it carefully so you understand ` +
        `your choices.`}
      sections={PRIVACY_POLICY}
      testIDPrefix="privacy"
    />
  );
}
