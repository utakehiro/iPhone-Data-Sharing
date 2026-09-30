# iPhone Data Sharing – 変更履歴

## 2026-09-28: Windows MSIX対応と名称変更

- Windowsアプリの表示名、実行ファイル、保存先、ログ、通知を `iPhone Data Sharing` へ変更
- MSIXマニフェスト、パッケージ画像、MakeAppx/SignTool用スクリプトを追加
- テスト証明書生成スクリプトとWindows GitHub Actionsを追加
- MSIXアップグレード後にWindows Firewallルールが古いNode.jsパスを参照しないよう更新処理を追加
- macOS検証とWindows実機検証を分離し、`WINDOWS_TEST_CHECKLIST.md` を追加

## 以前のiPhone送受信修正

## 2026-09-24 全面点検

- iPhone受信箱のリアルタイム更新URLを修正
- 画像プレビューがダウンロード扱いになり、受信期限を短縮していたルート順序を修正
- 空ファイル・fileなしmultipart送信で無料枠だけ消費される問題を修正
- ショートカット送信許可を1ファイルごとの使い切りに変更
- Windowsタスクトレイの多重起動、ポーリング重複、QR画面多重表示を防止
- Windowsビルドで署名済みショートカットのサイズ・SHA-256を検証
- Windowsビルドが開発環境のNode依存を削除しないようパッケージ工程を分離
- ブラウザ拡張の同時ダウンロード状態競合、Windows非対応ファイル名、中断時の再試行を修正
- Windowsモードと静的ショートカット配信を統合テストへ追加

## 目的

共有シートからのiPhone→Mac送信と、Mac→iPhone受信の保存・完了通知・ファイル名維持を修正します。

## Macに送る

- 共有シート実行は `ActionExtension` のみで登録
- 共有された項目は `ExtensionInput` をそのまま Repeat へ渡す
- 各項目を `multipart/form-data` の `file` として `POST /phone/shortcut` へ送信
- multipartのファイル値は Repeat Item の直接参照に修正し、「ファイル」Appの選択画面が開く問題を解消
- 認証は以前の安定版と同じ Bearer ヘッダー方式
- 送信完了後に「Macに送りました」通知
- Files を開く / URLを開く / ファイル保存 / 別ショートカット実行アクションは `Macに送る` に一切含めない
- 入力タイプは画像、メディア、ファイル、PDF

## iPhone Data Sharing受信

- ダウンロード後、元ファイル名へ明示的にリネームしてから保存
- Save File にはファイル名ではなく保存先フォルダー `iPhone Data Sharing/` を指定
- 保存完了後にPC側へACKを送る順序を固定し、「待機中」が残る問題を解消
- 受信後は Files のトップではなく `iCloud Drive / Shortcuts / iPhone Data Sharing` を開く絶対パスURLを使用

## キャッシュ対策

`shortcutRevision` を更新しました。Mac側で新しい設定済みショートカットを必ず再生成します。

## iPhoneで必要な作業

1. 既存の `Macに送る` と `iPhone Data Sharing受信` を削除
2. iPhone Data Sharing の設定ページから両方を再取得して追加
3. iPhone→Mac送信とMac→iPhone受信をそれぞれ確認
