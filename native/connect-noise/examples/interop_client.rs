use std::{env, error::Error};
use t3_connect_noise::NoisePeer;
use tungstenite::{Message, client::connect_with_config, protocol::WebSocketConfig};

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let url = args.next().ok_or("missing interop WebSocket URL")?;
    let pin = hex::decode(args.next().ok_or("missing host public key")?)?;
    let mut peer = NoisePeer::client("interop", &pin)?;
    let config = WebSocketConfig::default()
        .max_frame_size(Some(65_535))
        .max_message_size(Some(65_535));
    let (mut socket, _) = connect_with_config(url.as_str(), Some(config), 0)?;
    let mut exchange = |plaintext: &[u8]| -> Result<Vec<u8>, Box<dyn Error>> {
        socket.send(Message::binary(peer.write(plaintext)?))?;
        let Message::Binary(record) = socket.read()? else {
            return Err("expected a binary Noise record".into());
        };
        Ok(peer.read(&record)?)
    };
    let challenge = exchange(&[])?;
    let compressed = exchange(&challenge)?;
    let snapshot = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&compressed, 65_519)
        .map_err(|_| "invalid test snapshot")?;
    if !exchange(&snapshot)?.is_empty() {
        return Err("expected empty acknowledgement".into());
    }
    socket.close(None)?;
    Ok(())
}
