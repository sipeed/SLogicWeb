// SPDX-License-Identifier: GPL-3.0-or-later

export const USER_STORAGE_PREFIXES = ['slogicweb.', 'logicweb.'] as const;

export interface ResetFailure {
  readonly operation: string;
  readonly error: unknown;
}

export interface UserDataResetReport {
  readonly ok: boolean;
  readonly failures: readonly ResetFailure[];
  readonly remaining: readonly string[];
}

export type UserDataStorage = Pick<Storage, 'length' | 'key' | 'removeItem'>;

export interface UserDataStores {
  readonly local: UserDataStorage | null;
  readonly session: UserDataStorage | null;
}

function isUserKey(key: string): boolean {
  return USER_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function keysOf(
  store: UserDataStorage, operation: string, failures: ResetFailure[],
): string[] {
  const keys: string[] = [];
  let length = 0;
  try {
    length = store.length;
  } catch (error) {
    failures.push({ operation, error });
    return keys;
  }
  for (let index = 0; index < length; index += 1) {
    try {
      const key = store.key(index);
      if (key !== null) keys.push(key);
    } catch (error) {
      failures.push({ operation, error });
    }
  }
  return keys;
}

function sweepStore(
  label: string,
  store: UserDataStorage | null,
  failures: ResetFailure[],
  remaining: string[],
): void {
  if (store === null) return;
  for (const key of keysOf(store, `${label}.keys`, failures)) {
    if (!isUserKey(key)) continue;
    try {
      store.removeItem(key);
    } catch (error) {
      failures.push({ operation: `${label}.removeItem`, error });
    }
  }
  for (const key of keysOf(store, `${label}.verify`, failures)) {
    if (isUserKey(key)) remaining.push(`${label}:${key}`);
  }
}

export function clearStoredUserData(input: UserDataStores): UserDataResetReport {
  const failures: ResetFailure[] = [];
  const remaining: string[] = [];
  sweepStore('localStorage', input.local, failures, remaining);
  sweepStore('sessionStorage', input.session, failures, remaining);
  return { ok: failures.length === 0 && remaining.length === 0, failures, remaining };
}
