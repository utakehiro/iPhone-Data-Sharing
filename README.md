# iPhone Data Sharing

同じLAN内のiPhoneとWindows PCの間で、ファイルを直接送受信するWindowsアプリです。Windowsではタスクトレイ常駐アプリとして動作し、最終配布形式としてMSIXを生成できます。

## 構成

- `server/`: macOSでもテストできる共通のローカル転送サーバー
- `windows-agent/`: .NET 8 / Windows Formsのタスクトレイアプリ
- `packaging/windows/`: MSIXマニフェスト、画像、生成・署名スクリプト
- `tools/`: iPhoneショートカット生成・検証ツール
- `.github/workflows/windows-msix.yml`: Windows上のテスト、ビルド、MSIX生成

## macOSでの開発と検証

Node.js 20以降、npm、Python 3を用意してください。

```bash
cd server
npm ci
npm run typecheck
npm run test:agent
```

iPhoneショートカットの構造テストだけを行う場合:

```bash
python3 -m pytest tools/test_build_shortcuts.py
```

Apple署名済みのWindows用ショートカットを更新する場合:

```bash
bash windows-agent/prepare-shortcuts-mac.sh
```

この署名処理はmacOSの `/usr/bin/shortcuts` に依存します。Windowsでは実行しません。

## Windowsで通常ビルド

必要なもの:

- Windows 10または11
- Node.js 20以降
- .NET 8 SDK

```powershell
powershell -ExecutionPolicy Bypass -File windows-agent\build.ps1
```

出力:

```text
windows-agent\dist\iPhone Data Sharing\
windows-agent\dist\iPhone-Data-Sharing-Windows.zip
```

## WindowsでMSIXを生成

追加でWindows 10/11 SDK（`makeappx.exe` と `signtool.exe`）が必要です。

開発用証明書を作成して署名済みMSIXを生成する例:

```powershell
$password = [Guid]::NewGuid().ToString("N")
.\packaging\windows\new-test-certificate.ps1 -Password $password
.\packaging\windows\build-msix.ps1 `
  -Version 1.0.0.0 `
  -CertificatePath .\packaging\windows\output\iPhone-Data-Sharing-Test.pfx `
  -CertificatePassword $password
```

出力は `packaging\windows\output\` です。別のPCでテスト用MSIXをインストールする前に、同時生成された `.cer` を「信頼されたユーザー」へ登録してください。テスト証明書を本番配布には使用しないでください。

本番では、マニフェストのPublisherと一致する正式なコード署名証明書を指定します。Microsoft Storeを使う場合は、Storeが割り当てたPackage IdentityとPublisherを `build-msix.ps1` の引数へ渡してください。秘密鍵やパスワードはリポジトリへ保存せず、CIのSecretから渡します。

## GitHub Actions

`Windows MSIX` ワークフローはWindows runnerで共有ロジックをテストし、自己完結型アプリとテスト署名済みMSIXをArtifactとして出力します。最終リリースではテスト証明書を正式な署名またはMicrosoft Store署名へ置き換えてください。

## Windowsでのみ確認する項目

MSIX生成、署名、インストール、アップグレード、アンインストール、タスクトレイ、Windows Firewall、実機iPhoneとの通信はmacOSでは検証できません。手順と結果は `WINDOWS_TEST_CHECKLIST.md` に記録します。
