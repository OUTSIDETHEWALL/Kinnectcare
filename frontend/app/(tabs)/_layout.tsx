import { Tabs } from 'expo-router';
// Build #58 — switched from our emoji-based Icon shim to the real
// Ionicons vector font for the tab bar only.  Rationale: Charles's
// device QA showed the Me tab emoji (👤) rendering visually mis-matched
// against Family (👨‍👩‍👧) and Alerts (🔔) — emojis render at slightly
// different sizes/weights across Android OEMs.  Real vector glyphs
// render consistently, tint cleanly with the active/inactive color,
// and are the filled variants Charles asked for by name.  The rest
// of the app keeps using ../../src/Icon (which is emoji-based and
// intentionally so, per the comment in that file).
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '../../src/theme';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textTertiary,
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
          tabBarIcon: ({ color, size }) => <Ionicons name="people" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: 'Me',
          // Build #58 — real Ionicons "person" (Ionicons v7+ default =
          // filled variant, matching Family's filled `people`).  This
          // is the icon Charles asked for by name.  Renders as a
          // proper vector silhouette in the same weight as its
          // neighbours; the earlier emoji `👤` looked out-of-place
          // because Android OEMs render single-person emojis at a
          // lighter weight than group emojis.
          tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          tabBarIcon: ({ color, size }) => <Ionicons name="notifications" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
