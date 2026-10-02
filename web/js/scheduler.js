// One global interval for every site. Ticks never overlap; the next tick is scheduled from wall
// clock time so throttled background timers catch up as soon as the page is visible again.

export const timeoutFor = intervalSec => Math.min(10_000, Math.max(3000, intervalSec * 800));

export class Scheduler extends EventTarget {
  #run;
  #intervalSec = 60;
  #timer = null;
  #running = false;
  #nextAt = null;
  #lastAt = null;
  #started = false;
  #again = false;             // runNow() was requested while a tick was in flight

  constructor(run) {
    super();
    this.#run = run;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.#started && this.#nextAt && Date.now() >= this.#nextAt) this.runNow();
    });
  }

  get nextAt() { return this.#nextAt; }
  get lastAt() { return this.#lastAt; }
  get running() { return this.#running; }

  start(intervalSec) {
    this.#intervalSec = intervalSec;
    this.#started = true;
    this.runNow();
  }

  setInterval(intervalSec) {
    this.#intervalSec = intervalSec;
    if (!this.#started) return;
    // Re-plan from the last run so a shorter interval takes effect immediately
    const base = this.#lastAt ?? Date.now();
    this.#plan(base + intervalSec * 1000);
  }

  async runNow() {
    if (this.#running) { this.#again = true; return; }   // never overlap; run once more afterwards
    clearTimeout(this.#timer);
    this.#running = true;
    this.#lastAt = Date.now();
    this.dispatchEvent(new Event('tickstart'));
    try {
      await this.#run(timeoutFor(this.#intervalSec));
    } catch (err) {
      console.error('Tick failed', err);
    } finally {
      this.#running = false;
      this.dispatchEvent(new Event('tickend'));
      if (this.#again) { this.#again = false; this.runNow(); }
      else this.#plan(this.#lastAt + this.#intervalSec * 1000);
    }
  }

  #plan(at) {
    clearTimeout(this.#timer);
    if (this.#running) return;
    this.#nextAt = Math.max(at, Date.now());
    this.#timer = setTimeout(() => this.runNow(), this.#nextAt - Date.now());
  }
}
