export const Colors = {
  primary: '#1B5E35',
  primaryActive: '#113D22',
  secondary: '#2D8C55',
  tertiary: '#EAF3DE',
  background: '#F9F5F0',
  surface: '#FFFFFF',
  textPrimary: '#062210',
  textSecondary: '#2B4734',
  textTertiary: '#4D7359',
  border: '#E3EDE0',
  errorBg: '#FEF2F2',
  error: '#B91C1C',
  warning: '#D97706',
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
