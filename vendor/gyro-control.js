/**
 * パノラマ用ジャイロ制御（look.html / viewer.html 共通）
 * v4: alpha アンラップ + 急回転ガード
 */
(function(global) {
  'use strict';

  var GYRO_SMOOTH = 0.24;

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

  function trackOrientation(e, state) {
    if (e.alpha == null || e.beta == null) return null;
    if (state.prevAlpha == null) {
      state.prevAlpha = e.alpha;
      state.unwrappedAlpha = e.alpha;
      state.initUnwrappedAlpha = e.alpha;
      state.initBeta = e.beta;
      return { ready: false };
    }
    var alphaStep = e.alpha - state.prevAlpha;
    if (alphaStep > 180) alphaStep -= 360;
    if (alphaStep < -180) alphaStep += 360;
    if (Math.abs(alphaStep) > 55) return null;
    state.unwrappedAlpha += alphaStep;
    state.prevAlpha = e.alpha;
    return {
      ready: true,
      yawOff: degToRad(state.initUnwrappedAlpha - state.unwrappedAlpha),
      pitchOff: degToRad(state.initBeta - e.beta)
    };
  }

  function GyroControl(getView) {
    this.getView = getView;
    this.enabled = false;
    this.handler = null;
    this.raf = null;
    this.latestEvent = null;
    this.base = null;
    this.onChange = null;
  }

  GyroControl.prototype.setOnChange = function(fn) {
    this.onChange = fn;
  };

  GyroControl.prototype._emit = function() {
    if (this.onChange) this.onChange(this.enabled);
  };

  GyroControl.prototype.stop = function() {
    if (this.handler) {
      global.removeEventListener('deviceorientation', this.handler, true);
      this.handler = null;
    }
    if (this.raf) {
      global.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.latestEvent = null;
    this.base = null;
    if (this.enabled) {
      this.enabled = false;
      this._emit();
    }
  };

  GyroControl.prototype.start = function() {
    var view = this.getView();
    if (!view) return false;
    this.stop();
    this.enabled = true;
    this.base = { viewYaw: view.yaw(), viewPitch: view.pitch() };
    this.latestEvent = null;
    var self = this;
    var displayYaw = view.yaw();
    var displayPitch = view.pitch();
    var orientState = {
      prevAlpha: null,
      unwrappedAlpha: 0,
      initUnwrappedAlpha: 0,
      initBeta: 0
    };
    var lastTargetYaw = null;
    var lastTargetPitch = null;

    this.handler = function(e) { self.latestEvent = e; };
    global.addEventListener('deviceorientation', this.handler, true);

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      var v = self.getView();
      if (!v || !self.latestEvent) return;
      var o = trackOrientation(self.latestEvent, orientState);
      if (!o) return;
      if (!o.ready) {
        displayYaw = self.base.viewYaw;
        displayPitch = self.base.viewPitch;
        lastTargetYaw = displayYaw;
        lastTargetPitch = displayPitch;
        return;
      }
      var targetYaw = self.base.viewYaw + o.yawOff;
      var targetPitch = clamp(self.base.viewPitch + o.pitchOff, -Math.PI / 2, Math.PI / 2);
      if (lastTargetYaw != null) {
        if (Math.abs(angleDelta(lastTargetYaw, targetYaw)) > 0.9) return;
        if (Math.abs(targetPitch - lastTargetPitch) > 0.9) return;
      }
      lastTargetYaw = targetYaw;
      lastTargetPitch = targetPitch;
      displayYaw = normalizeAngle(displayYaw + GYRO_SMOOTH * angleDelta(displayYaw, targetYaw));
      displayPitch = displayPitch + GYRO_SMOOTH * (targetPitch - displayPitch);
      displayPitch = clamp(displayPitch, -Math.PI / 2, Math.PI / 2);
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
