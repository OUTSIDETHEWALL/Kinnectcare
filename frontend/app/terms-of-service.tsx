import { LegalScreen } from '../src/LegalScreen';
import { TERMS_OF_SERVICE, APP_NAME, COMPANY_NAME } from '../src/legal';

export default function TermsOfServiceScreen() {
  return (
    <LegalScreen
      title="Terms of Service"
      intro={`These Terms govern your access to and use of ${APP_NAME}, provided by ` +
        `${COMPANY_NAME}. By creating an account or using the service, you agree to these Terms.`}
      sections={TERMS_OF_SERVICE}
      testIDPrefix="terms"
    />
  );
}
