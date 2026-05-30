import { Tabs } from 'expo-router';
import { Icon } from '../../src/Icon';
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
          tabBarIcon: ({ color, size }) => <Icon name="people" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          tabBarIcon: ({ color, size }) => <Icon name="notifications" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
