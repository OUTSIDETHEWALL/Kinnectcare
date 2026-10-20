package expo.modules.startupdiagnostics

import android.content.Context
import com.facebook.react.modules.network.NetworkingModule
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import okhttp3.Call
import okhttp3.Connection
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.HttpUrl
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response

/** Wrap the existing listener/client; never replace its dispatcher or connection pool. */
object NativeHttpEvidence {
  private var installed = false
  @Synchronized
  @JvmStatic fun install(context: Context) {
    if (installed) return
    val application = context.applicationContext
    EvidenceTrace.install(application)
    // RN exposes only a global setter. Refuse to overwrite someone else's hook.
    val occupied = try {
      NetworkingModule::class.java.getDeclaredField("customClientBuilder").apply { isAccessible = true }.get(null) != null
    } catch (_: Exception) {
      EvidenceTrace.httpStatus("declined_unreadable_custom_builder")
      return
    }
    if (occupied) {
      EvidenceTrace.httpStatus("declined_existing_custom_builder")
      return
    }
    NetworkingModule.setCustomClientBuilder { builder ->
      // Snapshot only to preserve the existing listener factory and dispatcher.
      // newBuilder/build share the original pool, dispatcher, cache and policy.
      val existing = builder.build()
      val original = existing.eventListenerFactory
      fun id(call: Call): String? {
        val request = call.request()
        val candidate = request.header("X-Kinnship-Startup-Trace") ?: return null
        return candidate.takeIf { Regex("[a-f0-9]{32}").matches(it)
          && request.method == "GET"
          && request.url.encodedPath in setOf("/api/auth/me", "/api/members", "/api/summary", "/api/alerts") }
      }
      builder.addInterceptor { chain ->
        val call = chain.call()
        id(call)?.let {
          EvidenceTrace.record(application, "http", "dispatcher_entered", it, "{}")
        }
        chain.proceed(chain.request())
      }
      builder.eventListenerFactory { call ->
        val delegate = original.create(call)
        val traceId = id(call)
        if (traceId == null) delegate else object : EventListener() {
          fun emit(stage: String, detail: String = "{}") =
            EvidenceTrace.record(application, "http", stage, traceId, detail)
          override fun callStart(call: Call) {
            emit("native_call_start", """{"queued":${existing.dispatcher.queuedCallsCount()},"running":${existing.dispatcher.runningCallsCount()}}""")
            delegate.callStart(call)
          }
          override fun dnsStart(call: Call, domainName: String) { emit("dns_start"); delegate.dnsStart(call, domainName) }
          override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) {
            emit("dns_end"); delegate.dnsEnd(call, domainName, inetAddressList)
          }
          override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
            emit("connect_start"); delegate.connectStart(call, inetSocketAddress, proxy)
          }
          override fun secureConnectStart(call: Call) { emit("tls_start"); delegate.secureConnectStart(call) }
          override fun secureConnectEnd(call: Call, handshake: Handshake?) { emit("tls_end"); delegate.secureConnectEnd(call, handshake) }
          override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) {
            emit("connect_end"); delegate.connectEnd(call, inetSocketAddress, proxy, protocol)
          }
          override fun connectFailed(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?, ioe: IOException) {
            emit("connect_failed"); delegate.connectFailed(call, inetSocketAddress, proxy, protocol, ioe)
          }
          override fun connectionAcquired(call: Call, connection: Connection) {
            emit("connection_acquired"); delegate.connectionAcquired(call, connection)
          }
          override fun connectionReleased(call: Call, connection: Connection) { delegate.connectionReleased(call, connection) }
          override fun requestHeadersStart(call: Call) { emit("request_headers_start"); delegate.requestHeadersStart(call) }
          override fun requestHeadersEnd(call: Call, request: Request) { emit("request_headers_end"); delegate.requestHeadersEnd(call, request) }
          override fun requestBodyStart(call: Call) { emit("request_body_start"); delegate.requestBodyStart(call) }
          override fun requestBodyEnd(call: Call, byteCount: Long) { emit("request_body_end"); delegate.requestBodyEnd(call, byteCount) }
          override fun requestFailed(call: Call, ioe: IOException) { delegate.requestFailed(call, ioe) }
          override fun responseHeadersStart(call: Call) { emit("response_headers_start"); delegate.responseHeadersStart(call) }
          override fun responseHeadersEnd(call: Call, response: Response) {
            val edgeId = response.header("x-railway-request-id").orEmpty()
            val safeEdgeId = edgeId.takeIf { Regex("[A-Za-z0-9_-]{1,128}").matches(it) }.orEmpty()
            emit("response_headers_end", """{"status":${response.code},"edgeId":"$safeEdgeId"}""")
            delegate.responseHeadersEnd(call, response)
          }
          override fun responseBodyStart(call: Call) { emit("response_body_start"); delegate.responseBodyStart(call) }
          override fun responseBodyEnd(call: Call, byteCount: Long) {
            emit("response_body_end"); delegate.responseBodyEnd(call, byteCount)
          }
          override fun responseFailed(call: Call, ioe: IOException) { delegate.responseFailed(call, ioe) }
          override fun callEnd(call: Call) { emit("native_call_end"); delegate.callEnd(call) }
          override fun callFailed(call: Call, ioe: IOException) { emit("native_call_failed"); delegate.callFailed(call, ioe) }
          override fun canceled(call: Call) { delegate.canceled(call) }
          override fun proxySelectStart(call: Call, url: HttpUrl) { delegate.proxySelectStart(call, url) }
          override fun proxySelectEnd(call: Call, url: HttpUrl, proxies: List<Proxy>) { delegate.proxySelectEnd(call, url, proxies) }
          override fun satisfactionFailure(call: Call, response: Response) { delegate.satisfactionFailure(call, response) }
          override fun cacheHit(call: Call, response: Response) { delegate.cacheHit(call, response) }
          override fun cacheMiss(call: Call) { delegate.cacheMiss(call) }
          override fun cacheConditionalHit(call: Call, response: Response) { delegate.cacheConditionalHit(call, response) }
        }
      }
    }
    installed = true
    EvidenceTrace.httpStatus("installed")
  }
}
