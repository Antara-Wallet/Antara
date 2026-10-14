import { invoke } from "@tauri-apps/api/core";

export interface UsbDevice {
  id: string;
  vendor_id: string;
  product_id: string;
  product: string;
  manufacturer: string;
  serial: string | null;
  kind: string;
  can_store_file: boolean;
}

export function listUsbDevices(): Promise<UsbDevice[]> {
  return invoke<UsbDevice[]>("list_usb_devices");
}
