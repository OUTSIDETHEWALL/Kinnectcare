// Keep Metro's runtime first, including for the web entry.
import '@expo/metro-runtime';
import './src/startupEntryCheckpoint';

// Headless launches evaluate the entry without rendering the Router layout.
// Load the existing registration side effects before Router/UI initialization.
import './src/locationEngine';
import './src/batteryTask';
// Register Expo's existing notification task even when no UI listener mounts.
import './src/push';

import 'expo-router/entry';