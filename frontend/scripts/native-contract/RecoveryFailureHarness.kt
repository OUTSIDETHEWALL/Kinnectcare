import expo.modules.startupdiagnostics.NativeRecoveryFailure as Failure

fun main() {
  check(Failure.category("Already started") == "already_enabled")
  check(Failure.category("Already enabled") == "already_enabled")
  check(Failure.category("ForegroundServiceStartNotAllowedException") == "foreground_start_denied")
  check(Failure.category("startForegroundService() not allowed") == "foreground_start_denied")
  check(Failure.category("SecurityException") == "permission_denied")
  check(Failure.category("Location permission denied") == "permission_denied")
  check(Failure.category("Timed out") == "timeout")
  check(Failure.category("Invalid license") == "license_error")
  check(Failure.category("SDK not ready") == "configuration_error")
  check(Failure.category(null) == "missing_error")
  check(Failure.code(" 403 ") == "403")
  check(Failure.code("1234567") == null)
  val privateMessage = "Bearer secret-token https://private.test/?token=secret " +
    "user@example.test 35.12345,-114.12345"
  check(Failure.category(privateMessage) == "unclassified")
  check(Failure.code(privateMessage) == null)
  check(Failure.category("Already enabled $privateMessage") == "already_enabled")
  println("PASS native recovery failure categories and sensitive-message exclusion")
}
