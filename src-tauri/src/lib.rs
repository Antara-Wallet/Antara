mod browser; // embedded in-app web browser (multiwebview)
mod devices; // Bluetooth + geolocation presence factors
mod layer_passkey; // vault-layer passkeys via webauthn.dll (pinned RP ID and origin)
mod layers; // vault-layer readings: Wi-Fi, connected Bluetooth, location
mod stealth; // ERC-5564 stealth addresses (private receiving)
mod vault;
#[cfg(windows)]
mod webauthn; // Windows-native WebAuthn bridge
#[cfg(not(windows))]
#[path = "webauthn_unavailable.rs"]
mod webauthn;

use serde::Serialize;
use sysinfo::Disks;
use vault::VaultState;

#[derive(Serialize)]
struct Drive {
    mount: String,
    name: String,
    total_gb: f64,
    free_gb: f64,
    removable: bool,
    is_system: bool,
}

// Lists all mounted drives. We deliberately do NOT try to auto-classify "USB",
// because on Windows USB/UASP drives report is_removable=false and bus=SCSI.
// The user designates which drive is their wallet key; the system drive is
// flagged so the UI can disable it.
#[tauri::command]
fn list_drives() -> Vec<Drive> {
    let disks = Disks::new_with_refreshed_list();
    #[cfg(windows)]
    let system_mount = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    disks
        .iter()
        .map(|d| {
            let mount = d.mount_point().display().to_string();
            #[cfg(windows)]
            let is_system = mount.trim_end_matches('\\').eq_ignore_ascii_case(&system_mount);
            #[cfg(not(windows))]
            let is_system = mount == "/" || mount == "/System/Volumes/Data";
            Drive {
                mount,
                name: d.name().to_string_lossy().to_string(),
                total_gb: d.total_space() as f64 / 1e9,
                free_gb: d.available_space() as f64 / 1e9,
                removable: d.is_removable(),
                is_system,
            }
        })
        .collect()
}

#[derive(Serialize)]
struct UsbDevice {
    id: String,           // stable-ish key: vid:pid:serial
    vendor_id: String,    // hex, e.g. "046d"
    product_id: String,   // hex
    product: String,
    manufacturer: String,
    serial: Option<String>,
    kind: String,
    can_store_file: bool, // true only for mass-storage class (keypair-on-device possible)
}

// Lists ALL connected USB devices (mouse, keyboard, webcam, sticks, ...), not
// just disks. Any of these can be designated as a presence factor. Devices
// without a serial can only be identified by VID/PID, so any identical unit
// would also match — the UI surfaces this.
#[tauri::command]
fn list_usb_devices() -> Vec<UsbDevice> {
    let mut out = Vec::new();
    let devices = match nusb::list_devices() {
        Ok(d) => d,
        Err(_) => return out,
    };
    for d in devices {
        let vid = d.vendor_id();
        let pid = d.product_id();
        let class = d.class();
        let kind = match class {
            0x08 => "Mass storage",
            0x03 => "Keyboard / mouse (HID)",
            0x09 => "USB hub",
            0x0e => "Webcam / video",
            0x01 => "Audio",
            0xe0 => "Wireless (Bluetooth etc.)",
            0x00 => "Composite device",
            _ => "Other",
        }
        .to_string();
        let serial = d.serial_number().map(|s| s.to_string());
        let product = d
            .product_string()
            .filter(|s| !s.is_empty())
            .unwrap_or("USB device")
            .to_string();
        let manufacturer = d.manufacturer_string().unwrap_or("").to_string();
        out.push(UsbDevice {
            id: format!("{:04x}:{:04x}:{}", vid, pid, serial.clone().unwrap_or_default()),
            vendor_id: format!("{:04x}", vid),
            product_id: format!("{:04x}", pid),
            product,
            manufacturer,
            serial,
            kind,
            can_store_file: class == 0x08,
        });
    }
    // Hide hubs — they're not meaningful as a user key.
    out.retain(|d| d.kind != "USB hub");
    out
}

// Expand this once: macOS embeds an Info.plist symbol for each expansion.
// Runtime ACL tests must use the same context as the application.
fn app_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(VaultState::default())
        .invoke_handler(tauri::generate_handler![
            list_drives,
            list_usb_devices,
            vault::vault_exists,
            vault::create_vault,
            vault::import_vault,
            vault::unlock_vault,
            vault::lock_vault,
            vault::list_accounts,
            vault::add_account,
            vault::import_account,
            vault::sign_hash,
            vault::reveal_mnemonic,
            vault::reveal_private_key,
            vault::stealth_meta_address,
            vault::stealth_send_compute,
            vault::stealth_scan,
            vault::stealth_sign,
            webauthn::webauthn_make_credential,
            webauthn::webauthn_get_assertion,
            devices::list_bluetooth_devices,
            devices::get_location,
            layers::layer_wifi_connections,
            layers::layer_bluetooth_connected,
            layers::layer_location,
            layers::open_location_settings,
            layer_passkey::layer_passkey_get,
            layer_passkey::layer_passkey_create,
            browser::browser_open,
            browser::browser_activate,
            browser::browser_navigate,
            browser::browser_close,
            browser::browser_hide_all,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
        ])
        .run(app_context())
        .expect("error while running tauri application");
}
