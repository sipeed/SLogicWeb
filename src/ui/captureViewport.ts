// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Start/stop origin and reason vocabulary shared by the App and the session model.
 *
 * The viewport policy that used to live here moved to `captureSession.ts`; the session
 * owns FollowLive/Fixed/TriggerLocked and never auto-fits. This file only names why a
 * capture started and why it stopped.
 */

export type CaptureStartOrigin = 'manual' | 'repeat';
export type CaptureStopReason = 'manual' | 'completed';
