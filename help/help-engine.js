(function(global) {
  'use strict';

  var ASSET = {
    arrowUp: '../上-removebg-preview.png',
    arrowDown: '../下-removebg-preview.png',
    arrowRight: '../右-removebg-preview.png',
    mapBtn: '../Map戻り-removebg-preview.png',
    vrBtn: '../VR-removebg-preview.png'
  };

  var STEP_CATALOG = {
    mapPin: {
      id: 'mapPin',
      order: 10,
      always: true,
      defaultTitle: '地図のピンを押して見たい場面へ移動。',
      defaultBody: '',
      markType: 'pin'
    },
    lookAround: {
      id: 'lookAround',
      order: 20,
      always: true,
      defaultTitle: '画面の操作方法',
      defaultBody: 'マウスや指の操作で画面を回して広く見渡せます。',
      markType: 'look'
    },
    routeArrows: {
      id: 'routeArrows',
      order: 30,
      feature: 'hasRoute',
      defaultTitle: '黄色矢印でとなりのシーンに移動',
      defaultBody: '横方向の矢印が出たら横移動や別コースに移動できます。',
      markType: 'image',
      imageSrc: ASSET.arrowUp,
      blink: false
    },
    autoPlay: {
      id: 'autoPlay',
      order: 40,
      feature: 'hasRoute',
      defaultTitle: '黄色矢印を長押しで自動再生。',
      defaultBody: '上下の矢印を長押しで、自動で次の場所へ進みます。止めたいときは画面をタップしてください。',
      markType: 'image',
      imageSrc: ASSET.arrowUp,
      blink: false
    },
    mapButton: {
      id: 'mapButton',
      order: 50,
      always: true,
      defaultTitle: 'Mapボタンは地図への戻りです。',
      defaultBody: '画面左下のMapボタンから地図に戻って別のピンを選べます。',
      markType: 'image',
      imageSrc: ASSET.mapBtn,
      blink: false
    },
    compassBearing: {
      id: 'compassBearing',
      order: 60,
      always: true,
      defaultTitle: 'カウンターは今の場所をお知らせしています。',
      defaultBody: 'これを長押しでボリューム表示、ダブルクリック（連続タップ）で画面角度が表示されます。',
      markType: 'counter'
    },
    gyroButton: {
      id: 'gyroButton',
      order: 70,
      always: true,
      defaultTitle: 'ジャイロ機能',
      defaultBody: '360度画面の右上に青い「GYRO」があります。押して緑色になったら、端末を傾けるとその方向を見られます。※向きを変えたときは一度OFFにして、好きな向きのまま再度ONしてください。初めてのときは「モーション」の許可を選んでください。',
      defaultBodyPc: 'このVRはスマートフォン・タブレットでもご覧いただけます。360度画面を開くと右上に「GYRO」が出ます。端末を傾けて、いろいろな方向を見てみてください。',
      markType: 'gyro'
    },
    sideBranch: {
      id: 'sideBranch',
      order: 35,
      feature: 'hasSideBranch',
      explicitOnly: true,
      defaultTitle: '黄色矢印が点滅したら脇道へ。',
      defaultBody: '向きを合わせると黄色矢印が点滅します。点滅している矢印を押すと、脇道や別コースへ進めます。',
      markType: 'image',
      imageSrc: ASSET.arrowRight,
      blink: true
    },
    guideVideo: {
      id: 'guideVideo',
      order: 75,
      feature: 'hasGuideVideo',
      defaultTitle: 'ガイド人物が案内します。',
      defaultBody: 'パノラマ内に表示される人物動画が、見どころを案内することがあります。',
      markType: 'look',
      markIcon: '🧑'
    },
    hiResPeek: {
      id: 'hiResPeek',
      order: 80,
      feature: 'hasHiResPeek',
      defaultTitle: '虫眼鏡があるところでは拡大して見えます。',
      defaultBody: '虫眼鏡とその範囲の点滅表示が出たらクリックでくっきり見えます。',
      markType: 'magnifier',
      magnifierColor: 'pink'
    },
    hiResPeekVr: {
      id: 'hiResPeekVr',
      order: 90,
      feature: 'hasHiResPeek',
      defaultTitle: 'VRボタン',
      defaultBody: '虫眼鏡で拡大表示から元のVR画像に戻ります。',
      markType: 'image',
      imageSrc: ASSET.vrBtn,
      blink: false
    }
  };

  function isGyroHelpTarget() {
    if (!('ontouchstart' in global)) return false;
    var ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod|Android/i.test(ua)) return true;
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    return false;
  }

  function detectAppFeatures(appData, userCfg) {
    var scenes = (appData && appData.scenes) || [];
    var positions = {};
    var hasHiResPeek = false;
    var hasHiResPeekVideo = false;
    var hasGuideVideo = false;
    var magnifierColor = 'pink';

    scenes.forEach(function(sd) {
      if (sd && sd.position != null && sd.position !== '') {
        positions[String(sd.position)] = true;
      }
      if (sd && sd.hiResPeek) {
        hasHiResPeek = true;
        if (sd.hiResPeek.videoSrc) hasHiResPeekVideo = true;
        if (sd.hiResPeek.magnifierColor) magnifierColor = sd.hiResPeek.magnifierColor;
      }
      if (sd && sd.videoHotspots && sd.videoHotspots.length) {
        sd.videoHotspots.forEach(function(vh) {
          if (vh && (vh.src || vh.srcIos || vh.srcHevc)) hasGuideVideo = true;
        });
      }
    });

    var positionCount = Object.keys(positions).length;
    var hasRoute = positionCount > 1;

    var sideBranchFlag = null;
    if (userCfg && userCfg.features && userCfg.features.sideBranch != null) {
      sideBranchFlag = !!userCfg.features.sideBranch;
    } else if (appData && appData.helpFeatures && appData.helpFeatures.sideBranch != null) {
      sideBranchFlag = !!appData.helpFeatures.sideBranch;
    } else if (appData && Array.isArray(appData.sideBranches) && appData.sideBranches.length > 0) {
      sideBranchFlag = true;
    } else {
      sideBranchFlag = false;
    }

    return {
      tourTitle: (appData && appData.tourTitle) || (appData && appData.name) || 'VRツアー',
      sceneCount: scenes.length,
      routeSceneCount: positionCount,
      hasRoute: hasRoute,
      hasSideBranch: sideBranchFlag,
      hasHiResPeek: hasHiResPeek,
      hasHiResPeekVideo: hasHiResPeekVideo,
      hasGuideVideo: hasGuideVideo,
      magnifierColor: magnifierColor,
      hasGyroHelp: isGyroHelpTarget()
    };
  }

  function pickText(userTexts, stepId, field, fallback) {
    var block = userTexts && userTexts[stepId];
    if (block && block[field]) return String(block[field]);
    return fallback;
  }

  function defaultMapBackHref() {
  if (typeof location !== 'undefined' && /\/help\//i.test(location.pathname || '')) {
    return '../map.html';
  }
  return 'map.html';
}

function buildHelpConfig(appData, userCfg) {
    userCfg = userCfg || {};
    var features = detectAppFeatures(appData, userCfg);
    var userTexts = userCfg.texts || {};
    var steps = [];

    Object.keys(STEP_CATALOG).forEach(function(key) {
      var def = STEP_CATALOG[key];
      if (!def.always) {
        if (!def.feature || !features[def.feature]) return;
      }
      if (def.explicitOnly) {
        var explicit = userTexts[def.id];
        if (!explicit || (!explicit.title && !explicit.body)) return;
      }
      var step = {
        id: def.id,
        title: pickText(userTexts, def.id, 'title', def.defaultTitle),
        body: pickText(userTexts, def.id, 'body', def.defaultBody),
        markType: def.markType,
        imageSrc: def.imageSrc || '',
        blink: !!def.blink,
        magnifierColor: def.magnifierColor || features.magnifierColor || 'pink',
        markIcon: def.markIcon || ''
      };
      if (def.id === 'routeArrows' && features.routeSceneCount > 1) {
        if (!userTexts.routeArrows || !userTexts.routeArrows.body) {
          step.body = step.body.replace(/。$/, '') + '（全' + features.routeSceneCount + 'か所）。';
        }
      }
      if (def.id === 'gyroButton' && !features.hasGyroHelp) {
        step.body = pickText(userTexts, def.id, 'bodyPc', def.defaultBodyPc || step.body);
      }
      steps.push(step);
    });

    steps.sort(function(a, b) {
      return (STEP_CATALOG[a.id].order || 0) - (STEP_CATALOG[b.id].order || 0);
    });

    var notes = [];
    if (Array.isArray(userCfg.notes) && userCfg.notes.length) {
      notes = userCfg.notes;
    } else if (!Object.prototype.hasOwnProperty.call(userCfg, 'notes')) {
      notes = [{
        title: 'iPad・iPhone の場合',
        body: '画面を指でなぞると見回せます。虫眼鏡・矢印・ピンは軽くタップしてください。',
        tip: features.hasHiResPeekVideo
          ? '動画がある場合、最初に画面をタップすると再生が始まることがあります。'
          : '音がある場合、最初に画面をタップすると再生できることがあります。'
      }];
    }

    return {
      title: features.tourTitle + ' — 使い方',
      backLabel: userCfg.backLabel || '地図に戻る',
      backHref: userCfg.backHref || defaultMapBackHref(),
      steps: steps,
      notes: notes,
      gpsRows: buildGpsRows(appData),
      footer: userCfg.footer || '表示がおかしいときは、ブラウザでページを再読み込みしてください。',
      features: features
    };
  }

  function buildGpsRows(appData) {
    var scenes = (appData && appData.scenes) || [];
    return scenes.filter(function(sd) {
      return sd && sd.lat != null && sd.lng != null && !isNaN(Number(sd.lat)) && !isNaN(Number(sd.lng));
    }).map(function(sd) {
      return {
        id: sd.id || '',
        name: sd.name || sd.id || '',
        lat: Number(sd.lat),
        lng: Number(sd.lng)
      };
    });
  }

  function renderGpsAppendix(rows) {
    if (!rows || !rows.length) return '';
    var body = rows.map(function(row) {
      return '<tr><td>' + escapeHtml(row.name) + '</td><td>緯 ' + row.lat.toFixed(6) + '</td><td>経 ' + row.lng.toFixed(6) + '</td></tr>';
    }).join('');
    return '<div class="card gps-appendix">' +
      '<strong>撮影地点のGPS（記録用）</strong><br>' +
      '<span class="tip">VR画面には出しません。地図や記録用の数値です。</span>' +
      '<table class="gps-table"><thead><tr><th>場所</th><th>緯度</th><th>経度</th></tr></thead><tbody>' +
      body +
      '</tbody></table></div>';
  }

  function magnifierSvg(colorClass) {
    return '<svg viewBox="0 0 64 64" aria-hidden="true">' +
      '<circle cx="27" cy="27" r="16" fill="none" stroke="currentColor" stroke-width="5"></circle>' +
      '<line x1="38" y1="38" x2="54" y2="54" stroke="currentColor" stroke-width="6" stroke-linecap="round"></line>' +
      '</svg>';
  }

  function renderStepMark(step) {
    var html = '';
    if (step.markType === 'pin') {
      html = '<div class="step-mark step-mark--pin">' +
        '<div class="help-map-pin"><span class="help-map-pin-num">1</span></div></div>';
    } else if (step.markType === 'look') {
      html = '<div class="step-mark step-mark--look">' + escapeHtml(step.markIcon || '👀') + '</div>';
    } else if (step.markType === 'magnifier') {
      html = '<div class="step-mark step-mark--magnifier color-' + escapeAttr(step.magnifierColor || 'pink') + '">' +
        magnifierSvg(step.magnifierColor) + '</div>';
    } else if (step.markType === 'gyro') {
      html = '<div class="step-mark step-mark--gyro"><span>GYRO</span></div>';
    } else if (step.markType === 'compass') {
      html = '<div class="step-mark step-mark--compass" aria-hidden="true">' +
        '<span class="help-compass-dial">N</span>' +
        '<span class="help-compass-needle"></span>' +
        '</div>';
    } else if (step.markType === 'counter') {
      html = '<div class="step-mark step-mark--counter" aria-hidden="true"><span>1</span></div>';
    } else if (step.imageSrc) {
      var blinkClass = step.blink ? ' blink' : '';
      html = '<div class="step-mark' + blinkClass + '">' +
        '<img src="' + escapeAttr(step.imageSrc) + '" alt="">' +
        '</div>';
    } else {
      html = '<div class="step-mark">' + escapeHtml(step.markIcon || '•') + '</div>';
    }
    return html;
  }

  function renderHelpPage(rootEl, cfg) {
    if (!rootEl || !cfg) return;
    var titleEl = rootEl.querySelector('[data-help-title]');
    var backEl = rootEl.querySelector('[data-help-back]');
    var stepsEl = rootEl.querySelector('[data-help-steps]');
    var notesEl = rootEl.querySelector('[data-help-notes]');
    var gpsEl = rootEl.querySelector('[data-help-gps]');
    var footerEl = rootEl.querySelector('[data-help-footer]');

    if (titleEl) titleEl.textContent = cfg.title || 'VRツアーの使い方';
    if (backEl) {
      backEl.textContent = cfg.backLabel || '地図に戻る';
      backEl.href = cfg.backHref || defaultMapBackHref();
    }
    if (stepsEl) {
      stepsEl.innerHTML = (cfg.steps || []).map(function(step) {
        var bodyHtml = step.body ? '<br>' + nl2br(step.body) : '';
        return '<div class="card step">' +
          renderStepMark(step) +
          '<div class="step-text"><strong>' + escapeHtml(step.title || '') + '</strong>' + bodyHtml + '</div>' +
          '</div>';
      }).join('');
    }
    if (notesEl) {
      notesEl.innerHTML = (cfg.notes || []).map(function(note) {
        return '<div class="card">' +
          '<strong>' + escapeHtml(note.title || '') + '</strong><br>' +
          nl2br(note.body || '') +
          (note.tip ? '<div class="tip">' + nl2br(note.tip) + '</div>' : '') +
          '</div>';
      }).join('');
    }
    if (gpsEl) {
      gpsEl.innerHTML = renderGpsAppendix(cfg.gpsRows || []);
    }
    if (footerEl) footerEl.textContent = cfg.footer || '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }
  function nl2br(value) {
    return escapeHtml(value).replace(/\n/g, '<br>');
  }

  function getStepCatalog() {
    return STEP_CATALOG;
  }

  function initHelpPage(rootSelector) {
    var root = typeof rootSelector === 'string' ? document.querySelector(rootSelector) : rootSelector;
    var appData = global.APP_DATA || null;
    var userCfg = global.HELP_USER || {};
    var cfg = buildHelpConfig(appData, userCfg);
    renderHelpPage(root, cfg);
    return cfg;
  }

  global.HelpEngine = {
    ASSET: ASSET,
    STEP_CATALOG: STEP_CATALOG,
    detectAppFeatures: detectAppFeatures,
    buildHelpConfig: buildHelpConfig,
    buildGpsRows: buildGpsRows,
    renderGpsAppendix: renderGpsAppendix,
    renderHelpPage: renderHelpPage,
    renderStepMark: renderStepMark,
    getStepCatalog: getStepCatalog,
    initHelpPage: initHelpPage,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    nl2br: nl2br
  };
})(typeof window !== 'undefined' ? window : this);
