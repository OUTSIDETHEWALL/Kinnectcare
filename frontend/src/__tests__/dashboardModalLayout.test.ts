import {
  getDashboardModalCardStyle,
  shouldScrollDashboardModalList,
} from '../dashboardModalLayout';

describe('shared dashboard detail modal layout', () => {
  it('leaves comfortable spacing above an Android three-button navigation area', () => {
    expect(getDashboardModalCardStyle(48)).toEqual({
      paddingBottom: 76,
    });
    expect(getDashboardModalCardStyle(-1)).toEqual({
      paddingBottom: 28,
    });
  });

  describe.each(['Needs Attention', 'Missed Medications'])('%s modal', () => {
    it.each([
      [1, false],
      [4, true],
      [8, true],
    ])('uses list scrolling appropriately for %i rows', (itemCount, expected) => {
      expect(shouldScrollDashboardModalList(itemCount)).toBe(expected);
    });
  });
});