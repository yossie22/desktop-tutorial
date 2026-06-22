/**
 * パノラマ用ジャイロ制御 v23
 * 縦画面: v13 そのまま
 * 横画面: 左右=コンパス、上下=beta の「変化量」を積み上げ
 * iPhone/iPad で beta の向きを切替
 * 詳細: vendor/gyro-STABLE-v23.txt
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

  var LANDSCAPE_PITCH_GAIN = 0.88;
  var LANDSCAPE_PITCH_SMOOTH = 0.14;
  var LANDSCAPE_PITCH_MAX_STEP = 0.015;
  var LANDSCAPE_PITCH_MAX = Math.PI * 55 / 180;
  var LANDSCAPE_PITCH_DELTA_MAX = Math.PI * 2.5 / 180;
  var LANDSCAPE_YAW_IGNORE_PITCH = 0.45;
  var BUILD = 'v23';

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

  /** 横画面の上下センサー（beta 度→ラジアン）iPhone/iPad で向きを切替 */
  function landscapePitchSampleRad(betaDeg, screenAngleDeg) {
    if (betaDeg == null || isNaN(betaDeg)) return null;
    var b = betaDeg;
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    var iphone = isIPhoneDevice();
    if (a === 90) return degToRad(iphone ? -b : b);
    if (a === 270) return degToRad(iphone ? b : -b);
    return degToRad(iphone ? -b : b);
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
    state.pitchIntegral = null;
    state.prevPitchSample = null;
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
   * 横画面: 上下は beta の「変化量」を積み上げ
   * gamma は横画面で端に張り付くため beta を使う。
   * 左右を向いている間は上下を止める。
   */
  function trackLandscape(rawEvent, screenAngleDeg, state) {
    if (rawEvent.beta == null || isNaN(rawEvent.beta)) return null;

    if (state.pitchIntegral == null) {
      state.pitchIntegral = 0;
      state.initBeta = rawEvent.beta;
      state.fBeta = rawEvent.beta;
      state.prevPitchSample = landscapePitchSampleRad(state.fBeta, screenAngleDeg);
      state.initGamma = rawEvent.gamma;
      state.fGamma = rawEvent.gamma;
      state.prevHeading = readHeadingDegLandscape(rawEvent, screenAngleDeg);
      state.initHeading = state.prevHeading;
      state.unwrappedHeading = state.prevHeading != null ? state.prevHeading : 0;
      state.gammaYawDeg = 0;
      state.headingMode = state.prevHeading != null;
      state.lastHStepAbs = 0;
      return { ready: false };
    }

    state.fBeta = lp(state.fBeta, rawEvent.beta, SENSOR_LP);

    var heading = readHeadingDegLandscape(rawEvent, screenAngleDeg);
    var yawOff = trackYawFromHeading(heading, state);

    if (heading == null && rawEvent.gamma != null && state.initGamma != null) {
      state.fGamma = lp(state.fGamma, rawEvent.gamma, SENSOR_LP);
      state.gammaYawDeg = state.fGamma - state.initGamma;
      yawOff = degToRad(state.gammaYawDeg);
      state.headingMode = false;
    }

    var pitchSample = landscapePitchSampleRad(state.fBeta, screenAngleDeg);
    if (pitchSample == null) return null;

    var sampleDelta = pitchSample - state.prevPitchSample;
    state.prevPitchSample = pitchSample;
    sampleDelta = clamp(sampleDelta, -LANDSCAPE_PITCH_DELTA_MAX, LANDSCAPE_PITCH_DELTA_MAX);

    if (state.lastHStepAbs > LANDSCAPE_YAW_IGNORE_PITCH) {
      sampleDelta = 0;
    }

    state.pitchIntegral += sampleDelta * LANDSCAPE_PITCH_GAIN;
    state.pitchIntegral = clamp(state.pitchIntegral, -LANDSCAPE_PITCH_MAX, LANDSCAPE_PITCH_MAX);

    return {
      ready: true,
      yawOff: yawOff,
      pitchOff: state.pitchIntegral,
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
      pitchIntegral: null,
      prevPitchSample: null
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
