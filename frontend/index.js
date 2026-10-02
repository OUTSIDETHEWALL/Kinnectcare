// Keep Metro's runtime first, including for the web entry.
import '@expo/metro-runtime';

// Headless launches evaluate the entry without rendering the Router layout.
// Load the existing registration side effects before Router/UI initialization.
import './src/locationEngine';
import './src/batteryTask';

import 'expo-router/entry';