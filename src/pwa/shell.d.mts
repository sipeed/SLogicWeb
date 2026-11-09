// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/** Types for shell.mjs, so the TypeScript self-test can import the build-side module. */

export interface ShellList {
  index: string;
  hashed: string[];
  plain: string[];
  runtime: string[];
}

export const THEME_COLOR: string;
export const ICONS: readonly string[];
export const SHELL_TOKEN: string;
export function webManifest(): string;
export function collectShell(dist: string, inlined?: readonly string[]): ShellList;
export function shellVersion(dist: string, shell: ShellList, template?: string): string;
export function headTags(version: string): string;
export function stampIndex(html: string, version: string): string;
export function renderServiceWorker(template: string, shell: ShellList, version: string): string;
export function buildPwaShell(
  dist: string,
  options?: { inlined?: readonly string[]; template?: string; iconDir?: string },
): { version: string; shell: ShellList };
