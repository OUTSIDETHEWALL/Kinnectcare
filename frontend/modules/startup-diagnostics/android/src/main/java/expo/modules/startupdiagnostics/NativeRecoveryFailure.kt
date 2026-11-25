package expo.modules.startupdiagnostics

/** Fixed categories only: never persist SDK messages, URLs, tokens or locations. */
object NativeRecoveryFailure {
  fun category(error: String?): String {
    val text = error?.take(2048)?.lowercase() ?: return "missing_error"
    return when {
      "already" in text && ("start" in text || "enabled" in text) -> "already_enabled"
      "foregroundservicestartnotallowed" in text ||
        "startforegroundservice" in text && "not allowed" in text ||
        "foreground service" in text && ("not allowed" in text || "denied" in text) ->
          "foreground_start_denied"
      "securityexception" in text || "permission" in text -> "permission_denied"
      "timeout" in text || "timed out" in text -> "timeout"
      "license" in text -> "license_error"
      "configuration" in text || "not ready" in text -> "configuration_error"
      else -> "unclassified"
    }
  }

  // Preserve numeric SDK codes without copying arbitrary message content.
  fun code(error: String?): String? =
    error?.trim()?.takeIf { it.matches(Regex("[0-9]{1,6}")) }
}
