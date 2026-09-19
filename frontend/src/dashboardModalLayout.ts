import type { ViewStyle } from 'react-native';

const BASE_BOTTOM_ACTION_SPACING = 28;

export function getDashboardModalCardStyle(bottomInset: number): ViewStyle {
  return {
    paddingBottom: BASE_BOTTOM_ACTION_SPACING + Math.max(0, bottomInset),
  };
}

export function shouldScrollDashboardModalList(itemCount: number): boolean {
  return itemCount > 1;
}