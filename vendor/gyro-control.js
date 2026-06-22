/**
 * パノラマ用ジャイロ制御 v14
 * v13 の平滑化を維持し、縦・横画面どちらでも追従（画面向きで beta/gamma/コンパスを補正）
 * 画面回転時は見え方を保ったまま再キャリブレーション
 * 詳細: vendor/gyro-STABLE-v14.txt
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.040;
  var HEADING_SPIKE_DEG = 55;
  var SENSOR_LP = 0.22;
  var BUILD = 'v14';

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

  /** 端末座標の傾きを、今の画面の上下左右に合わせて入れ替える */
  function remapTiltForScreen(beta, gamma, screenAngleDeg) {
    if (beta == null) return { beta: null, gamma: gamma };
    var g = gamma == null ? 0 : gamma;
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    if (a === 90) return { beta: g, gamma: -beta };
    if (a === 180) return { beta: -beta, gamma: -g };
    if (a === 270) return { beta: -g, gamma: beta };
    return { beta: beta, gamma: g };
  }

  /** コンパスを「画面の上端」基準の角度に変換 */
  function screenRelativeHeading(heading, screenAngleDeg) {
    if (heading == null || isNaN(heading)) return null;
    return normalizeAngle360(heading - screenAngleDeg);
  }

  function normalizeSensorEvent(rawEvent) {
    if (!rawEvent || rawEvent.beta == null) return null;
    var screenAngle = getScreenAngleDeg();
    var tilt = remapTiltForScreen(rawEvent.beta, rawEvent.gamma, screenAngle);
    var screenHeading = null;
    if (typeof rawEvent.webkitCompassHeading === 'number' &&
        !isNaN(rawEvent.webkitCompassHeading)) {
      screenHeading = screenRelativeHeading(rawEvent.webkitCompassHeading, screenAngle);
    } else if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
      screenHeading = screenRelativeHeading(rawEvent.alpha, screenAngle);
    }
    return {
      beta: tilt.beta,
      gamma: tilt.gamma,
      screenHeading: screenHeading,
      screenAngle: screenAngle
    };
  }

  function readHeadingDeg(normalized) {
    if (!normalized) return null;
    return normalized.screenHeading;
  }

  function trackOrientation(normalized, state) {
    if (!normalized || normalized.beta == null) return null;

    if (state.initBeta == null) {
      state.initBeta = normalized.beta;
      state.fBeta = normalized.beta;
      state.initGamma = normalized.gamma;
      state.fGamma = normalized.gamma;
      state.prevHeading = readHeadingDeg(normalized);
      state.initHeading = state.prevHeading;
      state.unwrappedHeading = state.prevHeading != null ? state.prevHeading : 0;
      state.gammaYawDeg = 0;
      state.headingMode = state.prevHeading != null;
      return { ready: false };
    }

    state.fBeta = lp(state.fBeta, normalized.beta, SENSOR_LP);
    var pitchOff = degToRad(state.initBeta - state.fBeta);

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
    if (view && this.base) {
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

      var normalized = normalizeSensorEvent(self.latestEvent);
      var o = trackOrientation(normalized, self.orientState);
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
