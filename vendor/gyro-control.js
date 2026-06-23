/**
 * パノラマ用ジャイロ制御 v42
 * 縦画面: v13 ベース（逆さ180°補正）
 * 横画面: 左右=コンパス、上下=クォータニオン（90°/270°で符号分岐）
 * v42: 切替時コンパス差分吸収、左横・逆さ縦の上下左右補正
 * 詳細: vendor/gyro-STABLE-v42.txt
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

  var LANDSCAPE_PITCH_SMOOTH = 0.14;
  var LANDSCAPE_PITCH_MAX_STEP = 0.015;
  var LANDSCAPE_PITCH_UP = Math.PI * 82 / 180;
  var LANDSCAPE_PITCH_DOWN = Math.PI * 82 / 180;
  var LANDSCAPE_YAW_IGNORE_PITCH = 0.45;
  var LANDSCAPE_PITCH_YAW_DECOUPLE = 0.04;
  var LANDSCAPE_CALIB_FRAMES = 6;
  var SWITCH_SETTLE_FRAMES = 45;
  var SWITCH_STABLE_FRAMES = 40;
  var ROTATE_BETA_JUMP_DEG = 10;
  var BUILD = 'v42';

  function isLandscapeAngleDeg(screenAngleDeg) {
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    return a === 90 || a === 270;
  }

  function isPortraitAngleDeg(screenAngleDeg) {
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    return a === 0 || a === 180;
  }

  function isIPadDevice() {
    var ua = navigator.userAgent || '';
    if (/iPad/.test(ua)) return true;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }

  /** portrait / landscape（iPad でも止まらないよう matchMedia 優先） */
  function resolveTrackMode(screenAngleDeg) {
    if (global.matchMedia) {
      if (global.matchMedia('(orientation: portrait)').matches) return 'portrait';
      if (global.matchMedia('(orientation: landscape)').matches) return 'landscape';
    }
    if (isPortraitAngleDeg(screenAngleDeg)) return 'portrait';
    if (isLandscapeAngleDeg(screenAngleDeg)) return 'landscape';
    return 'portrait';
  }

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

  function landscapePitchSign(screenAngleDeg) {
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    if (a === 270) return 1;
    return -1;
  }

  function portraitAxisSign(screenAngleDeg) {
    return Math.round(normalizeAngle360(screenAngleDeg)) === 180 ? -1 : 1;
  }

  function beginSwitchStable(state) {
    if (state.pendingStable) {
      state.switchStableFrames = SWITCH_STABLE_FRAMES;
      state.pendingStable = false;
    }
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
    return resolveTrackMode(screenAngleDeg) === 'portrait';
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

  function landscapeScreenFixQuat(screenAngleDeg) {
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    if (isIPadDevice()) {
      if (a === 90) return landscapeFixLandscapeLeft();
      if (a === 270) return landscapeFixLandscapeRight();
    } else {
      if (a === 90) return landscapeFixLandscapeRight();
      if (a === 270) return landscapeFixLandscapeLeft();
    }
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
    if (isIPadDevice()) {
      var sinp = 2 * (qRel.w * qRel.x - qRel.y * qRel.z);
      return Math.asin(clamp(sinp, -1, 1));
    }
    var look = quatRotateVec(qRel, 0, 0, -1);
    return Math.atan2(look.y, Math.sqrt(look.x * look.x + look.z * look.z));
  }

  function syncHeadingBaseline(state, heading) {
    state.initHeading = heading;
    state.prevHeading = heading;
    state.unwrappedHeading = heading != null ? heading : 0;
    state.headingMode = heading != null;
  }

  function syncHeadingWithSwitchHold(state, heading) {
    if (heading == null) {
      syncHeadingBaseline(state, heading);
      state.switchCompassHold = null;
      return;
    }
    if (state.switchCompassHold != null) {
      var refJump = heading - state.switchCompassHold;
      if (refJump > 180) refJump -= 360;
      if (refJump < -180) refJump += 360;
      state.initHeading = normalizeAngle360(heading - refJump);
      state.unwrappedHeading = state.initHeading;
      state.prevHeading = heading;
      state.headingMode = true;
      state.switchCompassHold = null;
    } else {
      syncHeadingBaseline(state, heading);
    }
  }

  function isSettling(state) {
    return state.settleFrames > 0;
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
    state.calibCount = 0;
    state.landscapePrimed = false;
    state.landscapeReady = false;
    state.lastPitchOff = 0;
    state.portraitReady = false;
    state.prevRotateBeta = null;
    state.settleFrames = 0;
    state.switchStableFrames = 0;
    state.pendingStable = false;
    state.switchCompassHold = null;
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

  function isDeviceRotating(rawEvent, state) {
    if (rawEvent.beta == null || isNaN(rawEvent.beta)) return false;
    if (state.prevRotateBeta == null) {
      state.prevRotateBeta = rawEvent.beta;
      return false;
    }
    var jump = Math.abs(rawEvent.beta - state.prevRotateBeta);
    state.prevRotateBeta = rawEvent.beta;
    return jump > ROTATE_BETA_JUMP_DEG;
  }

  function readHeadingDegLandscape(rawEvent, screenAngleDeg) {
    var portraitHeading = readHeadingDegPortrait(rawEvent);
    if (portraitHeading != null) return portraitHeading;
    if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
      return normalizeAngle360(rawEvent.alpha - screenAngleDeg);
    }
    return null;
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

  function trackPortrait(rawEvent, screenAngleDeg, state) {
    if (rawEvent.beta == null) return null;

    var axisSign = portraitAxisSign(screenAngleDeg);

    if (state.initBeta == null) {
      state.initBeta = rawEvent.beta;
      state.fBeta = rawEvent.beta;
      state.initGamma = rawEvent.gamma;
      state.fGamma = rawEvent.gamma;
      state.gammaYawDeg = 0;
      state.prevRotateBeta = rawEvent.beta;
      state.portraitReady = false;
      return { ready: false };
    }

    state.fBeta = lp(state.fBeta, rawEvent.beta, SENSOR_LP);
    var pitchOff = clamp(
      degToRad(state.initBeta - state.fBeta) * axisSign,
      -MAX_PITCH_DOWN,
      MAX_PITCH_UP
    );

    if (isSettling(state)) {
      return {
        ready: true,
        yawOff: 0,
        pitchOff: 0,
        landscape: false,
        pitchDownMax: MAX_PITCH_DOWN,
        pitchUpMax: MAX_PITCH_UP
      };
    }

    var heading = readHeadingDegPortrait(rawEvent);
    var yawOff = 0;

    if (!state.portraitReady) {
      syncHeadingWithSwitchHold(state, heading);
      state.initBeta = state.fBeta;
      state.portraitReady = true;
      beginSwitchStable(state);
      yawOff = 0;
      pitchOff = 0;
    } else if (isDeviceRotating(rawEvent, state)) {
      yawOff = 0;
      pitchOff = 0;
    } else {
      yawOff = trackYawFromHeading(heading, state) * axisSign;
    }

    if (heading == null && rawEvent.gamma != null && state.initGamma != null) {
      state.fGamma = lp(state.fGamma, rawEvent.gamma, SENSOR_LP);
      state.gammaYawDeg = state.fGamma - state.initGamma;
      yawOff = degToRad(state.gammaYawDeg) * axisSign;
      state.headingMode = false;
    }

    return {
      ready: true,
      yawOff: yawOff,
      pitchOff: pitchOff,
      landscape: false,
      pitchDownMax: MAX_PITCH_DOWN,
      pitchUpMax: MAX_PITCH_UP
    };
  }

  /**
   * 横画面: 左右=コンパス、上下=クォータニオン
   */
  function trackLandscape(rawEvent, screenAngleDeg, state) {
    var qCurr = deviceQuatLandscape(rawEvent, screenAngleDeg);
    if (!qCurr) return null;

    if (isSettling(state)) {
      return {
        ready: true,
        yawOff: 0,
        pitchOff: 0,
        landscape: true,
        pitchDownMax: LANDSCAPE_PITCH_DOWN,
        pitchUpMax: LANDSCAPE_PITCH_UP
      };
    }

    if (!state.landscapePrimed) {
      state.calibCount = (state.calibCount || 0) + 1;
      if (state.calibCount < LANDSCAPE_CALIB_FRAMES) {
        return { ready: false };
      }
      state.landscapePrimed = true;
      state.lastHStepAbs = 0;
      return { ready: false };
    }

    var heading = readHeadingDegLandscape(rawEvent, screenAngleDeg);
    var yawOff = 0;
    var pitchOff = 0;

    if (!state.landscapeReady) {
      state.qInit = qCurr;
      state.initGamma = rawEvent.gamma;
      state.fGamma = rawEvent.gamma;
      state.gammaYawDeg = 0;
      state.landscapeReady = true;
      syncHeadingWithSwitchHold(state, heading);
      beginSwitchStable(state);
      state.lastPitchOff = 0;
      yawOff = 0;
      pitchOff = 0;
    } else {
      pitchOff = clamp(
        relativePitchFromQuat(state.qInit, qCurr) * landscapePitchSign(screenAngleDeg),
        -LANDSCAPE_PITCH_DOWN,
        LANDSCAPE_PITCH_UP
      );
      if (Math.abs(pitchOff - state.lastPitchOff) > LANDSCAPE_PITCH_YAW_DECOUPLE) {
        syncHeadingBaseline(state, heading);
        yawOff = 0;
      } else if (heading == null && rawEvent.gamma != null && state.initGamma != null) {
        state.fGamma = lp(state.fGamma, rawEvent.gamma, SENSOR_LP);
        state.gammaYawDeg = state.fGamma - state.initGamma;
        yawOff = degToRad(state.gammaYawDeg);
        state.headingMode = false;
      } else {
        yawOff = trackYawFromHeading(heading, state);
      }
      state.lastPitchOff = pitchOff;
    }

    return {
      ready: true,
      yawOff: yawOff,
      pitchOff: pitchOff,
      landscape: true,
      pitchDownMax: LANDSCAPE_PITCH_DOWN,
      pitchUpMax: LANDSCAPE_PITCH_UP
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
    var view = this.getView();
    if (this.base) {
      this.base.viewYaw = this.displayYaw;
      this.base.viewPitch = this.displayPitch;
    } else if (view) {
      this.base = { viewYaw: view.yaw(), viewPitch: view.pitch() };
      this.displayYaw = this.base.viewYaw;
      this.displayPitch = this.base.viewPitch;
    }
    if (this.orientState) {
      if (this.orientState.settleFrames > 0) return;
      var holdHeading = null;
      if (this.latestEvent) {
        holdHeading = readHeadingDegPortrait(this.latestEvent);
      }
      resetOrientState(this.orientState);
      if (holdHeading != null) {
        this.orientState.switchCompassHold = holdHeading;
      }
      this.orientState.settleFrames = SWITCH_SETTLE_FRAMES;
      this.orientState.pendingStable = true;
    }
    if (view) {
      view.setYaw(this.displayYaw);
      view.setPitch(this.displayPitch);
    }
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
      calibCount: 0,
      landscapePrimed: false,
      landscapeReady: false,
      lastPitchOff: 0,
      portraitReady: false,
      prevRotateBeta: null,
      settleFrames: 0,
      switchStableFrames: 0,
      pendingStable: false,
      switchCompassHold: null
    };

    this._bindOrientation();

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      if (self.hooks.onTick) self.hooks.onTick();
      var v = self.getView();
      if (!v || !self.latestEvent || !self.orientState) return;

      var screenAngle = getScreenAngleDeg();
      var trackMode = resolveTrackMode(screenAngle);
      var portrait = trackMode === 'portrait';

      if (self.orientState.lastTrackMode !== trackMode) {
        self.orientState.lastScreenAngle = screenAngle;
        self.orientState.lastTrackMode = trackMode;
        self._recalibrateForScreenRotate();
        return;
      }
      self.orientState.lastScreenAngle = screenAngle;

      var o = portrait
        ? trackPortrait(self.latestEvent, screenAngle, self.orientState)
        : trackLandscape(self.latestEvent, screenAngle, self.orientState);

      if (self.orientState.settleFrames > 0 ||
          self.orientState.switchStableFrames > 0 ||
          self.orientState.pendingStable) {
        self.displayYaw = self.base.viewYaw;
        self.displayPitch = self.base.viewPitch;
        v.setYaw(self.displayYaw);
        v.setPitch(self.displayPitch);
      }

      if (!o || !o.ready) {
        if (self.orientState.settleFrames > 0) {
          self.orientState.settleFrames--;
        }
        return;
      }

      if (self.orientState.settleFrames > 0) {
        o.yawOff = 0;
        o.pitchOff = 0;
        self.orientState.settleFrames--;
        self.displayYaw = self.base.viewYaw;
        self.displayPitch = self.base.viewPitch;
      }

      if (self.orientState.switchStableFrames > 0) {
        o.yawOff = 0;
        o.pitchOff = 0;
        self.orientState.switchStableFrames--;
        self.displayYaw = self.base.viewYaw;
        self.displayPitch = self.base.viewPitch;
      }

      var targetYaw = self.base.viewYaw + o.yawOff;
      var pitchDownMax = o.pitchDownMax || MAX_PITCH_DOWN;
      var pitchUpMax = o.pitchUpMax || MAX_PITCH_UP;
      var targetPitch = clamp(
        self.base.viewPitch + o.pitchOff,
        self.base.viewPitch - pitchDownMax,
        self.base.viewPitch + pitchUpMax
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
