# iPhone Data Sharing for Windows

WindowsタスクトレイからiPhoneとの接続、送受信、保存先、ライセンスを管理するアプリです。ローカル転送サーバー、Node.jsランタイム、.NETランタイム、署名済みiPhoneショートカットを自己完結型の配布物へまとめます。

通常ビルド:

```powershell
.\windows-agent\build.ps1 -Runtime win-x64 -Configuration Release -Version 1.0.0
```

MSIXビルドと署名は `packaging/windows/build-msix.ps1` が担当します。詳細はルートの `README.md` を参照してください。

実行時データは `%LOCALAPPDATA%\iPhone Data Sharing`、初期受信先は `%USERPROFILE%\Downloads\iPhone Data Sharing` です。MSIXのインストール先へは書き込みません。

Windows版はAppleのショートカット署名を生成できないため、`resources/shortcuts/` の事前署名済みテンプレートを同梱します。テンプレートの生成はmacOSで次を実行します。

```bash
bash windows-agent/prepare-shortcuts-mac.sh
```
