#[cfg(target_os = "android")]
mod android;

use curve25519_dalek::{montgomery::MontgomeryPoint, traits::IsIdentity};
use snow::{Builder, HandshakeState, TransportState};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

const SUITE: &str = "Noise_NK_25519_ChaChaPoly_SHA256";
const MAX_RECORD: usize = 65_535;
const TAG: usize = 16;
const NK_HANDSHAKE_OVERHEAD: usize = 32 + TAG;

fn builder() -> Builder<'static> {
    Builder::new(SUITE.parse().expect("fixed Noise suite"))
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn host_public_key(private: &[u8]) -> Result<Vec<u8>, String> {
    let scalar = private.try_into().map_err(|_| "invalid host key length")?;
    Ok(MontgomeryPoint::mul_base_clamped(scalar)
        .to_bytes()
        .to_vec())
}

fn check_public_key(key: &[u8]) -> Result<(), String> {
    let bytes: [u8; 32] = key.try_into().map_err(|_| "invalid X25519 key length")?;
    // Multiplication by the cofactor rejects low-order points on Curve25519 and its twist.
    if MontgomeryPoint(bytes)
        .mul_bits_be([true, false, false, false].into_iter())
        .is_identity()
    {
        return Err("invalid X25519 public key".into());
    }
    Ok(())
}

enum State {
    Handshake(Box<HandshakeState>),
    Transport(TransportState),
}

/// One ordered, reliable connection. Authentication of the device belongs above this layer.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct NoisePeer {
    state: Option<State>,
}

impl NoisePeer {
    fn new(environment: &str, key: &[u8], initiator: bool) -> Result<Self, String> {
        if environment.is_empty() || key.len() != 32 {
            return Err("invalid environment or key".into());
        }
        let prologue = format!("t3-connect-e2ee/v1\0{environment}");
        let builder = builder()
            .prologue(prologue.as_bytes())
            .map_err(|e| e.to_string())?;
        let handshake = if initiator {
            check_public_key(key)?;
            builder
                .remote_public_key(key)
                .and_then(Builder::build_initiator)
        } else {
            builder
                .local_private_key(key)
                .and_then(Builder::build_responder)
        }
        .map_err(|e| e.to_string())?;
        Ok(Self {
            state: Some(State::Handshake(Box::new(handshake))),
        })
    }

    fn record(&mut self, input: &[u8], writing: bool) -> Result<Vec<u8>, String> {
        // A bad tag or out-of-order record permanently closes this peer.
        let mut state = self.state.take().ok_or("Noise peer is closed")?;
        let overhead = match &state {
            State::Handshake(_) => NK_HANDSHAKE_OVERHEAD,
            State::Transport(_) => TAG,
        };
        let size = if writing {
            input
                .len()
                .checked_add(overhead)
                .filter(|n| *n <= MAX_RECORD)
        } else {
            input
                .len()
                .checked_sub(overhead)
                .filter(|_| input.len() <= MAX_RECORD)
        }
        .ok_or("invalid Noise record length")?;
        let mut out = vec![0; size];
        let len = match &mut state {
            State::Handshake(handshake) => {
                if !writing {
                    // In NK each handshake message begins with the sender's ephemeral public key.
                    check_public_key(&input[..32])?;
                }
                let first_message = handshake.is_initiator() == writing;
                let has_payload = if writing {
                    !input.is_empty()
                } else {
                    size != 0
                };
                if first_message && has_payload {
                    return Err("NK hello must have an empty payload".into());
                }
                if writing {
                    handshake.write_message(input, &mut out)
                } else {
                    handshake.read_message(input, &mut out)
                }
            }
            State::Transport(transport) => {
                if writing {
                    transport.write_message(input, &mut out)
                } else {
                    transport.read_message(input, &mut out)
                }
            }
        }
        .map_err(|_| "Noise record rejected")?;
        out.truncate(len);
        self.state = Some(match state {
            State::Handshake(done) if done.is_handshake_finished() => {
                State::Transport(done.into_transport_mode().map_err(|e| e.to_string())?)
            }
            other => other,
        });
        Ok(out)
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl NoisePeer {
    pub fn client(environment: &str, host_public: &[u8]) -> Result<NoisePeer, String> {
        Self::new(environment, host_public, true)
    }

    pub fn server(environment: &str, host_private: &[u8]) -> Result<NoisePeer, String> {
        Self::new(environment, host_private, false)
    }

    pub fn write(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        self.record(plaintext, true)
    }

    pub fn read(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        self.record(ciphertext, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // rweather/noise-c @ cfe25410979a87391bb9ac8d4d4bef64e9f268c6, tests/vector/noise-c-basic.txt
    #[test]
    fn matches_noise_c_handshake_and_both_transport_directions() {
        let secret =
            hex::decode("4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893")
                .unwrap();
        let ephemeral =
            hex::decode("bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b")
                .unwrap();
        let mut host = builder()
            .prologue(b"Prologue123")
            .unwrap()
            .local_private_key(&secret)
            .unwrap()
            .fixed_ephemeral_key_for_testing_only(&ephemeral)
            .build_responder()
            .unwrap();
        let hello = hex::decode("ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79448134d00711fdb390a0d178fa008f6d47f49a76e297aa164052a3d842aa8ff7d8").unwrap();
        let mut buffer = [0; 128];
        let len = host.read_message(&hello, &mut buffer).unwrap();
        assert_eq!(&buffer[..len], b"Ludwig von Mises");
        let len = host.write_message(b"Murray Rothbard", &mut buffer).unwrap();
        assert_eq!(
            hex::encode(&buffer[..len]),
            "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088438ea16e3701bc0d77744f117bee22451628b075da65d4114bd343e2d93006c4"
        );
        assert_eq!(
            hex::encode(host.get_handshake_hash()),
            "d5c4ce9ffe8bcd940aa50f842a5d4d90d3f7163f4b3916deb87a5d747712d718"
        );

        let mut peer = NoisePeer {
            state: Some(State::Transport(host.into_transport_mode().unwrap())),
        };
        let data = hex::decode("a62de29ce27cb80245d440d986ed816c156e9d757d7008df2198b0").unwrap();
        assert_eq!(peer.read(&data).unwrap(), b"F. A. Hayek");
        assert_eq!(
            hex::encode(peer.write(b"Carl Menger").unwrap()),
            "174a35f11c689f4530d7208618e0564ae12f2f50ba8eb4df5382ff"
        );
    }
}
