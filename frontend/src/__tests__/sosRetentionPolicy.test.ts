import { PRIVACY_POLICY } from '../legal';

describe('SOS retention disclosure', () => {
  it('discloses eligibility after resolution, not guaranteed deletion on a deadline', () => {
    const retention = PRIVACY_POLICY.find(section => section.heading.includes('Data Retention'));
    expect(retention).toBeDefined();
    expect(retention!.body).toContain('eligible for deletion 30 days after they are resolved');
    expect(retention!.body).toContain('even while your account is active');
    expect(retention!.body).toContain('rather than at an exact time');
    expect(retention!.body).toContain('Active, unresolved SOS records are not subject');
    expect(retention!.body).not.toContain('We keep your data for as long as your account is active.');
  });

  it('qualifies account deletion without promising immediate erasure of retained SOS', () => {
    const body = PRIVACY_POLICY.find(section => section.heading.includes('Data Retention'))!.body;
    expect(body).toContain('does not immediately erase resolved SOS history');
    expect(body).toContain('original family scope');
    expect(body).toContain('can block account deletion pending resolution or review');
    expect(body).toContain('Minimal hashed security records');
    expect(body).not.toContain('entire account at any time');
    expect(body).not.toContain('associated data is removed');
  });
});
