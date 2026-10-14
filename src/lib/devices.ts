import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isDemoMode, demoInvoke, hasTauriBridge } from "./demo";

/** Live device/location readers used by the vault policy layers. */

// Browser demo mode has no Rust bridge — serve fake device/location readings.
const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  isDemoMode() && !hasTauriBridge()
    ? (demoInvoke(cmd, args) as Promise<T>)
    : tauriInvoke<T>(cmd, args);

export interface UsbDevice {
  id: string; // VID:PID:serial
  vendor_id: string;
  product_id: string;
  product: string;
  manufacturer: string;
  serial: string | null;
  kind: string;
  can_store_file: boolean;
}

export interface BtDevice {
  id: string; // 48-bit address hex
  name: string;
  connected: boolean;
}

export interface GeoPos {
  lat: number;
  lng: number;
  accuracy_m: number;
}

export const listUsbDevices = () => invoke<UsbDevice[]>("list_usb_devices");
export const listBluetoothDevices = () => invoke<BtDevice[]>("list_bluetooth_devices");
export const getLocation = () => invoke<GeoPos>("get_location");
