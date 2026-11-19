# 手書きノート — Gemini Canvas 版（試作）

Gemini（gemini.google.com）の **Canvas** で動かす版です。claude.ai のアーティファクトと同じように、
**開いた人それぞれの Google アカウント（Gemini の利用枠）で AI が動きます**。API キーや課金の設定は要りません。

## しくみ
- Canvas には `loader.html`（短い読み込み用ページ）だけを置きます。
- `loader.html` は、このリポジトリの `gemini-canvas/app.js`（アプリ本体）を jsDelivr 経由で読み込みます。
  そのため **このリポジトリは公開（Public）にしておく必要があります**。
- AI：Canvas の中で Gemini API を呼ぶと、Canvas が開いている人の Gemini として処理します（`apiKey = ""` のままで動く）。
- 保存：Canvas が用意する Firestore の、その人専用の場所（`artifacts/{appId}/users/{uid}/…`）に保存します。
- URL の本文取得・関連内容の Web 検索も Gemini（URL 読み取り・Google 検索）で行います。

## Canvas への置き方
1. https://gemini.google.com を開き、入力欄の「ツール」から **Canvas** を選びます。
2. 次の文と、`loader.html` の中身をまるごと貼り付けて送ります。
   ```
   次の HTML を、1文字も変えずにそのまま Canvas のアプリとして表示してください。説明や改良は不要です。
   ```
   （Gemini がコードを書き換えてしまった場合は「元の HTML に戻して、そのまま表示して」と頼みます）
3. Canvas の右上の「共有」から、リンクを共有します。開いた人はそれぞれ自分の Google アカウントで使います。

## 更新のしかた
1. リポジトリ直下の `index.html`（アプリ本体）を変えたら、`python3 gemini-canvas/build.py` で `app.js` を作り直してコミットします。
2. jsDelivr は最大 12 時間ほど古い版を返すことがあります。すぐに反映したいときは次を開きます：
   https://purge.jsdelivr.net/gh/OS-41/inknote-aistudio@main/gemini-canvas/app.js
3. Canvas 側（`loader.html`）は貼り直す必要はありません。

## 制限（試作のため）
- Gemini の無料プランでは、AI が一度に扱える量が小さいため、長いノートや参考資料を含む本番テストの作成は失敗することがあります（「範囲を狭めて」と表示されます）。
- 共有リンクは gemini.google.com で開きます（Gemini のスマホアプリでは開けません）。
- Canvas の中ではファイルのダウンロード（書き出し）が許可されない場合があります。
- Canvas の内部の動き（API キーなしの Gemini 呼び出し・Firestore の用意）は Google が公式に説明している仕様ではないため、変更されると動かなくなる可能性があります。
