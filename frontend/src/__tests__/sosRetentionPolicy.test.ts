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
});
