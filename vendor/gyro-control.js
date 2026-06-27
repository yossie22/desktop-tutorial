/**
 * パノラマ用ジャイロ制御 v73
 * v72 ＋ 縦↔横ロールを即検出、必ずOFF→y/p復元→自動ON
 * 詳細: vendor/gyro-STABLE-v73.txt
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.040;
  var HEADING_SPIKE_DEG = 55;
  var PITCH_SPIKE_DEG = 20;
  var SENSOR_LP = 0.22;
  var STARTUP_SETTLE_FRAMES = 20;
  var ROLL_RESTART_DELAY_MS = 650;
  var LOCK_JUMP_REJECT_DEG = 8;
  var BUILD = 'v73';
  var LANDSCAPE_RIGHT_CUR = 90;
  var LANDSCAPE_LEFT_CUR = 270;

  function degToRad(d) { return d * Math.PI / 180; }
  function radToDeg(r) { return r * 180 / Math.PI; }
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
    if (typeof global.orientation === 'number' && !isNaN(global.orientation)) {
      return normalizeAngle360(global.orientation);
    }
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.angle === 'number') {
      return normalizeAngle360(global.screen.orientation.angle);
    }
    return 0;
  }

  function snapScreenAngleDeg(deg, prev) {
    var d = normalizeAngle360(deg);
    var candidates = [0, 90, 180, 270];
    var best = d;
    var bestDist = 999;
    var i;
    for (i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var dist = Math.abs(d - c);
      if (dist > 180) dist = 360 - dist;
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    if (prev != null) {
      var hold = Math.abs(d - prev);
      if (hold > 180) hold = 360 - hold;
      if (hold < 28) return prev;
    }
    if (bestDist <= 40) return best;
    return d;
  }

  function remapTiltForScreen(beta, gamma, screenAngleDeg) {
    if (beta == null) return { beta: null, gamma: gamma };
    var g = gamma == null ? 0 : gamma;
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    if (a === 90) return { beta: g, gamma: -beta };
    if (a === 180) return { beta: -beta, gamma: -g };
    if (a === 270) return { beta: -g, gamma: beta };
    return { beta: beta, gamma: g };
  }

  function screenRelativeHeading(heading, screenAngleDeg) {
    if (heading == null || isNaN(heading)) return null;
    return normalizeAngle360(heading - screenAngleDeg);
  }

  function hasCompassHeading(rawEvent) {
    return typeof rawEvent.webkitCompassHeading === 'number' &&
      !isNaN(rawEvent.webkitCompassHeading);
  }

  function detectHeadingSource(rawEvent) {
    if (hasCompassHeading(rawEvent)) return 'compass';
    if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) return 'alpha';
    return 'gamma';
  }

  function readHeadingFromEvent(rawEvent, screenAngleDeg, headingSource) {
    if (headingSource === 'gamma') return null;
    if (headingSource === 'compass' && hasCompassHeading(rawEvent)) {
      return normalizeAngle360(rawEvent.webkitCompassHeading);
    }
    if (headingSource === 'alpha' && rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
      return screenRelativeHeading(rawEvent.alpha, screenAngleDeg);
    }
    if (!headingSource) {
      if (hasCompassHeading(rawEvent)) {
        return normalizeAngle360(rawEvent.webkitCompassHeading);
      }
      if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
        return screenRelativeHeading(rawEvent.alpha, screenAngleDeg);
      }
    }
    return null;
  }

  function normalizeSensorEvent(rawEvent, screenAngleDeg, headingSource) {
    if (!rawEvent || rawEvent.beta == null) return null;
    var screenAngle = normalizeAngle360(screenAngleDeg);
    var tilt = remapTiltForScreen(rawEvent.beta, rawEvent.gamma, screenAngle);
    return {
      beta: tilt.beta,
      gamma: tilt.gamma,
      screenHeading: readHeadingFromEvent(rawEvent, screenAngle, headingSource),
      screenAngle: screenAngle
    };
  }

  function readHeadingDeg(normalized) {
    if (!normalized) return null;
    return normalized.screenHeading;
  }

  function snapRollAngleDeg(deg) {
    var d = normalizeAngle360(deg);
    var candidates = [0, 90, 180, 270];
    var best = 0;
    var bestDist = 999;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var dist = Math.abs(d - c);
      if (dist > 180) dist = 360 - dist;
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    return best;
  }

  function isPortraitRoll(cur) {
    var c = normalizeAngle360(cur);
    return c === 0 || c === 180;
  }

  function isLandscapeRoll(cur) {
    return isLandscapeScreen(cur);
  }

  function isRollBetweenOrientations(fromCur, toCur) {
    if (fromCur == null || toCur == null) return false;
    if (fromCur === toCur) return false;
    return (isPortraitRoll(fromCur) && isLandscapeRoll(toCur)) ||
      (isLandscapeRoll(fromCur) && isPortraitRoll(toCur));
  }

  function pitchNeedsInvert(screenAngle) {
    var a = normalizeAngle360(screenAngle);
    return a === LANDSCAPE_RIGHT_CUR || a === LANDSCAPE_LEFT_CUR;
  }

  function isLandscapeScreen(screenAngle) {
    var a = normalizeAngle360(screenAngle);
    return a === LANDSCAPE_RIGHT_CUR || a === LANDSCAPE_LEFT_CUR;
  }

  function boostPitchOff(pitchOff, screenAngle) {
    var deg = radToDeg(pitchOff);
    if (isLandscapeScreen(screenAngle)) {
      if (deg < 0) deg *= 1.58;
      else if (deg > 0) deg *= 1.15;
    } else {
      if (deg < 0) deg *= 1.32;
    }
    return degToRad(deg);
  }

  function pitchClampLimits(screenAngle) {
    if (isLandscapeScreen(screenAngle)) {
      return { min: degToRad(-88), max: degToRad(74) };
    }
    return { min: degToRad(-89), max: degToRad(80) };
  }

  function resetSensorBaseline(state) {
    state.initBeta = null;
    state.fBeta = null;
    state.initGamma = null;
    state.fGamma = null;
    state.prevHeading = null;
    state.initHeading = null;
    state.unwrappedHeading = 0;
    state.gammaYawDeg = 0;
    state.lastPitchOffDeg = null;
  }

  function trackOrientation(normalized, state) {
    if (!normalized || normalized.beta == null) return null;

    var useHeading = state.headingSource !== 'gamma';

    if (state.initBeta == null) {
      state.initBeta = normalized.beta;
      state.fBeta = normalized.beta;
      state.initGamma = normalized.gamma;
      state.fGamma = normalized.gamma;
      state.prevHeading = useHeading ? readHeadingDeg(normalized) : null;
      state.initHeading = state.prevHeading;
      state.unwrappedHeading = state.prevHeading != null ? state.prevHeading : 0;
      state.gammaYawDeg = 0;
      state.headingMode = useHeading && state.prevHeading != null;
      state.lastPitchOffDeg = null;
      return { ready: false };
    }

    state.fBeta = lp(state.fBeta, normalized.beta, SENSOR_LP);
    var pitchOff = degToRad(state.initBeta - state.fBeta);
    if (pitchNeedsInvert(normalized.screenAngle)) {
      pitchOff = -pitchOff;
      var pitchOffDeg = radToDeg(pitchOff);
      if (state.lastPitchOffDeg != null &&
          Math.abs(pitchOffDeg - state.lastPitchOffDeg) > PITCH_SPIKE_DEG) {
        pitchOff = degToRad(state.lastPitchOffDeg);
      } else {
        state.lastPitchOffDeg = pitchOffDeg;
      }
    }
    pitchOff = boostPitchOff(pitchOff, normalized.screenAngle);

    var heading = useHeading ? readHeadingDeg(normalized) : null;
    var yawOff = 0;

    if (useHeading && heading != null && state.prevHeading != null) {
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
    } else if (useHeading && state.headingMode && state.initHeading != null) {
      yawOff = degToRad(state.unwrappedHeading - state.initHeading);
    } else if (!useHeading && normalized.gamma != null && state.initGamma != null) {
      state.fGamma = lp(state.fGamma, normalized.gamma, SENSOR_LP);
      state.gammaYawDeg = state.fGamma - state.initGamma;
      yawOff = degToRad(state.gammaYawDeg);
      state.headingMode = false;
    }

    return { ready: true, yawOff: yawOff, pitchOff: pitchOff, headingMode: state.headingMode };
  }

  function isAllowedScreenCur(cur) {
    var c = normalizeAngle360(cur);
    return c === 0 || c === 90 || c === 180 || c === LANDSCAPE_LEFT_CUR;
  }

  function VisualImmersive(panoEl, getViewer) {
    this.panoEl = panoEl;
    this.getViewer = getViewer;
    this.lastLayoutKey = '';
    this.snappedCur = null;
  }

  VisualImmersive.prototype.apply = function(snappedCur) {
    if (!this.panoEl) return;
    var el = this.panoEl;
    this.snappedCur = snappedCur;
    var vw = global.innerWidth || document.documentElement.clientWidth;
    var vh = global.innerHeight || document.documentElement.clientHeight;
    var layoutKey = snappedCur + ':' + vw + 'x' + vh;
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.left = '0';
    el.style.top = '0';
    el.style.transform = '';
    el.style.transformOrigin = '';
    if (layoutKey !== this.lastLayoutKey) {
      this.lastLayoutKey = layoutKey;
      var viewer = this.getViewer ? this.getViewer() : null;
      if (viewer && typeof viewer.updateSize === 'function') {
        viewer.updateSize();
      } else {
        try {
          global.dispatchEvent(new Event('resize'));
        } catch (e) {
          if (document.createEvent) {
            var ev = document.createEvent('Event');
            ev.initEvent('resize', true, true);
            global.dispatchEvent(ev);
          }
        }
      }
    }
  };

  VisualImmersive.prototype.stop = function() {
    if (!this.panoEl) return;
    this.lastLayoutKey = '';
    this.snappedCur = null;
  };

  function GyroControl(getView) {
    this.getView = getView;
    this.getViewer = null;
    this.panoEl = null;
    this.enabled = false;
    this.handlers = [];
    this.raf = null;
    this.latestEvent = null;
    this.base = null;
    this.onChange = null;
    this.hooks = {};
    this.orientState = null;
    this.visual = null;
    this.displayYaw = 0;
    this.displayPitch = 0;
    this.hintText = '';
    this.autoLandscape = false;
    this.userDismissed = false;
    this._rollRestartTimer = null;
    this._rollRestartBusy = false;
    this._rollGuardBound = false;
    this._bindRollGuard();
  }

  GyroControl.BUILD = BUILD;

  GyroControl.isOrientationAllowed = function(cur) {
    return isAllowedScreenCur(cur);
  };

  GyroControl.prototype.getHint = function() {
    return this.hintText || '';
  };

  GyroControl.prototype._rejectOrientation = function(msg) {
    this.hintText = msg || '向きが変わったのでGYROを付け直してください';
    this.stop(false);
  };

  GyroControl.prototype._stopForRoll = function() {
    if (this.raf) {
      global.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.latestEvent = null;
    this.handlers.forEach(function(item) {
      if (item.target) {
        item.target.removeEventListener(item.type, item.fn);
      } else {
        global.removeEventListener(item.type, item.fn, item.capture === true);
      }
    });
    this.handlers = [];
    var wasOn = this.enabled;
    this.base = null;
    this.orientState = null;
    this.enabled = false;
    if (wasOn) {
      if (this.hooks.onStop) this.hooks.onStop();
      this._emit();
    }
  };

  GyroControl.prototype._onScreenRoll = function(savedYaw, savedPitch, newSnapped) {
    if (this._rollRestartBusy) return;
    this._rollRestartBusy = true;
    var view = this.getView();
    var yaw = savedYaw;
    var pitch = savedPitch;
    this._stopForRoll();
    if (view) {
      try {
        view.setYaw(yaw);
        view.setPitch(pitch);
      } catch (eFix) {}
    }
    if (this.visual) this.visual.apply(newSnapped);
    this.hintText = '';
    var self = this;
    if (this._rollRestartTimer) clearTimeout(this._rollRestartTimer);
    this._rollRestartTimer = setTimeout(function() {
      self._rollRestartTimer = null;
      self._rollRestartBusy = false;
      if (self.userDismissed) return;
      self.start();
    }, ROLL_RESTART_DELAY_MS);
  };

  GyroControl.prototype._tryRollRestart = function() {
    if (!this.enabled || !this.orientState || this._rollRestartBusy) return;
    if (this.orientState.settleLeft > 0) return;
    if (this.orientState.lockedCur == null) return;
    var rollSnap = snapRollAngleDeg(getScreenAngleDeg());
    if (!isAllowedScreenCur(rollSnap)) return;
    if (!isRollBetweenOrientations(this.orientState.lockedCur, rollSnap)) return;
    this._onScreenRoll(this.displayYaw, this.displayPitch, rollSnap);
  };

  GyroControl.prototype._bindRollGuard = function() {
    if (this._rollGuardBound) return;
    this._rollGuardBound = true;
    var self = this;
    var fn = function() {
      self._tryRollRestart();
    };
    global.addEventListener('orientationchange', fn, true);
    global.addEventListener('resize', fn, true);
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.addEventListener === 'function') {
      global.screen.orientation.addEventListener('change', fn);
    }
  };

  GyroControl.prototype.setAutoLandscape = function(on) {
    this.autoLandscape = on === true;
  };

  GyroControl.prototype._tryAutoLandscapeStart = function() {
    if (!this.autoLandscape || this.enabled || this.userDismissed) return;
    this.requestStart();
  };

  GyroControl.prototype.setOnChange = function(fn) {
    this.onChange = fn;
  };

  GyroControl.prototype.setHooks = function(hooks) {
    this.hooks = hooks || {};
  };

  GyroControl.prototype.setPanoElement = function(el) {
    this.panoEl = el;
    this.visual = el ? new VisualImmersive(el, this.getViewer ? this.getViewer.bind(this) : null) : null;
  };

  GyroControl.prototype.setGetViewer = function(fn) {
    this.getViewer = fn;
    if (this.panoEl) {
      this.visual = new VisualImmersive(this.panoEl, fn);
    }
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
    if (this.visual) this.visual.stop();
    this.latestEvent = null;
  };

  GyroControl.prototype._bindSensors = function() {
    var self = this;
    var orientFn = function(e) { self.latestEvent = e; };
    ['deviceorientationabsolute', 'deviceorientation'].forEach(function(type) {
      global.addEventListener(type, orientFn, true);
      self.handlers.push({ type: type, fn: orientFn, capture: true });
    });

    var layoutFn = function() {
      if (!self.enabled) {
        self._tryAutoLandscapeStart();
        return;
      }
      var snapped = snapScreenAngleDeg(getScreenAngleDeg(), self.orientState ?
        self.orientState.snappedCur : null);
      if (!isAllowedScreenCur(snapped)) {
        self._rejectOrientation('この向きでは使えません');
        return;
      }
      if (self.visual) self.visual.apply(snapped);
    };
    global.addEventListener('resize', layoutFn);
    self.handlers.push({ type: 'resize', fn: layoutFn, capture: false });
    global.addEventListener('orientationchange', layoutFn);
    self.handlers.push({ type: 'orientationchange', fn: layoutFn, capture: false });
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.addEventListener === 'function') {
      global.screen.orientation.addEventListener('change', layoutFn);
      self.handlers.push({ type: 'change', fn: layoutFn, target: global.screen.orientation });
    }
  };

  GyroControl.prototype._bindPassiveAutoLandscape = function() {
    if (!this.autoLandscape) return;
    var self = this;
    if (this._autoPassiveBound) return;
    this._autoPassiveBound = true;
    var fn = function() { self._tryAutoLandscapeStart(); };
    global.addEventListener('orientationchange', fn);
    global.addEventListener('resize', fn);
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.addEventListener === 'function') {
      global.screen.orientation.addEventListener('change', fn);
    }
    self._tryAutoLandscapeStart();
  };

  GyroControl.prototype.stop = function(fromUser) {
    if (this._rollRestartTimer) {
      clearTimeout(this._rollRestartTimer);
      this._rollRestartTimer = null;
    }
    this._rollRestartBusy = false;
    var wasOn = this.enabled;
    if (fromUser !== false) this.userDismissed = true;
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
    var cur = snapScreenAngleDeg(getScreenAngleDeg(), null);
    if (!GyroControl.isOrientationAllowed(cur)) {
      this.hintText = '端末を縦か横にしてからON';
      return false;
    }
    this.hintText = '';
    this.userDismissed = false;
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
      snappedCur: cur,
      lockedCur: null,
      headingSource: null,
      settleLeft: STARTUP_SETTLE_FRAMES,
      justLocked: false
    };

    if (this.visual) this.visual.apply(cur);
    this._bindSensors();

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      if (self.hooks.onTick) self.hooks.onTick();
      var v = self.getView();
      if (!v || !self.latestEvent || !self.orientState || !self.base) return;

      var snapped = snapScreenAngleDeg(
        getScreenAngleDeg(),
        self.orientState.snappedCur
      );

      if (!isAllowedScreenCur(snapped)) {
        self._rejectOrientation('この向きでは使えません');
        return;
      }

      if (self.orientState.settleLeft === 0 && self.orientState.lockedCur != null) {
        var rollSnap = snapRollAngleDeg(getScreenAngleDeg());
        if (isRollBetweenOrientations(self.orientState.lockedCur, rollSnap)) {
          self._onScreenRoll(self.displayYaw, self.displayPitch, rollSnap);
          return;
        }
      }

      if (self.visual) self.visual.apply(snapped);
      self.orientState.snappedCur = snapped;

      var source = self.orientState.headingSource;

      if (self.orientState.settleLeft > 0) {
        self.orientState.settleLeft--;
        resetSensorBaseline(self.orientState);
        if (self.orientState.settleLeft === 0) {
          self.orientState.headingSource = detectHeadingSource(self.latestEvent);
          self.orientState.lockedCur = snapped;
          self.orientState.justLocked = true;
          source = self.orientState.headingSource;
        }
        var settleNorm = normalizeSensorEvent(self.latestEvent, snapped, source);
        if (settleNorm) trackOrientation(settleNorm, self.orientState);
        return;
      }

      var normalized = normalizeSensorEvent(self.latestEvent, snapped, source);
      var o = trackOrientation(normalized, self.orientState);
      if (!o || !o.ready) return;

      if (self.orientState.justLocked) {
        self.orientState.justLocked = false;
        if (Math.abs(radToDeg(o.yawOff)) > LOCK_JUMP_REJECT_DEG ||
            Math.abs(radToDeg(o.pitchOff)) > LOCK_JUMP_REJECT_DEG) {
          resetSensorBaseline(self.orientState);
          if (normalized) trackOrientation(normalized, self.orientState);
          return;
        }
      }

      var targetYaw = self.base.viewYaw + o.yawOff;
      var pl = pitchClampLimits(snapped);
      var targetPitch = clamp(self.base.viewPitch + o.pitchOff, pl.min, pl.max);
      self.displayYaw = normalizeAngle(
        self.displayYaw + clamp(
          YAW_SMOOTH * angleDelta(self.displayYaw, targetYaw),
          -YAW_MAX_STEP,
          YAW_MAX_STEP
        )
      );
      self.displayPitch = clamp(
        self.displayPitch + clamp(
          PITCH_SMOOTH * (targetPitch - self.displayPitch),
          -PITCH_MAX_STEP,
          PITCH_MAX_STEP
        ),
        pl.min,
        pl.max
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
    var chain = Promise.resolve('granted');

    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      chain = chain.then(function() {
        return DeviceOrientationEvent.requestPermission();
      });
    }
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      chain = chain.then(function(prev) {
        if (prev !== 'granted') return prev;
        return DeviceMotionEvent.requestPermission();
      });
    }

    return chain.then(function(state) {
      if (state === 'granted') return self.start();
      return false;
    }).catch(function() { return false; });
  };

  GyroControl.prototype.toggle = function() {
    if (this.enabled) {
      this.stop(true);
      return Promise.resolve(false);
    }
    return this.requestStart();
  };

  GyroControl.installPassiveAutoLandscape = function(gyro) {
    if (gyro) gyro._bindPassiveAutoLandscape();
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
