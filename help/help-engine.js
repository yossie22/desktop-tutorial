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
      defaultTitle: '地図のピンを押して場所を選びます。',
      defaultBody: '見たい場所のピンを押すと、その場所の360度画面が開きます。',
      markType: 'pin'
    },
    lookAround: {
      id: 'lookAround',
      order: 20,
      always: true,
      defaultTitle: '指やマウスで見回します。',
      defaultBody: '画面をドラッグすると、上下左右を自由に見渡せます。',
      markType: 'look'
    },
    routeArrows: {
      id: 'routeArrows',
      order: 30,
      feature: 'hasRoute',
      defaultTitle: '黄色い矢印で次の場所へ進みます。',
      defaultBody: '画面中央付近の黄色い上下矢印を押すと、コース上の次のシーンへ移動します。',
      markType: 'image',
      imageSrc: ASSET.arrowUp,
      blink: false
    },
    sideBranch: {
      id: 'sideBranch',
      order: 40,
      feature: 'hasSideBranch',
      defaultTitle: '黄色矢印が点滅したら脇道へ。',
      defaultBody: '向きを合わせると黄色矢印が点滅します。点滅している矢印を押すと、脇道や別コースへ進めます。',
      markType: 'image',
      imageSrc: ASSET.arrowRight,
      blink: true
    },
    autoPlay: {
      id: 'autoPlay',
      order: 50,
      feature: 'hasRoute',
      defaultTitle: '黄色矢印を長押しで自動再生。',
      defaultBody: '上下の黄色矢印を長押しすると、自動で次の場所へ進みます。止めたいときは画面をタップしてください。',
      markType: 'image',
      imageSrc: ASSET.arrowUp,
      blink: false
    },
    guideVideo: {
      id: 'guideVideo',
      order: 60,
      feature: 'hasGuideVideo',
      defaultTitle: 'ガイド人物が案内します。',
      defaultBody: 'パノラマ内に表示される人物動画が、見どころを案内することがあります。',
      markType: 'look',
      markIcon: '🧑'
    },
    hiResPeek: {
      id: 'hiResPeek',
      order: 70,
      feature: 'hasHiResPeek',
      defaultTitle: 'ピンクの虫眼鏡をタップします。',
      defaultBody: '最後のシーン付近で、ピンク色の枠と虫眼鏡が点滅します。枠をタップすると高解像度の写真が開き、詳しく見られます。',
      markType: 'magnifier',
      magnifierColor: 'pink'
    },
    hiResPeekVr: {
      id: 'hiResPeekVr',
      order: 80,
      feature: 'hasHiResPeek',
      defaultTitle: '左下のボタンでVRに戻ります。',
      defaultBody: '高解像度の写真を拡大中は、左下のアイコンを押すと360度のVR画面に戻れます。',
      markType: 'image',
      imageSrc: ASSET.vrBtn,
      blink: false
    },
    mapButton: {
      id: 'mapButton',
      order: 90,
      always: true,
      defaultTitle: '地図ボタンでいつでも地図へ戻れます。',
      defaultBody: '迷ったときは画面左下の地図ボタンから、最初の地図に戻って別のピンを選べます。',
      markType: 'image',
      imageSrc: ASSET.mapBtn,
      blink: false
    }
  };

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
      magnifierColor: magnifierColor
    };
  }

  function pickText(userTexts, stepId, field, fallback) {
    var block = userTexts && userTexts[stepId];
    if (block && block[field]) return String(block[field]);
    return fallback;
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
      steps.push(step);
    });

    steps.sort(function(a, b) {
      return (STEP_CATALOG[a.id].order || 0) - (STEP_CATALOG[b.id].order || 0);
    });

    var notes = Array.isArray(userCfg.notes) && userCfg.notes.length
      ? userCfg.notes
      : [{
          title: 'iPad・iPhone の場合',
          body: '画面を指でなぞると見回せます。虫眼鏡・矢印・ピンは軽くタップしてください。',
          tip: features.hasHiResPeekVideo
            ? '動画がある場合、最初に画面をタップすると再生が始まることがあります。'
            : '音がある場合、最初に画面をタップすると再生できることがあります。'
        }];

    return {
      title: features.tourTitle + ' — 使い方',
      backLabel: userCfg.backLabel || '地図に戻る',
      backHref: userCfg.backHref || '../map.html',
      steps: steps,
      notes: notes,
      footer: userCfg.footer || '表示がおかしいときは、ブラウザでページを再読み込みしてください。',
      features: features
    };
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
    var footerEl = rootEl.querySelector('[data-help-footer]');

    if (titleEl) titleEl.textContent = cfg.title || 'VRツアーの使い方';
    if (backEl) {
      backEl.textContent = cfg.backLabel || '地図に戻る';
      backEl.href = cfg.backHref || '../map.html';
    }
    if (stepsEl) {
      stepsEl.innerHTML = (cfg.steps || []).map(function(step) {
        return '<div class="card step">' +
          renderStepMark(step) +
          '<div><strong>' + escapeHtml(step.title || '') + '</strong><br>' + nl2br(step.body || '') + '</div>' +
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
    renderHelpPage: renderHelpPage,
    renderStepMark: renderStepMark,
    getStepCatalog: getStepCatalog,
    initHelpPage: initHelpPage,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    nl2br: nl2br
  };
})(typeof window !== 'undefined' ? window : this);
