/**
 * MemberMap — cross-platform interactive Google Maps view for a member's last
 * known GPS coordinates. Renders a custom green pin via Google Maps JS API
 * inside an iframe (web) or WebView (native), so the same HTML template
 * works on iPhone, Android, and the web preview.
 *
 * Build 65 — Flicker fix
 * ──────────────────────
 * The pre-Build-65 implementation rebuilt `source.html` on every coordinate
 * change (via useMemo).  A new `source` object causes react-native-webview
 * to tear down and recreate the internal WKWebView / Android WebView,
 * reloading the entire Google Maps JS library from the network on every GPS
 * tick.  That is the white flash.
 *
 * Fix: the WebView is mounted ONCE with the initial coordinates baked into
 * the HTML.  All subsequent coordinate changes are pushed into the existing
 * page context via:
 *   • native  → webViewRef.current.injectJavaScript(...)
 *   • web     → iframeRef.current.contentWindow.postMessage(...)
 *
 * The HTML exposes window.__kinnUpdatePosition(lat, lng) which moves both
 * markers and pans the camera — zero reloads, zero flashes.
 *
 * Props:
 *   latitude / longitude  – number | null/undefined – coords to focus
 *   memberName            – title for the marker
 *   locationName          – second-line label
 *   height                – pixel height (default 220)
 *   memberId              – passed through to the instrumentation log
 */
import { Platform, View, Text, StyleSheet } from 'react-native';
import { useEffect, useRef } from 'react';
import { WebView } from 'react-native-webview';
import type { WebView as WebViewType } from 'react-native-webview';
import { Colors } from './theme';
import { logScreenRender } from './screenRenderLog';

const KEY = (process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '').trim();
const PIN_COLOR = '#1B5E35';

type Props = {
  latitude?: number | null;
  longitude?: number | null;
  memberName?: string;
  locationName?: string;
  height?: number;
  memberId?: string | null;
};

function escapeJs(s: string): string {
  return String(s).replace(/[\\\n'"<>]/g, (c) =>
    c === '\\' ? '\\\\'
    : c === '\n' ? '\\n'
    : c === "'" ? "\\'"
    : c === '"' ? '\\"'
    : c === '<' ? '\\u003c'
    : '\\u003e',
  );
}

/**
 * Builds the one-time HTML payload.  This runs exactly once per MemberMap
 * mount (the first time we have valid coordinates).
 *
 * Key additions vs. pre-Build-65:
 *  • window.__kinnUpdatePosition(lat, lng) — moves both markers + pans camera.
 *    Called by injectJavaScript (native) or postMessage (web).
 *  • window.addEventListener('message', ...) — receives {type:'kinn-move',lat,lng}
 *    from the web-path parent frame.
 */
function buildHtml(lat: number, lng: number, label: string): string {
  const safeLabel = escapeJs(label);
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="initial-scale=1,width=device-width"/>
<style>
  html,body,#map{height:100%;margin:0;padding:0;background:#eef3ef;}
  #fallback{
    display:none;align-items:center;justify-content:center;
    height:100%;color:#1B5E35;font-family:-apple-system,Roboto,sans-serif;
    font-size:14px;padding:24px;text-align:center;
  }
</style>
</head><body>
<div id="map"></div>
<div id="fallback">⚠️ Map failed to load. Check Google Maps API key.</div>
<script>
(function(){
  // ── shared map state ──────────────────────────────────────────────────────
  var gmap, ringMarker, pinMarker;

  function showFallback(msg){
    var fb=document.getElementById('fallback');
    if(msg) fb.textContent=msg;
    fb.style.display='flex';
    document.getElementById('map').style.display='none';
  }

  // v1.2.8 instrumentation: posts back to React Native confirming the
  // marker has been placed at the given coordinates.
  function postRendered(lat,lng){
    try{
      if(window.ReactNativeWebView && window.ReactNativeWebView.postMessage){
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type:'kinn-map-rendered', lat:lat, lng:lng
        }));
      }
    }catch(_e){}
  }

  // ── Build 65: live position update (no page reload) ───────────────────────
  // Called by injectJavaScript (native) or postMessage listener (web).
  // Safe to call before the map is ready — guard prevents errors.
  window.__kinnUpdatePosition = function(lat, lng){
    if(!gmap || !ringMarker || !pinMarker) return;
    var pos = { lat: lat, lng: lng };
    ringMarker.setPosition(pos);
    pinMarker.setPosition(pos);
    gmap.panTo(pos);
    postRendered(lat, lng);
  };

  // Web-iframe path: parent sends { type:'kinn-move', lat, lng }
  window.addEventListener('message', function(evt){
    try{
      var d = (typeof evt.data === 'string') ? JSON.parse(evt.data) : evt.data;
      if(d && d.type === 'kinn-move' && typeof d.lat === 'number'){
        window.__kinnUpdatePosition(d.lat, d.lng);
      }
    }catch(_e){}
  });

  // ── Map initialisation (runs once via callback) ───────────────────────────
  window.__initKinnshipMap = function(){
    try{
      var pos = { lat: ${lat}, lng: ${lng} };
      gmap = new google.maps.Map(document.getElementById('map'), {
        center: pos,
        zoom: 15,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        zoomControl: true,
        gestureHandling: 'greedy',
        clickableIcons: false,
        styles: [
          {featureType:'poi',      elementType:'labels', stylers:[{visibility:'off'}]},
          {featureType:'transit',  elementType:'labels', stylers:[{visibility:'off'}]},
        ],
      });
      // Pulsing ring
      ringMarker = new google.maps.Marker({
        position: pos, map: gmap,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 22,
          fillColor: '${PIN_COLOR}',
          fillOpacity: 0.18,
          strokeOpacity: 0,
        },
      });
      // Solid pin
      pinMarker = new google.maps.Marker({
        position: pos, map: gmap, title: '${safeLabel}',
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 11,
          fillColor: '${PIN_COLOR}',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
        },
      });
      postRendered(${lat}, ${lng});
    }catch(e){
      showFallback('Map error: '+(e&&e.message?e.message:e));
    }
  };

  // Load Maps JS API
  var s = document.createElement('script');
  s.src = 'https://maps.googleapis.com/maps/api/js?key=${KEY}&callback=__initKinnshipMap&loading=async&v=weekly';
  s.async = true; s.defer = true;
  s.onerror = function(){ showFallback('Could not load Google Maps script.'); };
  document.head.appendChild(s);
  setTimeout(function(){
    if(!window.google || !window.google.maps) showFallback('Google Maps did not load (network or key).');
  }, 8000);
})();
</script>
</body></html>`;
}

export default function MemberMap({
  latitude, longitude, memberName, locationName, height = 220,
  memberId,
}: Props) {
  const hasCoords = (
    typeof latitude === 'number' && typeof longitude === 'number'
    && Number.isFinite(latitude) && Number.isFinite(longitude)
  );

  // ── Build 65: stable source ───────────────────────────────────────────────
  // htmlRef holds the ONE-TIME html string that is baked into the WebView
  // source.  It is set the first time we have valid coordinates and never
  // updated again, so the WebView is never remounted or reloaded.
  const htmlRef = useRef<string>('');
  const initialLabelRef = useRef<string>('');
  if (hasCoords && !htmlRef.current) {
    const label = memberName || locationName || 'Last known location';
    initialLabelRef.current = label;
    htmlRef.current = buildHtml(latitude as number, longitude as number, label);
  }

  // WebView ref (native) and iframe ref (web) for injecting position updates.
  const webViewRef = useRef<WebViewType>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Tracks whether the Maps API callback has fired (safe to inject).
  const mapReadyRef = useRef(false);

  // v1.2.8 instrumentation: timestamp when new coords arrive via props.
  const propTsRef = useRef<number>(0);
  useEffect(() => {
    if (!hasCoords) return;
    propTsRef.current = Date.now();
    logScreenRender({
      src: 'map-props',
      memberId,
      lat: latitude as number,
      lon: longitude as number,
      locationName: locationName ?? null,
    });
  }, [hasCoords, latitude, longitude, memberId, locationName]);

  // ── Build 65: push coordinate updates into the live page ─────────────────
  // Runs whenever lat/lng change AFTER the initial mount.
  // Uses injectJavaScript (native) or postMessage (web) — no source change.
  useEffect(() => {
    if (!hasCoords) return;
    const lat = latitude as number;
    const lng = longitude as number;

    if (Platform.OS === 'web') {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage(
        JSON.stringify({ type: 'kinn-move', lat, lng }),
        '*',
      );
      return;
    }

    // Native path — injectJavaScript runs in the existing WKWebView /
    // Android WebView context.  The __kinnUpdatePosition guard means this
    // is a safe no-op if the Maps callback hasn't fired yet; the initial
    // coordinates are already baked into the HTML so nothing is lost.
    const js = `
      if (typeof window.__kinnUpdatePosition === 'function') {
        window.__kinnUpdatePosition(${lat}, ${lng});
      }
      true;
    `;
    webViewRef.current?.injectJavaScript(js);
  }, [hasCoords, latitude, longitude]);

  // ── Early-out: no coordinates ─────────────────────────────────────────────
  if (!hasCoords) {
    return (
      <View testID="member-map-empty" style={[styles.placeholder, { height }]}>
        <View style={styles.placeholderPin}>
          <Text style={styles.placeholderPinTxt}>📍</Text>
        </View>
        <Text style={styles.placeholderTitle}>Location not available yet</Text>
        <Text style={styles.placeholderSub}>
          {memberName
            ? `${memberName} hasn't checked in with GPS yet.`
            : 'Waiting for first GPS-enabled check-in.'}
        </Text>
      </View>
    );
  }

  if (!KEY) {
    return (
      <View testID="member-map-no-key" style={[styles.placeholder, { height }]}>
        <Text style={styles.placeholderTitle}>Map unavailable</Text>
        <Text style={styles.placeholderSub}>EXPO_PUBLIC_GOOGLE_MAPS_API_KEY is not set.</Text>
      </View>
    );
  }

  // ── Web path: iframe ──────────────────────────────────────────────────────
  if (Platform.OS === 'web') {
    return (
      <View testID="member-map" style={[styles.mapWrap, { height }]}>
        {/* @ts-ignore — iframe is web-only, accepted by react-native-web */}
        <iframe
          ref={iframeRef}
          title="Member location"
          srcDoc={htmlRef.current}
          style={{ border: 0, width: '100%', height: '100%' }}
          referrerPolicy="no-referrer-when-downgrade"
          allow="geolocation"
        />
      </View>
    );
  }

  // ── Native path: WebView ──────────────────────────────────────────────────
  // source is derived from htmlRef.current which never changes after the
  // first valid coordinate pair — so WebView is never remounted.
  return (
    <View testID="member-map" style={[styles.mapWrap, { height }]}>
      <WebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html: htmlRef.current, baseUrl: 'https://maps.googleapis.com' }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        scalesPageToFit
        startInLoadingState
        scrollEnabled={false}
        onMessage={(evt) => {
          // v1.2.8 instrumentation: WebView confirms the marker has been
          // placed/moved.  Compare against propTsRef to compute render latency.
          try {
            const m = JSON.parse(evt.nativeEvent.data || '{}');
            if (m?.type === 'kinn-map-rendered') {
              if (!mapReadyRef.current) mapReadyRef.current = true;
              const dt = propTsRef.current ? Date.now() - propTsRef.current : undefined;
              logScreenRender({
                src: 'map-rendered',
                memberId,
                lat: typeof m.lat === 'number' ? m.lat : null,
                lon: typeof m.lng === 'number' ? m.lng : null,
                renderLatencyMs: dt,
              });
            }
          } catch (_e) {}
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  mapWrap: {
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#eef3ef',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  webview: { flex: 1, backgroundColor: 'transparent' },
  placeholder: {
    borderRadius: 18,
    backgroundColor: Colors.tertiary,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  placeholderPin: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.surface,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 12,
    borderWidth: 2, borderColor: Colors.primary,
    borderStyle: 'dashed',
  },
  placeholderPinTxt: { fontSize: 26 },
  placeholderTitle: {
    fontSize: 15, fontWeight: '800', color: Colors.primary, marginBottom: 4,
  },
  placeholderSub: {
    fontSize: 12, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 17,
  },
});
