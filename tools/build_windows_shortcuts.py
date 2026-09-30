#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tools" / "build_shortcuts.py"
OUT = ROOT / "windows-agent" / "resources" / "shortcuts"

spec = importlib.util.spec_from_file_location("filedrop_build_shortcuts", SOURCE)
if spec is None or spec.loader is None:
    raise SystemExit(f"Cannot load {SOURCE}")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

LANGS = ("ja", "en", "zh", "ko", "es", "fr", "de")

WINDOWS = {
    "ja": {
        "name": "PCに送る",
        "notice": "PCに送りました",
        "send_q": "Windows PCのアドレスを入力（末尾は /phone/shortcut）",
        "recv_q": "Windows PCの受信APIアドレスを入力（末尾は /phone/shortcut/inbox）",
    },
    "en": {
        "name": "Send to PC",
        "notice": "Sent to PC",
        "send_q": "Enter the Windows PC address (ending in /phone/shortcut)",
        "recv_q": "Enter the Windows PC receive API address (ending in /phone/shortcut/inbox)",
    },
    "zh": {
        "name": "发送到 PC",
        "notice": "已发送到 PC",
        "send_q": "输入 Windows PC 地址（以 /phone/shortcut 结尾）",
        "recv_q": "输入 Windows PC 接收 API 地址（以 /phone/shortcut/inbox 结尾）",
    },
    "ko": {
        "name": "PC로 보내기",
        "notice": "PC로 보냈습니다",
        "send_q": "Windows PC 주소를 입력하세요(/phone/shortcut으로 끝남)",
        "recv_q": "Windows PC 수신 API 주소를 입력하세요(/phone/shortcut/inbox로 끝남)",
    },
    "es": {
        "name": "Enviar al PC",
        "notice": "Enviado al PC",
        "send_q": "Introduce la dirección del PC Windows (terminada en /phone/shortcut)",
        "recv_q": "Introduce la API de recepción del PC Windows (terminada en /phone/shortcut/inbox)",
    },
    "fr": {
        "name": "Envoyer au PC",
        "notice": "Envoyé au PC",
        "send_q": "Saisissez l’adresse du PC Windows (se terminant par /phone/shortcut)",
        "recv_q": "Saisissez l’API de réception du PC Windows (se terminant par /phone/shortcut/inbox)",
    },
    "de": {
        "name": "An PC senden",
        "notice": "An PC gesendet",
        "send_q": "Windows-PC-Adresse eingeben (endet mit /phone/shortcut)",
        "recv_q": "Windows-PC-Empfangs-API eingeben (endet mit /phone/shortcut/inbox)",
    },
}

def replace_all(value, mapping):
    if isinstance(value, dict):
        return {k: replace_all(v, mapping) for k, v in value.items()}
    if isinstance(value, list):
        return [replace_all(v, mapping) for v in value]
    if isinstance(value, str):
        return mapping.get(value, value)
    return value

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def build_one(kind: str, lang: str) -> Path:
    if kind == "send":
        data = mod.sending_shortcut(ask=True, locale=lang)
        mapping = {
            mod.localized(lang, "Macに送る", "Send to Mac"): WINDOWS[lang]["name"],
            mod.localized(lang, "Macに送りました", "Sent to Mac"): WINDOWS[lang]["notice"],
            mod.localized(
                lang,
                "PC 画面のアドレスを入力（末尾は /phone/shortcut）",
                "Enter the Mac address (ending in /phone/shortcut)",
            ): WINDOWS[lang]["send_q"],
        }
    else:
        data = mod.receiving_shortcut(ask=True, locale=lang)
        mapping = {
            mod.localized(
                lang,
                "PC の受信APIアドレスを入力（末尾は /phone/shortcut/inbox）",
                "Enter the Mac receive API address (ending in /phone/shortcut/inbox)",
            ): WINDOWS[lang]["recv_q"],
        }

    data = replace_all(data, mapping)
    mod.validate_shortcut(data, kind)
    target = OUT / f"{kind}-{lang}.shortcut"
    mod.sign_shortcut(data, target)
    return target

def main() -> None:
    if sys.platform != "darwin":
        raise SystemExit("Run this script on macOS. Apple Shortcut signing is only available there.")
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {"version": 1, "files": []}
    for lang in LANGS:
        for kind in ("send", "receive"):
            target = build_one(kind, lang)
            manifest["files"].append({
                "kind": kind,
                "lang": lang,
                "name": target.name,
                "size": target.stat().st_size,
                "sha256": sha256(target),
            })
            print(f"Built {target}")
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

if __name__ == "__main__":
    main()
