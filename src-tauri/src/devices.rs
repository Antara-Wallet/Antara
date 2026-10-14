//! Presence/location factors for the vault policy layers.
//!
//! - Bluetooth: enumerate paired/connected devices via the Win32 Bluetooth API.
//! - Geo: read the current coordinate via the WinRT Geolocation API.
//!
//! These report LIVE state; the registered identity + the rule live server-side
//! in the vault policy. The co-signer decides; the client just reports readings.

use serde::Serialize;

#[derive(Serialize)]
pub struct BtDevice {
    pub id: String, // 48-bit address, uppercase hex (stable per device)
    pub name: String,
    pub connected: bool,
}

#[derive(Serialize)]
pub struct GeoPos {
    pub lat: f64,
    pub lng: f64,
    pub accuracy_m: f64,
}

/// Paired / remembered / connected Bluetooth devices. We do NOT issue an inquiry
/// (slow radio scan); a proximity device is "present" when it is connected.
#[tauri::command]
#[cfg(windows)]
pub fn list_bluetooth_devices() -> Vec<BtDevice> {
    use windows::Win32::Devices::Bluetooth::{
        BluetoothFindDeviceClose, BluetoothFindFirstDevice, BluetoothFindNextDevice,
        BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS,
    };
    use windows::Win32::Foundation::{BOOL, HANDLE};

    let mut out = Vec::new();
    unsafe {
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

        let mut info = BLUETOOTH_DEVICE_INFO {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
            ..Default::default()
        };

        let hfind = match BluetoothFindFirstDevice(&params, &mut info) {
            Ok(h) => h,
            Err(_) => return out,
        };

        loop {
            let addr = info.Address.Anonymous.ullLong;
            let name = String::from_utf16_lossy(&info.szName);
            let name = name.trim_end_matches('\0').trim().to_string();
            out.push(BtDevice {
                id: format!("{:012X}", addr),
                name: if name.is_empty() { "Unknown device".into() } else { name },
                connected: info.fConnected.as_bool(),
            });

            info = BLUETOOTH_DEVICE_INFO {
                dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
                ..Default::default()
            };
            if BluetoothFindNextDevice(hfind, &mut info).is_err() {
                break;
            }
        }
        let _ = BluetoothFindDeviceClose(hfind);
    }
    out
}

#[cfg_attr(not(windows), allow(dead_code))]
const NOT_MEASURED: &str = "location unavailable: Windows returned its default, approximate, IP-based or redirected location, not one measured by this computer";

/// Current coordinate via Windows location services. Requires location access to
/// be enabled for desktop apps; returns an error string otherwise.
///
/// LEGACY (ARK presence factors only). It must never feed a vault layer: it is
/// a sync command (it runs on the main thread and blocks it until Windows
/// answers, with no timeout) and never asks for consent. Vault layers use
/// `layers::layer_location`.
#[tauri::command]
#[cfg(windows)]
pub fn get_location() -> Result<GeoPos, String> {
    use windows::Devices::Geolocation::Geolocator;

    let locator = Geolocator::new().map_err(|e| e.message())?;
    let pos = locator
        .GetGeopositionAsync()
        .map_err(|e| e.message())?
        .get()
        .map_err(|e| format!("location unavailable: {}", e.message()))?;
    let coord = pos.Coordinate().map_err(|e| e.message())?;
    // The same rule as the vault layer: the default location, a coarse or
    // IP-based estimate, or a Remote Desktop redirect is not a reading.
    if !crate::layers::measured_on_device(
        coord.PositionSource().ok().map(|source| source.0),
        coord.IsRemoteSource().ok(),
    ) {
        return Err(NOT_MEASURED.into());
    }
    let point = coord.Point().map_err(|e| e.message())?;
    let basic = point.Position().map_err(|e| e.message())?;
    let accuracy = known_accuracy(coord.Accuracy().ok())?;
    Ok(GeoPos {
        lat: basic.Latitude,
        lng: basic.Longitude,
        accuracy_m: accuracy,
    })
}

/// Unknown accuracy is an error, never a default: 0.0 would read as a perfect
/// fix and pass any accuracy rule (fail-open). Vault layers use `layer_location`.
#[cfg_attr(not(windows), allow(dead_code))]
fn known_accuracy(accuracy: Option<f64>) -> Result<f64, String> {
    match accuracy {
        Some(value) if value.is_finite() && value > 0.0 => Ok(value),
        _ => Err("location accuracy unknown".into()),
    }
}

// These legacy presence factors currently have Windows implementations only.
// Reject unsupported reads rather than inventing a successful security signal.
#[tauri::command]
#[cfg(not(windows))]
pub fn list_bluetooth_devices() -> Result<Vec<BtDevice>, String> {
    Err("Native Bluetooth presence is currently supported only on Windows.".into())
}

#[tauri::command]
#[cfg(not(windows))]
pub fn get_location() -> Result<GeoPos, String> {
    Err("Native location is currently supported only on Windows.".into())
}

#[cfg(all(test, not(windows)))]
mod tests {
    #[test]
    fn unsupported_presence_factors_fail_closed() {
        assert!(super::list_bluetooth_devices().is_err());
        assert!(super::get_location().is_err());
    }
}

#[cfg(test)]
mod accuracy_tests {
    use super::known_accuracy;

    #[test]
    fn legacy_location_never_reports_zero_or_unknown_accuracy() {
        for unknown in [None, Some(0.0), Some(-0.0), Some(-1.0), Some(f64::NAN), Some(f64::INFINITY)] {
            assert!(known_accuracy(unknown).is_err(), "{unknown:?}");
        }
        assert_eq!(known_accuracy(Some(35.0)), Ok(35.0));
    }
}
