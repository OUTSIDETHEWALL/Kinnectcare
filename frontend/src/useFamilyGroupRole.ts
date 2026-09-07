import { useEffect, useState } from 'react';
import { getFamilyGroup } from './api';

export type FamilyGroupRole = 'owner' | 'member';

/**
 * Reads the role from the family-group endpoint rather than the cached auth
 * user. Callers must treat `loading` and `error` as no permission: this keeps
 * privileged controls hidden until the server has confirmed ownership.
 */
export function useFamilyGroupRole() {
  const [role, setRole] = useState<FamilyGroupRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setRole(null);
    setError(null);

    getFamilyGroup()
      .then((family) => {
        if (active) setRole(family.my_role);
      })
      .catch((reason) => {
        if (active) setError(reason);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return {
    role,
    loading,
    error,
    isOwner: !loading && role === 'owner',
    isResolved: !loading && role !== null,
  };
}