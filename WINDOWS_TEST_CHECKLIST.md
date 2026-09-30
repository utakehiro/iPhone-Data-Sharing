# Windows Test Checklist — iPhone Data Sharing

macOSで代替できない確認を、Windows 10/11の実機またはWindows runnerで実施します。`結果` はリリースごとに `未実施 / Pass / Fail` のいずれかへ更新してください。

| 機能 | Windows確認が必要な理由 | 期待する動作 | 確認方法 | 結果 |
|---|---|---|---|---|
| Windowsビルド | WinFormsとWindows向けランタイムを使用 | `iPhone Data Sharing.exe` が自己完結型で生成される | `windows-agent\build.ps1` を実行 | 未実施 |
| MSIX生成 | MakeAppxはWindows SDK専用 | `.msix` がエラーなく生成される | `packaging\windows\build-msix.ps1` を実行 | 未実施 |
| MSIX署名 | Windows証明書ストアとSignToolを使用 | 署名検証が成功する | `Get-AuthenticodeSignature <msix>` を実行 | 未実施 |
| 新規インストール | MSIX配備はWindows専用 | Startメニューに「iPhone Data Sharing」が表示される | 証明書を信頼後、MSIXをダブルクリック | 未実施 |
| 起動・終了 | タスクトレイとWinFormsを使用 | アイコンが表示され、終了で子プロセスも停止する | 起動後、タスクマネージャーと終了メニューを確認 | 未実施 |
| 単一起動 | Windows Mutexを使用 | 2回起動しても常駐プロセスが重複しない | Startメニューから連続して2回起動 | 未実施 |
| Firewall許可 | UACとWindows Firewallに依存 | PrivateネットワークのTCP 3000ルールが現在の`node.exe`を参照する | 初回許可後にFirewall詳細を確認 | 未実施 |
| iPhoneペアリング | LAN、QR、実機iPhoneが必要 | QR読取後に接続済みとなる | 同一LANのiPhoneでQRを読む | 未実施 |
| 双方向転送 | iOSショートカットとWindowsファイルアクセスが必要 | 双方向でファイル名と内容が保持される | 画像、PDF、日本語名ファイルを各方向へ送る | 未実施 |
| iPhone側の名称 | Apple署名済みショートカットはmacOSでのみ再生成可能 | 追加後の受信ショートカット名と保存先が「iPhone Data Sharing」になる | 新規ショートカットを追加し、名前と保存先を確認 | 未実施 |
| 保存先変更 | Windows FolderBrowserDialogを使用 | 選択した書込可能フォルダーへ保存される | 保存先変更後にiPhoneから送信 | 未実施 |
| 通知 | Windows通知領域に依存 | 接続・受信時に通知が表示される | ペアリングと受信を実施 | 未実施 |
| アップグレード | MSIX identity/versionとFirewallパスが変化 | データを保持して更新され、Firewallルールも現バージョンへ更新される | 低いVersionを導入後、高いVersionを上書き | 未実施 |
| アンインストール | MSIX配備はWindows専用 | アプリ本体が削除される | Windows設定からアンインストール | 未実施 |
| 高DPI | Windowsの表示倍率に依存 | 125%/150%/200%でQRとダイアログが欠けない | 表示倍率を変更して再起動 | 未実施 |
| x64 CI | Windows runnerが必要 | テストとMSIX Artifact生成が成功する | GitHub Actionsの`Windows MSIX`を実行 | 未実施 |

## リリース前コマンド

```powershell
npm --prefix server ci
npm --prefix server run typecheck
npm --prefix server run test:agent
.\packaging\windows\build-msix.ps1 -Version 1.0.0.0 -CertificatePath <PFX> -CertificatePassword <PASSWORD>
Get-AuthenticodeSignature .\packaging\windows\output\iPhone-Data-Sharing-1.0.0.0-x64.msix
```
