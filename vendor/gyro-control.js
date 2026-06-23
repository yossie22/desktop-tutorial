/**
 * パノラマ用ジャイロ制御 v43
 * 統一クォータニオン方式（THETA 型：水平線を世界基準で維持）
 * 縦横切替で基準リセットしない。画面角度は毎フレーム補正。
 * 詳細: vendor/gyro-STABLE-v43.txt
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.040;
  var SENSOR_LP = 0.22;
  var MAX_PITCH_UP = Math.PI * 82 / 180;
  var MAX_PITCH_DOWN = Math.PI * 82 / 180;
  var TRACK_WARMUP_FRAMES = 10;
  var TRACK_YAW_SIGN = -1;
  var TRACK_PITCH_SIGN = -1;
  var BUILD = 'v43';

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
  function normalizeAngle360(d) {
    d = d % 360;
    if (d < 0) d += 360;
    return d;
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

  function qConj(q) {
    return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
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

  function deviceEulerToQuat(alphaDeg, betaDeg, gammaDeg) {
    if (betaDeg == null || gammaDeg == null) return null;
    if (isNaN(betaDeg) || isNaN(gammaDeg)) return null;
    if (alphaDeg == null || isNaN(alphaDeg)) alphaDeg = 0;
    var a = degToRad(alphaDeg);
    var b = degToRad(betaDeg);
    var g = degToRad(gammaDeg);
    var cA = Math.cos(a * 0.5);
    var sA = Math.sin(a * 0.5);
    var cB = Math.cos(b * 0.5);
    var sB = Math.sin(b * 0.5);
    var cG = Math.cos(g * 0.5);
    var sG = Math.sin(g * 0.5);
    return qNormalize({
      w: cA * cB * cG - sA * sB * sG,
      x: sA * sB * cG + cA * cB * sG,
      y: sA * cB * cG + cA * sB * sG,
      z: cA * sB * cG - sA * cB * sG
    });
  }

  /** 画面回転を毎フレーム補正（縦横で基準を変えない） */
  function deviceQuatWorld(rawEvent, screenAngleDeg) {
    var q = deviceEulerToQuat(rawEvent.alpha, rawEvent.beta, rawEvent.gamma);
    if (!q) return null;
    var qDeviceFix = qFromAxisAngle(1, 0, 0, -Math.PI / 2);
    var qScreen = qFromAxisAngle(0, 0, 1, -degToRad(screenAngleDeg));
    return qMul(qScreen, qMul(qDeviceFix, q));
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

  function offsetsFromRelQuat(qRel) {
    var look = quatRotateVec(qRel, 0, 0, -1);
    var horiz = Math.sqrt(look.x * look.x + look.z * look.z);
    var yawOff = Math.atan2(look.x, look.z) * TRACK_YAW_SIGN;
    var pitchOff = Math.atan2(look.y, horiz) * TRACK_PITCH_SIGN;
    return { yawOff: yawOff, pitchOff: pitchOff };
  }

  function resetTrackState(state) {
    state.qInit = null;
    state.qWarmup = 0;
    state.trackingReady = false;
  }

  function trackUnified(rawEvent, screenAngleDeg, state) {
    var qCurr = deviceQuatWorld(rawEvent, screenAngleDeg);
    if (!qCurr) return null;

    if (state.qWarmup < TRACK_WARMUP_FRAMES) {
      state.qWarmup += 1;
      return { ready: false };
    }

    if (!state.trackingReady) {
      state.qInit = qCurr;
      state.trackingReady = true;
      return {
        ready: true,
        yawOff: 0,
        pitchOff: 0,
        pitchDownMax: MAX_PITCH_DOWN,
        pitchUpMax: MAX_PITCH_UP
      };
    }

    var qRel = qMul(qConj(state.qInit), qCurr);
    var off = offsetsFromRelQuat(qRel);
    return {
      ready: true,
      yawOff: clamp(off.yawOff, -Math.PI, Math.PI),
      pitchOff: clamp(off.pitchOff, -MAX_PITCH_DOWN, MAX_PITCH_UP),
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
      qInit: null,
      qWarmup: 0,
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
