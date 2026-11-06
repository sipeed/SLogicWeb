// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The bundled example capture ("Open example"): fixtures/uart.sr, a small sigrok session
 * with a UART stream, so the app can be tried - view, measure, auto-decode - without a
 * device. app.ts imports the fixture with `?url&inline`, which makes it a `data:` URL in
 * every build (the hosted one and the portable single file, which must not fetch a
 * sibling file over file://); the dev server may hand out a plain URL instead.
 *
 * The file then goes through the ordinary open path (`loadFiles` -> srLoad), so it
 * behaves exactly like a file the user opened. Pure apart from `fetch` for a non-data URL.
 */

/** The name the example opens under (and the default base name a Save offers). */
export const EXAMPLE_CAPTURE_NAME = 'example-uart.sr';

/** The bytes of a base64 `data:` URL, or null when the URL is not one. */
export function dataUrlBytes(url: string): Uint8Array<ArrayBuffer> | null {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(url);
  if (!match) return null;
  const binary = atob(match[1]!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The example as a File for `loadFiles`. */
export async function exampleCaptureFile(url: string, name = EXAMPLE_CAPTURE_NAME): Promise<File> {
  const inline = dataUrlBytes(url);
  if (inline) return new File([inline], name);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`example capture: HTTP ${response.status}`);
  return new File([await response.arrayBuffer()], name);
}
