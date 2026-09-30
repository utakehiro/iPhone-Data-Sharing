# iPhone Data Sharing の iPhone 設定

## Macに送る

- 共有シート: ON
- 入力: 画像 / メディア / ファイル
- 色: 青系
- 共有シートからそのまま Mac へ送信

前バージョンから更新する場合は、既存の `Macに送る` を削除してから再インポートしてください。

## iPhone Data Sharing受信

受信ファイルは **iCloud Drive / Shortcuts / iPhone Data Sharing** に保存します。

今回の版では、受信データを元のファイル名へ明示的に戻してから、保存先フォルダー `iPhone Data Sharing/` へ保存します。たとえば `report.pdf` は次の場所に保存されます。

```text
iCloud Drive
└─ Shortcuts
   └─ iPhone Data Sharing
      └─ report.pdf
```

受信完了後は Files App の同フォルダを直接開くようにしています。
