jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
}));

import { Alert } from 'react-native';
import { confirmPendingInviteCancellation } from '../pendingInviteCancellation';

describe('pending invitation cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the confirmation and revokes only after the destructive action is chosen', () => {
    const onConfirm = jest.fn();

    confirmPendingInviteCancellation({ invitee_name: 'Joyce' }, onConfirm);

    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(
      'Cancel invitation?',
      "Joyce won't be able to accept this invitation anymore. You can send a new one later.",
      expect.any(Array),
    );

    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
    expect(onConfirm).not.toHaveBeenCalled();

    const destructiveButton = buttons.find(
      (button: { text: string }) => button.text === 'Cancel invite',
    );
    destructiveButton.onPress();

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});