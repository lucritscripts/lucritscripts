// Smooth scrolling that does not break `position: sticky`.
//
// Wheel input is intercepted and eased into window.scrollTo, so sections
// still stick natively. Touch, keyboard and scrollbar dragging stay native
// and simply re-sync the target.
//
// SETTLING: stopping half-way through a chapter's fade leaves the page in a
// limbo state — nothing fully on screen. When input goes quiet we ask the
// snap provider whether this position is a resting place; if it isn't, we
// glide (never jump) to the nearest one. Any new input cancels it instantly,
// so it assists rather than fights.

/**
 * How long a wheel can go quiet before the next tick counts as a new gesture.
 * Trackpad momentum arrives roughly every 16ms, so anything above ~100ms is
 * a person deciding to scroll again rather than a flick still coasting.
 */
const NEW_GESTURE_MS = 140;

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

    this.snapping = false;
    this.direction = 0;
    this._snapFn = null;
    this._snapFrom = 0;
    this._snapAt = 0;
    this._snapDur = 460;
    this._idle = 0;
    this._touching = false;
    this._lastY = window.scrollY;

    this._onWheel = this._onWheel.bind(this);
    this._onScroll = this._onScroll.bind(this);
    this._tick = this._tick.bind(this);

    if (this.enabled) {
      window.addEventListener("wheel", this._onWheel, { passive: false });
    }
    window.addEventListener("scroll", this._onScroll, { passive: true });
    window.addEventListener("resize", () => this._measure(), { passive: true });

    // A finger on the glass always outranks the settle.
    window.addEventListener("touchstart", () => {
      this._touching = true;
      this._cancelSnap();
    }, { passive: true });
    window.addEventListener("touchend", () => {
      this._touching = false;
      this._scheduleSnap(220);
    }, { passive: true });

    // Keyboard paging should settle too.
    window.addEventListener("keydown", (e) => {
      if (/^(Page|Arrow|Home|End| )/.test(e.key)) this._scheduleSnap(260);
    }, { passive: true });

    this._measure();
    this._emit();
  }

  /** fn(progress, direction) → progress to settle at, or null to stay put. */
  setSnap(fn) { this._snapFn = fn; }

  _cancelSnap() {
    clearTimeout(this._idle);
    if (this.snapping) {
      this.snapping = false;
      this.target = this.current;
    }
  }

  _scheduleSnap(delay = 130) {
    clearTimeout(this._idle);
    if (!this.enabled || !this._snapFn) return;
    this._idle = setTimeout(() => this._trySnap(), delay);
  }

  _trySnap() {
    if (!this.enabled || !this._snapFn || this._touching || this.snapping) return;
    // Never move the page out from under an open overlay.
    if (document.documentElement.classList.contains("is-locked")) return;

    this._measure();

    // Take over from the tail of a flick rather than waiting for it to stop
    // dead first — that hand-off is what makes the settle feel like momentum
    // carrying you home instead of a second, separate movement. A flick with
    // real distance left is somewhere the reader deliberately aimed, so it is
    // allowed to finish and settles afterwards.
    const from = this.animating ? this.current : window.scrollY;
    if (this.animating && Math.abs(this.target - this.current) > window.innerHeight * 0.4) {
      return;
    }

    const to = this._snapFn(from / this.max, this.direction);
    if (to == null) return;

    const y = Math.max(0, Math.min(this.max, to * this.max));
    if (Math.abs(y - from) < 2) return;

    // Longer trips glide for longer, but never long enough to feel stuck.
    this.snapping = true;
    this.current = from;
    this._snapFrom = from;
    this._snapAt = performance.now();
    this._snapDur = Math.max(320, Math.min(760, 240 + Math.abs(y - from) * 0.55));
    this.target = y;
    if (!this.animating) this._start();
  }

  _measure() {
    this.max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  }

  _onWheel(e) {
    // Let the browser handle zoom gestures.
    if (e.ctrlKey) return;

    // An open overlay owns the wheel. Without this, a sheet whose content is
    // too short to scroll let the wheel fall straight through and drove the
    // page behind it — you scrolled the background instead of the panel.
    if (document.documentElement.classList.contains("is-locked")) return;

    // A scrollable inner region — a tall chapter like Publish, or a results
    // list — owns the wheel while there is anything left to scroll in the
    // direction being asked for.
    //
    // The interesting part is what happens at the edge. Releasing immediately
    // means the tail of a flick flings you into the next chapter the moment
    // you reach the bottom of a form. Never releasing means you are trapped.
    // So: the same gesture cannot escape, but a fresh one can. Reach the
    // bottom of the publish form, momentum stops there, scroll again and the
    // page moves on — which is what people already expect from a modal.
    const now = performance.now();
    const gap = now - (this._wheelAt || 0);
    this._wheelAt = now;

    let node = e.target;
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.nativeScroll !== undefined
          && node.scrollHeight > node.clientHeight + 1) {
        const down = e.deltaY > 0;
        const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
        const atTop = node.scrollTop <= 0;

        if (!(down ? atEnd : atTop)) {
          // Still room to move inside. Also drop any settle already queued
          // from an earlier page-level wheel, or it fires while someone is
          // reading and slides the page out from under them.
          this._cancelSnap();
          return;
        }
        // At the edge: only a new gesture gets to leave.
        if (gap < NEW_GESTURE_MS) { this._cancelSnap(); return; }
        break;
      }
      node = node.parentElement;
    }

    e.preventDefault();
    this._cancelSnap();
    this._measure();
    const step = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY;
    if (step) this.direction = Math.sign(step);
    this.target = Math.max(0, Math.min(this.max, this.target + step * 2.0));
    this._start();
    // Arm the settle from the last wheel tick, not from when the flick runs
    // out — so the glide picks up the moment the reader stops scrolling.
    this._scheduleSnap(150);
  }

  _onScroll() {
    const y = window.scrollY;
    if (y !== this._lastY) {
      if (!this.animating) this.direction = Math.sign(y - this._lastY) || this.direction;
      this._lastY = y;
    }

    // A scroll we did not drive (touch, keys, scrollbar, anchor jump).
    if (!this.animating) {
      this.target = y;
      this.current = y;
      this._emit();
      this._scheduleSnap(200);
    }
  }

  _start() {
    if (this.animating) return;
    this.animating = true;
    this._last = 0;
    requestAnimationFrame(this._tick);
  }

  _tick(now) {
    // The settle runs on a fixed duration rather than exponential easing, so
    // it always finishes in the same amount of time — including on a device
    // rendering at a handful of frames per second, where an exponential ease
    // would crawl for seconds.
    if (this.snapping) {
      const t = Math.min(1, (now - this._snapAt) / this._snapDur);
      const eased = 1 - Math.pow(1 - t, 3);
      this.current = this._snapFrom + (this.target - this._snapFrom) * eased;
      this.velocity = this.target - this.current;
      window.scrollTo(0, this.current);
      this._lastY = Math.round(this.current);
      this._emit();

      if (t >= 1) {
        this.current = this.target;
        this.snapping = false;
        this.animating = false;
        this._last = 0;
        return;
      }
      requestAnimationFrame(this._tick);
      return;
    }

    const delta = this.target - this.current;
    this.velocity = delta;

    if (Math.abs(delta) < 0.35) {
      this.current = this.target;
      window.scrollTo(0, this.current);
      this.animating = false;
      this._last = 0;
      this._lastY = this.current;
      this._emit();
      this._scheduleSnap(120);
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
    this._cancelSnap();
    this._measure();
    const y = Math.max(0, Math.min(this.max, p * this.max));
    if (!this.enabled) { window.scrollTo(0, y); this.target = y; this.current = y; this._emit(); return; }
    this.target = y;
    this._start();
  }

  scrollToElement(el) {
    if (!el) return;
    this._cancelSnap();
    const rect = el.getBoundingClientRect();
    const y = window.scrollY + rect.top;
    this._measure();
    this.target = Math.max(0, Math.min(this.max, y));
    if (!this.enabled) { window.scrollTo(0, this.target); this.current = this.target; this._emit(); return; }
    this._start();
  }
}
