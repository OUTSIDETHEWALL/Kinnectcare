/**
 * PinPad — large-button numeric keypad designed for elderly users with
 * shaky hands. Touch targets are 88pt (exceeds Apple's 44pt and Google's
 * 48pt minimums; sized for seniors per WCAG AAA target spacing).
 *
 * Visual behaviour:
 *   • Filled dots above the pad reflect how many digits have been
 *     entered (0…length).
 *   • On submit (when the user reaches `length` digits) the parent's
 *     `onComplete(pin)` callback fires.
 *   • Optional `shake` prop briefly highlights the dots in red — call
 *     it after a wrong PIN attempt.
 *
 * The pad is fully self-contained: it tracks its own entered digits and
 * exposes a reset via the `reset` ref method.
 */
import { forwardRef, useImperativeHandle, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Colors } from './theme';

export type PinPadHandle = {
  reset: () => void;
};

type Props = {
  length?: number;
  onComplete: (pin: string) => void;
  // When true, render the dots in red (parent triggers after a wrong
  // attempt). The parent should toggle it briefly (e.g., 400ms).
  errorState?: boolean;
  // Optional header label rendered above the dots.
  label?: string;
  // Optional sub-label below the dots (e.g., "Try again — 3 left").
  hint?: string;
  hintTone?: 'normal' | 'error' | 'success';
  // Hide the digit buttons (used during a brief lockout cooldown).
  disabled?: boolean;
};

const KEYS: (string | null)[] = ['1','2','3','4','5','6','7','8','9', null, '0', 'back'];

export const PinPad = forwardRef<PinPadHandle, Props>(function PinPad(
  { length = 4, onComplete, errorState, label, hint, hintTone = 'normal', disabled }: Props,
  ref,
) {
  const [entered, setEntered] = useState('');

  useImperativeHandle(ref, () => ({
    reset: () => setEntered(''),
  }), []);

  const press = useCallback((digit: string) => {
    if (disabled) return;
    setEntered(prev => {
      if (prev.length >= length) return prev;
      const next = prev + digit;
      if (next.length === length) {
        // Fire the completion callback on the next microtask so React
        // can paint the filled dot before navigation happens.
        setTimeout(() => onComplete(next), 30);
      }
      return next;
    });
  }, [disabled, length, onComplete]);

  const backspace = useCallback(() => {
    if (disabled) return;
    setEntered(prev => prev.slice(0, -1));
  }, [disabled]);

  return (
    <View style={styles.wrap}>
      {!!label && <Text style={styles.label}>{label}</Text>}

      <View style={styles.dotsRow}>
        {Array.from({ length }).map((_, i) => {
          const filled = i < entered.length;
          return (
            <View
              key={i}
              testID={`pin-dot-${i}`}
              style={[
                styles.dot,
                filled && (errorState ? styles.dotError : styles.dotFilled),
              ]}
            />
          );
        })}
      </View>

      {!!hint && (
        <Text
          style={[
            styles.hint,
            hintTone === 'error' && { color: Colors.error },
            hintTone === 'success' && { color: Colors.success },
          ]}
        >
          {hint}
        </Text>
      )}

      <View style={styles.grid}>
        {KEYS.map((k, idx) => {
          if (k === null) {
            return <View key={idx} style={styles.keyEmpty} />;
          }
          if (k === 'back') {
            return (
              <TouchableOpacity
                key={idx}
                testID="pin-back"
                style={styles.keyBack}
                onPress={backspace}
                activeOpacity={0.6}
                accessibilityLabel="Delete last digit"
              >
                <Text style={styles.backTxt}>⌫</Text>
              </TouchableOpacity>
            );
          }
          return (
            <TouchableOpacity
              key={idx}
              testID={`pin-key-${k}`}
              style={[styles.key, disabled && styles.keyDisabled]}
              onPress={() => press(k)}
              activeOpacity={0.55}
              disabled={disabled}
              accessibilityLabel={`Number ${k}`}
            >
              <Text style={styles.keyTxt}>{k}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', width: '100%' },
  label: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginBottom: 18,
    textAlign: 'center',
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 18,
    marginBottom: 8,
  },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: Colors.border,
    backgroundColor: 'transparent',
  },
  dotFilled: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  dotError: {
    backgroundColor: Colors.error,
    borderColor: Colors.error,
  },
  hint: {
    marginTop: 8,
    marginBottom: 4,
    fontSize: 14,
    color: Colors.textSecondary,
    fontWeight: '600',
    textAlign: 'center',
    minHeight: 18,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 20,
    width: '100%',
    maxWidth: 340,
  },
  key: {
    width: 92,
    height: 92,
    borderRadius: 46,
    margin: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Platform.select({
      android: { elevation: 2 },
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 4 },
    }),
  },
  keyDisabled: { opacity: 0.4 },
  keyEmpty: {
    width: 92, height: 92, margin: 8, opacity: 0,
  },
  keyBack: {
    width: 92, height: 92, margin: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  keyTxt: {
    fontSize: 34,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  backTxt: {
    fontSize: 28,
    color: Colors.textSecondary,
  },
});

export default PinPad;
