export interface UsbSerialIdentity {
  readonly serialNumber?: string | null;
}

export function sameUsbDevice(serial: string, usb: UsbSerialIdentity): boolean {
  const reported = usb.serialNumber ?? '';
  return serial === '' || reported === '' || serial === reported;
}
