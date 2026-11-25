use t3_connect_noise::NoisePeer;

fn host_key() -> snow::Keypair {
    snow::Builder::new("Noise_NK_25519_ChaChaPoly_SHA256".parse().unwrap())
        .generate_keypair()
        .unwrap()
}

fn connected(key: &snow::Keypair) -> (NoisePeer, NoisePeer) {
    let mut client = NoisePeer::client("test", &key.public).unwrap();
    let mut host = NoisePeer::server("test", &key.private).unwrap();
    assert!(host.read(&client.write(b"").unwrap()).unwrap().is_empty());
    assert_eq!(
        client.read(&host.write(b"challenge").unwrap()).unwrap(),
        b"challenge"
    );
    (client, host)
}

#[test]
fn binds_the_environment_and_host_key_before_any_client_payload() {
    let key = host_key();
    for (environment, pin) in [("other", key.public.clone()), ("test", host_key().public)] {
        let mut client = NoisePeer::client(environment, &pin).unwrap();
        let mut host = NoisePeer::server("test", &key.private).unwrap();
        assert!(host.read(&client.write(b"").unwrap()).is_err());
        assert!(host.write(b"challenge").is_err());
    }
    let mut client = NoisePeer::client("test", &key.public).unwrap();
    assert!(client.write(b"credential").is_err());
    assert!(NoisePeer::client("test", &[0; 32]).is_err());

    let mut early_sender = snow::Builder::new("Noise_NK_25519_ChaChaPoly_SHA256".parse().unwrap())
        .remote_public_key(&key.public)
        .unwrap()
        .prologue(b"t3-connect-e2ee/v1\0test")
        .unwrap()
        .build_initiator()
        .unwrap();
    let mut hello = [0; 64];
    let len = early_sender
        .write_message(b"too early", &mut hello)
        .unwrap();
    let mut host = NoisePeer::server("test", &key.private).unwrap();
    assert!(host.read(&hello[..len]).is_err());
    assert!(host.write(b"challenge").is_err());
}

#[test]
fn a_corrupt_replayed_or_reordered_record_closes_the_reader() {
    let key = host_key();
    let (mut client, mut host) = connected(&key);
    let record = client.write(b"one").unwrap();
    assert_eq!(host.read(&record).unwrap(), b"one");
    assert!(host.read(&record).is_err());
    assert!(host.read(&client.write(b"two").unwrap()).is_err());

    let (mut client, mut host) = connected(&key);
    let current = client.write(b"one").unwrap();
    assert_ne!(record, current);
    assert!(host.read(&record).is_err());
    assert!(host.read(&current).is_err());

    let (mut client, mut host) = connected(&key);
    let original = client.write(b"message").unwrap();
    let mut corrupt = original.clone();
    corrupt[0] ^= 1;
    assert!(host.read(&corrupt).is_err());
    assert!(host.read(&original).is_err());

    let (mut client, mut host) = connected(&key);
    let first = host.write(b"one").unwrap();
    let second = host.write(b"two").unwrap();
    assert!(client.read(&second).is_err());
    assert!(client.read(&first).is_err());
}

#[test]
fn accepts_binary_up_to_the_noise_record_limit() {
    let (mut client, mut host) = connected(&host_key());
    let payload = vec![0xff; 65_535 - 16];
    let record = host.write(&payload).unwrap();
    assert_eq!(record.len(), 65_535);
    assert_eq!(client.read(&record).unwrap(), payload);
    assert!(host.write(&vec![0; payload.len() + 1]).is_err());
}
