const values = new Map<string, string>();

export const WHEN_UNLOCKED = 'WHEN_UNLOCKED';
export const AFTER_FIRST_UNLOCK = 'AFTER_FIRST_UNLOCK';

export async function getItemAsync(key: string): Promise<string | null> {
  return values.get(key) ?? null;
}

export async function setItemAsync(
  key: string,
  value: string,
  _options?: unknown,
): Promise<void> {
  values.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  values.delete(key);
}