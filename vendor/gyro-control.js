/**
 * パノラマ用ジャイロ制御 v45
 * 水平線優先：左右=コンパス(v13)、上下=重力基準の向き(クォータニオン)
 * 縦横切替で基準リセットなし。alpha は端末値、コンパスは左右専用。
 * 詳細: vendor/gyro-STABLE-v45.txt
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
  var BUILD = 'v45';

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

  function getScreenAngleDeg() {
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.angle === 'number') {
      return global.screen.orientation.angle;
    }
    if (typeof global.orientation === 'number') return global.orientation;
    return 0;
  }

  function qNormalize(q) {
    var len = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
    if (len < 1e-8) return { w: 1, x: 0, y: 0, z: 0 };
    return { w: q.w / len, x: q.x / len, y: q.y / len, z: q.z / len };
  }

  function qMul(a, b) {
    return qNormalize({
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
    });
  }

  function qFromAxisAngle(ax, ay, az, angleRad) {
    var half = angleRad * 0.5;
    var s = Math.sin(half);
    return qNormalize({
      w: Math.cos(half),
      x: ax * s,
      y: ay * s,
      z: az * s
    });
  }

  /** THREE.js DeviceOrientationControls と同じ */
  function setObjectQuaternion(alpha, beta, gamma, orientRad) {
    var c1 = Math.cos(beta * 0.5);
    var s1 = Math.sin(beta * 0.5);
    var c2 = Math.cos(alpha * 0.5);
    var s2 = Math.sin(alpha * 0.5);
    var c3 = Math.cos(-gamma * 0.5);
    var s3 = Math.sin(-gamma * 0.5);
    var q = qNormalize({
      w: c1 * c2 * c3 + s1 * s2 * s3,
      x: s1 * c2 * c3 + c1 * s2 * s3,
      y: c1 * s2 * c3 - s1 * c2 * s3,
      z: c1 * c2 * s3 - s1 * s2 * c3
    });
    var qFix = qFromAxisAngle(1, 0, 0, -Math.PI / 2);
    var qScreen = qFromAxisAngle(0, 0, 1, -orientRad);
    return qMul(qMul(q, qFix), qScreen);
  }

  function quatRotateVec(q, x, y, z) {
    var qx = q.x;
    var qy = q.y;
    var qz = q.z;
    var qw = q.w;
    var ix = qw * x + qy * z - qz * y;
    var iy = qw * y + qz * x - qx * z;
    var iz = qw * z + qx * y - qy * x;
    var iw = -qx * x - qy * y - qz * z;
    return {
      x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
      y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
      z: iz * qw + iw * -qz + ix * -qy - iy * -qx
    };
  }

  /** 画面が向いている方向の仰角（重力基準・ロールの影響を抑える） */
  function lookElevationRad(rawEvent, screenAngleDeg) {
    if (rawEvent.beta == null || rawEvent.gamma == null) return null;
    var alpha = rawEvent.alpha != null && !isNaN(rawEvent.alpha) ? degToRad(rawEvent.alpha) : 0;
    var beta = degToRad(rawEvent.beta);
    var gamma = degToRad(rawEvent.gamma);
    var q = setObjectQuaternion(alpha, beta, gamma, degToRad(screenAngleDeg));
    var look = quatRotateVec(q, 0, 0, -1);
    var horiz = Math.sqrt(look.x * look.x + look.z * look.z);
    if (horiz < 1e-6) return look.y > 0 ? Math.PI / 2 : -Math.PI / 2;
    return Math.atan2(look.y, horiz);
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

  function trackUnified(rawEvent, screenAngleDeg, state) {
    var elev = lookElevationRad(rawEvent, screenAngleDeg);
    if (elev == null) return null;

    if (state.warmup < TRACK_WARMUP_FRAMES) {
      state.warmup += 1;
      return { ready: false };
    }

    var heading = readHeadingDeg(rawEvent);

    if (!state.trackingReady) {
      state.initElevation = elev;
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

    var pitchOff = clamp(
      elev - state.initElevation,
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
  };

  GyroControl.prototype._bindOrientation = function() {
    var self = this;
    var sensorFn = function(e) { self.latestEvent = e; };
    ['deviceorientationabsolute', 'deviceorientation'].forEach(function(type) {
      global.addEventListener(type, sensorFn, true);
      self.handlers.push({ type: type, fn: sensorFn, capture: true });
    });
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
      initElevation: null,
      initHeading: null,
      prevHeading: null,
      unwrappedHeading: 0,
      warmup: 0,
      trackingReady: false
    };

    this._bindOrientation();

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      if (self.hooks.onTick) self.hooks.onTick();
      var v = self.getView();
      if (!v || !self.latestEvent || !self.orientState || !self.base) return;

      var screenAngle = getScreenAngleDeg();
      var o = trackUnified(self.latestEvent, screenAngle, self.orientState);
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
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      return DeviceOrientationEvent.requestPermission().then(function(state) {
        if (state === 'granted') return self.start();
        return false;
      }).catch(function() { return false; });
    }
    return Promise.resolve(self.start());
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
