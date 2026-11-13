// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
import type { Device } from './types.js';
import { DiagnosticError } from '../diagnostics.js';
import { PID_SLOGIC16_U3, PID_SLOGIC32_U3, USB_VID_SIPEED } from './protocol.js';
import { USB_FILTERS } from './usbCore.js';
import { workerTransport } from './workerTransport.js';

export type {
  CaptureConfig, CaptureStartOptions, Device, DieTemperatureReading, SampleSink,
} from './types.js';
export {
  PROFILES,
  SLOGIC16U3_PROFILE,
  SLOGIC32U3_PROFILE,
  capabilityReason,
  maxSamplerateFor,
  profileForVidPid,
  recommendedSamplerateHzFor,
  sampleRatesFor,
  validateProfile,
} from './profile.js';
export type {
  AnalogGroup,
  AnalogTriggerKind,
  CalibrationRef,
  DeviceProfile,
  DigitalGroup,
  LinkRate,
  ProfileQuirk,
  RateTier,
  TestMode,
  TriggerKind,
} from './profileTypes.js';
export {
  SIM_CH0_PERIOD_SAMPLES,
  SimDriver,
  SimDriverError,
  type SimDriverErrorCode,
  type SimDriverOptions,
  type SimDriverState,
  type SimFault,
  type SimFaultKind,
  type SimGapSpan,
  type SimSink,
  type SimStartConfig,
} from './simDriver.js';
export { WorkerSlogicDevice, workerTransport } from './workerTransport.js';

/**
 * Open the device the origin already has permission for, on the worker when it can and
 * on the page when it cannot. See `workerTransport`.
 */
export async function getGrantedDevicesOnBestThread(): Promise<Device[]> {
  if (!navigator.usb) throw new DiagnosticError('usb.unavailable');
  const all = await navigator.usb.getDevices().catch(rethrowUsbFailure);
  const mine = all.filter((d) => d.vendorId === USB_VID_SIPEED &&
    (d.productId === PID_SLOGIC16_U3 || d.productId === PID_SLOGIC32_U3));
  const devices: Device[] = [];
  for (const usb of mine) devices.push(await workerTransport.open(usb));
  return devices;
}

/**
 * Prompt for a device - which WebUSB only allows in response to a user gesture - and hand
 * back the transport that should run it.
 */
export async function requestDeviceOnBestThread(): Promise<Device> {
  if (!navigator.usb) throw new DiagnosticError('usb.unavailable');
  const usb = await navigator.usb.requestDevice({ filters: USB_FILTERS })
    .catch(rethrowUsbFailure);
  return workerTransport.open(usb);
}

function rethrowUsbFailure(error: unknown): never {
  if (!(error instanceof DOMException)) throw error;
  if (error.name === 'SecurityError') {
    throw new DiagnosticError('usb.blocked', undefined, error.message || undefined);
  }
  throw error;
}
export {
  SoftwareTrigger,
  MAX_SOFTWARE_TRIGGER_PREFIX_BYTES,
  type SoftwareTriggerConfig,
  type SoftwareTriggerKind,
  type SoftwareTriggerLevel,
  type SoftwareTriggerMatch,
  type SoftwareTriggerMode,
  type SoftwareTriggerOptions,
  type SoftwareTriggerScanOptions,
  type SoftwareTriggerStats,
} from '../data/softwareTrigger.js';
export { USB_FILTERS } from './usbCore.js';
export type { StartOptions, Stats, StreamTuning } from './slogic16u3.js';
export { TransportDeadError } from './types.js';
export {
  MAX_SAMPLERATE_HZ,
  MAX_SAMPLERATE_HZ_SLOGIC32_U3,
  PID_SLOGIC16_U3,
  PID_SLOGIC32_U3,
  SAMPLERATES_HZ,
  SUPPORTED_CHANNELS,
  TEST_MODE_EMULATION,
  TEST_MODE_NORMAL,
  TEST_MODE_USB_MAX_SPEED,
  vrefCode,
  vrefVolts,
  type TraceEntry,
} from './protocol.js';
