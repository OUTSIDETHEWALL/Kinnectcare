/**
 * MemberMap — cross-platform interactive Google Maps view for a member's last
 * known GPS coordinates. Renders a custom green pin via Google Maps JS API
 * inside an iframe (web) or WebView (native), so the same HTML template
 * works on iPhone, Android, and the web preview.
 *
 * The API key is read from EXPO_PUBLIC_GOOGLE_MAPS_API_KEY at runtime.
 *
 * Props:
 *   - latitude/longitude: number | null/undefined — coords to focus
 *   - memberName: string — title for the marker
 *   - locationName: string — second-line label
 *   - height: number — pixel height of the map (default 220)
 *
 * If coordinates are missing, a styled placeholder is rendered instead of the
 * map.
 */
import { Platform, View, Text, StyleSheet } from 'react-native';
import { useMemo } from 'react';
import { WebView } from 'react-native-webview';
import { Colors } from './theme';

const KEY = (process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '').trim();

type Props = {
  latitude?: number | null;
  longitude?: number | null;
  memberName?: string;
  locationName?: string;
  height?: number;
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

function buildHtml(lat: number, lng: number, label: string): string {
  const safeLabel = escapeJs(label);
  // The custom marker is a circular SVG with Kinnship's primary green so the
  // pin is unmistakably "ours" and not the generic Google red.
  const pinColor = '#1B5E35';
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="initial-scale=1, width=device-width" />
<style>
  html,body,#map{height:100%;margin:0;padding:0;background:#eef3ef;}
  #fallback{
    display:none; align-items:center; justify-content:center;
    height:100%; color:#1B5E35; font-family:-apple-system,Roboto,sans-serif;
    font-size:14px; padding:24px; text-align:center;
  }
</style>
</head><body>
<div id="map"></div>
<div id="fallback">⚠️ Map failed to load. Check Google Maps API key.</div>
<script>
(function(){
  function showFallback(msg){
    var fb=document.getElementById('fallback');
    if (msg) fb.textContent=msg;
    fb.style.display='flex';
    document.getElementById('map').style.display='none';
  }
  window.__initKinnshipMap = function(){
    try {
      var pos = { lat: ${lat}, lng: ${lng} };
      var map = new google.maps.Map(document.getElementById('map'), {
        center: pos,
        zoom: 15,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        zoomControl: true,
        gestureHandling: 'greedy',
        clickableIcons: false,
        styles: [
          { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }]},
          { featureType: 'transit', elementType: 'labels', stylers: [{ visibility: 'off' }]},
        ]
      });
      // Pulsing ring + solid pin via two markers
      new google.maps.Marker({
        position: pos, map: map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 22,
          fillColor: '${pinColor}',
          fillOpacity: 0.18,
          strokeOpacity: 0,
        },
      });
      new google.maps.Marker({
        position: pos, map: map, title: '${safeLabel}',
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 11,
          fillColor: '${pinColor}',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
        },
      });
    } catch (e) {
      showFallback('Map error: ' + (e && e.message ? e.message : e));
    }
  };
  var s = document.createElement('script');
  s.src = 'https://maps.googleapis.com/maps/api/js?key=${KEY}&callback=__initKinnshipMap&loading=async&v=weekly';
  s.async = true; s.defer = true;
  s.onerror = function(){ showFallback('Could not load Google Maps script.'); };
  document.head.appendChild(s);
  // Hard timeout — if Maps fails to call the callback in 8s, show fallback.
  setTimeout(function(){
    if (!window.google || !window.google.maps) showFallback('Google Maps did not load (network or key).');
  }, 8000);
})();
</script>
</body></html>`;
}

export default function MemberMap({
  latitude, longitude, memberName, locationName, height = 220,
}: Props) {
  const hasCoords = (
    typeof latitude === 'number' && typeof longitude === 'number'
    && Number.isFinite(latitude) && Number.isFinite(longitude)
  );

  const html = useMemo(() => {
    if (!hasCoords) return '';
    const label = memberName || locationName || 'Last known location';
    return buildHtml(latitude as number, longitude as number, label);
  }, [hasCoords, latitude, longitude, memberName, locationName]);

  if (!hasCoords) {
    return (
      <View
        testID="member-map-empty"
        style={[styles.placeholder, { height }]}
      >
        <View style={styles.placeholderPin}>
          <Text style={styles.placeholderPinTxt}>📍</Text>
        </View>
        <Text style={styles.placeholderTitle}>Location not available yet</Text>
        <Text style={styles.placeholderSub}>
          {memberName ? `${memberName} hasn't checked in with GPS yet.` : 'Waiting for first GPS-enabled check-in.'}
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

  if (Platform.OS === 'web') {
    return (
      <View testID="member-map" style={[styles.mapWrap, { height }]}>
        {/* @ts-ignore — iframe is web-only, accepted by react-native-web */}
        <iframe
          title="Member location"
          srcDoc={html}
          style={{ border: 0, width: '100%', height: '100%' }}
          referrerPolicy="no-referrer-when-downgrade"
          allow="geolocation"
        />
      </View>
    );
  }

  return (
    <View testID="member-map" style={[styles.mapWrap, { height }]}>
      <WebView
        originWhitelist={['*']}
        source={{ html, baseUrl: 'https://maps.googleapis.com' }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        scalesPageToFit
        startInLoadingState
        scrollEnabled={false}
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
