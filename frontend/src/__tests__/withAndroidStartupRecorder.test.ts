const plugin = require('../../plugins/withAndroidStartupRecorder');

// Representative Expo SDK 54 CNG Kotlin templates (new architecture enabled).
const MAIN_APPLICATION = `package app.kinnship.client

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactNativeHost
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {
  override val reactNativeHost = ReactNativeHostWrapper(
    this,
    object : DefaultReactNativeHost(this) {
      override fun getPackages(): List<ReactPackage> =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here.
        }
    }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }
}
`;

const MAIN_ACTIVITY = `package app.kinnship.client

import android.os.Bundle
import com.facebook.react.ReactActivity
import expo.modules.splashscreen.SplashScreenManager

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    SplashScreenManager.registerOnActivity(this)
    super.onCreate(null)
  }

  override fun invokeDefaultOnBackPressed() {
    moveTaskToBack(true)
  }
}
`;

describe('withAndroidStartupRecorder', () => {
  const packageName = 'app.kinnship.client';

  test('injects SDK 54 MainApplication truthful checkpoints once without legacy package registration', () => {
    const once = plugin.injectMainApplication(MAIN_APPLICATION);
    const twice = plugin.injectMainApplication(once);

    expect(twice).toBe(once);
    expect(once).not.toContain('StartupDiagnosticsPackage');
    expect(once.match(/native_application_on_create_started/g)).toHaveLength(1);
    expect(once.match(/native_application_on_create_completed/g)).toHaveLength(1);
    expect(once).toContain(
      'StartupDiagnosticsRecorder.record(this, "native_application_on_create_started", null)',
    );
    expect(once).toContain(
      'StartupDiagnosticsRecorder.record(this, "native_application_on_create_completed", null)',
    );
    expect(once).toContain('PackageList(this).packages.apply');
    expect(once.indexOf('native_application_on_create_started'))
      .toBeLessThan(once.indexOf('super.onCreate()'));
    expect(once.indexOf('native_application_on_create_completed'))
      .toBeGreaterThan(once.indexOf('ApplicationLifecycleDispatcher.onApplicationCreate(this)'));
  });

  test('injects SDK 54 MainActivity lifecycle and focus checkpoints once', () => {
    const once = plugin.injectMainActivity(MAIN_ACTIVITY);
    const twice = plugin.injectMainActivity(once);

    expect(twice).toBe(once);
    expect(once.match(/native_activity_on_create_started/g)).toHaveLength(1);
    expect(once.match(/native_activity_on_create_completed/g)).toHaveLength(1);
    expect(once.match(/override fun onWindowFocusChanged/g)).toHaveLength(1);
    expect(once.match(/native_activity_window_focus_changed/g)).toHaveLength(1);
    expect(once).toContain(
      'StartupDiagnosticsRecorder.record(this, "native_activity_on_create_started", null)',
    );
    expect(once).toContain(
      'StartupDiagnosticsRecorder.record(this, "native_activity_on_create_completed", null)',
    );
    expect(once).toContain(
      'StartupDiagnosticsRecorder.record(this, "native_activity_window_focus_changed"',
    );
    expect(once.indexOf('native_activity_on_create_started'))
      .toBeLessThan(once.indexOf('SplashScreenManager.registerOnActivity(this)'));
    expect(once.indexOf('native_activity_on_create_completed'))
      .toBeGreaterThan(once.indexOf('super.onCreate(null)'));
  });

  test('uses Expo Module Functions and contains no legacy bridge package source', () => {
    const fs = require('fs');
    const path = require('path');
    const moduleRoot = path.join(__dirname, '../../modules/startup-diagnostics');
    const moduleGradle = fs.readFileSync(path.join(moduleRoot, 'android/build.gradle'), 'utf8');
    const source = fs.readFileSync(
      path.join(moduleRoot, 'android/src/main/java/expo/modules/startupdiagnostics/StartupDiagnosticsModule.kt'),
      'utf8',
    );
    const config = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'expo-module.config.json'), 'utf8'));

    expect(moduleGradle).toContain("version = '1.0.0'");
    expect(moduleGradle).toContain('versionCode 1');
    expect(moduleGradle).toContain("versionName '1.0.0'");
    expect(source).toContain('class StartupDiagnosticsModule : Module()');
    expect(source.match(/Function\("/g)).toHaveLength(3);
    expect(source).not.toContain('AsyncFunction');
    expect(source).not.toContain('@ReactMethod');
    expect(source).not.toContain('ReactPackage');
    expect(source).toContain('.commit()');
    expect(source).toContain('putString(LATEST, entry.toString())');
    expect(config.android.modules).toEqual([
      'expo.modules.startupdiagnostics.StartupDiagnosticsModule',
    ]);
  });

  test('uses an exact metadata allowlist and cannot retain sensitive or unknown metadata', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '../../modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/StartupDiagnosticsModule.kt'),
      'utf8',
    );
    const allowlist = [...source.matchAll(/^\s*"([^"]+)",?$/gm)]
      .map((match: RegExpMatchArray) => match[1])
      .filter((key: string) => [
        'authenticated', 'pathnameObserved', 'coldStart', 'urlPresent', 'invitePresent',
        'accepted', 'alreadyConsumed', 'persistenceFailed', 'android',
      ].includes(key));

    expect(allowlist).toEqual([
      'authenticated', 'pathnameObserved', 'coldStart', 'urlPresent', 'invitePresent',
      'accepted', 'alreadyConsumed', 'persistenceFailed', 'android',
    ]);
    for (const forbidden of [
      'latitude', 'longitude', 'password', 'secret', 'jwt', 'token',
      'session', 'credential', 'arbitraryUnknown',
    ]) {
      expect(allowlist).not.toContain(forbidden);
    }
    expect(source).toContain('key in allowedMetadataKeys');
    expect(source).toContain('(value is Boolean || value is Number)');
    expect(source).not.toContain('value is String');
  });
});