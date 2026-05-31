import { Stack } from 'expo-router';

// (modals) group — full-screen presentation, no tab bar.
// Used for the notification ACKNOWLEDGE panel which is meant to be
// the only thing on screen for elderly users.
export default function ModalsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        presentation: 'fullScreenModal',
        animation: 'fade',
      }}
    />
  );
}
