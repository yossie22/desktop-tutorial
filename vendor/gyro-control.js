/**
 * パノラマ用ジャイロ制御 v9
 * 上下: beta（安定）
 * 左右: その場の動きが大きい方を採用（体の回転=alpha / iPadの傾き=gamma）
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.038;
  var ALPHA_SPIKE_DEG = 72;
  var SENSOR_LP = 0.22;

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

  function trackOrientation(e, state) {
    if (e.beta == null || e.gamma == null) return null;

    if (state.initBeta == null) {
      state.initBeta = e.beta;
      state.fBeta = e.beta;
      state.prevGamma = e.gamma;
      state.prevAlpha = e.alpha;
      state.unwrappedAlpha = e.alpha != null ? e.alpha : 0;
      state.yawOff = 0;
      return { ready: false };
    }

    state.fBeta = lp(state.fBeta, e.beta, SENSOR_LP);
    var pitchOff = degToRad(state.initBeta - state.fBeta);

    var dGamma = e.gamma - state.prevGamma;
    state.prevGamma = e.gamma;

    var alphaStep = 0;
    var alphaOk = false;
    if (e.alpha != null && state.prevAlpha != null) {
      alphaStep = e.alpha - state.prevAlpha;
      if (alphaStep > 180) alphaStep -= 360;
      if (alphaStep < -180) alphaStep += 360;
      if (Math.abs(alphaStep) <= ALPHA_SPIKE_DEG) {
        alphaOk = true;
        state.unwrappedAlpha += alphaStep;
        state.prevAlpha = e.alpha;
      }
    }

    var stepYawDeg = 0;
    if (Math.abs(dGamma) >= Math.abs(alphaOk ? alphaStep : 0)) {
      stepYawDeg = dGamma;
    } else if (alphaOk) {
      stepYawDeg = -alphaStep;
    }

    state.yawOff = normalizeAngle(state.yawOff + degToRad(stepYawDeg));

    return { ready: true, yawOff: state.yawOff, pitchOff: pitchOff };
  }

  function GyroControl(getView) {
    this.getView = getView;
    this.enabled = false;
    this.handler = null;
    this.raf = null;
    this.latestEvent = null;
    this.base = null;
    this.onChange = null;
    this.hooks = {};
  }

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
    if (this.handler) {
      global.removeEventListener('deviceorientation', this.handler, true);
      this.handler = null;
    }
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
      prevGamma: null,
      prevAlpha: null,
      unwrappedAlpha: 0,
      yawOff: 0
    };

    this.handler = function(e) { self.latestEvent = e; };
    global.addEventListener('deviceorientation', this.handler, true);

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
