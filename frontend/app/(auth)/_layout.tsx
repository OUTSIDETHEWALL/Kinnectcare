import { Stack } from 'expo-router';
import { Colors } from '../../src/theme';

export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }} />
  );
}
