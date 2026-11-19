# 手書きノート — Google AI Studio 版

Cloudflare 版と同じ画面・機能を、Google AI Studio の Build モード（フルスタックアプリ）で動かす版です。

| | Cloudflare 版（[OS-41/inknote](https://github.com/OS-41/inknote)） | AI Studio 版（このリポジトリ） |
|---|---|---|
| AI | Gemini / OpenAI / Anthropic / OpenRouter / Workers AI から選択 | **Gemini**（AI Studio が用意する `GEMINI_API_KEY`） |
| ログイン | ユーザー名とパスワード | **Google でログイン**（Firebase Authentication） |
| 保存 | Cloudflare D1 | **Cloud Firestore**（本人だけが読み書きできるルール） |
| 関連内容の Web 検索 | Parallel の API キーがあるとき | **Gemini の Google 検索**（追加の設定なし） |
| 公開 | Cloudflare Workers | **Cloud Run**（AI Studio から） |

## Gemini Canvas 版（試作）
API キーを使わず、開いた人それぞれの Gemini で動く版を `gemini-canvas/` に置いています。手順は [gemini-canvas/README.md](gemini-canvas/README.md) を見てください。

## 構成
```
index.html           アプリ本体（Cloudflare 版と同じ）
src/shim.js          Firebase（Firestore・Google ログイン）とサーバーにつなぐ部品
src/firebase.js      Firebase の読み込み
public/sw.js         画像（/_blob/…）を Firestore から読み出して表示する Service Worker
public/icon-*.png    アイコン
server.ts            サーバー（Express）：Gemini 呼び出し・URL 取得・Google 検索
firestore.rules      Firestore のセキュリティルール（自分のデータだけ読み書き可）
metadata.json        AI Studio 用のアプリ情報
```

## AI Studio での始め方

### 1. 取り込む
1. https://aistudio.google.com/apps を開き、Build モードの入力欄の「＋（Add files）」→「**Import from GitHub**」。
2. リポジトリ `OS-41/inknote-aistudio` を選びます（`main` ブランチが取り込まれます）。

### 2. Firebase（保存とログイン）を有効にする
AI Studio のチャットに、次の文をそのまま送ります。
```
このアプリに Firebase を有効にしてください（Cloud Firestore と、Google でログインする Firebase Authentication）。
・設定は firebase-applet-config.json に出力してください（server.ts がこのファイルを読みます）。
・Firestore のルールは既存の firestore.rules をそのまま使ってください。
・src/shim.js・src/firebase.js・server.ts・index.html の構成は変えないでください。
```
カードが出たら承認します。完了すると、プロジェクトに `firebase-applet-config.json` ができます。

### 3. AI の確認
`GEMINI_API_KEY` は AI Studio が自動で設定します（Settings → Secrets で確認できます）。
プレビューでログインし、左のメニューの「AIの設定」→「接続テスト」で動作を確認します。

### 4. 公開する
右上の「Deploy」（または Share → Deploy）から **Cloud Run** に公開します。
- 公開したアプリでは、**すべての利用者の Gemini 呼び出しに、作った人の API キー（利用枠）が使われます**。1人1日の回数は `AI_DAILY_LIMIT`（標準 200 回、Secrets で変更可）で制限しています（サーバーが再起動するとリセットされる簡易なものです）。
- Google ログインがエラーになる場合は、Firebase コンソールの Authentication → 設定 →「承認済みドメイン」に、公開された URL のドメインを追加してください（AI Studio のチャットで頼むこともできます）。

## うまく動かないとき
- **「Firebase が未設定です」と出る**：手順2が終わっていないか、`firebase-applet-config.json` ができていません。
- **画像が表示されない**：画像は Service Worker 経由で表示します。一度ページを再読み込みしてください。AI Studio のプレビュー画面では Service Worker が使えない場合があります（公開した URL では使えます）。
- **ビルドエラー**：AI Studio のチャットで「fix any build issues with the current code」と頼むと、エージェントが直します。

## 設定（Settings → Secrets）
| 名前 | 内容 | 標準 |
|---|---|---|
| `GEMINI_API_KEY` | Gemini の API キー（自動で設定） | — |
| `GEMINI_MODEL` | ふだんの処理に使うモデル | `gemini-2.5-flash` |
| `GEMINI_MODEL_COMPLEX` | 重い処理（画像の解析・本番テスト・添削）に使うモデル | `gemini-2.5-pro` |
| `AI_DAILY_LIMIT` | 1人1日の AI 呼び出し回数 | 200 |

利用者は「AIの設定」で、自分の端末で使うモデルを変えることもできます（「一覧」で今使えるモデルを確認できます）。

## データの保存場所（Firestore）
- `users/{uid}/docs/{id}`：ノート・手書き・参考資料・演習の記録など（中身は JSON 文字列）
- `users/{uid}/blobs/{id}` と `users/{uid}/blobs/{id}/chunks/{n}`：画像（分割して保存）

Cloudflare 版のノートは、Cloudflare 版で「書き出し」→ この版で「読み込み」で移せます（画像も含む）。

## 変更の管理
- AI Studio で変更したときは、Settings の GitHub タブからこのリポジトリと同期（push / pull）できます。
- アプリ本体の `index.html` は Cloudflare 版と共通です。片方で機能を変えたら、もう片方にも同じ変更を入れてください（Claude に頼めば両方に入れます）。
