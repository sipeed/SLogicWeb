import { createEdgeStore } from '../../data/index.js';
import type { SampleStore } from '../../data/types.js';
import type { DecoderInstance } from '../../decode/types.js';

export interface ProtocolFixture {
  store: SampleStore;
  channelNames: string[];
  analyzers: DecoderInstance[];
}

const FIXTURE_SAMPLERATE = 16_000_000;
const FIXTURE_SAMPLES = 18_000;
const FIXTURE_I2C_START = 500;
const FIXTURE_I2C_BIT = 160;
const FIXTURE_SPI_START = 7000;
const FIXTURE_SPI_BIT = 160;
const FIXTURE_UART_START = 8000;
const FIXTURE_UART_BAUD = 115200;

interface TraceWriter {
  initial: 0 | 1;
  edges: number[];
  set(at: number, level: 0 | 1): void;
}

function fixtureChannel(initial: 0 | 1): TraceWriter {
  const edges: number[] = [];
  let level = initial;
  return {
    initial,
    edges,
    set(at, next) {
      if (next === level) return;
      if (!Number.isInteger(at)) throw new Error(`transition at ${at} is not a sample`);
      const last = edges.length > 0 ? edges[edges.length - 1]! : 0;
      if (!(at > last)) throw new Error(`transition at ${at} does not follow ${last}`);
      edges.push(at);
      level = next;
    },
  };
}

function writeUartFrames(w: TraceWriter, start: number, bitPeriod: number, bytes: readonly number[]): void {
  bytes.forEach((byte, frame) => {
    const t = start + frame * 10 * bitPeriod;
    w.set(Math.round(t), 0);
    for (let bit = 0; bit < 8; bit++) {
      w.set(Math.round(t + (1 + bit) * bitPeriod), ((byte >> bit) & 1) as 0 | 1);
    }
    w.set(Math.round(t + 9 * bitPeriod), 1);
  });
}

function writeI2cTransfer(
  scl: TraceWriter, sda: TraceWriter, start: number, bit: number,
  address: number, data: readonly number[],
): void {
  const bits: number[] = [];
  for (let b = 7; b >= 0; b--) bits.push(((address << 1) >> b) & 1);
  bits.push(0);
  for (const byte of data) {
    for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
    bits.push(0);
  }
  sda.set(start, 0);
  scl.set(start + bit / 2, 0);
  bits.forEach((value, k) => {
    sda.set(start + bit / 2 + 10 + k * bit, value as 0 | 1);
    scl.set(start + bit + k * bit, 1);
    scl.set(start + bit + bit / 2 + k * bit, 0);
  });
  const last = bits.length - 1;
  sda.set(start + bit + bit / 4 + last * bit, 1);
  scl.set(start + 2 * bit + last * bit, 1);
}

function writeSpiTransfer(
  clk: TraceWriter, miso: TraceWriter, mosi: TraceWriter, cs: TraceWriter,
  start: number, bit: number, misoBytes: readonly number[], mosiBytes: readonly number[],
): void {
  const misoBits: number[] = [];
  const mosiBits: number[] = [];
  for (const byte of misoBytes) for (let b = 7; b >= 0; b--) misoBits.push((byte >> b) & 1);
  for (const byte of mosiBytes) for (let b = 7; b >= 0; b--) mosiBits.push((byte >> b) & 1);
  const words = Math.max(misoBits.length, mosiBits.length);
  cs.set(start, 0);
  for (let k = 0; k < words; k++) {
    const rise = start + bit * 5 / 2 + k * bit;
    miso.set(rise - bit / 2, (misoBits[k] ?? 0) as 0 | 1);
    mosi.set(rise - bit / 2, (mosiBits[k] ?? 0) as 0 | 1);
    clk.set(rise, 1);
    clk.set(rise + bit / 2, 0);
  }
  cs.set(start + bit * 5 / 2 + words * bit + bit / 2, 1);
}

export function createProtocolFixture(): ProtocolFixture {
  const i2cScl = fixtureChannel(1);
  const i2cSda = fixtureChannel(1);
  const spiClk = fixtureChannel(0);
  const spiMiso = fixtureChannel(0);
  const spiMosi = fixtureChannel(0);
  const spiCs = fixtureChannel(1);
  const uartRx = fixtureChannel(1);
  const uartTx = fixtureChannel(1);

  writeI2cTransfer(i2cScl, i2cSda, FIXTURE_I2C_START, FIXTURE_I2C_BIT, 0x50, [0x00, 0xff]);
  writeSpiTransfer(spiClk, spiMiso, spiMosi, spiCs, FIXTURE_SPI_START, FIXTURE_SPI_BIT,
    [0x5a, 0xa5], [0xde, 0xad]);
  const uartBit = FIXTURE_SAMPLERATE / FIXTURE_UART_BAUD;
  writeUartFrames(uartRx, FIXTURE_UART_START, uartBit, [0x4f, 0x4b, 0x0d, 0x0a]);
  writeUartFrames(uartTx, FIXTURE_UART_START, uartBit, [0x48, 0x65, 0x6c, 0x6c, 0x6f]);

  const traces = [i2cScl, i2cSda, spiClk, spiMiso, spiMosi, spiCs, uartRx, uartTx];
  return {
    store: createEdgeStore(8, FIXTURE_SAMPLERATE, FIXTURE_SAMPLES,
      traces.map((t) => ({ initial: t.initial, edges: Int32Array.from(t.edges) }))),
    channelNames: ['I2C SCL', 'I2C SDA', 'SPI CLK', 'SPI MISO', 'SPI MOSI', 'SPI CS#', 'UART RX', 'UART TX'],
    analyzers: [
      { id: 'i2c', channels: { 0: 0, 1: 1 }, options: { address_format: 'shifted' } },
      {
        id: 'spi', channels: { 0: 2, 1: 3, 2: 4, 3: 5 },
        options: { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder: 'msb-first', wordsize: 8 },
      },
      {
        id: 'uart', channels: { 0: 6, 1: 7 },
        options: {
          baudrate: FIXTURE_UART_BAUD, data_bits: 8, parity: 'none', stop_bits: 1,
          bit_order: 'lsb-first', format: 'ascii',
        },
      },
    ],
  };
}
