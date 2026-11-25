use crate::NoisePeer;
use jni::{
    JNIEnv,
    objects::{JByteArray, JObject, JString},
    sys::{jboolean, jbyteArray, jlong},
};
use std::{
    collections::HashMap,
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicI64, Ordering},
    },
};

// JS never owns a Rust pointer; a stale handle after reload or release simply fails.
static PEERS: LazyLock<Mutex<HashMap<i64, NoisePeer>>> = LazyLock::new(Default::default);
static NEXT: AtomicI64 = AtomicI64::new(1);

fn finish<T: Default>(env: &mut JNIEnv, result: Result<T, String>) -> T {
    result.unwrap_or_else(|reason| {
        let _ = env.throw_new("java/lang/IllegalStateException", reason);
        T::default()
    })
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_t3nativecontrols_T3Noise_open(
    mut env: JNIEnv,
    _: JObject,
    environment: JString,
    pin: JByteArray,
) -> jlong {
    let result = (|| {
        let environment: String = env
            .get_string(&environment)
            .map_err(|e| e.to_string())?
            .into();
        let pin = env.convert_byte_array(pin).map_err(|e| e.to_string())?;
        let peer = NoisePeer::client(&environment, &pin)?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        PEERS
            .lock()
            .map_err(|_| "Noise registry unavailable")?
            .insert(id, peer);
        Ok(id)
    })();
    finish(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_t3nativecontrols_T3Noise_record(
    mut env: JNIEnv,
    _: JObject,
    id: jlong,
    bytes: JByteArray,
    writing: jboolean,
) -> jbyteArray {
    let result = (|| {
        let len = env.get_array_length(&bytes).map_err(|e| e.to_string())?;
        let mut peers = PEERS.lock().map_err(|_| "Noise registry unavailable")?;
        if len > 65_535 {
            peers.remove(&id);
            return Err("Noise record too large".to_owned());
        }
        let data = env.convert_byte_array(bytes).map_err(|e| e.to_string())?;
        let peer = peers.get_mut(&id).ok_or("Noise peer is closed")?;
        let output = if writing != 0 {
            peer.write(&data)?
        } else {
            peer.read(&data)?
        };
        drop(peers);
        env.byte_array_from_slice(&output)
            .map(|a| a.into_raw())
            .map_err(|e| e.to_string())
    })();
    finish(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_t3nativecontrols_T3Noise_close(
    _: JNIEnv,
    _: JObject,
    id: jlong,
) {
    if let Ok(mut peers) = PEERS.lock() {
        peers.remove(&id);
    }
}
