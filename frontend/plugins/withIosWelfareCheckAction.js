const { withAppDelegate } = require('expo/config-plugins');

const MARKER = 'final class KinnshipWelfareCheckNotificationDelegate';

const DELEGATE_SOURCE = `
final class KinnshipWelfareCheckNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  weak var forwardingDelegate: UNUserNotificationCenterDelegate?

  init(forwardingTo delegate: UNUserNotificationCenterDelegate?) {
    forwardingDelegate = delegate
    super.init()
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if let delegate = forwardingDelegate {
      delegate.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
    } else {
      completionHandler([])
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    guard response.actionIdentifier == "IM_OK" else {
      if let delegate = forwardingDelegate {
        delegate.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
      } else {
        completionHandler()
      }
      return
    }

    let userInfo = response.notification.request.content.userInfo
    let nestedData = userInfo["data"] as? [String: Any]
    guard
      let requestId = (userInfo["request_id"] ?? nestedData?["request_id"]) as? String,
      let memberId = (userInfo["member_id"] ?? nestedData?["member_id"]) as? String,
      let backendString = Bundle.main.object(forInfoDictionaryKey: "KinnshipBackendURL") as? String,
      !backendString.isEmpty,
      let encodedMemberId = memberId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
      let url = URL(string: backendString + "/api/members/" + encodedMemberId + "/welfare-check-response"),
      let token = secureStoreToken()
    else {
      completionHandler()
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = 10
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["request_id": requestId])

    URLSession.shared.dataTask(with: request) { _, _, _ in
      completionHandler()
    }.resume()
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    openSettingsFor notification: UNNotification?
  ) {
    forwardingDelegate?.userNotificationCenter?(center, openSettingsFor: notification)
  }

  private func secureStoreToken() -> String? {
    let encodedKey = Data("kc_token".utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      // Expo SecureStore 15 stores unauthenticated values in the no-auth
      // service namespace and matches both account and generic key data.
      kSecAttrService as String: "app:no-auth",
      kSecAttrGeneric as String: encodedKey,
      kSecAttrAccount as String: encodedKey,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data
    else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }
}
`;

function injectIosWelfareCheckAction(source) {
  if (source.includes(MARKER)) return source;

  let next = source;
  if (!next.includes('import UserNotifications')) {
    next = next.replace(
      'import Expo',
      'import Expo\nimport Security\nimport UserNotifications',
    );
  }
  next = next.replace(
    'var reactNativeFactory: RCTReactNativeFactory?',
    `var reactNativeFactory: RCTReactNativeFactory?
  private var welfareCheckNotificationDelegate: KinnshipWelfareCheckNotificationDelegate?`,
  );
  next = next.replace(
    'return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
    `let launched = super.application(application, didFinishLaunchingWithOptions: launchOptions)
    let notificationDelegate = KinnshipWelfareCheckNotificationDelegate(
      forwardingTo: UNUserNotificationCenter.current().delegate
    )
    welfareCheckNotificationDelegate = notificationDelegate
    UNUserNotificationCenter.current().delegate = notificationDelegate
    return launched`,
  );
  next = next.replace(
    '\nclass ReactNativeDelegate: ExpoReactNativeFactoryDelegate {',
    `\n${DELEGATE_SOURCE}\nclass ReactNativeDelegate: ExpoReactNativeFactoryDelegate {`,
  );
  return next;
}

module.exports = function withIosWelfareCheckAction(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('withIosWelfareCheckAction requires a Swift AppDelegate');
    }
    cfg.modResults.contents = injectIosWelfareCheckAction(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.injectIosWelfareCheckAction = injectIosWelfareCheckAction;
