// 現場ごとの使い方説明はここを編集してください。
// 取説表示.html は共通で使い回せます。
// GitHub 用は help/config.js にも同じ内容をコピーしてください。
window.HELP_CONFIG = {
  title: 'VRツアーの使い方',
  backLabel: '地図に戻る',
  backHref: '../map.html',
  steps: [
    {
      iconType: 'mapPin',
      pinColor: '#ff8080',
      colorClass: 'pin',
      title: '地図のピンを押します。',
      body: '見たい場所のピンを押すと、その場所の360度画面へ移動します。'
    },
    {
      icon: '↑',
      colorClass: 'arrow',
      imageSrc: '../上-removebg-preview.png',
      title: '黄色い上下矢印で進む・戻る。',
      body: '上矢印で次へ、下矢印で前の場所へ移動します。'
    },
    {
      icon: '→',
      colorClass: 'arrow blink',
      imageSrc: '../右-removebg-preview.png',
      title: '黄色矢印が点滅したら脇道へ。',
      body: '向きを合わせると黄色矢印が点滅します。点滅している矢印を押すと、脇道や花畑コースへ進めます。'
    },
    {
      icon: '↑',
      colorClass: 'arrow',
      imageSrc: '../上-removebg-preview.png',
      title: '黄色矢印を長押しで自動再生。',
      body: '上下の黄色矢印を長押しすると、自動で次の場所へ進みます。止めたいときは画面をタップしてください。'
    },
    {
      icon: '地図',
      colorClass: 'map',
      imageSrc: '../Map戻り-removebg-preview.png',
      title: '地図ボタンでいつでも戻れます。',
      body: '迷った時は地図に戻り、別のピンを選んでください。'
    }
  ],
  notes: [
    {
      title: 'スマホ・タブレットの場合',
      body: '画面を指で動かすと周囲を見回せます。矢印やピンは軽くタップしてください。',
      tip: '音がある場合、最初に画面をタップすると再生できることがあります。'
    }
  ],
  footer: '表示が止まったり古い画面が出る場合は、ページを再読み込みしてください。'
};
