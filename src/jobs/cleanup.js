import { cleanupOldJobs } from './store.js';
import { getJobTtlDays } from '../config.js';

export function scheduleCleanup() {
  const run = () => {
    const ttl = getJobTtlDays();
    const removed = cleanupOldJobs(ttl);
    if (removed > 0) console.log(`[cleanup] ${removed} alte Jobs gelöscht (TTL ${ttl} Tage)`);
  };
  // Täglich um 03:00 Uhr
  const msUntilNext3am = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };
  setTimeout(function tick() {
    run();
    setTimeout(tick, 86400_000);
  }, msUntilNext3am());
}
