import { Tabs } from 'expo-router';
// Build #59 — Custom Kinnship-branded tab icons.  Rationale: the
// Build #58 Ionicons swap (`people` / `person` / `notifications`)
// was better than emoji but still generic — the user asked for a
// visual identity: three tab icons that read as "this is Kinnship,
// not just another Android app".  New icons live in
// `../../src/KinnshipTabIcon` and share a single Kinnship-shield
// outer frame so all three tabs feel like a matched set.
import KinnshipTabIcon from '../../src/KinnshipTabIcon';
import { Colors } from '../../src/theme';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Muted grey-green for inactive tabs — never plain grey, per spec.
// Sits comfortably between #9AA69A and the deeper Kinnship green so
// the inactive state is still clearly branded.
const KINNSHIP_INACTIVE = '#8FA697';

export default function TabsLayout() {
  // On Android with edge-to-edge enabled, the system back/home bar overlays the
  // bottom of our app. Without inset-aware padding, our tab bar sits BEHIND
  // the system bar, making the Alerts tab unreachable. Read the safe-area
  // inset and add it to the tab bar's bottom padding + height so the tabs
  // always render above the system UI.
  const insets = useSafeAreaInsets();
  const baseBottomPad = Platform.OS === 'ios' ? 28 : 10;
  const bottomPad = baseBottomPad + insets.bottom;
  const baseHeight = Platform.OS === 'ios' ? 88 : 68;
  const height = baseHeight + insets.bottom;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.primary,        // Kinnship green #1B5E35
        tabBarInactiveTintColor: KINNSHIP_INACTIVE,   // Muted brand grey-green
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopColor: Colors.border,
          height,
          paddingTop: 8,
          paddingBottom: bottomPad,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: 'Family',
          tabBarIcon: ({ color, size, focused }) => (
            <KinnshipTabIcon name="family" color={color} size={size} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: 'Me',
          tabBarIcon: ({ color, size, focused }) => (
            <KinnshipTabIcon name="me" color={color} size={size} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          tabBarIcon: ({ color, size, focused }) => (
            <KinnshipTabIcon name="alerts" color={color} size={size} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
