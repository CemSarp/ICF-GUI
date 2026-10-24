//! SHA-256 via macOS CommonCrypto (part of libSystem): no extra crate for one digest.

#[repr(C)]
struct Ctx {
    count: [u32; 2],
    hash: [u32; 8],
    wbuf: [u32; 16],
}

extern "C" {
    fn CC_SHA256_Init(c: *mut Ctx) -> i32;
    fn CC_SHA256_Update(c: *mut Ctx, data: *const u8, len: u32) -> i32;
    fn CC_SHA256_Final(md: *mut u8, c: *mut Ctx) -> i32;
}

pub struct Sha256(Ctx);

impl Default for Sha256 {
    fn default() -> Self {
        let mut c = Ctx { count: [0; 2], hash: [0; 8], wbuf: [0; 16] };
        // SAFETY: valid, exclusively borrowed context struct with CommonCrypto's layout.
        unsafe { CC_SHA256_Init(&mut c) };
        Self(c)
    }
}

impl Sha256 {
    pub fn update(&mut self, data: &[u8]) {
        for chunk in data.chunks(u32::MAX as usize) {
            // SAFETY: pointer/len describe a live slice; context initialised in `default`.
            unsafe { CC_SHA256_Update(&mut self.0, chunk.as_ptr(), chunk.len() as u32) };
        }
    }
    pub fn hex(mut self) -> String {
        let mut md = [0u8; 32];
        // SAFETY: `md` is the 32-byte digest buffer CommonCrypto expects.
        unsafe { CC_SHA256_Final(md.as_mut_ptr(), &mut self.0) };
        md.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Hash a file in 1 MiB chunks; `progress(bytes_so_far)`; `stop()` aborts early with `Interrupted`.
pub fn file(path: &std::path::Path, mut progress: impl FnMut(u64), stop: impl Fn() -> bool) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::default();
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    loop {
        if stop() {
            return Err(std::io::ErrorKind::Interrupted.into());
        }
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(h.hex());
        }
        h.update(&buf[..n]);
        done += n as u64;
        progress(done);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn known_vectors() {
        let hex = |s: &[u8]| {
            let mut h = super::Sha256::default();
            h.update(s);
            h.hex()
        };
        assert_eq!(hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let dir = std::env::temp_dir().join(format!("icfcc-sha-{}", crate::util::random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x");
        std::fs::write(&f, vec![b'a'; 3 * 1024 * 1024 + 7]).unwrap();
        let mut seen = 0;
        let h = super::file(&f, |n| seen = n, || false).unwrap();
        assert_eq!(seen, 3 * 1024 * 1024 + 7);
        let mut one = super::Sha256::default();
        one.update(&vec![b'a'; 3 * 1024 * 1024 + 7]);
        assert_eq!(h, one.hex());
        assert!(super::file(&f, |_| {}, || true).is_err(), "cancellable");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
