/**
 * Build #59 — Custom Kinnship-branded tab bar icons.
 *
 * Per spec (Priority 10):
 *   • No emoji, no Unicode glyphs, no platform-dependent icons.
 *   • Same line thickness / same visual weight across all three tabs.
 *   • Rounded, clean, minimal, professional.
 *   • Inspired by the Kinnship shield silhouette.
 *   • Active state → Kinnship Green (#1B5E35), inactive → muted grey-green.
 *
 * Icons:
 *   Family  → three people inside a shield outline (family connection)
 *   Me      → single person inside a shield outline (this user)
 *   Alerts  → bell inside a shield outline (emergencies)
 *
 * All three share the exact same shield outer path so the "brand" is
 * consistent — only the inner glyph differs.  Rendered via
 * react-native-svg so the geometry is identical on Android and iOS.
 */
import { View, StyleSheet } from 'react-native';
import Svg, { Path, Circle, G } from 'react-native-svg';

export type KinnshipTabName = 'family' | 'me' | 'alerts';

interface Props {
  name: KinnshipTabName;
  color: string;   // navigation-provided tint (active or inactive)
  size?: number;
  focused?: boolean;
}

// The shield silhouette used as the outer frame for all three icons.
// Traced against the Kinnship master logo — a rounded top with a
// gentle bottom taper.  Viewbox 32x32.
const SHIELD_PATH =
  'M16 3 C 20 3 24 4.5 28 5.5 C 28 14 27 22 16 29 C 5 22 4 14 4 5.5 C 8 4.5 12 3 16 3 Z';

export default function KinnshipTabIcon({ name, color, size = 26, focused }: Props) {
  // A little breathing room around the shield so the outline never
  // clips against neighbouring tabs on high-density displays.
  const dim = size;
  const strokeW = focused ? 1.8 : 1.5;

  return (
    <View style={[styles.wrap, { width: dim, height: dim }]}>
      <Svg width={dim} height={dim} viewBox="0 0 32 32" fill="none">
        {/* Shield outer frame (identical across all three icons). */}
        <Path
          d={SHIELD_PATH}
          stroke={color}
          strokeWidth={strokeW}
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
        />
        {/* Inner glyph per tab. */}
        {name === 'family' ? <FamilyGlyph color={color} /> : null}
        {name === 'me' ? <MeGlyph color={color} /> : null}
        {name === 'alerts' ? <AlertsGlyph color={color} /> : null}
      </Svg>
    </View>
  );
}

/** Three people huddled together — represents family connection. */
function FamilyGlyph({ color }: { color: string }) {
  const stroke = color;
  const sw = 1.4;
  return (
    <G>
      {/* Left person */}
      <Circle cx={10.5} cy={13} r={1.7} stroke={stroke} strokeWidth={sw} fill="none" />
      <Path
        d="M8 18.5 C 8 16.8 9 15.8 10.5 15.8 C 12 15.8 13 16.8 13 18.5"
        stroke={stroke} strokeWidth={sw} strokeLinecap="round" fill="none"
      />
      {/* Right person */}
      <Circle cx={21.5} cy={13} r={1.7} stroke={stroke} strokeWidth={sw} fill="none" />
      <Path
        d="M19 18.5 C 19 16.8 20 15.8 21.5 15.8 C 23 15.8 24 16.8 24 18.5"
        stroke={stroke} strokeWidth={sw} strokeLinecap="round" fill="none"
      />
      {/* Front-center person (slightly larger) */}
      <Circle cx={16} cy={15} r={2} stroke={stroke} strokeWidth={sw} fill="none" />
      <Path
        d="M12.8 22 C 12.8 19.7 14.2 18.5 16 18.5 C 17.8 18.5 19.2 19.7 19.2 22"
        stroke={stroke} strokeWidth={sw} strokeLinecap="round" fill="none"
      />
    </G>
  );
}

/** Single person silhouette — represents the current user. */
function MeGlyph({ color }: { color: string }) {
  const stroke = color;
  const sw = 1.6;
  return (
    <G>
      {/* Head */}
      <Circle cx={16} cy={13} r={2.6} stroke={stroke} strokeWidth={sw} fill="none" />
      {/* Shoulders */}
      <Path
        d="M11 22 C 11 18.7 13 17 16 17 C 19 17 21 18.7 21 22"
        stroke={stroke} strokeWidth={sw} strokeLinecap="round" fill="none"
      />
    </G>
  );
}

/** Notification bell — represents emergency / alert. */
function AlertsGlyph({ color }: { color: string }) {
  const stroke = color;
  const sw = 1.6;
  return (
    <G>
      {/* Bell body (dome + rim) */}
      <Path
        d="M11.5 20 L 11.5 15.5 C 11.5 13 13.5 11 16 11 C 18.5 11 20.5 13 20.5 15.5 L 20.5 20 Z"
        stroke={stroke} strokeWidth={sw} strokeLinejoin="round" fill="none"
      />
      {/* Bell rim (bottom line stroke) */}
      <Path
        d="M10.5 20 L 21.5 20"
        stroke={stroke} strokeWidth={sw} strokeLinecap="round" fill="none"
      />
      {/* Clapper (small dot) */}
      <Circle cx={16} cy={22.2} r={0.9} fill={stroke} />
      {/* Top nub */}
      <Path
        d="M16 9.7 L 16 11"
        stroke={stroke} strokeWidth={sw} strokeLinecap="round" fill="none"
      />
    </G>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
});
