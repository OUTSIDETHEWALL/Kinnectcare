import { Alert } from 'react-native';

type PendingInvitee = {
  invitee_name: string;
};

/**
 * Keeps the destructive invitation-revocation confirmation consistent and
 * testable without coupling the regression test to the whole dashboard.
 */
export function confirmPendingInviteCancellation(
  invite: PendingInvitee,
  onConfirm: () => void,
): void {
  Alert.alert(
    'Cancel invitation?',
    `${invite.invitee_name} won't be able to accept this invitation anymore. You can send a new one later.`,
    [
      { text: 'Keep', style: 'cancel' },
      { text: 'Cancel invite', style: 'destructive', onPress: onConfirm },
    ],
  );
}