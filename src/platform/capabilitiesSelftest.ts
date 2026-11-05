// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic correctness tests for the platform capability probes.
 *
 * Every environment is a fake passed through `PlatformEnv`; the host globals are never
 * consulted except by the one explicit "ambient environment" case, and no check depends
 * on the machine running the suite.
 *
 *   node_modules/.bin/esbuild src/platform/capabilitiesSelftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/platform-selftest.mjs --log-level=error \
 *     && node /tmp/platform-selftest.mjs
 *
 * Prints PASS/FAIL per check and exits non-zero on any failure.
 */

import {
  CAPABILITY_NAMES,
  capabilityReason,
  detectCapabilities,
  type CapabilityName,
  type PlatformCapabilities,
  type PlatformDocumentLike,
  type PlatformEnv,
  type PlatformNavigatorLike,
  type PlatformWindowLike,
} from './index.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const nodeProcess = (() => {
  const processLike = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!processLike || typeof processLike.exit !== 'function') {
    throw new Error('this entry point only runs under node');
  }
  return processLike;
})();

function missingEquals(
  caps: PlatformCapabilities,
  expected: readonly CapabilityName[],
): boolean {
  return caps.missing.length === expected.length &&
    caps.missing.every((name, index) => name === expected[index]);
}

/** `missing` must follow the declaration order and contain no duplicates. */
function isOrderedSubset(missing: readonly CapabilityName[]): boolean {
  let previous = -1;
  for (const name of missing) {
    const index = CAPABILITY_NAMES.indexOf(name);
    if (index <= previous) return false;
    previous = index;
  }
  return true;
}

/** The contract the one-argument reason form reports when the capability is missing. */
const EXPECTED_REASONS: Readonly<Record<CapabilityName, string>> = Object.freeze({
  usb: 'unsupported-platform',
  secureContext: 'insecure-context',
  crossOriginIsolated: 'not-cross-origin-isolated',
  offscreenCanvas: 'unsupported-platform',
  webgl2: 'unsupported-platform',
  opfs: 'unsupported-platform',
  opfsSync: 'unsupported-platform',
  webLocks: 'unsupported-platform',
  wakeLock: 'unsupported-platform',
  share: 'unsupported-platform',
  saveFilePicker: 'unsupported-platform',
  persistStorage: 'unsupported-platform',
});

// ---------------------------------------------------------------------------
// A complete fake platform: every probe must succeed.

const contextRequests: string[] = [];
const fullNavigator: PlatformNavigatorLike = {
  usb: { requestDevice: () => Promise.resolve({}) },
  locks: { request: () => Promise.resolve() },
  storage: {
    getDirectory: () => Promise.resolve({}),
    persist: () => Promise.resolve(true),
  },
  wakeLock: { request: () => Promise.resolve({}) },
  share: () => Promise.resolve(),
};
const fullDocument: PlatformDocumentLike = {
  createElement(tagName: string): unknown {
    if (tagName !== 'canvas') throw new Error(`unexpected element ${tagName}`);
    return {
      getContext(contextId: string): unknown {
        contextRequests.push(contextId);
        return contextId === 'webgl2' ? { kind: 'webgl2' } : null;
      },
    };
  },
};
const fullWindow: PlatformWindowLike = {
  isSecureContext: true,
  crossOriginIsolated: true,
  OffscreenCanvas: class FakeOffscreenCanvas {
    getContext(): unknown { return {}; }
  },
  FileSystemSyncAccessHandle: class FakeSyncAccessHandle {},
  showSaveFilePicker: () => Promise.resolve({}),
};
const fullEnv: PlatformEnv = {
  navigator: fullNavigator,
  document: fullDocument,
  window: fullWindow,
};

{
  const caps = detectCapabilities(fullEnv);
  const notEnabled = CAPABILITY_NAMES.filter((name) => caps[name] !== true);
  check('a complete environment enables every capability',
    notEnabled.length === 0 && caps.missing.length === 0 &&
      caps.isolated && caps.crossOriginIsolated,
    `missing=[${caps.missing.join(',')}], disabled=[${notEnabled.join(',')}]`);
  check('the WebGL2 probe requests exactly the webgl2 context',
    contextRequests.length === 1 && contextRequests[0] === 'webgl2',
    `requests=[${contextRequests.join(',')}]`);
  check('detected capabilities and their missing list are immutable',
    Object.isFrozen(caps) && Object.isFrozen(caps.missing),
    `frozen=${Object.isFrozen(caps)}, missingFrozen=${Object.isFrozen(caps.missing)}`);
  const withReasons = CAPABILITY_NAMES.filter((name) => capabilityReason(name, caps) !== null);
  check('capabilityReason returns null for every available capability',
    withReasons.length === 0,
    withReasons.length === 0 ? 'all 12 available capabilities are null' : `non-null: ${withReasons.join(',')}`);
  const wrong = CAPABILITY_NAMES.filter((name) => capabilityReason(name) !== EXPECTED_REASONS[name]);
  check('the one-argument reason form returns the stable code for a missing capability',
    wrong.length === 0,
    wrong.length === 0
      ? `${CAPABILITY_NAMES.length} codes match`
      : wrong.map((name) => `${name}=${capabilityReason(name)}`).join(', '));
}

// ---------------------------------------------------------------------------
// An explicitly empty environment must not fall through to the host globals.

{
  const empty = detectCapabilities({});
  const enabled = CAPABILITY_NAMES.filter((name) => empty[name] !== false);
  check('an explicitly empty environment reports every capability missing in order',
    enabled.length === 0 && missingEquals(empty, CAPABILITY_NAMES) && !empty.isolated,
    `enabled=[${enabled.join(',')}], isolated=${empty.isolated}`);
  const emptyObjects = detectCapabilities({ navigator: {}, document: {}, window: {} });
  const emptyUndefined = detectCapabilities({
    navigator: undefined,
    document: undefined,
    window: undefined,
  });
  check('empty navigator/document/window objects match the empty environment',
    JSON.stringify(emptyObjects) === JSON.stringify(empty) &&
      JSON.stringify(emptyUndefined) === JSON.stringify(empty),
    `objects=${JSON.stringify(emptyObjects.missing)}, undefined=${JSON.stringify(emptyUndefined.missing)}`);
  const wrong = CAPABILITY_NAMES.filter(
    (name) => capabilityReason(name, empty) !== EXPECTED_REASONS[name],
  );
  const nulls = CAPABILITY_NAMES.filter((name) => capabilityReason(name, empty) === null);
  check('each missing capability maps to its stable non-null reason code',
    wrong.length === 0 && nulls.length === 0,
    wrong.length === 0 && nulls.length === 0
      ? `${CAPABILITY_NAMES.length} codes match`
      : `wrong=[${wrong.join(',')}] null=[${nulls.join(',')}]`);
  const badCodes = CAPABILITY_NAMES
    .map((name) => EXPECTED_REASONS[name])
    .filter((code) => !/^[a-z][a-z0-9-]*$/.test(code));
  check('reason codes are diagnostic keys rather than localized copy',
    badCodes.length === 0,
    badCodes.length === 0 ? 'all codes are lowercase kebab-case' : `bad: ${badCodes.join(',')}`);
}

// ---------------------------------------------------------------------------
// A partial platform: exactly the absent bits, in declaration order.

const partialNavigator: PlatformNavigatorLike = {
  usb: { requestDevice: () => Promise.resolve({}) },
  locks: { request: () => Promise.resolve() },
  storage: {
    getDirectory: () => Promise.resolve({}),
    persist: () => Promise.resolve(true),
  },
};
const partialDocument: PlatformDocumentLike = {
  createElement: () => ({ getContext: () => null }),
};
const partialWindow: PlatformWindowLike = {
  isSecureContext: true,
  crossOriginIsolated: false,
};
const partialMissing: readonly CapabilityName[] = [
  'crossOriginIsolated',
  'offscreenCanvas',
  'webgl2',
  'opfsSync',
  'wakeLock',
  'share',
  'saveFilePicker',
];

{
  const caps = detectCapabilities({
    navigator: partialNavigator,
    document: partialDocument,
    window: partialWindow,
  });
  const booleansMatch =
    caps.usb && caps.secureContext && !caps.crossOriginIsolated &&
    !caps.offscreenCanvas && !caps.webgl2 && caps.opfs && !caps.opfsSync &&
    caps.webLocks && !caps.wakeLock && !caps.share && !caps.saveFilePicker &&
    caps.persistStorage && !caps.isolated;
  check('a partial environment reports exactly its missing capabilities in order',
    booleansMatch && missingEquals(caps, partialMissing),
    `missing=[${caps.missing.join(',')}] want [${partialMissing.join(',')}]`);

  const reasonFailures: string[] = [];
  for (const name of CAPABILITY_NAMES) {
    const expected = caps[name] ? null : EXPECTED_REASONS[name];
    const got = capabilityReason(name, caps);
    if (got !== expected) reasonFailures.push(`${name}: ${got} want ${expected}`);
  }
  check('capabilityReason follows the detected capability bits',
    reasonFailures.length === 0,
    reasonFailures.length === 0
      ? `${CAPABILITY_NAMES.length} names match availability`
      : reasonFailures.join('; '));

  const forged: PlatformCapabilities = { ...detectCapabilities({}), usb: true };
  check('availability is read from the capability bit, not the derived list',
    capabilityReason('usb', forged) === null &&
      capabilityReason('secureContext', forged) === EXPECTED_REASONS.secureContext,
    `usb=${capabilityReason('usb', forged)}, secureContext=${capabilityReason('secureContext', forged)}`);
}

// ---------------------------------------------------------------------------
// Presence probes accept functions, not truthy values.

{
  const caps = detectCapabilities({
    navigator: {
      usb: {},
      locks: {},
      storage: { getDirectory: () => Promise.resolve({}), persist: true },
      wakeLock: {},
      share: true,
    },
    window: { showSaveFilePicker: true },
  });
  check('function-presence probes reject non-function values',
    !caps.usb && !caps.webLocks && caps.opfs && !caps.persistStorage &&
      !caps.wakeLock && !caps.share && !caps.saveFilePicker,
    `usb=${caps.usb}, locks=${caps.webLocks}, opfs=${caps.opfs}, persist=${caps.persistStorage}, ` +
      `wakeLock=${caps.wakeLock}, share=${caps.share}, picker=${caps.saveFilePicker}`);
}

// ---------------------------------------------------------------------------
// OPFS sync and the WebGL2 OffscreenCanvas fallback.

{
  const syncOnly = detectCapabilities({
    window: { FileSystemSyncAccessHandle: class FakeSyncAccessHandle {} },
  });
  const expected = CAPABILITY_NAMES.filter((name) => name !== 'opfsSync');
  check('OPFS sync probes the FileSystemSyncAccessHandle constructor independently of OPFS',
    !syncOnly.opfs && syncOnly.opfsSync && missingEquals(syncOnly, expected),
    `opfs=${syncOnly.opfs}, opfsSync=${syncOnly.opfsSync}, missing=[${syncOnly.missing.join(',')}]`);

  const offscreen = detectCapabilities({
    window: {
      OffscreenCanvas: class FakeOffscreenCanvas {
        getContext(contextId: string): unknown {
          return contextId === 'webgl2' ? {} : null;
        }
      },
    },
  });
  check('WebGL2 falls back to an OffscreenCanvas probe when no document is injected',
    offscreen.offscreenCanvas && offscreen.webgl2,
    `offscreenCanvas=${offscreen.offscreenCanvas}, webgl2=${offscreen.webgl2}`);
}

// ---------------------------------------------------------------------------
// A probe failure must stay inside the probe.

{
  const hostileNavigator = {
    get usb(): unknown { throw new Error('navigator.usb'); },
    get locks(): unknown { throw new Error('navigator.locks'); },
    get storage(): unknown { throw new Error('navigator.storage'); },
    get wakeLock(): unknown { throw new Error('navigator.wakeLock'); },
    get share(): unknown { throw new Error('navigator.share'); },
  } as unknown as PlatformNavigatorLike;
  const hostileWindow = {
    get isSecureContext(): unknown { throw new Error('window.isSecureContext'); },
    get crossOriginIsolated(): unknown { throw new Error('window.crossOriginIsolated'); },
    get OffscreenCanvas(): unknown { throw new Error('window.OffscreenCanvas'); },
    get FileSystemSyncAccessHandle(): unknown { throw new Error('window.FileSystemSyncAccessHandle'); },
    get showSaveFilePicker(): unknown { throw new Error('window.showSaveFilePicker'); },
  } as unknown as PlatformWindowLike;

  let hostile: PlatformCapabilities | null = null;
  let hostileError = '';
  try {
    hostile = detectCapabilities({
      navigator: hostileNavigator,
      document: {},
      window: hostileWindow,
    });
  } catch (error) {
    hostileError = String(error);
  }
  check('throwing global getters are contained per probe',
    hostileError === '' && hostile !== null &&
      missingEquals(hostile, CAPABILITY_NAMES),
    hostileError !== ''
      ? hostileError
      : `missing=${hostile === null ? 'null' : hostile.missing.length}`);

  let documentError = '';
  let throwingDocument: PlatformCapabilities | null = null;
  try {
    throwingDocument = detectCapabilities({
      document: { createElement: () => { throw new Error('canvas'); } },
    });
  } catch (error) {
    documentError = String(error);
  }
  check('a throwing canvas factory yields webgl2 false instead of escaping',
    documentError === '' && throwingDocument !== null && !throwingDocument.webgl2,
    documentError !== '' ? documentError : `webgl2=${throwingDocument?.webgl2}`);

  let contextError = '';
  let throwingContext: PlatformCapabilities | null = null;
  try {
    throwingContext = detectCapabilities({
      document: {
        createElement: () => ({
          getContext: () => { throw new Error('context'); },
        }),
      },
    });
  } catch (error) {
    contextError = String(error);
  }
  check('a throwing getContext yields webgl2 false instead of escaping',
    contextError === '' && throwingContext !== null && !throwingContext.webgl2,
    contextError !== '' ? contextError : `webgl2=${throwingContext?.webgl2}`);

  let nullError = '';
  let nullEnv: PlatformCapabilities | null = null;
  try {
    nullEnv = detectCapabilities(null as unknown as PlatformEnv);
  } catch (error) {
    nullError = String(error);
  }
  check('an invalid null environment is treated as empty rather than throwing',
    nullError === '' && nullEnv !== null && missingEquals(nullEnv, CAPABILITY_NAMES),
    nullError !== '' ? nullError : `missing=${nullEnv?.missing.length ?? 'null'}`);
}

// ---------------------------------------------------------------------------
// No user-agent sniffing and no dependence on the ambient host in injected mode.

{
  const browserNavigator = {
    usb: { requestDevice: () => Promise.resolve({}) },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/999.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    vendor: 'Fake Inc.',
    languages: ['fr-FR'],
  };
  const browserWindow = {
    isSecureContext: true,
    OffscreenCanvas: class FakeOffscreenCanvas {
      getContext(contextId: string): unknown {
        return contextId === 'webgl2' ? {} : null;
      }
    },
    userAgentData: { brands: [{ brand: 'Fake', version: '999' }] },
  };
  const withUa = detectCapabilities({ navigator: browserNavigator, window: browserWindow });
  const withoutUa = detectCapabilities({
    navigator: { usb: browserNavigator.usb },
    window: {
      isSecureContext: true,
      OffscreenCanvas: browserWindow.OffscreenCanvas,
    },
  });
  check('detection ignores user-agent, platform and vendor strings',
    JSON.stringify(withUa) === JSON.stringify(withoutUa),
    `uaMissing=[${withUa.missing.join(',')}], plainMissing=[${withoutUa.missing.join(',')}]`);

  let ambientError = '';
  let ambient: PlatformCapabilities | null = null;
  try {
    ambient = detectCapabilities();
  } catch (error) {
    ambientError = String(error);
  }
  check('detectCapabilities() probes the ambient environment without throwing',
    ambientError === '' && ambient !== null && ambient.isolated === ambient.crossOriginIsolated,
    ambientError !== '' ? ambientError : `missing=${ambient?.missing.length ?? 'null'}`);
}

// ---------------------------------------------------------------------------
// Cross-environment invariants.

{
  const environments: PlatformCapabilities[] = [
    detectCapabilities(fullEnv),
    detectCapabilities({}),
    detectCapabilities({ navigator: partialNavigator, document: partialDocument, window: partialWindow }),
    detectCapabilities({
      navigator: {
        usb: {},
        locks: {},
        storage: { getDirectory: () => Promise.resolve({}), persist: true },
        wakeLock: {},
        share: true,
      },
      window: { showSaveFilePicker: true },
    }),
    detectCapabilities({ window: { FileSystemSyncAccessHandle: class FakeSyncAccessHandle {} } }),
    detectCapabilities({
      window: {
        OffscreenCanvas: class FakeOffscreenCanvas {
          getContext(): unknown { return {}; }
        },
      },
    }),
    detectCapabilities(null as unknown as PlatformEnv),
  ];
  check('missing agrees with every capability bit in every environment',
    environments.every((caps) => CAPABILITY_NAMES.every(
      (name) => caps[name] === !caps.missing.includes(name),
    )),
    `checked ${environments.length} environments`);
  check('isolated is always the crossOriginIsolated bit',
    environments.every((caps) => caps.isolated === caps.crossOriginIsolated),
    `checked ${environments.length} environments`);
  check('every missing list is an ordered subset of the capability vocabulary',
    environments.every((caps) => isOrderedSubset(caps.missing)),
    `checked ${environments.length} environments`);
}

// ---------------------------------------------------------------------- report

console.log(results
  .map((result) => `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`)
  .join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
