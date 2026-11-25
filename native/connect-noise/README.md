# Connect Noise interoperability

This standalone probe exercises `Noise_NK_25519_ChaChaPoly_SHA256` over a loopback WebSocket. The Node responder and browser clients use the Rust core compiled to WASM. The native test executable uses the same core on the target OS. Each run generates a host key and a challenge. The client verifies the pinned host, echoes the challenge in ciphertext, then decrypts and inflates a synthetic snapshot and sends its original bytes back for comparison. Device approval and application traffic are outside this probe.

## Build and run

Install workspace dependencies with `./vp i` from the repository root and use its Node version. With stable Rust and the workspace's Playwright Chromium available, run the following from this directory.

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.130
cargo test --locked
./build-bindings.sh check

node interop.mjs node
node interop.mjs chromium
node interop.mjs electron
cargo build --locked --example interop_client
node interop.mjs native 127.0.0.1 target/debug/examples/interop_client
```

The Rust tests include a published NK vector and record rejection cases. The probe reports the WASM size and the observed lengths of both Noise transport records. Each snapshot gets an independent zlib-wrapped DEFLATE stream at level 1. The receiver authenticates the record before decompression and caps its output at 65,519 bytes. WebSocket compression is disabled. [Reference vector](https://github.com/rweather/noise-c/blob/cfe25410979a87391bb9ac8d4d4bef64e9f268c6/tests/vector/noise-c-basic.txt)

## Distribution bindings

The Android, web and desktop clients and the Node server use this crate for device approval and encrypted RPC. The client and server can negotiate raw DEFLATE for large PR diff response blocks before Noise encryption. Each block has its own dictionary and a bounded decoded size. Other RPC payloads use the original encoding. Regenerate both checked-in bindings when the crate changes. With the workspace Node version, the same wasm-bindgen CLI as above and Android NDK 27.1.12297006, run:

```sh
./build-bindings.sh server
ANDROID_NDK_HOME=/path/to/ndk/27.1.12297006 ./build-bindings.sh android
./build-bindings.sh check
```

The server and the browser/desktop renderer share the embedded WASM. The renderer loads it on first encrypted connection. The Android module loads the packaged JNI library for its ABI and releases each peer when its Expo shared object is disposed. Each build records hashes of its sources, lockfile, build script and outputs. CI compares them to catch a stale or missing binding.

## Android emulator

For an arm64 emulator, set `ANDROID_SERIAL` to the selected device and `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` to the NDK's `aarch64-linux-android<API>-clang`. The emulator reaches the host's loopback listener at `10.0.2.2`.

```sh
rustup target add aarch64-linux-android
cargo build --locked --release --target aarch64-linux-android --example interop_client
device_binary=$(adb -s "$ANDROID_SERIAL" shell mktemp /data/local/tmp/t3-noise-XXXXXX | tr -d '\r')
adb -s "$ANDROID_SERIAL" push target/aarch64-linux-android/release/examples/interop_client "$device_binary"
adb -s "$ANDROID_SERIAL" shell chmod 700 "$device_binary"
node interop.mjs native 10.0.2.2 adb -s "$ANDROID_SERIAL" shell -T "$device_binary"
adb -s "$ANDROID_SERIAL" shell rm "$device_binary"
```

## iOS simulator

On an Apple Silicon Mac with full Xcode and a booted simulator, set `IOS_SIMULATOR_UDID` to its identifier. The simulator shares the host's loopback network.

```sh
rustup target add aarch64-apple-ios-sim
cargo build --locked --release --target aarch64-apple-ios-sim --example interop_client
node interop.mjs native 127.0.0.1 xcrun simctl spawn "$IOS_SIMULATOR_UDID" "$PWD/target/aarch64-apple-ios-sim/release/examples/interop_client"
```
