import { Text, TextStyle } from 'react-native';

// Drop-in replacement for Ionicons using emoji so they render in Expo Go.
// Maps the icon names used across the app to the requested emoji set.
const MAP: Record<string, string> = {
  // Wellness
  'heart': '💚',

  // Nav
  'arrow-forward': '›',
  'arrow-back': '‹',
  'chevron-forward': '›',
  'close': '✕',
  'add': '➕',
  'log-out-outline': '↪',

  // Tabs / sections
  'home': '🏠',
  'people': '👨‍👩‍👧',
  'people-outline': '👨‍👩‍👧',
  'person': '👤',
  // Build #57 — Me tab used `person-circle-outline` from Build #56 but the
  // emoji map had no entry, so it fell back to the "•" dot placeholder
  // (root cause of the "tiny invisible dot" Charles saw on device).  Both
  // aliases now point at the same filled-person glyph so the Me tab
  // reads visually identical to Family (👨‍👩‍👧) and Alerts (🔔).
  'person-circle': '👤',
  'person-circle-outline': '👤',
  'person-outline': '👤',
  'settings': '⚙️',

  // Status & alerts
  'notifications': '🔔',
  'alert-circle': '🔔',
  'alert-circle-outline': '🔔',
  'warning': '🆘',
  'warning-outline': '🆘',
  'battery-dead-outline': '🔋',

  // Care
  'medical': '💊',
  'medical-outline': '💊',
  'checkmark': '✅',
  'checkmark-circle': '✅',

  // Member / location
  'location': '📍',
  'location-outline': '📍',
  'time-outline': '🕐',
  'call': '📞',
  'call-outline': '📞',
  'trash-outline': '🗑',

  // Status pills
  'senior': '👴',

  // Form helpers
  'eye': '👁',
  'eye-off': '🙈',
};

type Props = {
  name: string;
  size?: number;
  color?: string;
  style?: TextStyle;
};

export function Icon({ name, size = 18, color, style }: Props) {
  const ch = MAP[name] ?? '•';
  return (
    <Text
      allowFontScaling={false}
      style={[{ fontSize: size, color, lineHeight: size + 4, textAlign: 'center' }, style]}
    >
      {ch}
    </Text>
  );
}

export default Icon;
