/**
 * パノラマ用ジャイロ制御 v55
 * 没入モード：重力+コンパス、CSS逆回転で水平・切替抑制
 * 詳細: vendor/gyro-STABLE-v55.txt
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.08;
  var YAW_SMOOTH = 0.10;
  var PITCH_MAX_STEP = 0.016;
  var YAW_MAX_STEP = 0.020;
  var HEADING_SPIKE_DEG = 55;
  var HEADING_LP = 0.11;
  var SENSOR_LP = 0.09;
  var ROLL_LP = 0.07;
  var ROLL_SMOOTH = 0.09;
  var ROLL_DEADZONE_DEG = 4.0;
  var ROLL_MAX_COVER_DEG = 22;
  var PITCH_ZENITH_START = Math.PI * 58 / 180;
  var PITCH_ZENITH_END = Math.PI * 74 / 180;
  var MAX_PITCH_UP = Math.PI * 78 / 180;
  var MAX_PITCH_DOWN = Math.PI * 78 / 180;
  var TRACK_WARMUP_FRAMES = 18;
  var GRAVITY_MIN = 4;
  var BUILD = 'v55';

  var SCREEN_FORWARD = { x: 0, y: 0, z: -1 };

  function degToRad(d) { return d * Math.PI / 180; }
  function radToDeg(r) { return r * 180 / Math.PI; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function normalizeAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
  function angleDelta(from, to) {
    return normalizeAngle(to - from);
  }
  function lp(prev, next, k) {
    return prev == null ? next : prev + k * (next - prev);
  }
  function normalizeAngle360(d) {
    d = d % 360;
    if (d < 0) d += 360;
    return d;
  }

  function getScreenAngleDeg() {
    if (typeof global.orientation === 'number' && !isNaN(global.orientation)) {
      return normalizeAngle360(global.orientation);
    }
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.angle === 'number') {
      return normalizeAngle360(global.screen.orientation.angle);
    }
    return 0;
  }

  function gravityInLockFrame(rawEvent, motion, screenDelta) {
    var gx;
    var gy;
    var gz;
    if (motion && motion.x != null && motion.y != null && motion.z != null) {
      gx = motion.x;
      gy = motion.y;
      gz = motion.z;
    } else {
      var g = gravityFromEuler(rawEvent);
      if (!g) return null;
      gx = g.x;
      gy = g.y;
      gz = g.z;
    }
    if (!screenDelta) return { x: gx, y: gy, z: gz };
    return gravityToLockFrame(gx, gy, gz, screenDelta);
  }

  function pitchFromGravityRad(gx, gy, gz) {
    var len = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (len < GRAVITY_MIN) return null;
    var ux = -gx / len;
    var uy = -gy / len;
    var uz = -gz / len;
    var dot = clamp(
      SCREEN_FORWARD.x * ux + SCREEN_FORWARD.y * uy + SCREEN_FORWARD.z * uz,
      -1, 1
    );
    return Math.asin(dot);
  }

  function gravityFromEuler(rawEvent) {
    if (rawEvent.beta == null || rawEvent.gamma == null) return null;
    var b = degToRad(rawEvent.beta);
    var g = degToRad(rawEvent.gamma);
    return {
      x: Math.cos(b) * Math.sin(g),
      y: -Math.sin(b),
      z: Math.cos(b) * Math.cos(g)
    };
  }

  function rollFromGravityVec(gx, gy, gz) {
    var len = Math.sqrt(gx * gx + gy * gy);
    if (len < GRAVITY_MIN) return null;
    return Math.atan2(gx, -gy);
  }

  function gravityToLockFrame(gx, gy, gz, deltaDeg) {
    var a = degToRad(-deltaDeg);
    var c = Math.cos(a);
    var s = Math.sin(a);
    return {
      x: gx * c + gy * s,
      y: -gx * s + gy * c,
      z: gz
    };
  }

  function rollFromGravity(motion, rawEvent, screenDelta) {
    var g = gravityInLockFrame(rawEvent, motion, screenDelta);
    if (!g) return null;
    var scale = (motion && motion.x != null) ? 1 : 9.81;
    return rollFromGravityVec(g.x * scale, g.y * scale, g.z * scale);
  }

  function readHeadingDeg(rawEvent) {
    if (typeof rawEvent.webkitCompassHeading === 'number' &&
        !isNaN(rawEvent.webkitCompassHeading)) {
      return rawEvent.webkitCompassHeading;
    }
    if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
      return rawEvent.alpha;
    }
    return null;
  }

  function syncHeadingBaseline(state, heading) {
    state.initHeading = heading;
    state.prevHeading = heading;
    state.unwrappedHeading = heading != null ? heading : 0;
  }

  function trackYawFromHeading(heading, state) {
    var yawOff = 0;
    if (heading != null && state.prevHeading != null) {
      var hStep = heading - state.prevHeading;
      if (hStep > 180) hStep -= 360;
      if (hStep < -180) hStep += 360;
      if (Math.abs(hStep) <= HEADING_SPIKE_DEG) {
        state.unwrappedHeading += hStep;
        state.prevHeading = heading;
      }
      if (state.initHeading != null) {
        yawOff = degToRad(state.unwrappedHeading - state.initHeading);
      }
    }
    return yawOff;
  }

  function resolvePitchRad(rawEvent, motion, screenDelta) {
    var g = gravityInLockFrame(rawEvent, motion, screenDelta);
    if (!g) return null;
    return pitchFromGravityRad(g.x, g.y, g.z);
  }

  function trackUnified(rawEvent, motion, state, screenDelta) {
    var pitchSample = resolvePitchRad(rawEvent, motion, screenDelta);
    if (pitchSample == null) return null;

    if (state.warmup < TRACK_WARMUP_FRAMES) {
      state.warmup += 1;
      return { ready: false };
    }

    var heading = readHeadingDeg(rawEvent);
    if (heading != null) {
      state.fHeading = lp(state.fHeading, heading, HEADING_LP);
      heading = state.fHeading;
    }

    if (!state.trackingReady) {
      state.initPitch = pitchSample;
      state.fPitch = pitchSample;
      syncHeadingBaseline(state, heading);
      state.trackingReady = true;
      return {
        ready: true,
        yawOff: 0,
        pitchOff: 0,
        pitchDownMax: MAX_PITCH_DOWN,
        pitchUpMax: MAX_PITCH_UP
      };
    }

    state.fPitch = lp(state.fPitch, pitchSample, SENSOR_LP);
    var pitchOff = clamp(
      state.initPitch - state.fPitch,
      -MAX_PITCH_DOWN,
      MAX_PITCH_UP
    );
    var yawOff = trackYawFromHeading(heading, state);
    state.lastYawOff = yawOff;

    return {
      ready: true,
      yawOff: yawOff,
      pitchOff: pitchOff,
      pitchDownMax: MAX_PITCH_DOWN,
      pitchUpMax: MAX_PITCH_UP
    };
  }

  function zenithFactor(pitch) {
    var a = Math.abs(pitch);
    if (a <= PITCH_ZENITH_START) return 0;
    if (a >= PITCH_ZENITH_END) return 1;
    return (a - PITCH_ZENITH_START) / (PITCH_ZENITH_END - PITCH_ZENITH_START);
  }

  function dampedScalarStep(display, target, smooth, maxStep) {
    var err = target - display;
    var k = Math.abs(err) < 0.04 ? smooth * 0.55 : smooth;
    return clamp(k * err, -maxStep, maxStep);
  }

  function orientDegForLayout(delta) {
    var absD = Math.abs(Math.round(delta));
    if (absD === 90) return -90;
    if (absD === 180) return 180;
    return -delta;
  }

  function resetSensorBaselineOnLayout(gyro) {
    var st = gyro.orientState;
    if (!st || !st.trackingReady) return;
    st.trackingReady = false;
    st.initPitch = null;
    st.warmup = Math.max(0, TRACK_WARMUP_FRAMES - 6);
    if (gyro.visual) {
      gyro.visual.initRoll = null;
      gyro.visual.fRoll = null;
      gyro.visual.fRollDeg = 0;
    }
  }

  function snapScreenAngleDeg(deg, prev) {
    var d = normalizeAngle360(deg);
    var candidates = [0, 90, 180, 270];
    var best = d;
    var bestDist = 999;
    var i;
    for (i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var dist = Math.abs(d - c);
      if (dist > 180) dist = 360 - dist;
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    if (prev != null) {
      var hold = Math.abs(d - prev);
      if (hold > 180) hold = 360 - hold;
      if (hold < 28) return prev;
    }
    if (bestDist <= 40) return best;
    return d;
  }

  function coverScaleForRotate(w, h, deg) {
    var rad = deg * Math.PI / 180;
    var c = Math.abs(Math.cos(rad));
    var s = Math.abs(Math.sin(rad));
    return Math.max((w * c + h * s) / w, (w * s + h * c) / h) * 1.02;
  }

  function VisualImmersive(panoEl, getViewer) {
    this.panoEl = panoEl;
    this.getViewer = getViewer;
    this.lockAngle = null;
    this.initRoll = null;
    this.fRoll = null;
    this.saved = null;
    this.lastLayoutKey = '';
    this.snappedCur = null;
    this.prevSnappedCur = null;
    this.fRollDeg = null;
  }

  VisualImmersive.prototype.getDelta = function() {
    if (this.lockAngle == null || this.snappedCur == null) return 0;
    var delta = this.snappedCur - this.lockAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return delta;
  };

  VisualImmersive.prototype.start = function(motion, rawEvent) {
    if (!this.panoEl) return;
    var el = this.panoEl;
    var startAngle = normalizeAngle360(getScreenAngleDeg());
    this.lockAngle = snapScreenAngleDeg(startAngle, null);
    this.snappedCur = this.lockAngle;
    this.prevSnappedCur = this.lockAngle;
    var screenDelta = this.getDelta();
    var roll = rollFromGravity(motion, rawEvent, screenDelta);
    this.initRoll = roll != null ? roll : 0;
    this.fRoll = this.initRoll;
    this.fRollDeg = 0;
    this.saved = {
      width: el.style.width,
      height: el.style.height,
      left: el.style.left,
      top: el.style.top,
      transform: el.style.transform,
      transformOrigin: el.style.transformOrigin
    };
    this.lastLayoutKey = '';
    this.apply(getScreenAngleDeg(), motion, rawEvent);
  };

  VisualImmersive.prototype.stop = function() {
    if (!this.panoEl || !this.saved) return;
    var el = this.panoEl;
    var s = this.saved;
    el.style.width = s.width;
    el.style.height = s.height;
    el.style.left = s.left;
    el.style.top = s.top;
    el.style.transform = s.transform;
    el.style.transformOrigin = s.transformOrigin;
    this.lockAngle = null;
    this.initRoll = null;
    this.fRoll = null;
    this.saved = null;
    this.lastLayoutKey = '';
    this.snappedCur = null;
    this.prevSnappedCur = null;
    this.fRollDeg = null;
    this._updateViewerSize();
  };

  VisualImmersive.prototype._updateViewerSize = function() {
    var viewer = this.getViewer ? this.getViewer() : null;
    if (viewer && typeof viewer.updateSize === 'function') {
      viewer.updateSize();
    } else {
      try {
        global.dispatchEvent(new Event('resize'));
      } catch (e) {
        if (document.createEvent) {
          var ev = document.createEvent('Event');
          ev.initEvent('resize', true, true);
          global.dispatchEvent(ev);
        }
      }
    }
  };

  VisualImmersive.prototype.apply = function(screenAngleDeg, motion, rawEvent) {
    if (!this.panoEl || this.lockAngle == null) return;
    var el = this.panoEl;
    var rawCur = normalizeAngle360(screenAngleDeg);
    this.snappedCur = snapScreenAngleDeg(rawCur, this.snappedCur);
    var cur = this.snappedCur;
    var delta = cur - this.lockAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    var screenDelta = delta;

    var roll = rollFromGravity(motion, rawEvent, screenDelta);
    if (roll != null) {
      this.fRoll = lp(this.fRoll, roll, ROLL_LP);
    }
    var rollOff = (this.fRoll != null && this.initRoll != null)
      ? this.fRoll - this.initRoll
      : 0;
    var rollDeg = 0;
    if (Math.abs(radToDeg(rollOff)) >= ROLL_DEADZONE_DEG &&
        Math.abs(Math.round(delta)) !== 180) {
      rollDeg = -radToDeg(rollOff);
    }
    this.fRollDeg = lp(this.fRollDeg, rollDeg, ROLL_SMOOTH);
    if (this.fRollDeg == null) this.fRollDeg = rollDeg;

    var absD = Math.abs(Math.round(delta));
    var orientDeg = orientDegForLayout(delta);

    var vw = global.innerWidth || document.documentElement.clientWidth;
    var vh = global.innerHeight || document.documentElement.clientHeight;
    var layoutKey = cur + ':' + vw + 'x' + vh;
    var pw = vw;
    var ph = vh;

    if (absD === 90) {
      pw = vh;
      ph = vw;
      el.style.width = pw + 'px';
      el.style.height = ph + 'px';
      el.style.left = ((vw - pw) / 2) + 'px';
      el.style.top = ((vh - ph) / 2) + 'px';
    } else {
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.left = '0';
      el.style.top = '0';
    }

    var scale;
    if (absD === 90) {
      scale = coverScaleForRotate(pw, ph, orientDeg);
      scale = Math.max(scale, coverScaleForRotate(pw, ph, orientDeg + ROLL_MAX_COVER_DEG));
    } else {
      scale = coverScaleForRotate(pw, ph, ROLL_MAX_COVER_DEG);
    }
    scale = scale * 1.04;

    el.style.transformOrigin = 'center center';
    el.style.transform = 'rotate(' + orientDeg + 'deg) scale(' + scale + ') rotate(' + this.fRollDeg + 'deg)';
    if (layoutKey !== this.lastLayoutKey) {
      this.lastLayoutKey = layoutKey;
      this._updateViewerSize();
    }
  };

  function GyroControl(getView) {
    this.getView = getView;
    this.getViewer = null;
    this.panoEl = null;
    this.enabled = false;
    this.handlers = [];
    this.raf = null;
    this.latestEvent = null;
    this.latestMotion = null;
    this.base = null;
    this.onChange = null;
    this.hooks = {};
    this.orientState = null;
    this.visual = null;
    this.displayYaw = 0;
    this.displayPitch = 0;
  }

  GyroControl.BUILD = BUILD;

  GyroControl.prototype.setOnChange = function(fn) {
    this.onChange = fn;
  };

  GyroControl.prototype.setHooks = function(hooks) {
    this.hooks = hooks || {};
  };

  GyroControl.prototype.setPanoElement = function(el) {
    this.panoEl = el;
    this.visual = el ? new VisualImmersive(el, this.getViewer ? this.getViewer.bind(this) : null) : null;
  };

  GyroControl.prototype.setGetViewer = function(fn) {
    this.getViewer = fn;
    if (this.panoEl) {
      this.visual = new VisualImmersive(this.panoEl, fn);
    }
  };

  GyroControl.prototype._emit = function() {
    if (this.onChange) this.onChange(this.enabled);
  };

  GyroControl.prototype._onLayoutChange = function() {
    if (!this.enabled || !this.visual) return;
    this.visual.apply(getScreenAngleDeg(), this.latestMotion, this.latestEvent);
  };

  GyroControl.prototype._cleanupListeners = function() {
    this.handlers.forEach(function(item) {
      if (item.target) {
        item.target.removeEventListener(item.type, item.fn);
      } else {
        global.removeEventListener(item.type, item.fn, item.capture === true);
      }
    });
    this.handlers = [];
    if (this.raf) {
      global.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (this.visual) this.visual.stop();
    this.latestEvent = null;
    this.latestMotion = null;
  };

  GyroControl.prototype._bindSensors = function() {
    var self = this;
    var orientFn = function(e) { self.latestEvent = e; };
    ['deviceorientationabsolute', 'deviceorientation'].forEach(function(type) {
      global.addEventListener(type, orientFn, true);
      self.handlers.push({ type: type, fn: orientFn, capture: true });
    });
    var motionFn = function(e) {
      var a = e.accelerationIncludingGravity;
      if (a && a.x != null) {
        self.latestMotion = { x: a.x, y: a.y, z: a.z };
      }
    };
    global.addEventListener('devicemotion', motionFn, true);
    self.handlers.push({ type: 'devicemotion', fn: motionFn, capture: true });

    var layoutFn = function() { self._onLayoutChange(); };
    global.addEventListener('resize', layoutFn);
    self.handlers.push({ type: 'resize', fn: layoutFn, capture: false });
    global.addEventListener('orientationchange', layoutFn);
    self.handlers.push({ type: 'orientationchange', fn: layoutFn, capture: false });
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.addEventListener === 'function') {
      global.screen.orientation.addEventListener('change', layoutFn);
      self.handlers.push({ type: 'change', fn: layoutFn, target: global.screen.orientation });
    }
  };

  GyroControl.prototype.stop = function() {
    var wasOn = this.enabled;
    this._cleanupListeners();
    this.base = null;
    this.orientState = null;
    this.enabled = false;
    if (wasOn) {
      if (this.hooks.onStop) this.hooks.onStop();
      this._emit();
    }
  };

  GyroControl.prototype.start = function() {
    var view = this.getView();
    if (!view) return false;
    var wasOn = this.enabled;
    this._cleanupListeners();
    this.enabled = true;
    this.base = { viewYaw: view.yaw(), viewPitch: view.pitch() };
    this.displayYaw = view.yaw();
    this.displayPitch = view.pitch();
    if (!wasOn && this.hooks.onStart) this.hooks.onStart();

    var self = this;
    this.orientState = {
      initPitch: null,
      fPitch: null,
      initHeading: null,
      prevHeading: null,
      fHeading: null,
      lastYawOff: 0,
      unwrappedHeading: 0,
      warmup: 0,
      trackingReady: false
    };

    this._bindSensors();

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      if (self.hooks.onTick) self.hooks.onTick();
      var v = self.getView();
      if (!v || !self.latestEvent || !self.orientState || !self.base) return;

      if (self.visual && self.orientState.warmup === 0 && !self.visual.lockAngle) {
        self.visual.start(self.latestMotion, self.latestEvent);
      }

      if (self.visual && self.visual.lockAngle != null) {
        var prevCur = self.visual.prevSnappedCur;
        self.visual.apply(getScreenAngleDeg(), self.latestMotion, self.latestEvent);
        if (prevCur != null && self.visual.snappedCur != null &&
            prevCur !== self.visual.snappedCur) {
          resetSensorBaselineOnLayout(self);
        }
        self.visual.prevSnappedCur = self.visual.snappedCur;
      }

      var screenDelta = self.visual ? self.visual.getDelta() : 0;
      var o = trackUnified(self.latestEvent, self.latestMotion, self.orientState, screenDelta);

      if (!o || !o.ready) return;

      var targetYaw = self.base.viewYaw + o.yawOff;
      var targetPitch = clamp(
        self.base.viewPitch + o.pitchOff,
        self.base.viewPitch - o.pitchDownMax,
        self.base.viewPitch + o.pitchUpMax
      );
      targetPitch = clamp(targetPitch, -Math.PI / 2, Math.PI / 2);

      var zf = zenithFactor(self.displayPitch);
      if (Math.abs(screenDelta) === 90 && Math.abs(self.displayPitch) > degToRad(52)) {
        zf = Math.max(zf, 0.75);
      }
      if (zf >= 1) {
        targetYaw = self.displayYaw;
      } else if (zf > 0) {
        targetYaw = self.displayYaw + (1 - zf) * angleDelta(self.displayYaw, targetYaw);
      }

      var ySmooth = YAW_SMOOTH * (1 - zf * 0.92);
      var yStep = YAW_MAX_STEP * (1 - zf * 0.92);
      var yawStep = dampedScalarStep(0, angleDelta(self.displayYaw, targetYaw), ySmooth, yStep);
      self.displayYaw = normalizeAngle(self.displayYaw + yawStep);
      self.displayPitch = clamp(
        self.displayPitch + dampedScalarStep(self.displayPitch, targetPitch, PITCH_SMOOTH, PITCH_MAX_STEP),
        -Math.PI / 2,
        Math.PI / 2
      );
      v.setYaw(self.displayYaw);
      v.setPitch(self.displayPitch);
    }
    this.raf = global.requestAnimationFrame(tick);
    this._emit();
    return true;
  };

  GyroControl.prototype.requestStart = function() {
    var self = this;
    var chain = Promise.resolve('granted');

    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      chain = chain.then(function() {
        return DeviceOrientationEvent.requestPermission();
      });
    }
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      chain = chain.then(function(prev) {
        if (prev !== 'granted') return prev;
        return DeviceMotionEvent.requestPermission();
      });
    }

    return chain.then(function(state) {
      if (state === 'granted') return self.start();
      return false;
    }).catch(function() { return false; });
  };

  GyroControl.prototype.toggle = function() {
    if (this.enabled) {
      this.stop();
      return Promise.resolve(false);
    }
    return this.requestStart();
  };

  GyroControl.isSupportedDevice = function() {
    if (!('ontouchstart' in global)) return false;
    var ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod|Android/i.test(ua)) return true;
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    return false;
  };

  global.GyroControl = GyroControl;
})(typeof window !== 'undefined' ? window : this);
