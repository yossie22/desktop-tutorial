/**
 * パノラマ用ジャイロ制御 v26
 * 縦画面: v13 そのまま
 * 横画面: クォータニオン+画面向き補正
 * v26: iPad縦横判定修正、上下基準リセット、縦→横ずれ防止
 * 詳細: vendor/gyro-STABLE-v26.txt
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.040;
  var HEADING_SPIKE_DEG = 55;
  var SENSOR_LP = 0.22;
  var MAX_PITCH_OFF = Math.PI * 50 / 180;

  var LANDSCAPE_PITCH_SMOOTH = 0.14;
  var LANDSCAPE_PITCH_MAX_STEP = 0.015;
  var LANDSCAPE_PITCH_MAX = Math.PI * 55 / 180;
  var LANDSCAPE_YAW_IGNORE_PITCH = 0.45;
  var LANDSCAPE_CALIB_FRAMES = 8;
  var LANDSCAPE_PITCH_SIGN = 1;
  var LANDSCAPE_QUAT_LP = 0.18;
  var BUILD = 'v26';

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

  function isIPhoneDevice() {
    var ua = navigator.userAgent || '';
    if (/iPad/.test(ua)) return false;
    if (/iPhone|iPod/.test(ua)) return true;
    return false;
  }

  function isIPadDevice() {
    var ua = navigator.userAgent || '';
    if (/iPad/.test(ua)) return true;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }

  function landscapePitchSign() {
    return LANDSCAPE_PITCH_SIGN;
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
    if (global.matchMedia) {
      if (global.matchMedia('(orientation: portrait)').matches) return true;
      if (global.matchMedia('(orientation: landscape)').matches) return false;
    }
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    return a === 0 || a === 180;
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

  function landscapeFixLandscapeRight() {
    var cq1 = qFromAxisAngle(0, 1, 0, Math.PI / 2);
    var cq2 = qFromAxisAngle(1, 0, 0, -Math.PI / 2);
    return qMul(cq2, cq1);
  }

  function landscapeFixLandscapeLeft() {
    var cq1 = qFromAxisAngle(0, 1, 0, -Math.PI / 2);
    var cq2 = qFromAxisAngle(1, 0, 0, -Math.PI / 2);
    return qMul(cq2, cq1);
  }

  /** CTPanoramaView 方式（iPhone/iPad 共通） */
  function landscapeScreenFixQuat(screenAngleDeg) {
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    if (a === 90) return landscapeFixLandscapeRight();
    if (a === 270) return landscapeFixLandscapeLeft();
    return qFromAxisAngle(1, 0, 0, -Math.PI / 2);
  }

  function deviceQuatLandscape(rawEvent, screenAngleDeg) {
    var q = deviceEulerToQuat(rawEvent.alpha, rawEvent.beta, rawEvent.gamma);
    if (!q) return null;
    return qMul(landscapeScreenFixQuat(screenAngleDeg), q);
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

  function relativePitchFromQuat(qInit, qCurr) {
    var qRel = qMul(qConj(qInit), qCurr);
    var look = quatRotateVec(qRel, 0, 0, -1);
    return Math.atan2(look.y, Math.sqrt(look.x * look.x + look.z * look.z));
  }

  /** iPad 横画面: beta ベースの上下（クォータニオンが動かないときの予備） */
  function landscapePitchFromBeta(rawEvent, state) {
    if (rawEvent.beta == null || isNaN(rawEvent.beta)) return null;
    if (state.landscapeInitBeta == null) state.landscapeInitBeta = rawEvent.beta;
    state.landscapeFBeta = lp(state.landscapeFBeta, rawEvent.beta, SENSOR_LP);
    return clamp(
      degToRad(state.landscapeInitBeta - state.landscapeFBeta),
      -LANDSCAPE_PITCH_MAX,
      LANDSCAPE_PITCH_MAX
    );
  }

  function readHeadingDegPortrait(rawEvent) {
    if (typeof rawEvent.webkitCompassHeading === 'number' &&
        !isNaN(rawEvent.webkitCompassHeading)) {
      return rawEvent.webkitCompassHeading;
    }
    if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
      return rawEvent.alpha;
    }
    return null;
  }

  function readHeadingDegLandscape(rawEvent, screenAngleDeg) {
    var raw = null;
    if (typeof rawEvent.webkitCompassHeading === 'number' &&
        !isNaN(rawEvent.webkitCompassHeading)) {
      raw = rawEvent.webkitCompassHeading;
    } else if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
      raw = rawEvent.alpha;
    }
    if (raw == null) return null;
    return normalizeAngle360(raw - screenAngleDeg);
  }

  function resetOrientState(state) {
    state.initBeta = null;
    state.fBeta = null;
    state.initGamma = null;
    state.fGamma = null;
    state.prevHeading = null;
    state.initHeading = null;
    state.unwrappedHeading = 0;
    state.gammaYawDeg = 0;
    state.headingMode = true;
    state.lastHStepAbs = 0;
    state.qInit = null;
    state.fQuat = null;
    state.calibCount = 0;
    state.initPitchSample = null;
    state.landscapeInitBeta = null;
    state.landscapeFBeta = null;
    state.lastPitchOff = 0;
  }

  function trackYawFromHeading(heading, state) {
    var yawOff = 0;
    state.lastHStepAbs = 0;
    if (heading != null && state.prevHeading != null) {
      var hStep = heading - state.prevHeading;
      if (hStep > 180) hStep -= 360;
      if (hStep < -180) hStep += 360;
      state.lastHStepAbs = Math.abs(hStep);
      if (Math.abs(hStep) <= HEADING_SPIKE_DEG) {
        state.unwrappedHeading += hStep;
        state.prevHeading = heading;
      }
      if (state.initHeading != null) {
        yawOff = degToRad(state.unwrappedHeading - state.initHeading);
        state.headingMode = true;
      }
    }
    return yawOff;
  }

  function trackPortrait(rawEvent, state) {
    if (rawEvent.beta == null) return null;

    if (state.initBeta == null) {
      state.initBeta = rawEvent.beta;
      state.fBeta = rawEvent.beta;
      state.initGamma = rawEvent.gamma;
      state.fGamma = rawEvent.gamma;
      state.prevHeading = readHeadingDegPortrait(rawEvent);
      state.initHeading = state.prevHeading;
      state.unwrappedHeading = state.prevHeading != null ? state.prevHeading : 0;
      state.gammaYawDeg = 0;
      state.headingMode = state.prevHeading != null;
      return { ready: false };
    }

    state.fBeta = lp(state.fBeta, rawEvent.beta, SENSOR_LP);
    var pitchOff = clamp(degToRad(state.initBeta - state.fBeta), -MAX_PITCH_OFF, MAX_PITCH_OFF);

    var heading = readHeadingDegPortrait(rawEvent);
    var yawOff = trackYawFromHeading(heading, state);

    if (heading == null && rawEvent.gamma != null && state.initGamma != null) {
      state.fGamma = lp(state.fGamma, rawEvent.gamma, SENSOR_LP);
      state.gammaYawDeg = state.fGamma - state.initGamma;
      yawOff = degToRad(state.gammaYawDeg);
      state.headingMode = false;
    }

    return { ready: true, yawOff: yawOff, pitchOff: pitchOff, landscape: false };
  }

  /**
   * 横画面: 左右=コンパス、上下=クォータニオン差分
   * 開始時の pitch を 0 に合わせる（縦→横のずれ防止）
   * iPad は beta ベースも併用
   */
  function trackLandscape(rawEvent, screenAngleDeg, state) {
    var qCurr = deviceQuatLandscape(rawEvent, screenAngleDeg);
    if (!qCurr) return null;

    if (state.qInit == null) {
      state.calibCount = (state.calibCount || 0) + 1;
      if (state.calibCount < LANDSCAPE_CALIB_FRAMES) {
        return { ready: false };
      }
      state.qInit = qCurr;
      state.initPitchSample = null;
      state.landscapeInitBeta = rawEvent.beta;
      state.landscapeFBeta = rawEvent.beta;
      state.prevHeading = readHeadingDegLandscape(rawEvent, screenAngleDeg);
      state.initHeading = state.prevHeading;
      state.unwrappedHeading = state.prevHeading != null ? state.prevHeading : 0;
      state.initGamma = rawEvent.gamma;
      state.fGamma = rawEvent.gamma;
      state.gammaYawDeg = 0;
      state.headingMode = state.prevHeading != null;
      state.lastHStepAbs = 0;
      state.lastPitchOff = 0;
      return { ready: false };
    }

    var heading = readHeadingDegLandscape(rawEvent, screenAngleDeg);
    var yawOff = trackYawFromHeading(heading, state);

    if (heading == null && rawEvent.gamma != null && state.initGamma != null) {
      state.fGamma = lp(state.fGamma, rawEvent.gamma, SENSOR_LP);
      state.gammaYawDeg = state.fGamma - state.initGamma;
      yawOff = degToRad(state.gammaYawDeg);
      state.headingMode = false;
    }

    var pitchSample = relativePitchFromQuat(state.qInit, qCurr) * landscapePitchSign();
    if (state.initPitchSample == null) {
      state.initPitchSample = pitchSample;
    }
    var pitchOff = pitchSample - state.initPitchSample;

    if (isIPadDevice()) {
      var betaPitch = landscapePitchFromBeta(rawEvent, state);
      if (betaPitch != null) pitchOff = betaPitch;
    }

    if (state.lastHStepAbs > LANDSCAPE_YAW_IGNORE_PITCH) {
      pitchOff = state.lastPitchOff;
    } else {
      state.lastPitchOff = pitchOff;
    }

    pitchOff = clamp(pitchOff, -LANDSCAPE_PITCH_MAX, LANDSCAPE_PITCH_MAX);

    return {
      ready: true,
      yawOff: yawOff,
      pitchOff: pitchOff,
      landscape: true
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
      initBeta: null,
      fBeta: null,
      initGamma: null,
      fGamma: null,
      prevHeading: null,
      initHeading: null,
      unwrappedHeading: 0,
      gammaYawDeg: 0,
      headingMode: true,
      lastScreenAngle: getScreenAngleDeg(),
      lastTrackMode: null,
      lastHStepAbs: 0,
      qInit: null,
      fQuat: null,
      calibCount: 0,
      initPitchSample: null,
      landscapeInitBeta: null,
      landscapeFBeta: null,
      lastPitchOff: 0
    };

    this._bindOrientation();

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      if (self.hooks.onTick) self.hooks.onTick();
      var v = self.getView();
      if (!v || !self.latestEvent || !self.orientState) return;

      var screenAngle = getScreenAngleDeg();
      var portrait = isPortraitScreen(screenAngle);
      var trackMode = portrait ? 'portrait' : 'landscape';

      if (self.orientState.lastScreenAngle !== screenAngle ||
          self.orientState.lastTrackMode !== trackMode) {
        self.orientState.lastScreenAngle = screenAngle;
        self.orientState.lastTrackMode = trackMode;
        self._recalibrateForScreenRotate();
        return;
      }

      var o = portrait
        ? trackPortrait(self.latestEvent, self.orientState)
        : trackLandscape(self.latestEvent, screenAngle, self.orientState);
      if (!o || !o.ready) return;

      var targetYaw = self.base.viewYaw + o.yawOff;
      var relMax = o.landscape ? LANDSCAPE_PITCH_MAX : MAX_PITCH_OFF;
      var targetPitch = clamp(
        self.base.viewPitch + o.pitchOff,
        self.base.viewPitch - relMax,
        self.base.viewPitch + relMax
      );
      targetPitch = clamp(targetPitch, -Math.PI / 2, Math.PI / 2);

      var pitchSmooth = o.landscape ? LANDSCAPE_PITCH_SMOOTH : PITCH_SMOOTH;
      var pitchMaxStep = o.landscape ? LANDSCAPE_PITCH_MAX_STEP : PITCH_MAX_STEP;

      self.displayYaw = normalizeAngle(
        self.displayYaw + clamp(YAW_SMOOTH * angleDelta(self.displayYaw, targetYaw), -YAW_MAX_STEP, YAW_MAX_STEP)
      );
      self.displayPitch = clamp(
        self.displayPitch + clamp(pitchSmooth * (targetPitch - self.displayPitch), -pitchMaxStep, pitchMaxStep),
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
