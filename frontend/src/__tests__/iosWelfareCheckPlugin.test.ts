const {
  injectIosWelfareCheckAction,
} = require('../../plugins/withIosWelfareCheckAction');

const appDelegate = `import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
}
`;

describe('iOS welfare-check config plugin', () => {
  it('injects a native silent action handler and preserves Expo body-tap forwarding', () => {
    const result = injectIosWelfareCheckAction(appDelegate);
    expect(result).toContain('response.actionIdentifier == "IM_OK"');
    expect(result).toContain('/welfare-check-response');
    expect(result).toContain('forwardingDelegate?.userNotificationCenter?');
    expect(result).toContain('kSecAttrService as String: "app:no-auth"');
    expect(result).toContain('kSecAttrGeneric as String: encodedKey');
    expect(result).toContain('kSecAttrAccount as String: encodedKey');
    expect(result).toContain('welfareCheckNotificationDelegate = notificationDelegate');
  });

  it('is idempotent across repeated prebuilds', () => {
    const once = injectIosWelfareCheckAction(appDelegate);
    expect(injectIosWelfareCheckAction(once)).toBe(once);
  });
});