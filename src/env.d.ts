// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Build identity, injected by vite.config.ts `define`. The offline self-tests bundle
 * sources with esbuild and no define, so readers must guard with `typeof` and fall back
 * to 'dev' (src/ui/about.ts buildIdentity()).
 */
declare const __APP_VERSION__: string;
declare const __GIT_HASH__: string;

/** Vite `?raw` imports: the bundled text of the repository skill and future cases. */
declare module '*?raw' {
  const text: string;
  export default text;
}
