#!/bin/sh
set -eu
cd "$(dirname "$0")"
server=../../packages/shared/src/_generated
android=../../apps/mobile/modules/t3-native-controls/android/src/main/jniLibs
hashes() {
  find src -type f -exec shasum -a 256 {} + | LC_ALL=C sort -k2
  shasum -a 256 Cargo.toml Cargo.lock build-bindings.sh "$@"
}
if [ "${1:-}" = check ]; then
  hashes "$server"/noise.* | diff -u server.sha256 -
  hashes "$android"/*/libt3_connect_noise.so | diff -u android.sha256 -
  exit 0
fi
# Keep the build machine's registry and checkout paths out of shipped binaries.
sep=$(printf '\037')
cargo_root=${CARGO_HOME:-"$HOME/.cargo"}
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$cargo_root=/cargo${sep}--remap-path-prefix=$(cd "$cargo_root" && pwd -P)=/cargo${sep}--remap-path-prefix=$(pwd -P)=/t3/connect-noise"
case ${1:-} in
  server)
    cargo build --locked --release --lib --target wasm32-unknown-unknown
    wasm-bindgen --target web --omit-default-module-path --out-name noise --out-dir target/server-bindings target/wasm32-unknown-unknown/release/t3_connect_noise.wasm
    mkdir -p "$server"
    cp target/server-bindings/noise.js target/server-bindings/noise.d.ts "$server/"
    node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs";writeFileSync(process.argv[1], JSON.stringify(readFileSync("target/server-bindings/noise_bg.wasm").toString("base64"))+"\n")' "$server/noise.json"
    (cd ../.. && ./vp fmt packages/shared/src/_generated/noise.js packages/shared/src/_generated/noise.d.ts)
    hashes "$server"/noise.* > server.sha256
    ;;
  android)
    : "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to the Android NDK directory}"
    case "$(uname -s)" in Darwin) platform=darwin-x86_64;; Linux) platform=linux-x86_64;; *) exit 1;; esac
    bin="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$platform/bin"
    for pair in arm64-v8a:aarch64-linux-android armeabi-v7a:armv7-linux-androideabi x86:i686-linux-android x86_64:x86_64-linux-android; do
      abi=${pair%:*}
      target=${pair#*:}
      clang=$target
      if [ "$abi" = armeabi-v7a ]; then clang=armv7a-linux-androideabi; fi
      rustup target add "$target"
      key=$(echo "$target" | tr '[:lower:]-' '[:upper:]_')
      env "CARGO_TARGET_${key}_LINKER=$bin/${clang}24-clang" CARGO_ENCODED_RUSTFLAGS="$CARGO_ENCODED_RUSTFLAGS${sep}-Clink-arg=-Wl,-z,max-page-size=16384" cargo build --locked --release --lib --target "$target"
      mkdir -p "$android/$abi"
      "$bin/llvm-strip" -o "$android/$abi/libt3_connect_noise.so" "target/$target/release/libt3_connect_noise.so"
    done
    hashes "$android"/*/libt3_connect_noise.so > android.sha256
    ;;
  *) echo "usage: build-bindings.sh server|android|check" >&2; exit 2;;
esac
