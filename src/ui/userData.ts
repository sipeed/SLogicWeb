// SPDX-License-Identifier: GPL-3.0-or-later

export const USER_STORAGE_PREFIXES = ['slogicweb.', 'logicweb.'] as const;
export const USER_CACHE_PREFIXES = ['slogicweb:', 'logicweb:'] as const;

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
export type UserDataCacheStorage = Pick<CacheStorage, 'keys' | 'delete'>;

export interface UserDataServiceWorkerRegistration {
  unregister(): Promise<boolean>;
}

export interface UserDataServiceWorkerContainer {
  getRegistration(): Promise<UserDataServiceWorkerRegistration | undefined>;
}

export interface UserDataStores {
  readonly local: UserDataStorage | null;
  readonly session: UserDataStorage | null;
}

export interface UserDataEnvironment {
  readonly local?: UserDataStorage | null;
  readonly session?: UserDataStorage | null;
  readonly caches?: UserDataCacheStorage | null;
  readonly serviceWorker?: UserDataServiceWorkerContainer | null;
  readonly beforeReload?: (() => void) | null;
  readonly reload?: (() => void) | null;
}

interface BrowserScope {
  readonly caches?: UserDataCacheStorage | null;
  readonly navigator?: { readonly serviceWorker?: UserDataServiceWorkerContainer | null } | null;
  readonly localStorage?: UserDataStorage | null;
  readonly sessionStorage?: UserDataStorage | null;
  readonly location?: { readonly reload?: (() => void) | null } | null;
}

function browserScope(): BrowserScope {
  return globalThis as unknown as BrowserScope;
}

function browserCaches(): UserDataCacheStorage | null {
  return browserScope().caches ?? null;
}

function browserServiceWorker(): UserDataServiceWorkerContainer | null {
  return browserScope().navigator?.serviceWorker ?? null;
}

function browserStorage(kind: 'localStorage' | 'sessionStorage'): UserDataStorage | null {
  return browserScope()[kind] ?? null;
}

function browserReload(): (() => void) | null {
  const location = browserScope().location;
  const reload = location?.reload;
  if (!location || typeof reload !== 'function') return null;
  return () => { reload.call(location); };
}

function isUserKey(key: string): boolean {
  return USER_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isUserCache(name: string): boolean {
  return USER_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function resolve<T>(
  operation: string,
  explicit: T | null | undefined,
  fallback: () => T | null,
  failures: ResetFailure[],
): T | null {
  if (explicit !== undefined) return explicit;
  try {
    return fallback();
  } catch (error) {
    failures.push({ operation, error });
    return null;
  }
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

async function unregisterServiceWorker(
  container: UserDataServiceWorkerContainer | null, failures: ResetFailure[],
): Promise<boolean> {
  if (container === null) return true;
  let registration: UserDataServiceWorkerRegistration | undefined;
  try {
    registration = await container.getRegistration();
  } catch (error) {
    failures.push({ operation: 'serviceWorker.getRegistration', error });
    return false;
  }
  if (!registration) return true;
  try {
    if (!(await registration.unregister())) {
      failures.push({ operation: 'serviceWorker.unregister', error: false });
      return false;
    }
    return true;
  } catch (error) {
    failures.push({ operation: 'serviceWorker.unregister', error });
    return false;
  }
}

async function deleteUserCaches(
  storage: UserDataCacheStorage | null,
  failures: ResetFailure[],
  remaining: string[],
): Promise<boolean> {
  if (storage === null) return true;
  let names: readonly string[];
  try {
    names = await storage.keys();
  } catch (error) {
    failures.push({ operation: 'caches.keys', error });
    return false;
  }
  let ok = true;
  for (const name of names) {
    if (!isUserCache(name)) continue;
    try {
      if (!(await storage.delete(name))) {
        failures.push({ operation: 'caches.delete', error: false });
        ok = false;
      }
    } catch (error) {
      failures.push({ operation: 'caches.delete', error });
      ok = false;
    }
  }
  try {
    for (const name of await storage.keys()) {
      if (!isUserCache(name)) continue;
      remaining.push(`cache:${name}`);
      ok = false;
    }
  } catch (error) {
    failures.push({ operation: 'caches.verify', error });
    return false;
  }
  return ok;
}

export async function clearUserData(
  input: UserDataEnvironment = {},
): Promise<UserDataResetReport> {
  const failures: ResetFailure[] = [];
  const remaining: string[] = [];
  const report = (): UserDataResetReport => ({
    ok: failures.length === 0 && remaining.length === 0,
    failures,
    remaining,
  });

  const serviceWorker = resolve(
    'serviceWorker.container', input.serviceWorker, browserServiceWorker, failures,
  );
  if (failures.length > 0) return report();
  if (!(await unregisterServiceWorker(serviceWorker, failures))) return report();

  const caches = resolve('caches.storage', input.caches, browserCaches, failures);
  if (failures.length > 0) return report();
  if (!(await deleteUserCaches(caches, failures, remaining))) return report();

  const local = resolve(
    'localStorage.storage', input.local, () => browserStorage('localStorage'), failures,
  );
  const session = resolve(
    'sessionStorage.storage', input.session, () => browserStorage('sessionStorage'), failures,
  );
  if (failures.length > 0) return report();

  const stored = clearStoredUserData({ local, session });
  for (const failure of stored.failures) failures.push(failure);
  for (const name of stored.remaining) remaining.push(name);
  if (!stored.ok) return report();

  const reload = resolve('reload', input.reload, browserReload, failures);
  if (failures.length > 0) return report();
  if (reload === null) {
    failures.push({ operation: 'reload.unavailable', error: null });
    return report();
  }

  const beforeReload = resolve('beforeReload', input.beforeReload, () => null, failures);
  if (failures.length > 0) return report();
  if (beforeReload !== null) {
    try {
      beforeReload();
    } catch (error) {
      failures.push({ operation: 'beforeReload', error });
      return report();
    }
  }

  try {
    reload();
  } catch (error) {
    failures.push({ operation: 'reload', error });
  }
  return report();
}
