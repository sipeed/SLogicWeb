// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Public M0 contracts for the USB link session. The concrete WebUSB adapter is injected
 * as a `LinkPort`; this module owns pairing/claim/handshake/probe/reconnect state.
 */

export * from './linkSession.js';
export * from './webUsbPort.js';
