// Smooth scrolling that does not break `position: sticky`.
//
// Wheel input is intercepted and eased into window.scrollTo, so sections
// still stick natively. Touch, keyboard and scrollbar dragging stay native
// and simply re-sync the target.

export class SmoothScroll {
  constructor({ reducedMotion = false, ease = 0.11 } = {}) {
    this.enabled = !reducedMotion;
    this.ease = ease;
    this.target = window.scrollY;
    this.current = window.scrollY;
    this.animating = false;
    this.listeners = new Set();
    this.progress = 0;
    this.velocity = 0;

    this._onWheel = this._onWheel.bind(this);
    this._onScroll = this._onScroll.bind(this);
    this._tick = this._tick.bind(this);

    if (this.enabled) {
      window.addEventListener("wheel", this._onWheel, { passive: false });
    }
    window.addEventListener("scroll", this._onScroll, { passive: true });
    window.addEventListener("resize", () => this._measure(), { passive: true });

    this._measure();
    this._emit();
  }

  _measure() {
    this.max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  }

  _onWheel(e) {
    // Let the browser handle zoom gestures and scrollable inner panels.
    if (e.ctrlKey) return;
    let node = e.target;
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.nativeScroll !== undefined) {
        const canScroll = node.scrollHeight > node.clientHeight + 1;
        if (canScroll) {
          const atTop = node.scrollTop <= 0 && e.deltaY < 0;
          const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 1 && e.deltaY > 0;
          if (!atTop && !atEnd) return;
        }
      }
      node = node.parentElement;
    }

    e.preventDefault();
    this._measure();
    const step = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY;
    this.target = Math.max(0, Math.min(this.max, this.target + step * 2.0));
    this._start();
  }

  _onScroll() {
    // A scroll we did not drive (touch, keys, scrollbar, anchor jump).
    if (!this.animating) {
      this.target = window.scrollY;
      this.current = window.scrollY;
      this._emit();
    }
  }

  _start() {
    if (this.animating) return;
    this.animating = true;
    this._last = 0;
    requestAnimationFrame(this._tick);
  }

  _tick(now) {
    const delta = this.target - this.current;
    this.velocity = delta;

    if (Math.abs(delta) < 0.35) {
      this.current = this.target;
      window.scrollTo(0, this.current);
      this.animating = false;
      this._last = 0;
      this._emit();
      return;
    }

    // Framerate-independent easing, so a slow device still arrives promptly
    // instead of crawling one fixed fraction per rendered frame.
    const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 1 / 60;
    this._last = now;
    const k = Math.min(1, 1 - Math.pow(1 - this.ease, dt * 60));

    this.current += delta * k;
    window.scrollTo(0, this.current);
    this._emit();
    requestAnimationFrame(this._tick);
  }

  _emit() {
    this._measure();
    this.progress = Math.max(0, Math.min(1, (this.animating ? this.current : window.scrollY) / this.max));
    for (const fn of this.listeners) fn(this.progress, this.velocity);
  }

  onChange(fn) {
    this.listeners.add(fn);
    fn(this.progress, 0);
    return () => this.listeners.delete(fn);
  }

  /** Animated jump used by nav links and buttons. */
  scrollToProgress(p) {
    this._measure();
    const y = Math.max(0, Math.min(this.max, p * this.max));
    if (!this.enabled) { window.scrollTo(0, y); this.target = y; this.current = y; this._emit(); return; }
    this.target = y;
    this._start();
  }

  scrollToElement(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = window.scrollY + rect.top;
    this._measure();
    this.target = Math.max(0, Math.min(this.max, y));
    if (!this.enabled) { window.scrollTo(0, this.target); this.current = this.target; this._emit(); return; }
    this._start();
  }
}
