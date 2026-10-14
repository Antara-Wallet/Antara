//! Native readings for the paired-vault protection layers (docs/VAULT_LAYERS.md §10).
//!
//! - `layer_wifi_connections`: SSID and BSSID of each connected Wi-Fi interface (wlanapi).
//! - `layer_bluetooth_connected`: classic Bluetooth devices that are connected right now.
//! - `layer_location`: one fresh WinRT `Geolocator` fix, after the OS consent
//!   request, measured by this computer itself (see `measured_on_device`).
//! - `open_location_settings`: opens Windows' location privacy page (a fixed URI).
//!
//! Every reading here is DEVICE-REPORTED. The client signs it with its trusted
//! device key and ANTARA's server decides; nothing here proves where the device
//! is, and a modified device can report anything. What this module does
//! guarantee is that it never invents a reading: each command fails closed with
//! exactly one of the error codes below, and no value (accuracy, timestamp,
//! SSID, BSSID) is ever defaulted. A position Windows did not measure on this
//! computer (the hand-typed default location, a coarse or IP-based estimate, or
//! a fix redirected from a Remote Desktop client) is refused, never passed on.
//! Bluetooth distance is never measured.
//!
//! Blocking Win32/WinRT work runs on `spawn_blocking`, so the webview stays
//! responsive. The one exception is the location consent request, which
//! Microsoft requires on the UI thread: it is started on the main thread and
//! its answer is awaited on the worker. Other platforms return
//! `unsupported-platform`.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;
use std::time::{Duration, Instant};

/// Returned by the non-Windows stubs.
#[cfg_attr(windows, allow(dead_code))]
pub const UNSUPPORTED_PLATFORM: &str = "unsupported-platform";
pub const LOCATION_CONSENT_REQUIRED: &str = "location-consent-required";
pub const WIFI_UNAVAILABLE: &str = "wifi-unavailable";
pub const NOT_CONNECTED: &str = "not-connected";
pub const BLUETOOTH_UNAVAILABLE: &str = "bluetooth-unavailable";
pub const LOCATION_UNAVAILABLE: &str = "location-unavailable";
pub const ACCURACY_UNKNOWN: &str = "accuracy-unknown";

/// Windows' location privacy page. On Windows 11 24H2 and later the same
/// consent also gates Wi-Fi names, so the Wi-Fi layer sends users here too.
const LOCATION_SETTINGS_URI: &str = "ms-settings:privacy-location";
/// `ERROR_ACCESS_DENIED`: wlanapi's answer without location consent (Windows 11 24H2+).
const ERROR_ACCESS_DENIED: u32 = 5;
/// `E_ACCESSDENIED` (`HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED)`), as WinRT reports it.
const E_ACCESSDENIED: i32 = 0x8007_0005_u32 as i32;
/// `E_FAIL`: the consent request produced neither an answer nor an error code.
const E_FAIL: i32 = 0x8000_4005_u32 as i32;
/// `Windows.Devices.Geolocation.PositionSource` values (pinned against the
/// `windows` crate in a Windows-only test). Only the first three are accepted;
/// the refused values are named for the tests and readers.
pub const SOURCE_CELLULAR: i32 = 0;
pub const SOURCE_SATELLITE: i32 = 1;
pub const SOURCE_WIFI: i32 = 2;
#[allow(dead_code)]
pub const SOURCE_IP_ADDRESS: i32 = 3;
#[allow(dead_code)]
pub const SOURCE_UNKNOWN: i32 = 4;
/// The location typed in Settings > Privacy & security > Location > Default
/// location, which Windows returns when it has no fix.
#[allow(dead_code)]
pub const SOURCE_DEFAULT: i32 = 5;
/// Windows' coarse-location feature: deliberately made inaccurate.
#[allow(dead_code)]
pub const SOURCE_OBFUSCATED: i32 = 6;
/// Longest device name passed on, in UTF-16 units (the server's limit).
const MAX_DEVICE_NAME_UNITS: usize = 64;
/// Upper bound on devices read from one Bluetooth enumeration (defensive).
const MAX_BLUETOOTH_DEVICES: usize = 256;
/// More connected Wi-Fi interfaces than this is not a reading the client
/// accepts (src/platform/native.ts), so it is refused here too.
const MAX_WIFI_CONNECTIONS: usize = 8;
/// Name shown when a device reports none; matching always uses the address.
const UNNAMED_DEVICE: &str = "Unknown device";
/// 100 ns ticks between 1601-01-01 (Windows `DateTime`) and 1970-01-01 (Unix).
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;
/// How long the location consent request may stay unanswered before it counts
/// as not granted. WinRT's `get()` would wait forever.
const LOCATION_CONSENT_WAIT: Duration = Duration::from_secs(60);
/// Windows is asked for a fix within 15 s; this is the hard stop around it.
const LOCATION_FIX_WAIT: Duration = Duration::from_secs(20);
/// Poll interval while waiting for a WinRT operation.
const WAIT_STEP: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiConnection {
    /// Lossy UTF-8 display name; matching uses `ssid_hex`.
    pub ssid: String,
    /// The exact SSID bytes, lowercase hex (2..64 characters).
    pub ssid_hex: String,
    /// `AA:BB:CC:DD:EE:FF`, uppercase.
    pub bssid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedBluetoothDevice {
    /// 48-bit address as 12 uppercase hex digits (the enrolled identifier).
    pub id: String,
    pub name: String,
    pub kind: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerLocation {
    pub lat: f64,
    pub lng: f64,
    /// Always finite and greater than zero.
    pub accuracy_m: f64,
    /// When Windows took the fix, in ms since the Unix epoch.
    pub at: i64,
}

/// Connected Wi-Fi networks (SSID and BSSID). Never empty on success.
#[tauri::command]
pub async fn layer_wifi_connections() -> Result<Vec<WifiConnection>, String> {
    run_blocking(platform::wifi_connections, WIFI_UNAVAILABLE).await
}

/// Classic Bluetooth devices connected to this computer now; may be empty.
/// Remembered but disconnected devices and BLE-only devices are not listed.
#[tauri::command]
pub async fn layer_bluetooth_connected() -> Result<Vec<ConnectedBluetoothDevice>, String> {
    run_blocking(platform::bluetooth_connected, BLUETOOTH_UNAVAILABLE).await
}

/// One fresh location fix measured by this computer. Unknown accuracy is an
/// error, never a default. The app handle only schedules the consent request
/// on the main thread.
#[tauri::command]
pub async fn layer_location(app: tauri::AppHandle) -> Result<LayerLocation, String> {
    run_blocking(move || platform::location(&app), LOCATION_UNAVAILABLE).await
}

/// Opens `ms-settings:privacy-location`. Takes no argument, so JavaScript
/// cannot choose what is opened.
#[tauri::command]
pub async fn open_location_settings() -> Result<(), String> {
    run_blocking(platform::open_location_settings, LOCATION_UNAVAILABLE).await
}

/// Runs blocking OS work off the async runtime; a panicked worker is `on_panic`.
async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
    on_panic: &'static str,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or(Err(on_panic))
        .map_err(str::to_string)
}

// ---------------------------------------------------------------------------
// Pure helpers (no FFI), shared by every platform and unit-tested.
// ---------------------------------------------------------------------------

/// `AA:BB:CC:DD:EE:FF`, uppercase.
pub fn format_bssid(bytes: &[u8; 6]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// An all-zero or broadcast BSSID is not an access point (a redacted or
/// half-populated reading), so it is refused rather than reported.
pub fn usable_bssid(bytes: &[u8; 6]) -> bool {
    bytes != &[0u8; 6] && bytes != &[0xFFu8; 6]
}

/// SSID bytes as (lossy UTF-8 display name, lowercase hex of the exact bytes).
/// `None` for a length of 0 or above 32 (`DOT11_SSID_MAX_LENGTH`).
pub fn ssid_from_dot11(length: u32, bytes: &[u8; 32]) -> Option<(String, String)> {
    let length = usize::try_from(length).ok()?;
    if length == 0 || length > bytes.len() {
        return None;
    }
    let raw = &bytes[..length];
    Some((String::from_utf8_lossy(raw).into_owned(), hex::encode(raw)))
}

/// Maps a wlanapi error code. `ERROR_ACCESS_DENIED` (5) is what Windows 11
/// 24H2+ returns for connection attributes without location consent.
pub fn map_wlan_error(code: u32) -> &'static str {
    if code == ERROR_ACCESS_DENIED {
        LOCATION_CONSENT_REQUIRED
    } else {
        WIFI_UNAVAILABLE
    }
}

/// Outcome of reading one connected interface's current connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InterfaceReading {
    Connection(WifiConnection),
    /// The query was refused for lack of location consent.
    Denied,
    /// The query failed, or returned an SSID or BSSID that is not usable.
    Unusable,
}

/// Turns one interface's connection attributes into a reading.
pub fn connection_reading(
    still_connected: bool,
    ssid_length: u32,
    ssid: &[u8; 32],
    bssid: &[u8; 6],
) -> InterfaceReading {
    if !still_connected || !usable_bssid(bssid) {
        return InterfaceReading::Unusable;
    }
    match ssid_from_dot11(ssid_length, ssid) {
        Some((ssid, ssid_hex)) => InterfaceReading::Connection(WifiConnection {
            ssid,
            ssid_hex,
            bssid: format_bssid(bssid),
        }),
        None => InterfaceReading::Unusable,
    }
}

/// Combines per-interface readings. Success is never an empty list:
/// no WLAN interface is `wifi-unavailable`, none connected is `not-connected`,
/// only refusals is `location-consent-required`, anything else unusable (or
/// more than eight distinct connections) is `wifi-unavailable`.
pub fn summarize_wifi(
    interface_count: usize,
    readings: Vec<InterfaceReading>,
) -> Result<Vec<WifiConnection>, &'static str> {
    if interface_count == 0 {
        return Err(WIFI_UNAVAILABLE);
    }
    if readings.is_empty() {
        return Err(NOT_CONNECTED);
    }
    let mut connections: Vec<WifiConnection> = Vec::new();
    let mut denied = false;
    for reading in readings {
        match reading {
            InterfaceReading::Connection(connection) => {
                if !connections.contains(&connection) {
                    connections.push(connection);
                }
            }
            InterfaceReading::Denied => denied = true,
            InterfaceReading::Unusable => {}
        }
    }
    if connections.len() > MAX_WIFI_CONNECTIONS {
        Err(WIFI_UNAVAILABLE)
    } else if !connections.is_empty() {
        Ok(connections)
    } else if denied {
        Err(LOCATION_CONSENT_REQUIRED)
    } else {
        Err(WIFI_UNAVAILABLE)
    }
}

/// 48-bit Bluetooth address as 12 uppercase hex digits.
pub fn format_bt_address(address: u64) -> String {
    format!("{:012X}", address & 0xFFFF_FFFF_FFFF)
}

/// Device name from a NUL-terminated UTF-16 buffer: control characters
/// dropped, trimmed, and cut to 64 UTF-16 units on a character boundary.
pub fn bt_device_name(raw: &[u16]) -> String {
    let end = raw.iter().position(|&unit| unit == 0).unwrap_or(raw.len());
    let decoded = String::from_utf16_lossy(&raw[..end]);
    let mut name = String::new();
    let mut units = 0;
    for ch in decoded.trim().chars().filter(|ch| !ch.is_control()) {
        units += ch.len_utf16();
        if units > MAX_DEVICE_NAME_UNITS {
            break;
        }
        name.push(ch);
    }
    let name = name.trim_end();
    if name.is_empty() {
        UNNAMED_DEVICE.to_string()
    } else {
        name.to_string()
    }
}

/// Keeps devices that are connected now, with a non-zero address, once each.
pub fn connected_devices(
    devices: impl IntoIterator<Item = (u64, String, bool)>,
) -> Vec<ConnectedBluetoothDevice> {
    let mut out: Vec<ConnectedBluetoothDevice> = Vec::new();
    for (address, name, connected) in devices {
        let address = address & 0xFFFF_FFFF_FFFF;
        if !connected || address == 0 {
            continue;
        }
        let id = format_bt_address(address);
        if out.iter().any(|device| device.id == id) {
            continue;
        }
        out.push(ConnectedBluetoothDevice {
            id,
            name,
            kind: "classic",
        });
    }
    out
}

/// Windows `DateTime` ticks (100 ns since 1601-01-01 UTC) to Unix ms.
/// `None` for anything at or before the Unix epoch, which no real fix has.
pub fn filetime_to_unix_ms(ticks: i64) -> Option<i64> {
    let ms = ticks.checked_sub(UNIX_EPOCH_TICKS)?.div_euclid(10_000);
    (ms > 0).then_some(ms)
}

/// Polls `finished` until it reports true (`Ok(true)`) or `limit` has passed
/// (`Ok(false)`). An error from `finished` ends the wait. Never blocks forever.
pub fn wait_with_deadline<E>(
    mut finished: impl FnMut() -> Result<bool, E>,
    limit: Duration,
    step: Duration,
) -> Result<bool, E> {
    let deadline = Instant::now() + limit;
    loop {
        if finished()? {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(step);
    }
}

/// WinRT location failures: access denied means consent; anything else is unavailable.
pub fn map_location_error(code: i32) -> &'static str {
    if code == E_ACCESSDENIED {
        LOCATION_CONSENT_REQUIRED
    } else {
        LOCATION_UNAVAILABLE
    }
}

/// What `Geolocator::RequestAccessAsync` answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentAnswer {
    Allowed,
    /// `Denied` or `Unspecified`.
    NotAllowed,
    /// No answer within `LOCATION_CONSENT_WAIT`.
    NoAnswer,
    /// The request could not be made, or failed with this HRESULT.
    Failed(i32),
}

/// Whether to go on and ask Windows for a fix. The consent request exists
/// only to show Windows' one-time prompt; Windows itself refuses a fix without
/// consent (`E_ACCESSDENIED`, mapped to `location-consent-required`). So a
/// request that fails for another reason (for example `RPC_E_WRONG_THREAD`)
/// goes on to the fix, which still cannot succeed without consent and is still
/// checked by `checked_location`. Anything but `Allowed` from the user stops here.
pub fn consent_decision(answer: ConsentAnswer) -> Result<(), &'static str> {
    match answer {
        ConsentAnswer::Allowed => Ok(()),
        ConsentAnswer::NotAllowed | ConsentAnswer::NoAnswer => Err(LOCATION_CONSENT_REQUIRED),
        ConsentAnswer::Failed(code) => match map_location_error(code) {
            LOCATION_CONSENT_REQUIRED => Err(LOCATION_CONSENT_REQUIRED),
            _ => Ok(()),
        },
    }
}

/// True only for a position this computer measured itself: a satellite, Wi-Fi
/// or cellular fix (`Geocoordinate.PositionSource`) that Windows says is not
/// redirected from a Remote Desktop client (`Geocoordinate.IsRemoteSource`
/// is `false`). Everything else is refused:
/// - `Default`: the hand-typed default location, which Windows returns when it
///   has no fix. Anyone at the unlocked computer could set it to a safe zone.
/// - `Obfuscated`: deliberately inaccurate (coarse location).
/// - `IPAddress`: an estimate from the network address, not a device reading
///   (ANTARA's server checks the public IP itself in the Wi-Fi layer).
/// - `Unknown`, an unrecognised value, or a source that cannot be read.
/// - A remote (redirected) fix, or a remote flag that cannot be read: the
///   property exists from Windows 11 (build 22000), so older Windows is refused.
pub fn measured_on_device(source: Option<i32>, remote: Option<bool>) -> bool {
    matches!(
        source,
        Some(SOURCE_SATELLITE | SOURCE_WIFI | SOURCE_CELLULAR)
    ) && remote == Some(false)
}

/// Validates one fix. It must be measured on this computer
/// (`measured_on_device`), coordinates must be finite and in range, accuracy
/// must be known, finite and greater than zero, and the timestamp must be real.
pub fn checked_location(
    lat: f64,
    lng: f64,
    accuracy: Option<f64>,
    timestamp_ticks: Option<i64>,
    source: Option<i32>,
    remote: Option<bool>,
) -> Result<LayerLocation, &'static str> {
    if !measured_on_device(source, remote) {
        return Err(LOCATION_UNAVAILABLE);
    }
    if !lat.is_finite()
        || !lng.is_finite()
        || !(-90.0..=90.0).contains(&lat)
        || !(-180.0..=180.0).contains(&lng)
    {
        return Err(LOCATION_UNAVAILABLE);
    }
    let accuracy_m = match accuracy {
        Some(value) if value.is_finite() && value > 0.0 => value,
        _ => return Err(ACCURACY_UNKNOWN),
    };
    let at = timestamp_ticks
        .and_then(filetime_to_unix_ms)
        .ok_or(LOCATION_UNAVAILABLE)?;
    Ok(LayerLocation {
        lat,
        lng,
        accuracy_m,
        at,
    })
}

// ---------------------------------------------------------------------------
// Platform implementations.
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::ptr::{addr_of, null_mut};

    pub fn wifi_connections() -> Result<Vec<WifiConnection>, &'static str> {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::NetworkManagement::WiFi::{
            wlan_interface_state_connected, wlan_intf_opcode_current_connection, WlanCloseHandle,
            WlanEnumInterfaces, WlanFreeMemory, WlanOpenHandle, WlanQueryInterface,
            WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO, WLAN_INTERFACE_INFO_LIST,
        };

        /// Closes the wlanapi client handle on every path.
        struct Client(HANDLE);
        impl Drop for Client {
            fn drop(&mut self) {
                let _ = unsafe { WlanCloseHandle(self.0, None) };
            }
        }
        /// Frees wlanapi-allocated memory on every path.
        struct Memory(*mut c_void);
        impl Drop for Memory {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe { WlanFreeMemory(self.0) };
                }
            }
        }

        // Client version 2: the Windows Vista+ WLAN API.
        let mut negotiated = 0u32;
        let mut handle = HANDLE::default();
        let code = unsafe { WlanOpenHandle(2, None, &mut negotiated, &mut handle) };
        if code != 0 {
            return Err(map_wlan_error(code));
        }
        let client = Client(handle);

        let mut list: *mut WLAN_INTERFACE_INFO_LIST = null_mut();
        let code = unsafe { WlanEnumInterfaces(client.0, None, &mut list) };
        let _list_memory = Memory(list.cast());
        if code != 0 {
            return Err(map_wlan_error(code));
        }
        if list.is_null() {
            return Err(WIFI_UNAVAILABLE);
        }
        // SAFETY: wlanapi returns `dwNumberOfItems` entries starting at
        // `InterfaceInfo`; `_list_memory` keeps them alive for this scope.
        let interfaces: &[WLAN_INTERFACE_INFO] = unsafe {
            let count = (*list).dwNumberOfItems as usize;
            std::slice::from_raw_parts(
                addr_of!((*list).InterfaceInfo).cast::<WLAN_INTERFACE_INFO>(),
                count,
            )
        };

        let mut readings = Vec::new();
        for interface in interfaces
            .iter()
            .filter(|interface| interface.isState == wlan_interface_state_connected)
        {
            let mut size = 0u32;
            let mut data: *mut c_void = null_mut();
            let code = unsafe {
                WlanQueryInterface(
                    client.0,
                    &interface.InterfaceGuid,
                    wlan_intf_opcode_current_connection,
                    None,
                    &mut size,
                    &mut data,
                    None,
                )
            };
            let _data_memory = Memory(data);
            if code != 0 {
                readings.push(if map_wlan_error(code) == LOCATION_CONSENT_REQUIRED {
                    InterfaceReading::Denied
                } else {
                    InterfaceReading::Unusable
                });
                continue;
            }
            if data.is_null() || (size as usize) < std::mem::size_of::<WLAN_CONNECTION_ATTRIBUTES>()
            {
                readings.push(InterfaceReading::Unusable);
                continue;
            }
            // SAFETY: the size is checked above; the copy does not rely on alignment.
            let attributes = unsafe { data.cast::<WLAN_CONNECTION_ATTRIBUTES>().read_unaligned() };
            let association = attributes.wlanAssociationAttributes;
            readings.push(connection_reading(
                attributes.isState == wlan_interface_state_connected,
                association.dot11Ssid.uSSIDLength,
                &association.dot11Ssid.ucSSID,
                &association.dot11Bssid,
            ));
        }
        summarize_wifi(interfaces.len(), readings)
    }

    pub fn bluetooth_connected() -> Result<Vec<ConnectedBluetoothDevice>, &'static str> {
        use windows::Win32::Devices::Bluetooth::{
            BluetoothFindDeviceClose, BluetoothFindFirstDevice, BluetoothFindFirstRadio,
            BluetoothFindNextDevice, BluetoothFindRadioClose, BLUETOOTH_DEVICE_INFO,
            BLUETOOTH_DEVICE_SEARCH_PARAMS, BLUETOOTH_FIND_RADIO_PARAMS,
        };
        use windows::Win32::Foundation::{CloseHandle, BOOL, ERROR_NO_MORE_ITEMS, HANDLE};

        // Without a radio, "nothing connected" would be a guess: refuse instead.
        let radio_params = BLUETOOTH_FIND_RADIO_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32,
        };
        let mut radio = HANDLE::default();
        let radio_find = unsafe { BluetoothFindFirstRadio(&radio_params, &mut radio) }
            .map_err(|_| BLUETOOTH_UNAVAILABLE)?;
        unsafe {
            let _ = BluetoothFindRadioClose(radio_find);
            let _ = CloseHandle(radio);
        }

        // The same search as the legacy `list_bluetooth_devices`, never an
        // inquiry (radio scan). Only `fConnected` devices are kept below.
        let params = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            fReturnAuthenticated: BOOL(1),
            fReturnRemembered: BOOL(1),
            fReturnUnknown: BOOL(0),
            fReturnConnected: BOOL(1),
            fIssueInquiry: BOOL(0),
            cTimeoutMultiplier: 2,
            hRadio: HANDLE::default(),
        };
        let blank = || BLUETOOTH_DEVICE_INFO {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
            ..Default::default()
        };
        let no_more_items = ERROR_NO_MORE_ITEMS.to_hresult();

        let mut info = blank();
        let find = match unsafe { BluetoothFindFirstDevice(&params, &mut info) } {
            Ok(find) => find,
            Err(error) if error.code() == no_more_items => return Ok(Vec::new()),
            Err(_) => return Err(BLUETOOTH_UNAVAILABLE),
        };
        let mut seen = Vec::new();
        let outcome = loop {
            // SAFETY: both union members are the same 8-byte address.
            let address = unsafe { info.Address.Anonymous.ullLong };
            seen.push((
                address,
                bt_device_name(&info.szName),
                info.fConnected.as_bool(),
            ));
            if seen.len() >= MAX_BLUETOOTH_DEVICES {
                break Ok(());
            }
            info = blank();
            match unsafe { BluetoothFindNextDevice(find, &mut info) } {
                Ok(()) => {}
                Err(error) if error.code() == no_more_items => break Ok(()),
                Err(_) => break Err(BLUETOOTH_UNAVAILABLE),
            }
        };
        unsafe {
            let _ = BluetoothFindDeviceClose(find);
        }
        outcome.map(|()| connected_devices(seen))
    }

    fn location_error(error: windows::core::Error) -> &'static str {
        map_location_error(error.code().0)
    }

    /// Waits for a WinRT operation for at most `limit`, then cancels it and
    /// answers `on_timeout`. `IAsyncOperation::get()` has no deadline.
    fn bounded<T: windows::core::RuntimeType + 'static>(
        operation: windows::Foundation::IAsyncOperation<T>,
        limit: Duration,
        on_timeout: &'static str,
    ) -> Result<T, &'static str> {
        use windows::Foundation::AsyncStatus;
        let finished = wait_with_deadline(
            || {
                operation
                    .Status()
                    .map(|status| status != AsyncStatus::Started)
            },
            limit,
            WAIT_STEP,
        )
        .map_err(location_error)?;
        if !finished {
            let _ = operation.Cancel();
            return Err(on_timeout);
        }
        operation.GetResults().map_err(location_error)
    }

    /// Asks for location consent (the one-time OS prompt). Microsoft requires
    /// `RequestAccessAsync` on the UI thread ("otherwise an exception will
    /// occur"), so it is started on the main thread, which is never blocked:
    /// a completion handler sends the answer back, and this worker waits at
    /// most `LOCATION_CONSENT_WAIT`. A late answer is discarded and the
    /// request is cancelled (also on the main thread).
    fn request_access(app: &tauri::AppHandle) -> ConsentAnswer {
        use std::sync::{mpsc, Arc, Mutex};
        use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator};
        use windows::Foundation::{AsyncOperationCompletedHandler, IAsyncOperation};

        type Request = IAsyncOperation<GeolocationAccessStatus>;
        let (sender, receiver) = mpsc::channel::<ConsentAnswer>();
        let pending: Arc<Mutex<Option<Request>>> = Arc::default();
        let slot = Arc::clone(&pending);
        let scheduled = app.run_on_main_thread(move || {
            let reply = sender.clone();
            let handler =
                AsyncOperationCompletedHandler::new(move |request: Option<&Request>, _status| {
                    // GetResults reports an error or cancellation as its HRESULT.
                    let answer = match request.map(|request| request.GetResults()) {
                        Some(Ok(status)) if status == GeolocationAccessStatus::Allowed => {
                            ConsentAnswer::Allowed
                        }
                        Some(Ok(_)) => ConsentAnswer::NotAllowed,
                        Some(Err(error)) => ConsentAnswer::Failed(error.code().0),
                        None => ConsentAnswer::Failed(E_FAIL),
                    };
                    let _ = reply.send(answer);
                    Ok(())
                });
            let started = Geolocator::RequestAccessAsync().and_then(|request| {
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(request.clone());
                }
                request.SetCompleted(&handler)
            });
            if let Err(error) = started {
                let _ = sender.send(ConsentAnswer::Failed(error.code().0));
            }
        });
        if scheduled.is_err() {
            return ConsentAnswer::Failed(E_FAIL);
        }
        match receiver.recv_timeout(LOCATION_CONSENT_WAIT) {
            Ok(answer) => answer,
            Err(_) => {
                let request = pending.lock().ok().and_then(|mut slot| slot.take());
                if let Some(request) = request {
                    let _ = app.run_on_main_thread(move || {
                        let _ = request.Cancel();
                    });
                }
                ConsentAnswer::NoAnswer
            }
        }
    }

    pub fn location(app: &tauri::AppHandle) -> Result<LayerLocation, &'static str> {
        use windows::Devices::Geolocation::{Geolocator, PositionAccuracy};
        use windows::Foundation::TimeSpan;

        let fail = location_error;

        // Anything but Allowed from the user (including no answer within a
        // minute) is a refusal; see `consent_decision`.
        consent_decision(request_access(app))?;

        let locator = Geolocator::new().map_err(fail)?;
        locator
            .SetDesiredAccuracy(PositionAccuracy::High)
            .map_err(fail)?;
        // A fresh fix only (maximum age 0), like the browser collector, within 15 s.
        let fix = locator
            .GetGeopositionAsyncWithAgeAndTimeout(
                TimeSpan { Duration: 0 },
                TimeSpan {
                    Duration: 15 * 10_000_000,
                },
            )
            .map_err(fail)?;
        let position = bounded(fix, LOCATION_FIX_WAIT, LOCATION_UNAVAILABLE)?;
        let coordinate = position.Coordinate().map_err(fail)?;
        let point = coordinate
            .Point()
            .and_then(|point| point.Position())
            .map_err(|_| LOCATION_UNAVAILABLE)?;
        checked_location(
            point.Latitude,
            point.Longitude,
            coordinate.Accuracy().ok(),
            coordinate
                .Timestamp()
                .ok()
                .map(|timestamp| timestamp.UniversalTime),
            coordinate.PositionSource().ok().map(|source| source.0),
            coordinate.IsRemoteSource().ok(),
        )
    }

    pub fn open_location_settings() -> Result<(), &'static str> {
        tauri_plugin_opener::open_url(LOCATION_SETTINGS_URI, None::<&str>)
            .map_err(|_| LOCATION_UNAVAILABLE)
    }
}

/// Other platforms have no implementation: every reading is refused.
#[cfg(any(not(windows), test))]
mod unsupported {
    use super::*;

    pub fn wifi_connections() -> Result<Vec<WifiConnection>, &'static str> {
        Err(UNSUPPORTED_PLATFORM)
    }

    pub fn bluetooth_connected() -> Result<Vec<ConnectedBluetoothDevice>, &'static str> {
        Err(UNSUPPORTED_PLATFORM)
    }

    /// Generic over the app handle so the Windows test build can call it.
    pub fn location<App>(_app: App) -> Result<LayerLocation, &'static str> {
        Err(UNSUPPORTED_PLATFORM)
    }

    pub fn open_location_settings() -> Result<(), &'static str> {
        Err(UNSUPPORTED_PLATFORM)
    }
}

#[cfg(not(windows))]
use self::unsupported as platform;

#[cfg(test)]
mod tests {
    use super::*;

    fn ssid(bytes: &[u8]) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[..bytes.len()].copy_from_slice(bytes);
        out
    }

    fn connection(name: &str, bssid: &str) -> WifiConnection {
        WifiConnection {
            ssid: name.into(),
            ssid_hex: hex::encode(name),
            bssid: bssid.into(),
        }
    }

    const AP: [u8; 6] = [0x00, 0x1a, 0x7d, 0xda, 0x3f, 0xa1];

    #[test]
    fn bssid_is_uppercase_colon_separated() {
        assert_eq!(format_bssid(&AP), "00:1A:7D:DA:3F:A1");
        assert_eq!(
            format_bssid(&[0xab, 0xcd, 0xef, 0x01, 0x23, 0x45]),
            "AB:CD:EF:01:23:45"
        );
        assert!(usable_bssid(&AP));
        assert!(
            !usable_bssid(&[0; 6]),
            "an all-zero BSSID is a redacted reading"
        );
        assert!(
            !usable_bssid(&[0xFF; 6]),
            "broadcast is not an access point"
        );
    }

    #[test]
    fn ssid_bytes_keep_exact_hex_and_a_lossy_display_name() {
        assert_eq!(
            ssid_from_dot11(4, &ssid(b"Home")),
            Some(("Home".into(), "486f6d65".into()))
        );
        // Non-UTF-8 bytes: the hex is exact, the display name is lossy.
        let (name, hex) = ssid_from_dot11(3, &ssid(&[0xff, 0xfe, 0x41])).unwrap();
        assert_eq!(hex, "fffe41");
        assert_eq!(name, "\u{FFFD}\u{FFFD}A");
        // Bytes past the reported length are ignored.
        assert_eq!(ssid_from_dot11(2, &ssid(b"Home")).unwrap().1, "486f");
        // The 32-byte maximum.
        let full = [b'x'; 32];
        let (name, hex) = ssid_from_dot11(32, &full).unwrap();
        assert_eq!(name.len(), 32);
        assert_eq!(hex.len(), 64);
        // Empty or oversized lengths are never a reading.
        assert_eq!(ssid_from_dot11(0, &full), None);
        assert_eq!(ssid_from_dot11(33, &full), None);
        assert_eq!(ssid_from_dot11(u32::MAX, &full), None);
    }

    #[test]
    fn wlan_access_denied_means_location_consent() {
        assert_eq!(map_wlan_error(5), LOCATION_CONSENT_REQUIRED);
        for code in [2, 87, 1062, 0x8007_0005] {
            assert_eq!(map_wlan_error(code), WIFI_UNAVAILABLE, "{code}");
        }
    }

    #[test]
    fn a_connection_reading_needs_a_live_connection_ssid_and_bssid() {
        assert_eq!(
            connection_reading(true, 4, &ssid(b"Home"), &AP),
            InterfaceReading::Connection(connection("Home", "00:1A:7D:DA:3F:A1"))
        );
        assert_eq!(
            connection_reading(false, 4, &ssid(b"Home"), &AP),
            InterfaceReading::Unusable
        );
        assert_eq!(
            connection_reading(true, 0, &ssid(b""), &AP),
            InterfaceReading::Unusable
        );
        assert_eq!(
            connection_reading(true, 4, &ssid(b"Home"), &[0; 6]),
            InterfaceReading::Unusable
        );
    }

    #[test]
    fn wifi_summary_fails_closed_and_is_never_empty() {
        let home = connection("Home", "00:1A:7D:DA:3F:A1");
        let office = connection("Office", "AA:BB:CC:DD:EE:FF");
        assert_eq!(summarize_wifi(0, vec![]), Err(WIFI_UNAVAILABLE));
        assert_eq!(summarize_wifi(2, vec![]), Err(NOT_CONNECTED));
        assert_eq!(
            summarize_wifi(1, vec![InterfaceReading::Denied]),
            Err(LOCATION_CONSENT_REQUIRED)
        );
        assert_eq!(
            summarize_wifi(
                2,
                vec![InterfaceReading::Denied, InterfaceReading::Unusable]
            ),
            Err(LOCATION_CONSENT_REQUIRED)
        );
        assert_eq!(
            summarize_wifi(1, vec![InterfaceReading::Unusable]),
            Err(WIFI_UNAVAILABLE)
        );
        assert_eq!(
            summarize_wifi(
                3,
                vec![
                    InterfaceReading::Connection(home.clone()),
                    InterfaceReading::Unusable,
                    InterfaceReading::Connection(home.clone()),
                    InterfaceReading::Connection(office.clone()),
                ]
            ),
            Ok(vec![home, office])
        );
        // Eight distinct connections is the most the client accepts.
        let many = |count: u8| {
            (0..count)
                .map(|n| {
                    InterfaceReading::Connection(connection(
                        &format!("Net{n}"),
                        &format!("AA:BB:CC:DD:EE:{n:02X}"),
                    ))
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(summarize_wifi(8, many(8)).map(|list| list.len()), Ok(8));
        assert_eq!(summarize_wifi(9, many(9)), Err(WIFI_UNAVAILABLE));
    }

    #[test]
    fn bluetooth_addresses_are_48_bit_uppercase_hex() {
        assert_eq!(format_bt_address(0x001A_7DDA_7113), "001A7DDA7113");
        assert_eq!(format_bt_address(0xFFFF_001A_7DDA_7113), "001A7DDA7113");
        assert_eq!(format_bt_address(0xab), "0000000000AB");
    }

    #[test]
    fn bluetooth_names_are_trimmed_bounded_and_never_empty() {
        let raw = |text: &str| {
            let mut units: Vec<u16> = text.encode_utf16().collect();
            units.resize(248, 0);
            units
        };
        assert_eq!(bt_device_name(&raw("  Pixel 9  ")), "Pixel 9");
        assert_eq!(bt_device_name(&raw("Pixel\u{7}9")), "Pixel9");
        assert_eq!(bt_device_name(&raw("")), UNNAMED_DEVICE);
        assert_eq!(bt_device_name(&raw("   ")), UNNAMED_DEVICE);
        assert_eq!(bt_device_name(&[]), UNNAMED_DEVICE);
        assert_eq!(bt_device_name(&raw(&"a".repeat(100))), "a".repeat(64));
        // 63 units plus a surrogate pair would be 65: the pair is not split.
        let name = bt_device_name(&raw(&format!("{}\u{1F600}", "a".repeat(63))));
        assert_eq!(name, "a".repeat(63));
        // Text after an embedded NUL is ignored.
        assert_eq!(bt_device_name(&raw("Pixel\u{0}hidden")), "Pixel");
    }

    #[test]
    fn only_connected_devices_with_an_address_are_listed_once() {
        let devices = connected_devices(vec![
            (0x001A_7DDA_7113, "Pixel 9".to_string(), true),
            (0x0022_3344_5566, "Old headset".to_string(), false),
            (0, "Ghost".to_string(), true),
            (0x001A_7DDA_7113, "Pixel 9 again".to_string(), true),
        ]);
        assert_eq!(
            devices,
            vec![ConnectedBluetoothDevice {
                id: "001A7DDA7113".into(),
                name: "Pixel 9".into(),
                kind: "classic",
            }]
        );
        assert!(connected_devices(Vec::new()).is_empty());
    }

    #[test]
    fn windows_timestamps_convert_to_unix_ms() {
        // 2026-10-13T12:00:00Z, the spec's example signedAt.
        let ms = 1_791_892_800_000_i64;
        assert_eq!(
            filetime_to_unix_ms(UNIX_EPOCH_TICKS + ms * 10_000),
            Some(ms)
        );
        assert_eq!(
            filetime_to_unix_ms(UNIX_EPOCH_TICKS + ms * 10_000 + 9_999),
            Some(ms)
        );
        assert_eq!(filetime_to_unix_ms(UNIX_EPOCH_TICKS), None);
        assert_eq!(filetime_to_unix_ms(0), None);
        assert_eq!(filetime_to_unix_ms(i64::MIN), None);
    }

    #[test]
    fn waits_end_on_completion_error_or_deadline() {
        let step = Duration::from_millis(1);
        // Finishes on the third poll.
        let mut polls = 0;
        assert_eq!(
            wait_with_deadline(
                || {
                    polls += 1;
                    Ok::<_, ()>(polls == 3)
                },
                Duration::from_secs(5),
                step
            ),
            Ok(true)
        );
        assert_eq!(polls, 3);
        // An error ends the wait at once.
        assert_eq!(
            wait_with_deadline(|| Err::<bool, _>("failed"), Duration::from_secs(5), step),
            Err("failed")
        );
        // Never finished: gives up after the limit instead of blocking forever.
        let started = Instant::now();
        assert_eq!(
            wait_with_deadline(|| Ok::<_, ()>(false), Duration::from_millis(30), step),
            Ok(false)
        );
        assert!(started.elapsed() >= Duration::from_millis(30));
        assert!(started.elapsed() < Duration::from_secs(5));
        // A zero limit still checks once.
        assert_eq!(
            wait_with_deadline(|| Ok::<_, ()>(true), Duration::ZERO, step),
            Ok(true)
        );
        assert!(
            LOCATION_FIX_WAIT > Duration::from_secs(15),
            "the hard stop must outlast Windows' own 15 s timeout"
        );
    }

    #[test]
    fn winrt_access_denied_means_location_consent() {
        assert_eq!(
            map_location_error(E_ACCESSDENIED),
            LOCATION_CONSENT_REQUIRED
        );
        assert_eq!(
            map_location_error(0x8000_4005_u32 as i32),
            LOCATION_UNAVAILABLE
        );
        assert_eq!(
            map_location_error(0x8000_000E_u32 as i32),
            LOCATION_UNAVAILABLE
        );
    }

    #[test]
    fn consent_stops_on_anything_but_allowed_and_failures_defer_to_the_fix() {
        assert_eq!(consent_decision(ConsentAnswer::Allowed), Ok(()));
        assert_eq!(
            consent_decision(ConsentAnswer::NotAllowed),
            Err(LOCATION_CONSENT_REQUIRED)
        );
        assert_eq!(
            consent_decision(ConsentAnswer::NoAnswer),
            Err(LOCATION_CONSENT_REQUIRED)
        );
        assert_eq!(
            consent_decision(ConsentAnswer::Failed(E_ACCESSDENIED)),
            Err(LOCATION_CONSENT_REQUIRED)
        );
        // A request that could not run (wrong thread, no event loop, E_FAIL)
        // only skips the prompt: Windows still refuses a fix without consent,
        // and the fix is still checked.
        for code in [0x8001_010E_u32 as i32, E_FAIL, 0x8000_000E_u32 as i32] {
            assert_eq!(
                consent_decision(ConsentAnswer::Failed(code)),
                Ok(()),
                "{code:#x}"
            );
        }
    }

    /// A fix in every other respect valid, from `source` with `remote`.
    fn fix_from(source: Option<i32>, remote: Option<bool>) -> Result<LayerLocation, &'static str> {
        let at = UNIX_EPOCH_TICKS + 1_791_892_800_000 * 10_000;
        checked_location(48.8566, 2.3522, Some(35.0), Some(at), source, remote)
    }

    #[test]
    fn only_a_fix_measured_on_this_computer_is_a_reading() {
        // The device's own satellite, Wi-Fi or cellular measurement.
        for source in [SOURCE_SATELLITE, SOURCE_WIFI, SOURCE_CELLULAR] {
            assert!(measured_on_device(Some(source), Some(false)), "{source}");
            assert!(fix_from(Some(source), Some(false)).is_ok(), "{source}");
        }
        // The hand-typed default location, a coarse position, an IP estimate,
        // an unknown, unrecognised or unreadable source: never a reading, even
        // with accuracy and a timestamp, and never `accuracy-unknown` instead.
        for source in [
            Some(SOURCE_DEFAULT),
            Some(SOURCE_OBFUSCATED),
            Some(SOURCE_IP_ADDRESS),
            Some(SOURCE_UNKNOWN),
            Some(7),
            Some(-1),
            None,
        ] {
            assert!(!measured_on_device(source, Some(false)), "{source:?}");
            assert_eq!(
                fix_from(source, Some(false)),
                Err(LOCATION_UNAVAILABLE),
                "{source:?}"
            );
        }
        // A fix redirected from a Remote Desktop client, or a remote flag that
        // cannot be read (before Windows 11), is refused for every source.
        for source in [
            SOURCE_SATELLITE,
            SOURCE_WIFI,
            SOURCE_CELLULAR,
            SOURCE_DEFAULT,
        ] {
            for remote in [Some(true), None] {
                assert!(
                    !measured_on_device(Some(source), remote),
                    "{source} {remote:?}"
                );
                assert_eq!(fix_from(Some(source), remote), Err(LOCATION_UNAVAILABLE));
            }
        }
        // The source is checked before accuracy, so a default location with
        // unknown accuracy still reads as not measured.
        let at = UNIX_EPOCH_TICKS + 1_791_892_800_000 * 10_000;
        assert_eq!(
            checked_location(48.8, 2.3, None, Some(at), Some(SOURCE_DEFAULT), Some(false)),
            Err(LOCATION_UNAVAILABLE)
        );
    }

    #[cfg(windows)]
    #[test]
    fn position_source_constants_match_winrt() {
        use windows::Devices::Geolocation::PositionSource;
        assert_eq!(PositionSource::Cellular.0, SOURCE_CELLULAR);
        assert_eq!(PositionSource::Satellite.0, SOURCE_SATELLITE);
        assert_eq!(PositionSource::WiFi.0, SOURCE_WIFI);
        assert_eq!(PositionSource::IPAddress.0, SOURCE_IP_ADDRESS);
        assert_eq!(PositionSource::Unknown.0, SOURCE_UNKNOWN);
        assert_eq!(PositionSource::Default.0, SOURCE_DEFAULT);
        assert_eq!(PositionSource::Obfuscated.0, SOURCE_OBFUSCATED);
    }

    #[test]
    fn a_fix_needs_known_accuracy_valid_coordinates_and_a_timestamp() {
        let at = UNIX_EPOCH_TICKS + 1_791_892_800_000 * 10_000;
        let checked_location = |lat, lng, accuracy, ticks| {
            checked_location(lat, lng, accuracy, ticks, Some(SOURCE_WIFI), Some(false))
        };
        assert_eq!(
            checked_location(48.8566, 2.3522, Some(35.0), Some(at)),
            Ok(LayerLocation {
                lat: 48.8566,
                lng: 2.3522,
                accuracy_m: 35.0,
                at: 1_791_892_800_000,
            })
        );
        for accuracy in [
            None,
            Some(0.0),
            Some(-0.0),
            Some(-5.0),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            assert_eq!(
                checked_location(48.8, 2.3, accuracy, Some(at)),
                Err(ACCURACY_UNKNOWN),
                "{accuracy:?}"
            );
        }
        for (lat, lng) in [
            (f64::NAN, 2.3),
            (48.8, f64::INFINITY),
            (90.1, 2.3),
            (-90.1, 2.3),
            (48.8, 180.1),
            (48.8, -180.1),
        ] {
            assert_eq!(
                checked_location(lat, lng, Some(35.0), Some(at)),
                Err(LOCATION_UNAVAILABLE)
            );
        }
        assert_eq!(
            checked_location(48.8, 2.3, Some(35.0), None),
            Err(LOCATION_UNAVAILABLE)
        );
        assert_eq!(
            checked_location(48.8, 2.3, Some(35.0), Some(0)),
            Err(LOCATION_UNAVAILABLE)
        );
        // The poles and the antimeridian are valid coordinates.
        assert!(checked_location(90.0, 180.0, Some(10.0), Some(at)).is_ok());
        assert!(checked_location(-90.0, -180.0, Some(10.0), Some(at)).is_ok());
    }

    #[test]
    fn readings_serialize_with_the_contract_field_names() {
        let wifi = serde_json::to_value(connection("Home", "00:1A:7D:DA:3F:A1")).unwrap();
        assert_eq!(
            wifi,
            serde_json::json!({ "ssid": "Home", "ssidHex": "486f6d65", "bssid": "00:1A:7D:DA:3F:A1" })
        );
        let device = serde_json::to_value(
            &connected_devices(vec![(0x001A_7DDA_7113, "Pixel 9".into(), true)])[0],
        )
        .unwrap();
        assert_eq!(
            device,
            serde_json::json!({ "id": "001A7DDA7113", "name": "Pixel 9", "kind": "classic" })
        );
        let fix = checked_location(
            48.8566,
            2.3522,
            Some(35.0),
            Some(UNIX_EPOCH_TICKS + 1_791_892_795_000 * 10_000),
            Some(SOURCE_SATELLITE),
            Some(false),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(fix).unwrap(),
            serde_json::json!({ "lat": 48.8566, "lng": 2.3522, "accuracyM": 35.0, "at": 1_791_892_795_000_i64 })
        );
    }

    #[test]
    fn stubs_refuse_every_reading() {
        assert_eq!(unsupported::wifi_connections(), Err(UNSUPPORTED_PLATFORM));
        assert_eq!(
            unsupported::bluetooth_connected(),
            Err(UNSUPPORTED_PLATFORM)
        );
        assert_eq!(unsupported::location(()), Err(UNSUPPORTED_PLATFORM));
        assert_eq!(
            unsupported::open_location_settings(),
            Err(UNSUPPORTED_PLATFORM)
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn commands_are_unsupported_off_windows() {
        use tauri::async_runtime::block_on as block;
        assert_eq!(
            block(layer_wifi_connections()),
            Err(UNSUPPORTED_PLATFORM.to_string())
        );
        assert_eq!(
            block(layer_bluetooth_connected()),
            Err(UNSUPPORTED_PLATFORM.to_string())
        );
        // layer_location needs an app handle; it runs the same stub.
        assert_eq!(
            block(run_blocking(
                || platform::location(()),
                LOCATION_UNAVAILABLE
            )),
            Err(UNSUPPORTED_PLATFORM.to_string())
        );
        assert_eq!(
            block(open_location_settings()),
            Err(UNSUPPORTED_PLATFORM.to_string())
        );
    }
}
