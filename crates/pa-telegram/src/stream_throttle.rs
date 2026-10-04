use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct ProgressiveThrottle {
    started_at: Instant,
    last_update_at: Mutex<Option<Instant>>,
}

impl ProgressiveThrottle {
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
            last_update_at: Mutex::new(None),
        }
    }

    pub fn get_interval(&self) -> Duration {
        let elapsed = self.started_at.elapsed();
        if elapsed < Duration::from_secs(60) {
            Duration::from_millis(1000)
        } else if elapsed < Duration::from_secs(300) {
            Duration::from_millis(2000)
        } else if elapsed < Duration::from_secs(900) {
            Duration::from_millis(5000)
        } else {
            Duration::from_millis(10000)
        }
    }

    pub async fn can_update(&self) -> bool {
        let mut last = self.last_update_at.lock().await;
        let now = Instant::now();
        let interval = self.get_interval();

        match *last {
            Some(t) if now.duration_since(t) < interval => false,
            _ => {
                *last = Some(now);
                true
            }
        }
    }
}
