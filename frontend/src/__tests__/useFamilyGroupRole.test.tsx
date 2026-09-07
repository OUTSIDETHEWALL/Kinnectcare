import React from 'react';
import { act, create } from 'react-test-renderer';

const mockGetFamilyGroup = jest.fn();

jest.mock('../api', () => ({
  getFamilyGroup: (...args: unknown[]) => mockGetFamilyGroup(...args),
}));

import { useFamilyGroupRole } from '../useFamilyGroupRole';

function RoleProbe() {
  const state = useFamilyGroupRole();
  return React.createElement('role-state', state);
}

function renderedState(renderer: ReturnType<typeof create>) {
  return renderer.root.findByType('role-state').props;
}

describe('useFamilyGroupRole', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fails closed while the authoritative role is loading', async () => {
    let resolve!: (value: { my_role: 'owner' }) => void;
    mockGetFamilyGroup.mockReturnValue(new Promise((done) => { resolve = done; }));

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<RoleProbe />);
    });

    expect(renderedState(renderer)).toMatchObject({
      role: null,
      loading: true,
      isOwner: false,
      isResolved: false,
    });

    await act(async () => {
      resolve({ my_role: 'owner' });
      await Promise.resolve();
    });
    expect(renderedState(renderer)).toMatchObject({
      role: 'owner',
      loading: false,
      isOwner: true,
      isResolved: true,
    });
  });

  test('resolves a member role without granting owner controls', async () => {
    mockGetFamilyGroup.mockResolvedValue({ my_role: 'member' });

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<RoleProbe />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(renderedState(renderer)).toMatchObject({
      role: 'member',
      loading: false,
      isOwner: false,
      isResolved: true,
    });
  });

  test('keeps permissions closed if the family role cannot be fetched', async () => {
    mockGetFamilyGroup.mockRejectedValue(new Error('offline'));

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<RoleProbe />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(renderedState(renderer)).toMatchObject({
      role: null,
      loading: false,
      isOwner: false,
      isResolved: false,
    });
    expect(renderedState(renderer).error).toBeInstanceOf(Error);
  });
});