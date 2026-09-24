//! Small, immutable item images. Two workers share a bounded latest-view queue;
//! no credentials, downloads or PNG parsing run in the native paint handler.
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{Cursor, Read};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use sha2::{Digest, Sha256};
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};

const MAX_BYTES: usize = 256 * 1024;
const MAX_IMAGES: usize = 96;
const MAX_VISIBLE: usize = 16;

#[derive(Debug)]
pub(crate) struct Thumbnail {
    pub width: i32,
    pub height: i32,
    /// BGRA flattened onto the launcher's #101211 item surface.
    pub pixels: Vec<u8>,
}

fn image_hash(path: &str) -> Option<&str> {
    let hash = path.strip_prefix("/trading-items/")?.strip_suffix(".png")?;
    (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(hash)
}

pub(crate) fn decode(path: &str, bytes: &[u8]) -> Result<Thumbnail, String> {
    let hash = image_hash(path).ok_or("Invalid item image path")?;
    if bytes.len() > MAX_BYTES || format!("{:x}", Sha256::digest(bytes)) != hash {
        return Err("Item image integrity check failed".into());
    }
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits { bytes: 2 * 1024 * 1024 });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| "Invalid item PNG")?;
    let info = reader.info();
    if info.width == 0 || info.width > 256 || info.height == 0 || info.height > 160 || info.animation_control.is_some() {
        return Err("Item image dimensions are unsupported".into());
    }
    let size = reader.output_buffer_size().filter(|size| *size <= 256 * 160 * 4).ok_or("Item image is too large")?;
    let mut bytes = vec![0; size];
    let info = reader.next_frame(&mut bytes).map_err(|_| "Incomplete item PNG")?;
    let channels = match info.color_type { png::ColorType::Rgba => 4, png::ColorType::Rgb => 3, _ => return Err("Unsupported item image colors".into()) };
    if info.bit_depth != png::BitDepth::Eight { return Err("Unsupported item image depth".into()); }
    let mut pixels = Vec::with_capacity(info.width as usize * info.height as usize * 4);
    for pixel in bytes[..info.buffer_size()].chunks_exact(channels) {
        let alpha = if channels == 4 { pixel[3] as u32 } else { 255 };
        for (source, background) in [(pixel[2], 17), (pixel[1], 18), (pixel[0], 16)] {
            pixels.push(((source as u32 * alpha + background * (255 - alpha) + 127) / 255) as u8);
        }
        pixels.push(255);
    }
    Ok(Thumbnail { width: info.width as i32, height: info.height as i32, pixels })
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().max_redirects(0).http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(6)))
        .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
        .build().new_agent()
}

fn download(agent: &ureq::Agent, path: &str) -> Result<Thumbnail, String> {
    image_hash(path).ok_or("Invalid item image path")?;
    // Resolve only the paired B2G origin; never forward the bearer to images.
    let origin = crate::read_launcher_credential()?.map(|c| c.api_origin).unwrap_or_else(|| crate::DEFAULT_API_ORIGIN.into());
    let endpoint = crate::api_endpoint(&origin, path)?;
    let mut response = agent.get(&endpoint).header("Accept", "image/png").call().map_err(|_| "Item image is unavailable")?;
    if response.status().as_u16() != 200 { return Err("Item image is unavailable".into()); }
    let mut bytes = Vec::new();
    response.body_mut().as_reader().take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| "Item image download interrupted")?;
    decode(path, &bytes)
}

#[derive(Debug)]
struct Entry { image: Option<Arc<Thumbnail>>, touched: u64, retry_at: Instant }
#[derive(Debug, Default)]
struct Cache {
    entries: BTreeMap<String, Entry>,
    desired: BTreeSet<String>,
    queue: VecDeque<String>,
    loading: BTreeSet<String>,
    clock: u64,
    stopped: bool,
}
impl Cache {
    fn request(&mut self, paths: &[String]) {
        if self.stopped { return; }
        self.clock += 1;
        self.desired = paths.iter().filter(|p| image_hash(p).is_some()).take(MAX_VISIBLE).cloned().collect();
        self.queue.clear();
        let now = Instant::now();
        for path in &self.desired {
            let needs_load = match self.entries.get_mut(path) {
                Some(entry) => { entry.touched = self.clock; entry.image.is_none() && entry.retry_at <= now },
                None => true,
            };
            if needs_load && !self.loading.contains(path) { self.queue.push_back(path.clone()); }
        }
    }
    fn store(&mut self, path: String, image: Option<Thumbnail>) {
        self.loading.remove(&path);
        if self.stopped { return; }
        self.clock += 1;
        self.entries.insert(path, Entry { image: image.map(Arc::new), touched: self.clock, retry_at: Instant::now() + Duration::from_secs(60) });
        while self.entries.len() > MAX_IMAGES {
            let oldest = self.entries.iter().filter(|(key, _)| !self.desired.contains(*key))
                .min_by_key(|(_, entry)| entry.touched).map(|(key, _)| key.clone());
            if let Some(key) = oldest { self.entries.remove(&key); } else { break; }
        }
    }
}

#[derive(Debug, Default)]
struct Shared { cache: Mutex<Cache>, wake: Condvar }
#[derive(Debug)]
pub(crate) struct Loader { shared: Arc<Shared> }
impl Loader {
    pub fn new(notify: impl Fn() + Send + Sync + 'static) -> Self {
        Self::with_fetch(notify, |path, agent| download(agent, path))
    }
    fn with_fetch(notify: impl Fn() + Send + Sync + 'static,
        fetch: impl Fn(&str, &ureq::Agent) -> Result<Thumbnail, String> + Send + Sync + 'static) -> Self {
        let shared = Arc::new(Shared::default());
        let notify = Arc::new(notify); let fetch = Arc::new(fetch);
        for _ in 0..2 {
            let shared = shared.clone(); let notify = notify.clone(); let fetch = fetch.clone();
            std::thread::spawn(move || {
                let agent = agent();
                loop {
                    let path = {
                        let Ok(mut cache) = shared.cache.lock() else { return; };
                        loop {
                            if cache.stopped { return; }
                            if let Some(path) = cache.queue.pop_front() { cache.loading.insert(path.clone()); break path; }
                            cache = match shared.wake.wait(cache) { Ok(cache) => cache, Err(_) => return };
                        }
                    };
                    let image = fetch(&path, &agent).ok();
                    let should_notify = if let Ok(mut cache) = shared.cache.lock() {
                        let visible = cache.desired.contains(&path) && !cache.stopped;
                        cache.store(path, image); visible
                    } else { false };
                    if should_notify { notify(); }
                }
            });
        }
        Self { shared }
    }
    pub fn request(&self, paths: &[String]) {
        if let Ok(mut cache) = self.shared.cache.lock() { cache.request(paths); }
        self.shared.wake.notify_all();
    }
    pub fn image(&self, path: &str) -> Option<Arc<Thumbnail>> {
        self.shared.cache.lock().ok()?.entries.get(path)?.image.clone()
    }
    pub fn failed(&self,path:&str)->bool {
        self.shared.cache.lock().is_ok_and(|cache|cache.entries.get(path).is_some_and(|entry|entry.image.is_none()))
    }
    #[cfg(test)]
    pub fn fixture(images:Vec<(String,Thumbnail)>)->Self {
        let shared=Arc::new(Shared::default());
        for (path,image) in images {shared.cache.lock().unwrap().store(path,Some(image));}
        Self{shared}
    }
    pub fn stop(&self) {
        if let Ok(mut cache) = self.shared.cache.lock() {
            cache.stopped = true; cache.queue.clear(); cache.desired.clear(); cache.entries.clear();
        }
        self.shared.wake.notify_all();
    }
}
impl Drop for Loader { fn drop(&mut self) { self.stop(); } }

#[cfg(test)]
mod tests {
    use super::*;
    fn png(width: u32, height: u32) -> (String, Vec<u8>) {
        let mut bytes = vec![];
        { let mut encoder = png::Encoder::new(&mut bytes, width, height); encoder.set_color(png::ColorType::Rgba);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[200,100,50,128].repeat(width as usize * height as usize)).unwrap(); }
        (format!("/trading-items/{:x}.png", Sha256::digest(&bytes)), bytes)
    }
    #[test]
    fn validates_paths_hashes_dimensions_and_flattens_alpha() {
        let (path, bytes) = png(2,1);
        let image = decode(&path, &bytes).unwrap();
        assert_eq!(image.pixels, [34,59,108,255].repeat(2));
        assert!(decode(&path, &bytes[..bytes.len()-1]).is_err());
        for invalid in ["https://evil.example/asset.png", "/trading-items/../asset.png", "/trading-items/ABC.png"] {
            assert!(decode(invalid, &bytes).is_err());
        }
        let (path, bytes) = png(257,160); assert!(decode(&path, &bytes).is_err());
    }
    #[test]
    fn cache_limits_queue_memory_and_negative_retries() {
        let mut cache = Cache::default();
        let paths = (0..140).map(|i| format!("/trading-items/{i:064x}.png")).collect::<Vec<_>>();
        cache.request(&paths); assert_eq!(cache.queue.len(), MAX_VISIBLE);
        let failed = paths[0].clone(); cache.store(failed.clone(), None);
        cache.request(&paths); assert!(!cache.queue.contains(&failed));
        cache.request(&paths[30..]); assert_eq!(cache.queue.len(), MAX_VISIBLE);
        assert!(!cache.queue.contains(&paths[1]));
        for path in &paths { cache.store(path.clone(), Some(Thumbnail { width:1,height:1,pixels:vec![0;4] })); }
        assert_eq!(cache.entries.len(),MAX_IMAGES); assert!(cache.entries.contains_key(&paths[30]));
        cache.stopped = true; cache.queue.clear(); cache.request(&paths); assert!(cache.queue.is_empty());
    }
    #[test]
    fn stalled_images_do_not_block_request_or_shutdown() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new())); let worker_gate = gate.clone();
        let loader = Loader::with_fetch(|| {}, move |_, _| {
            entered_tx.send(()).unwrap();
            let (lock,wake) = &*worker_gate; let mut ready = lock.lock().unwrap();
            while !*ready { ready = wake.wait(ready).unwrap(); }
            Err("offline".into())
        });
        loader.request(&[format!("/trading-items/{:064x}.png", 1)]);
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let start = Instant::now(); loader.request(&[]); loader.stop();
        assert!(start.elapsed() < Duration::from_millis(100));
        *gate.0.lock().unwrap() = true; gate.1.notify_all();
    }
}
