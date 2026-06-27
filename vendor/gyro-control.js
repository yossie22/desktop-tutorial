/**
 * パノラマ用ジャイロ制御 v77
 * 意図的な横倒しのみ15°記録→30°OFF / 横は手動ON可 / 横→縦で自動ON
 * 詳細: vendor/gyro-STABLE-v77.txt
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.040;
  var HEADING_SPIKE_DEG = 55;
  var SENSOR_LP = 0.22;
  var STARTUP_SETTLE_FRAMES = 20;
  var PORTRAIT_RESTART_DELAY_MS = 450;
  var LOCK_JUMP_REJECT_DEG = 8;
  var ROLL_SNAPSHOT_DEG = 15;
  var ROLL_OFF_DEG = 30;
  var ROLL_RESET_DEG = 8;
  var ROLL_STABLE_FRAMES = 15;
  var ROLL_BETA_MAX = 22;
  var ROLL_HEADING_MAX = 5;
  var PITCH_UP_BOOST_PORTRAIT = 1.32;
  var PITCH_UP_BOOST_LANDSCAPE = 1.58;
  var BUILD = 'v77';
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

  function isPortraitRoll(cur) {
    var c = normalizeAngle360(cur);
    return c === 0 || c === 180;
  }

  function isLandscapeScreen(screenAngle) {
    var a = normalizeAngle360(screenAngle);
    return a === LANDSCAPE_RIGHT_CUR || a === LANDSCAPE_LEFT_CUR;
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

  function isAllowedScreenCur(cur) {
    var c = normalizeAngle360(cur);
    return c === 0 || c === 90 || c === 180 || c === LANDSCAPE_LEFT_CUR;
  }

  function getDeviceRollTiltDeg(rawEvent, screenSnapped) {
    if (!rawEvent || rawEvent.beta == null || rawEvent.gamma == null) return 0;
    var screen = normalizeAngle360(screenSnapped);
    if (!isPortraitRoll(screen)) return 0;
    if (Math.abs(rawEvent.beta - 90) > 50) return 0;
    var gamma = rawEvent.gamma;
    if (screen === 180) gamma = -gamma;
    return gamma;
  }

  function correctViewForLandscapeRoll(snap) {
    return {
      yaw: snap.yaw,
      pitch: clamp(snap.pitch, -Math.PI / 2, Math.PI / 2)
    };
  }

  function resetSensorBaseline(state) {
    state.initBeta = null;
    state.fBeta = null;
    state.initGamma = null;
    state.fGamma = null;
    state.landPitchInit = null;
    state.landPitchF = null;
    state.prevHeading = null;
    state.initHeading = null;
    state.unwrappedHeading = 0;
    state.gammaYawDeg = 0;
    state.lastPitchOffDeg = null;
  }

  function computePitchOff(normalized, state, rawBeta, screenSnapped) {
    var cur = normalizeAngle360(screenSnapped);
    if (isLandscapeScreen(cur) && rawBeta != null && !isNaN(rawBeta)) {
      state.landPitchF = lp(state.landPitchF, rawBeta, SENSOR_LP);
      if (state.landPitchInit == null) {
        state.landPitchInit = rawBeta;
        state.landPitchF = rawBeta;
        return 0;
      }
      var landOff = degToRad(state.landPitchInit - state.landPitchF);
      var landDeg = radToDeg(landOff);
      if (landDeg < 0) landOff = degToRad(landDeg * PITCH_UP_BOOST_LANDSCAPE);
      return landOff;
    }
    state.landPitchInit = null;
    state.landPitchF = null;
    state.fBeta = lp(state.fBeta, normalized.beta, SENSOR_LP);
    var pitchOff = degToRad(state.initBeta - state.fBeta);
    var pDeg = radToDeg(pitchOff);
    if (pDeg < 0) pitchOff = degToRad(pDeg * PITCH_UP_BOOST_PORTRAIT);
    return pitchOff;
  }

  function trackOrientation(normalized, state, rawBeta, screenSnapped) {
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
      state.landPitchInit = null;
      state.landPitchF = null;
      return { ready: false };
    }

    var pitchOff = computePitchOff(normalized, state, rawBeta, screenSnapped);
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
    this._portraitViewSnapshot = null;
    this._earlyRollSnapshot = null;
    this._rollTransitionDir = null;
    this._earlyRollOff = false;
    this._frozenView = null;
    this._landscapeFrozen = false;
    this._gyroWasOnBeforeLandscape = false;
    this._portraitRestartTimer = null;
    this._rollBusy = false;
    this._rollGuardBound = false;
    this._rollWatchFrames = 0;
    this._rollWatchDir = null;
    this._rollWatchLastHeading = null;
    this._bindRollGuard();
  }

  GyroControl.BUILD = BUILD;

  GyroControl.isOrientationAllowed = function(cur) {
    return isAllowedScreenCur(snapRollAngleDeg(cur));
  };

  GyroControl.prototype.getHint = function() {
    return this.hintText || '';
  };

  GyroControl.prototype._applyViewAngles = function(yaw, pitch) {
    var view = this.getView();
    if (!view) return;
    try {
      view.setYaw(yaw);
      view.setPitch(clamp(pitch, -Math.PI / 2, Math.PI / 2));
    } catch (e0) {}
  };

  GyroControl.prototype._savePortraitSnapshot = function() {
    this._portraitViewSnapshot = {
      yaw: this.displayYaw,
      pitch: this.displayPitch
    };
  };

  GyroControl.prototype._applyFrozenView = function() {
    if (!this._frozenView) return;
    this._applyViewAngles(this._frozenView.yaw, this._frozenView.pitch);
  };

  GyroControl.prototype._resetEarlyRollState = function() {
    this._earlyRollSnapshot = null;
    this._rollTransitionDir = null;
    this._earlyRollOff = false;
    this._rollWatchFrames = 0;
    this._rollWatchDir = null;
    this._rollWatchLastHeading = null;
  };

  GyroControl.prototype._stopGyroOnly = function() {
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

  GyroControl.prototype._triggerEarlyRollOff = function() {
    var snap = this._earlyRollSnapshot ||
      { yaw: this.displayYaw, pitch: this.displayPitch };
    var corrected = correctViewForLandscapeRoll(snap);
    this._frozenView = corrected;
    this._landscapeFrozen = true;
    this._earlyRollOff = true;
    this._gyroWasOnBeforeLandscape = true;
    this._stopGyroOnly();
    this._applyViewAngles(corrected.yaw, corrected.pitch);
    this.hintText = '';
    this._emit();
  };

  GyroControl.prototype._isPortraitToLandscapeTransition = function(rollSnap) {
    if (!this.orientState || this.orientState.lockedCur == null) return false;
    return isPortraitRoll(this.orientState.lockedCur) && isLandscapeRoll(rollSnap);
  };

  GyroControl.prototype._checkIntentionalRoll = function() {
    if (!this.enabled || !this.latestEvent || this._rollBusy) return false;
    if (!this.orientState || this.orientState.settleLeft > 0) return false;
    var screenSnap = snapRollAngleDeg(getScreenAngleDeg());
    if (!isPortraitRoll(screenSnap)) return false;

    var e = this.latestEvent;
    if (e.beta == null || e.gamma == null) return false;
    if (Math.abs(e.beta - 90) > ROLL_BETA_MAX) {
      this._rollWatchFrames = 0;
      if (!this._landscapeFrozen) {
        this._earlyRollSnapshot = null;
        this._rollTransitionDir = null;
      }
      return false;
    }

    var source = this.orientState.headingSource;
    if (source && source !== 'gamma') {
      var heading = readHeadingFromEvent(e, screenSnap, source);
      if (heading != null && this._rollWatchLastHeading != null) {
        var hStep = heading - this._rollWatchLastHeading;
        if (hStep > 180) hStep -= 360;
        if (hStep < -180) hStep += 360;
        if (Math.abs(hStep) > ROLL_HEADING_MAX) {
          this._rollWatchFrames = 0;
          this._rollWatchDir = null;
          if (!this._landscapeFrozen) {
            this._earlyRollSnapshot = null;
            this._rollTransitionDir = null;
          }
          this._rollWatchLastHeading = heading;
          return false;
        }
      }
      this._rollWatchLastHeading = heading;
    }

    var rollTilt = getDeviceRollTiltDeg(e, screenSnap);
    var absRoll = Math.abs(rollTilt);

    if (absRoll < ROLL_RESET_DEG) {
      this._rollWatchFrames = 0;
      this._rollWatchDir = null;
      if (!this._landscapeFrozen) this._resetEarlyRollState();
      return false;
    }

    var dir = rollTilt > 0 ? LANDSCAPE_RIGHT_CUR : LANDSCAPE_LEFT_CUR;
    if (this._rollWatchDir != null && this._rollWatchDir !== dir) {
      this._rollWatchFrames = 0;
      this._earlyRollSnapshot = null;
    }
    this._rollWatchDir = dir;
    this._rollWatchFrames++;

    if (this._rollWatchFrames < ROLL_STABLE_FRAMES) return false;

    if (absRoll >= ROLL_SNAPSHOT_DEG && !this._earlyRollSnapshot) {
      this._earlyRollSnapshot = {
        yaw: this.displayYaw,
        pitch: this.displayPitch
      };
      this._rollTransitionDir = dir;
    }

    if (absRoll >= ROLL_OFF_DEG && !this._earlyRollOff) {
      this._triggerEarlyRollOff();
      return true;
    }
    return false;
  };

  GyroControl.prototype._onPortraitToLandscape = function(newSnapped) {
    if (this._rollBusy) return;
    if (this._earlyRollOff) {
      if (this.visual) this.visual.apply(newSnapped);
      if (this._earlyRollSnapshot) {
        this._frozenView = correctViewForLandscapeRoll(this._earlyRollSnapshot);
      }
      this._applyFrozenView();
      return;
    }
    this._rollBusy = true;
    var snap = this._earlyRollSnapshot || this._portraitViewSnapshot ||
      { yaw: this.displayYaw, pitch: this.displayPitch };
    var corrected = correctViewForLandscapeRoll(snap);
    this._frozenView = corrected;
    this._landscapeFrozen = true;
    this._earlyRollOff = true;
    this._gyroWasOnBeforeLandscape = true;
    this._stopGyroOnly();
    this._applyViewAngles(corrected.yaw, corrected.pitch);
    if (this.visual) this.visual.apply(newSnapped);
    this.hintText = '';
    this._emit();
    var self = this;
    setTimeout(function() {
      self._rollBusy = false;
      self._applyFrozenView();
    }, 300);
  };

  GyroControl.prototype._onLandscapeToPortrait = function(newSnapped) {
    if (this._rollBusy) return;
    this._rollBusy = true;
    var snap = this._frozenView || this._earlyRollSnapshot || this._portraitViewSnapshot;
    this._landscapeFrozen = false;
    this._resetEarlyRollState();
    if (snap) this._applyViewAngles(snap.yaw, snap.pitch);
    if (this.visual) this.visual.apply(newSnapped);
    this.hintText = '';
    var self = this;
    var restart = this._gyroWasOnBeforeLandscape && !this.userDismissed;
    this._gyroWasOnBeforeLandscape = false;
    if (this._portraitRestartTimer) clearTimeout(this._portraitRestartTimer);
    if (restart) {
      this._portraitRestartTimer = setTimeout(function() {
        self._portraitRestartTimer = null;
        self._rollBusy = false;
        if (!self.userDismissed) self.start();
      }, PORTRAIT_RESTART_DELAY_MS);
    } else {
      setTimeout(function() { self._rollBusy = false; }, 200);
    }
    this._emit();
  };

  GyroControl.prototype._handleScreenRoll = function() {
    var rollSnap = snapRollAngleDeg(getScreenAngleDeg());
    if (!isAllowedScreenCur(rollSnap)) return;

    if (this._landscapeFrozen && !this.enabled) {
      if (isLandscapeRoll(rollSnap)) {
        if (this.visual) this.visual.apply(rollSnap);
        if (this._earlyRollSnapshot) {
          this._frozenView = correctViewForLandscapeRoll(this._earlyRollSnapshot);
        }
        this._applyFrozenView();
        return;
      }
      if (isPortraitRoll(rollSnap)) {
        var tilt = this.latestEvent ? getDeviceRollTiltDeg(this.latestEvent, rollSnap) : 999;
        if (Math.abs(tilt) < ROLL_RESET_DEG) {
          this._onLandscapeToPortrait(rollSnap);
        } else {
          this._applyFrozenView();
        }
        return;
      }
    }

    if (!this.enabled || !this.orientState || this._rollBusy) return;
    if (this.orientState.settleLeft > 0) return;
    if (this.orientState.lockedCur == null) return;
    if (!isRollBetweenOrientations(this.orientState.lockedCur, rollSnap)) return;

    if (isPortraitRoll(this.orientState.lockedCur) && isLandscapeRoll(rollSnap)) {
      this._savePortraitSnapshot();
      this._onPortraitToLandscape(rollSnap);
    }
  };

  GyroControl.prototype._bindRollGuard = function() {
    if (this._rollGuardBound) return;
    this._rollGuardBound = true;
    var self = this;
    var fn = function() {
      self._handleScreenRoll();
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
    if (isLandscapeScreen(snapRollAngleDeg(getScreenAngleDeg()))) return;
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
      if (!self.enabled || !self.orientState) return;
      var snapped = snapScreenAngleDeg(getScreenAngleDeg(), self.orientState.snappedCur);
      var rollSnap = snapRollAngleDeg(getScreenAngleDeg());
      if (self._isPortraitToLandscapeTransition(rollSnap)) {
        if (!self._earlyRollOff) self._savePortraitSnapshot();
        self._onPortraitToLandscape(rollSnap);
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
    if (this._portraitRestartTimer) {
      clearTimeout(this._portraitRestartTimer);
      this._portraitRestartTimer = null;
    }
    this._rollBusy = false;
    var wasOn = this.enabled;
    if (fromUser !== false) {
      this.userDismissed = true;
      this._landscapeFrozen = false;
      this._gyroWasOnBeforeLandscape = false;
      this._resetEarlyRollState();
    }
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
    var cur = snapRollAngleDeg(getScreenAngleDeg());
    this.hintText = '';
    this.userDismissed = false;
    this._landscapeFrozen = false;
    this._frozenView = null;
    this._resetEarlyRollState();
    var wasOn = this.enabled;
    this._cleanupListeners();
    this.enabled = true;
    this.base = { viewYaw: view.yaw(), viewPitch: view.pitch() };
    this.displayYaw = view.yaw();
    this.displayPitch = view.pitch();
    this._savePortraitSnapshot();
    if (!wasOn && this.hooks.onStart) this.hooks.onStart();

    var self = this;
    this.orientState = {
      initBeta: null,
      fBeta: null,
      initGamma: null,
      fGamma: null,
      landPitchInit: null,
      landPitchF: null,
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

      if (self._checkIntentionalRoll()) return;

      var snapped = snapScreenAngleDeg(
        getScreenAngleDeg(),
        self.orientState.snappedCur
      );
      var rollSnap = snapRollAngleDeg(getScreenAngleDeg());

      if (self._isPortraitToLandscapeTransition(rollSnap)) {
        if (!self._earlyRollOff) self._savePortraitSnapshot();
        self._onPortraitToLandscape(rollSnap);
        return;
      }

      if (self.visual) self.visual.apply(snapped);
      self.orientState.snappedCur = snapped;

      var source = self.orientState.headingSource;
      var rawBeta = self.latestEvent.beta;

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
        if (settleNorm) trackOrientation(settleNorm, self.orientState, rawBeta, snapped);
        return;
      }

      var normalized = normalizeSensorEvent(self.latestEvent, snapped, source);
      var o = trackOrientation(normalized, self.orientState, rawBeta, snapped);
      if (!o || !o.ready) return;

      if (self.orientState.justLocked) {
        self.orientState.justLocked = false;
        if (Math.abs(radToDeg(o.yawOff)) > LOCK_JUMP_REJECT_DEG ||
            Math.abs(radToDeg(o.pitchOff)) > LOCK_JUMP_REJECT_DEG) {
          resetSensorBaseline(self.orientState);
          if (normalized) trackOrientation(normalized, self.orientState, rawBeta, snapped);
          return;
        }
      }

      var targetYaw = self.base.viewYaw + o.yawOff;
      var targetPitch = clamp(self.base.viewPitch + o.pitchOff, -Math.PI / 2, Math.PI / 2);
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
        -Math.PI / 2,
        Math.PI / 2
      );
      v.setYaw(self.displayYaw);
      v.setPitch(self.displayPitch);
      self._savePortraitSnapshot();
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
