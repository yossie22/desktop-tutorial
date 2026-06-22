/**
 * パノラマ用ジャイロ制御 v16
 * 縦画面: v13（beta + コンパス）— 安定版そのまま
 * 横画面: クォータニオン差分で左右・上下を分離（コンパス依存なし）
 * 詳細: vendor/gyro-STABLE-v16.txt
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.040;
  var HEADING_SPIKE_DEG = 55;
  var SENSOR_LP = 0.22;
  var LANDSCAPE_QUAT_LP = 0.18;
  var LANDSCAPE_WARMUP = 6;
  var LANDSCAPE_YAW_SIGN = -1;
  var LANDSCAPE_PITCH_SIGN = 1;
  var BUILD = 'v16';

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

  function isPortraitScreen(screenAngleDeg) {
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    return a === 0 || a === 180;
  }

  function quatFromAxisAngle(x, y, z, angle) {
    var len = Math.sqrt(x * x + y * y + z * z) || 1;
    x /= len; y /= len; z /= len;
    var s = Math.sin(angle / 2);
    var c = Math.cos(angle / 2);
    return { x: x * s, y: y * s, z: z * s, w: c };
  }

  function quatNormalize(q) {
    var len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
    return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
  }

  function quatMultiply(a, b) {
    return {
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
    };
  }

  function quatInverse(q) {
    var len2 = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w || 1;
    return { x: -q.x / len2, y: -q.y / len2, z: -q.z / len2, w: q.w / len2 };
  }

  function quatSlerp(a, b, t) {
    var dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    var bUse = b;
    if (dot < 0) {
      dot = -dot;
      bUse = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    }
    if (dot > 0.9995) {
      return quatNormalize({
        x: a.x + t * (bUse.x - a.x),
        y: a.y + t * (bUse.y - a.y),
        z: a.z + t * (bUse.z - a.z),
        w: a.w + t * (bUse.w - a.w)
      });
    }
    var theta = Math.acos(clamp(dot, -1, 1));
    var sinTheta = Math.sin(theta);
    if (sinTheta < 1e-6) return quatNormalize(bUse);
    var w1 = Math.sin((1 - t) * theta) / sinTheta;
    var w2 = Math.sin(t * theta) / sinTheta;
    return quatNormalize({
      x: a.x * w1 + bUse.x * w2,
      y: a.y * w1 + bUse.y * w2,
      z: a.z * w1 + bUse.z * w2,
      w: a.w * w1 + bUse.w * w2
    });
  }

  function quatFromDeviceOrientation(alphaDeg, betaDeg, gammaDeg) {
    var y = degToRad(alphaDeg);
    var x = degToRad(betaDeg);
    var z = degToRad(-gammaDeg);
    var c1 = Math.cos(y / 2), s1 = Math.sin(y / 2);
    var c2 = Math.cos(x / 2), s2 = Math.sin(x / 2);
    var c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
    return quatNormalize({
      w: c1 * c2 * c3 + s1 * s2 * s3,
      x: c1 * s2 * c3 + s1 * c2 * s3,
      y: s1 * c2 * c3 - c1 * s2 * s3,
      z: c1 * c2 * s3 - s1 * s2 * c3
    });
  }

  function computeDeviceToScreenQuat(rawEvent, screenAngleDeg) {
    if (!rawEvent || rawEvent.beta == null || rawEvent.gamma == null) return null;
    var alpha = rawEvent.alpha != null && !isNaN(rawEvent.alpha) ? rawEvent.alpha : 0;
    var q = quatFromDeviceOrientation(alpha, rawEvent.beta, rawEvent.gamma);
    var qFix = quatFromAxisAngle(1, 0, 0, -Math.PI / 2);
    q = quatMultiply(q, qFix);
    var qScreen = quatFromAxisAngle(0, 0, 1, -degToRad(screenAngleDeg));
    q = quatMultiply(q, qScreen);
    return quatNormalize(q);
  }

  function deltaQuatToYawPitch(q) {
    var sinp = 2 * (q.w * q.x - q.y * q.z);
    var pitch = sinp >= 1 ? Math.PI / 2 : (sinp <= -1 ? -Math.PI / 2 : Math.asin(sinp));
    var siny = 2 * (q.w * q.y + q.x * q.z);
    var cosy = 1 - 2 * (q.y * q.y + q.z * q.z);
    var yaw = Math.atan2(siny, cosy);
    return { yaw: yaw, pitch: pitch };
  }

  function screenRelativeHeading(heading, screenAngleDeg) {
    if (heading == null || isNaN(heading)) return null;
    return normalizeAngle360(heading - screenAngleDeg);
  }

  function normalizeSensorEvent(rawEvent) {
    if (!rawEvent || rawEvent.beta == null) return null;
    var screenAngle = getScreenAngleDeg();
    var screenHeading = null;
    if (typeof rawEvent.webkitCompassHeading === 'number' &&
        !isNaN(rawEvent.webkitCompassHeading)) {
      screenHeading = screenRelativeHeading(rawEvent.webkitCompassHeading, screenAngle);
    } else if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
      screenHeading = screenRelativeHeading(rawEvent.alpha, screenAngle);
    }
    return {
      gamma: rawEvent.gamma,
      screenHeading: screenHeading,
      screenAngle: screenAngle
    };
  }

  function readHeadingDeg(normalized) {
    if (!normalized) return null;
    return normalized.screenHeading;
  }

  /** 縦画面: v13 そのまま */
  function trackPortrait(rawEvent, normalized, state) {
    if (!normalized || rawEvent.beta == null) return null;
    var beta = rawEvent.beta;
    if (Math.round(normalizeAngle360(normalized.screenAngle)) === 180) beta = -beta;

    if (state.initPitch == null) {
      state.initPitch = degToRad(beta);
      state.fPitch = state.initPitch;
      state.initGamma = normalized.gamma;
      state.fGamma = normalized.gamma;
      state.prevHeading = readHeadingDeg(normalized);
      state.initHeading = state.prevHeading;
      state.unwrappedHeading = state.prevHeading != null ? state.prevHeading : 0;
      state.gammaYawDeg = 0;
      state.headingMode = state.prevHeading != null;
      return { ready: false };
    }

    state.fPitch = lp(state.fPitch, degToRad(beta), SENSOR_LP);
    var pitchOff = clamp(state.initPitch - state.fPitch, -Math.PI / 2.2, Math.PI / 2.2);

    var heading = readHeadingDeg(normalized);
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
        state.headingMode = true;
      }
    } else if (normalized.gamma != null && state.initGamma != null) {
      state.fGamma = lp(state.fGamma, normalized.gamma, SENSOR_LP);
      state.gammaYawDeg = state.fGamma - state.initGamma;
      yawOff = degToRad(state.gammaYawDeg);
      state.headingMode = false;
    }

    return { ready: true, yawOff: yawOff, pitchOff: pitchOff, headingMode: state.headingMode };
  }

  /** 横画面: 開始時の向きからの差分（左右・上下を分離） */
  function trackLandscape(rawEvent, screenAngle, state) {
    var q = computeDeviceToScreenQuat(rawEvent, screenAngle);
    if (!q) return null;

    if (!state.initQ) {
      if (!state.warmupQs) state.warmupQs = [];
      state.warmupQs.push(q);
      if (state.warmupQs.length < LANDSCAPE_WARMUP) return { ready: false };
      state.initQ = state.warmupQs[state.warmupQs.length - 1];
      state.fQ = state.initQ;
      state.smoothYaw = 0;
      state.smoothPitch = 0;
      state.warmupQs = null;
      return { ready: false };
    }

    state.fQ = quatSlerp(state.fQ, q, LANDSCAPE_QUAT_LP);
    var qDelta = quatMultiply(quatInverse(state.initQ), state.fQ);
    var yp = deltaQuatToYawPitch(qDelta);

    var targetYaw = LANDSCAPE_YAW_SIGN * yp.yaw;
    var targetPitch = LANDSCAPE_PITCH_SIGN * yp.pitch;

    state.smoothYaw = lp(state.smoothYaw, targetYaw, SENSOR_LP);
    state.smoothPitch = lp(state.smoothPitch, targetPitch, SENSOR_LP);

    return {
      ready: true,
      yawOff: clamp(state.smoothYaw, -Math.PI, Math.PI),
      pitchOff: clamp(state.smoothPitch, -Math.PI / 2.2, Math.PI / 2.2),
      headingMode: true
    };
  }

  function resetOrientState(state) {
    state.initPitch = null;
    state.fPitch = null;
    state.initGamma = null;
    state.fGamma = null;
    state.prevHeading = null;
    state.initHeading = null;
    state.unwrappedHeading = 0;
    state.gammaYawDeg = 0;
    state.headingMode = true;
    state.initQ = null;
    state.fQ = null;
    state.warmupQs = null;
    state.smoothYaw = 0;
    state.smoothPitch = 0;
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

  GyroControl.prototype._recalibrateForScreenRotate = function() {
    if (this.base) {
      this.base.viewYaw = this.displayYaw;
      this.base.viewPitch = this.displayPitch;
    }
    if (this.orientState) resetOrientState(this.orientState);
  };

  GyroControl.prototype._bindOrientation = function() {
    var self = this;
    var sensorFn = function(e) { self.latestEvent = e; };
    ['deviceorientationabsolute', 'deviceorientation'].forEach(function(type) {
      global.addEventListener(type, sensorFn, true);
      self.handlers.push({ type: type, fn: sensorFn, capture: true });
    });

    var rotateFn = function() {
      if (!self.enabled) return;
      self._recalibrateForScreenRotate();
    };
    global.addEventListener('orientationchange', rotateFn);
    self.handlers.push({ type: 'orientationchange', fn: rotateFn, capture: false });
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.addEventListener === 'function') {
      global.screen.orientation.addEventListener('change', rotateFn);
      self.handlers.push({
        type: 'change',
        fn: rotateFn,
        target: global.screen.orientation
      });
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
      initGamma: null,
      fGamma: null,
      prevHeading: null,
      initHeading: null,
      unwrappedHeading: 0,
      gammaYawDeg: 0,
      headingMode: true,
      initQ: null,
      fQ: null,
      warmupQs: null,
      smoothYaw: 0,
      smoothPitch: 0,
      lastScreenAngle: getScreenAngleDeg()
    };

    this._bindOrientation();

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      if (self.hooks.onTick) self.hooks.onTick();
      var v = self.getView();
      if (!v || !self.latestEvent || !self.orientState) return;

      var screenAngle = getScreenAngleDeg();
      if (self.orientState.lastScreenAngle !== screenAngle) {
        self.orientState.lastScreenAngle = screenAngle;
        self._recalibrateForScreenRotate();
        return;
      }

      var o;
      if (isPortraitScreen(screenAngle)) {
        var normalized = normalizeSensorEvent(self.latestEvent);
        o = trackPortrait(self.latestEvent, normalized, self.orientState);
      } else {
        o = trackLandscape(self.latestEvent, screenAngle, self.orientState);
      }
      if (!o || !o.ready) return;

      var targetYaw = self.base.viewYaw + o.yawOff;
      var targetPitch = clamp(self.base.viewPitch + o.pitchOff, -Math.PI / 2, Math.PI / 2);
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
