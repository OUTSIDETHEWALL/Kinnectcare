import { recordNativeStartupCheckpoint } from './nativeStartupRecorder';

// Before location/push registration and Router's static dependency evaluation.
// Uses the synchronous recorder already in Build 70; adds no optional task wait.
recordNativeStartupCheckpoint('js_entry_started');
