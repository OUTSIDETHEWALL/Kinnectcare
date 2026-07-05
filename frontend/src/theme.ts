export const Colors = {
  primary: '#1B5E35',
  primaryActive: '#113D22',
  secondary: '#2D8C55',
  tertiary: '#EAF3DE',
  background: '#F9F5F0',
  surface: '#FFFFFF',
  textPrimary: '#1A2E20',
  textSecondary: '#5A6B5E',
  // Darkened from #7A8A7E (3.64:1 — failed WCAG AA on white) to lift contrast
  // for senior users. Now 5.81:1 on white surfaces and ≥5:1 on every other
  // background in the palette. Hue preserved (still grey-green).
  textTertiary: '#566A5C',
  border: '#E3EDE0',
  errorBg: '#FEF2F2',
  error: '#B91C1C',
  // Darkened from #D97706 (3.19:1 on white — failed WCAG AA) to 5.17:1.
  // Affects "Missed meds" chips, refill warning banners, and warning button
  // text. Hue preserved (still amber/orange).
  warning: '#A85800',
  warningBg: '#FFFBEB',
  success: '#15803D',
  successBg: '#F0FDF4',
  sos: '#DC2626',
};

export const StatusColor = (status: string): string => {
  if (status === 'healthy') return Colors.success;
  if (status === 'warning') return Colors.warning;
  if (status === 'critical') return Colors.error;
  return Colors.textTertiary;
};
