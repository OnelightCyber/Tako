use std::io::Write;
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};

const STALL: Duration = Duration::from_secs(30);

pub struct Asset {
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

impl Asset {
    pub fn present(&self, dir: &Path) -> bool {
        std::fs::metadata(dir.join(self.file)).map(|m| m.len() == self.size).unwrap_or(false)
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn fetch(asset: &Asset, dir: &Path, mut progress: impl FnMut(u64)) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = dir.join(asset.file);
    let part = dir.join(format!("{}.part", asset.file));
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let mut response = tokio::time::timeout(STALL, client.get(asset.url).send())
        .await
        .map_err(|_| "stalled".to_string())?
        .map_err(|_| "offline".to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    loop {
        let next = match tokio::time::timeout(STALL, response.chunk()).await {
            Ok(next) => next,
            Err(_) => {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err("stalled".into());
            }
        };
        let chunk = match next {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err("offline".into());
            }
        };
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        progress(received);
        if received > asset.size {
            break;
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if received != asset.size || hex(&hasher.finalize()) != asset.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err("corrupt".into());
    }
    std::fs::rename(&part, &target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digests_are_lowercase_hex() {
        assert_eq!(hex(&[0x00, 0xab, 0x7f]), "00ab7f");
        assert_eq!(hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
