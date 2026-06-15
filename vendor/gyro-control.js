/**
 * パノラマ用ジャイロ制御 v13 【安定版・本番用】
 * 確定日: 2026-06-14（iPad 実機で上下と同程度の安定性を確認）
 * 上下: beta + 平滑化
 * 左右: iPad コンパス（webkitCompassHeading）→ alpha → gamma
 * 詳細: vendor/gyro-STABLE-v13.txt を参照（数値・手順・注意）
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.040;
  var HEADING_SPIKE_DEG = 55;
  var SENSOR_LP = 0.22;
  var BUILD = 'v13';

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

  function readHeadingDeg(e) {
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      return e.webkitCompassHeading;
    }
    if (e.alpha != null && !isNaN(e.alpha)) {
      return e.alpha;
    }
    return null;
  }

  function trackOrientation(e, state) {
    if (e.beta == null) return null;

    if (state.initBeta == null) {
      state.initBeta = e.beta;
      state.fBeta = e.beta;
      state.initGamma = e.gamma;
      state.fGamma = e.gamma;
      state.prevHeading = readHeadingDeg(e);
      state.initHeading = state.prevHeading;
      state.unwrappedHeading = state.prevHeading;
      state.gammaYawDeg = 0;
      state.headingMode = state.prevHeading != null;
      return { ready: false };
    }

    state.fBeta = lp(state.fBeta, e.beta, SENSOR_LP);
    var pitchOff = degToRad(state.initBeta - state.fBeta);

    var heading = readHeadingDeg(e);
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
    } else if (e.gamma != null && state.initGamma != null) {
      state.fGamma = lp(state.fGamma, e.gamma, SENSOR_LP);
      state.gammaYawDeg = state.fGamma - state.initGamma;
      yawOff = degToRad(state.gammaYawDeg);
      state.headingMode = false;
    }

    return { ready: true, yawOff: yawOff, pitchOff: pitchOff, headingMode: state.headingMode };
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
    var self = this;
    this.handlers.forEach(function(item) {
      global.removeEventListener(item.type, item.fn, true);
    });
    this.handlers = [];
    if (this.raf) {
      global.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.latestEvent = null;
  };

  GyroControl.prototype.stop = function() {
    var wasOn = this.enabled;
    this._cleanupListeners();
    this.base = null;
    this.enabled = false;
    if (wasOn) {
      if (this.hooks.onStop) this.hooks.onStop();
      this._emit();
    }
  };

  GyroControl.prototype._bindOrientation = function() {
    var self = this;
    var fn = function(e) { self.latestEvent = e; };
    ['deviceorientationabsolute', 'deviceorientation'].forEach(function(type) {
      global.addEventListener(type, fn, true);
      self.handlers.push({ type: type, fn: fn });
    });
  };

  GyroControl.prototype.start = function() {
    var view = this.getView();
    if (!view) return false;
    var wasOn = this.enabled;
    this._cleanupListeners();
    this.enabled = true;
    this.base = { viewYaw: view.yaw(), viewPitch: view.pitch() };
    if (!wasOn && this.hooks.onStart) this.hooks.onStart();

    var self = this;
    var displayYaw = view.yaw();
    var displayPitch = view.pitch();
    var orientState = {
      initBeta: null,
      fBeta: null,
      initGamma: null,
      fGamma: null,
      prevHeading: null,
      initHeading: null,
      unwrappedHeading: 0,
      gammaYawDeg: 0,
      headingMode: true
    };

    this._bindOrientation();

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      if (self.hooks.onTick) self.hooks.onTick();
      var v = self.getView();
      if (!v || !self.latestEvent) return;
      var o = trackOrientation(self.latestEvent, orientState);
      if (!o || !o.ready) return;
      var targetYaw = self.base.viewYaw + o.yawOff;
      var targetPitch = clamp(self.base.viewPitch + o.pitchOff, -Math.PI / 2, Math.PI / 2);
      displayYaw = normalizeAngle(
        displayYaw + clamp(YAW_SMOOTH * angleDelta(displayYaw, targetYaw), -YAW_MAX_STEP, YAW_MAX_STEP)
      );
      displayPitch = clamp(
        displayPitch + clamp(PITCH_SMOOTH * (targetPitch - displayPitch), -PITCH_MAX_STEP, PITCH_MAX_STEP),
        -Math.PI / 2,
        Math.PI / 2
      );
      v.setYaw(displayYaw);
      v.setPitch(displayPitch);
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
