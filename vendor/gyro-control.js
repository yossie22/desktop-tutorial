/**
 * パノラマ用ジャイロ制御 v47
 * 水平線優先：上下=重力（画面は端末に固定なので角度補正しない）
 * 左右=コンパス(v13)、縦横切替で基準リセットなし
 * 詳細: vendor/gyro-STABLE-v47.txt
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.040;
  var HEADING_SPIKE_DEG = 55;
  var SENSOR_LP = 0.22;
  var MAX_PITCH_UP = Math.PI * 82 / 180;
  var MAX_PITCH_DOWN = Math.PI * 82 / 180;
  var TRACK_WARMUP_FRAMES = 12;
  var GRAVITY_MIN = 4;
  var BUILD = 'v47';

  function degToRad(d) { return d * Math.PI / 180; }
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

  /** 画面の向き＝端末の -Z（センサーは端末に固定） */
  var SCREEN_FORWARD = { x: 0, y: 0, z: -1 };

  /**
   * 重力から仰角（端末を横に傾けても変わりにくい）
   * up = 重力と逆方向、pitch = asin(画面向き · up)
   */
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

  /** beta/gamma から重力方向（devicemotion 無し時） */
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

  function resolvePitchRad(rawEvent, motion) {
    if (motion && motion.x != null && motion.y != null && motion.z != null) {
      return pitchFromGravityRad(motion.x, motion.y, motion.z);
    }
    var g = gravityFromEuler(rawEvent);
    if (!g) return null;
    return pitchFromGravityRad(g.x, g.y, g.z);
  }

  function trackUnified(rawEvent, motion, state) {
    var pitchSample = resolvePitchRad(rawEvent, motion);
    if (pitchSample == null) return null;

    if (state.warmup < TRACK_WARMUP_FRAMES) {
      state.warmup += 1;
      return { ready: false };
    }

    var heading = readHeadingDeg(rawEvent);

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
      state.fPitch - state.initPitch,
      -MAX_PITCH_DOWN,
      MAX_PITCH_UP
    );
    var yawOff = trackYawFromHeading(heading, state);

    return {
      ready: true,
      yawOff: yawOff,
      pitchOff: pitchOff,
      pitchDownMax: MAX_PITCH_DOWN,
      pitchUpMax: MAX_PITCH_UP
    };
  }

  function GyroControl(getView) {
    this.getView = getView;
    this.enabled = false;
    this.handlers = [];
    this.raf = null;
    this.latestEvent = null;
    this.latestMotion = null;
    this.base = null;
    this.onChange = null;
    this.hooks = {};
    this.orientState = null;
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

  GyroControl.prototype._emit = function() {
    if (this.onChange) this.onChange(this.enabled);
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

      var o = trackUnified(self.latestEvent, self.latestMotion, self.orientState);
      if (!o || !o.ready) return;

      var targetYaw = self.base.viewYaw + o.yawOff;
      var targetPitch = clamp(
        self.base.viewPitch + o.pitchOff,
        self.base.viewPitch - o.pitchDownMax,
        self.base.viewPitch + o.pitchUpMax
      );
      targetPitch = clamp(targetPitch, -Math.PI / 2, Math.PI / 2);

      self.displayYaw = normalizeAngle(
        self.displayYaw + clamp(YAW_SMOOTH * angleDelta(self.displayYaw, targetYaw), -YAW_MAX_STEP, YAW_MAX_STEP)
      );
      self.displayPitch = clamp(
        self.displayPitch + clamp(PITCH_SMOOTH * (targetPitch - self.displayPitch), -PITCH_MAX_STEP, PITCH_MAX_STEP),
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
