const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/** Pin/patch the installed native source during prebuild, not an OTA shim. */
function patchSharing(source) {
  if (source.includes('Kinnship share lifecycle')) return source;
  const required = ['private var pendingPromise: Promise? = null',
    'pendingPromise = promise', 'appContext.throwingActivity.startActivityForResult(intent, REQUEST_CODE)',
    '    OnActivityResult { _, (requestCode) ->'];
  if (required.some(text => !source.includes(text))) {
    throw new Error('Expo Sharing source changed; review the native lifecycle patch before building.');
  }
  source = source.replace('private var pendingPromise: Promise? = null', `
  // Kinnship share lifecycle. No timer releases an active chooser.
  @Volatile private var pendingPromise: Promise? = null
  private var pendingRequestCode = 0
  private var chooserPausedHost = false
  private fun clearShare(expected: Promise?): Promise? = synchronized(this) {
    if (expected == null || pendingPromise !== expected) return@synchronized null
    val previous = pendingPromise
    pendingPromise = null
    chooserPausedHost = false
    previous
  }
  private fun interruptShare() {
    runCatching {
      clearShare(pendingPromise)?.reject("ERR_SHARING_INTERRUPTED",
        "The Activity was recreated while sharing. Return to Diagnostics and retry export.", null)
    }
  }`);
  source = source.replace(`      if (pendingPromise != null) {
        throw SharingInProgressException()
      }`, `      synchronized(this@SharingModule) {
        if (pendingPromise != null) throw SharingInProgressException()
        pendingPromise = promise
        pendingRequestCode = (nextShareCode.incrementAndGet() and 0xffff).coerceAtLeast(1)
        chooserPausedHost = false
      }`);
  source = source.replace(`        pendingPromise = promise
        appContext.throwingActivity.startActivityForResult(intent, REQUEST_CODE)`,
  '        appContext.throwingActivity.startActivityForResult(intent, pendingRequestCode)');
  source = source.replace('} catch (e: InvalidArgumentException) {',
    '} catch (e: InvalidArgumentException) {\n        clearShare(promise)');
  source = source.replace('} catch (e: Exception) {',
    '} catch (e: Exception) {\n        clearShare(promise)');
  const begin = source.indexOf('    OnActivityResult { _, (requestCode) ->');
  const end = source.indexOf('\n  @Throws(InvalidArgumentException::class)', begin);
  if (end < 0) throw new Error('Expo Sharing lifecycle boundary changed.');
  source = source.slice(0, begin) + `
    OnActivityResult { _, (requestCode) ->
      val expected = synchronized(this@SharingModule) {
        if (requestCode == pendingRequestCode) pendingPromise else null
      }
      clearShare(expected)?.resolve(null)
    }
    OnActivityEntersBackground {
      synchronized(this@SharingModule) {
        if (pendingPromise != null) chooserPausedHost = true
      }
    }
    OnActivityEntersForeground {
      val expected = synchronized(this@SharingModule) {
        if (chooserPausedHost) pendingPromise else null
      }
      // Give an actual activity result first opportunity. If Android loses it,
      // returning to our foreground Activity still ends this chooser session.
      android.os.Handler(android.os.Looper.getMainLooper()).post {
        clearShare(expected)?.resolve(null)
      }
    }
    // Cancel explicitly rather than relying on Expo's incomplete fallback
    // restoration. Unique request codes prevent a late result clearing a retry.
    OnActivityDestroys { interruptShare() }
    OnDestroy { interruptShare() }
  }
` + source.slice(end);
  source = source.replace('private const val REQUEST_CODE = 8524',
    'private val nextShareCode = java.util.concurrent.atomic.AtomicInteger(0x4b00)');
  return source;
}

module.exports = config => withDangerousMod(config, ['android', async config => {
  const file = path.join(config.modRequest.projectRoot,
    'node_modules/expo-sharing/android/src/main/java/expo/modules/sharing/SharingModule.kt');
  fs.writeFileSync(file, patchSharing(fs.readFileSync(file, 'utf8')));
  return config;
}]);
module.exports.patchSharing = patchSharing;
