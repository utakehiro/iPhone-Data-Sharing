"""Build installable iPhone Data Sharing Shortcuts on macOS (requires /usr/bin/shortcuts)."""

from __future__ import annotations

import json
import plistlib
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "shortcuts"

# These three classes correspond to the Shortcuts share-sheet categories
# 画像 / メディア / ファイル. Keep them explicit so imported shortcuts
# appear in the share sheet for the common iPhone Data Sharing payloads.
SHARE_INPUT_CLASSES = [
    "WFImageContentItem",
    "WFAVAssetContentItem",
    "WFGenericFileContentItem",
]



def uid() -> str:
    return str(uuid.uuid4()).upper()


def action(identifier: str, **parameters: object) -> dict:
    return {
        "WFWorkflowActionIdentifier": f"is.workflow.actions.{identifier}",
        "WFWorkflowActionParameters": parameters,
    }


def attachment(value: dict) -> dict:
    return {"Value": value, "WFSerializationType": "WFTextTokenAttachment"}


def reference(action_uuid: str, name: str) -> dict:
    return {"OutputUUID": action_uuid, "OutputName": name, "Type": "ActionOutput"}


def property_reference(action_uuid: str, name: str, property_name: str) -> dict:
    """Reference a property of a Magic Variable without adding another action."""
    value = reference(action_uuid, name)
    value["Aggrandizements"] = [
        {
            "Type": "WFPropertyVariableAggrandizement",
            "PropertyName": property_name,
        }
    ]
    return value


def token_string(value: str, refs: dict[int, dict] | None = None) -> dict:
    refs = refs or {}
    return {
        "Value": {
            "string": value,
            "attachmentsByRange": {f"{{{index}, 1}}": ref for index, ref in refs.items()},
        },
        "WFSerializationType": "WFTextTokenString",
    }


def field(key: str, value: object, item_type: int = 0) -> dict:
    return {"WFKey": token_string(key), "WFItemType": item_type, "WFValue": value}


def dictionary(fields: list[dict]) -> dict:
    return {
        "Value": {"WFDictionaryFieldValueItems": fields},
        "WFSerializationType": "WFDictionaryFieldValue",
    }


def shortcut(
    name: str,
    actions: list[dict],
    *,
    share_sheet: bool,
    input_classes: list[str],
    glyph: int,
    color: int,
    questions: list[dict] | None = None,
) -> dict:
    return {
        "WFWorkflowName": name,
        "WFWorkflowActions": actions,
        "WFWorkflowIcon": {
            "WFWorkflowIconGlyphNumber": glyph,
            "WFWorkflowIconStartColor": color,
        },
        "WFWorkflowClientVersion": "1200",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowImportQuestions": questions or [],
        "WFWorkflowTypes": ["ActionExtension"] if share_sheet else [],
        "WFWorkflowInputContentItemClasses": input_classes,
        "WFWorkflowOutputContentItemClasses": [],
    }


def validate_shortcut(data: dict, kind: str) -> None:
    """Fail the build if send/receive actions are accidentally mixed.

    This protects the install endpoints from ever shipping a receive workflow under
    the "Macに送る" name (or vice versa), which is especially confusing on iOS
    because importing a duplicate creates names such as "Macに送る (2)".
    """
    identifiers = [
        item.get("WFWorkflowActionIdentifier", "").removeprefix("is.workflow.actions.")
        for item in data.get("WFWorkflowActions", [])
    ]
    if kind == "send":
        forbidden = {"documentpicker.save", "openurl", "setname"}
        mixed = forbidden.intersection(identifiers)
        if mixed:
            raise ValueError(f"Send shortcut contains receive-only actions: {sorted(mixed)}")
        upload_actions = [
            item
            for item in data.get("WFWorkflowActions", [])
            if item.get("WFWorkflowActionIdentifier") == "is.workflow.actions.downloadurl"
            and item.get("WFWorkflowActionParameters", {}).get("WFHTTPMethod") == "POST"
        ]
        if not any(
            item.get("WFWorkflowActionParameters", {}).get("WFHTTPBodyType") == "File"
            and "WFRequestVariable" in item.get("WFWorkflowActionParameters", {})
            and "WFFormValues" not in item.get("WFWorkflowActionParameters", {})
            for item in upload_actions
        ):
            raise ValueError("Send shortcut is missing the raw file-body upload action")
        if any("WFFormValues" in item.get("WFWorkflowActionParameters", {}) for item in upload_actions):
            raise ValueError("Send shortcut must not use multipart/Form file fields on current iOS")
    elif kind == "receive":
        if "documentpicker.save" not in identifiers:
            raise ValueError("Receive shortcut is missing its save action")
    else:
        raise ValueError(f"Unknown shortcut kind: {kind}")


SUPPORTED_LOCALES = {"ja", "en", "zh", "ko", "es", "fr", "de"}
SHORTCUT_TRANSLATIONS = {'zh': {'Send to Mac': '发送到 Mac', 'iPhone Data Sharing Receive': 'iPhone Data Sharing 接收', 'Sent to Mac': '已发送到 Mac', 'Received files are in “iCloud > Shortcuts > iPhone Data Sharing”': '接收的文件位于“iCloud > Shortcuts > iPhone Data Sharing”', 'Enter the Mac address (ending in /phone/shortcut)': '输入 Mac 地址（以 /phone/shortcut 结尾）', 'Enter the send token from the pairing screen (prefix with Bearer and a space)': '输入配对页面的发送令牌（前加 Bearer 和一个空格）', 'Enter the Mac receive API address (ending in /phone/shortcut/inbox)': '输入 Mac 接收 API 地址（以 /phone/shortcut/inbox 结尾）', 'Enter the receive token from the pairing screen (prefix with Bearer and a space)': '输入配对页面的接收令牌（前加 Bearer 和一个空格）'}, 'ko': {'Send to Mac': 'Mac으로 보내기', 'iPhone Data Sharing Receive': 'iPhone Data Sharing 수신', 'Sent to Mac': 'Mac으로 보냈습니다', 'Received files are in “iCloud > Shortcuts > iPhone Data Sharing”': '수신 파일은 ‘iCloud > Shortcuts > iPhone Data Sharing’에 있습니다', 'Enter the Mac address (ending in /phone/shortcut)': 'Mac 주소를 입력하세요(/phone/shortcut으로 끝남)', 'Enter the send token from the pairing screen (prefix with Bearer and a space)': '페어링 화면의 전송 토큰을 입력하세요(Bearer와 공백을 앞에 추가)', 'Enter the Mac receive API address (ending in /phone/shortcut/inbox)': 'Mac 수신 API 주소를 입력하세요(/phone/shortcut/inbox로 끝남)', 'Enter the receive token from the pairing screen (prefix with Bearer and a space)': '페어링 화면의 수신 토큰을 입력하세요(Bearer와 공백을 앞에 추가)'}, 'es': {'Send to Mac': 'Enviar al Mac', 'iPhone Data Sharing Receive': 'Recibir con iPhone Data Sharing', 'Sent to Mac': 'Enviado al Mac', 'Received files are in “iCloud > Shortcuts > iPhone Data Sharing”': 'Los archivos recibidos están en «iCloud > Shortcuts > iPhone Data Sharing»', 'Enter the Mac address (ending in /phone/shortcut)': 'Introduce la dirección del Mac (terminada en /phone/shortcut)', 'Enter the send token from the pairing screen (prefix with Bearer and a space)': 'Introduce el token de envío de la pantalla de enlace (con Bearer y un espacio delante)', 'Enter the Mac receive API address (ending in /phone/shortcut/inbox)': 'Introduce la dirección API de recepción del Mac (terminada en /phone/shortcut/inbox)', 'Enter the receive token from the pairing screen (prefix with Bearer and a space)': 'Introduce el token de recepción de la pantalla de enlace (con Bearer y un espacio delante)'}, 'fr': {'Send to Mac': 'Envoyer au Mac', 'iPhone Data Sharing Receive': 'Réception iPhone Data Sharing', 'Sent to Mac': 'Envoyé au Mac', 'Received files are in “iCloud > Shortcuts > iPhone Data Sharing”': 'Les fichiers reçus se trouvent dans « iCloud > Shortcuts > iPhone Data Sharing »', 'Enter the Mac address (ending in /phone/shortcut)': 'Saisissez l’adresse du Mac (se terminant par /phone/shortcut)', 'Enter the send token from the pairing screen (prefix with Bearer and a space)': 'Saisissez le jeton d’envoi de l’écran d’association (précédé de Bearer et d’un espace)', 'Enter the Mac receive API address (ending in /phone/shortcut/inbox)': 'Saisissez l’adresse API de réception du Mac (se terminant par /phone/shortcut/inbox)', 'Enter the receive token from the pairing screen (prefix with Bearer and a space)': 'Saisissez le jeton de réception de l’écran d’association (précédé de Bearer et d’un espace)'}, 'de': {'Send to Mac': 'An Mac senden', 'iPhone Data Sharing Receive': 'iPhone Data Sharing Empfangen', 'Sent to Mac': 'An Mac gesendet', 'Received files are in “iCloud > Shortcuts > iPhone Data Sharing”': 'Empfangene Dateien befinden sich in „iCloud > Shortcuts > iPhone Data Sharing“', 'Enter the Mac address (ending in /phone/shortcut)': 'Mac-Adresse eingeben (endet mit /phone/shortcut)', 'Enter the send token from the pairing screen (prefix with Bearer and a space)': 'Sendetoken vom Kopplungsbildschirm eingeben (mit Bearer und Leerzeichen davor)', 'Enter the Mac receive API address (ending in /phone/shortcut/inbox)': 'Mac-Empfangs-API-Adresse eingeben (endet mit /phone/shortcut/inbox)', 'Enter the receive token from the pairing screen (prefix with Bearer and a space)': 'Empfangstoken vom Kopplungsbildschirm eingeben (mit Bearer und Leerzeichen davor)'}}


def normalized_locale(value: object) -> str:
    if not isinstance(value, str):
        return "en"
    code = value.lower().split("-", 1)[0]
    return code if code in SUPPORTED_LOCALES else "en"


def localized(locale: str, ja: str, en: str) -> str:
    code = normalized_locale(locale)
    if code == "ja":
        return ja
    if code == "en":
        return en
    return SHORTCUT_TRANSLATIONS.get(code, {}).get(en, en)


def sending_shortcut(
    address: str = "http://PC-IP:3000/phone/shortcut",
    authorization: str = "Bearer PAIRING_TOKEN",
    *,
    ask: bool = True,
    locale: str = "ja",
) -> dict:
    """Build the iPhone -> Mac share-sheet shortcut.

    Current iOS crashes while importing a shortcut that places ExtensionInput
    inside a multipart/Form ``file`` field. The send flow therefore uploads each
    shared item as the raw HTTP request body instead. The PC endpoint already
    supports this transport.
    """
    url_uuid, token_uuid, repeat_uuid, group_uuid = uid(), uid(), uid(), uid()
    permit_request_uuid, permit_uuid = uid(), uid()
    permit_address = f"{address.rstrip('/')}/permit"
    actions = [
        action("gettext", UUID=url_uuid, CustomOutputName="PC address", WFTextActionText=address),
        action("gettext", UUID=token_uuid, CustomOutputName="Authorization", WFTextActionText=authorization),
        # Obtain one permit per Share-sheet execution. The Local Agent counts the
        # first successful upload under this permit as one transfer, so a batch of
        # multiple shared files remains one daily use.
        action(
            "downloadurl",
            UUID=permit_request_uuid,
            CustomOutputName="Transfer Permit Response",
            WFURL=permit_address,
            WFHTTPMethod="POST",
            ShowHeaders=True,
            WFHTTPHeaders=dictionary(
                [
                    field(
                        "Authorization",
                        token_string("\ufffc", {0: reference(token_uuid, "Authorization")}),
                    )
                ]
            ),
        ),
        action(
            "getvalueforkey",
            UUID=permit_uuid,
            CustomOutputName="Transfer Permit",
            WFDictionaryKey="permit",
            WFInput=attachment(reference(permit_request_uuid, "Transfer Permit Response")),
        ),
        action(
            "repeat.each",
            UUID=repeat_uuid,
            GroupingIdentifier=group_uuid,
            WFControlFlowMode=0,
            WFInput=attachment({"Type": "ExtensionInput"}),
        ),
        action(
            "downloadurl",
            UUID=uid(),
            WFURL=token_string("\ufffc", {0: reference(url_uuid, "PC address")}),
            WFHTTPMethod="POST",
            WFHTTPBodyType="File",
            ShowHeaders=True,
            WFHTTPHeaders=dictionary(
                [
                    field(
                        "Authorization",
                        token_string("\ufffc", {0: reference(token_uuid, "Authorization")}),
                    ),
                    # Keep the raw-body transport (which imports safely on current iOS)
                    # while passing the original shared item's name in a normal header.
                    field(
                        "X-Filename",
                        token_string(
                            "\ufffc",
                            {0: property_reference(repeat_uuid, "Repeat Item", "Name")},
                        ),
                    ),
                    field(
                        "X-Usage-Permit",
                        token_string("\ufffc", {0: reference(permit_uuid, "Transfer Permit")}),
                    ),
                ]
            ),
            WFRequestVariable=attachment(reference(repeat_uuid, "Repeat Item")),
        ),
        action("repeat.each", UUID=uid(), GroupingIdentifier=group_uuid, WFControlFlowMode=2),
        action(
            "notification",
            UUID=uid(),
            WFNotificationActionTitle="iPhone Data Sharing",
            WFNotificationActionBody=localized(locale, "Macに送りました", "Sent to Mac"),
            WFNotificationActionSound=False,
        ),
    ]
    questions = [
        {
            "ActionIndex": 0,
            "Category": "Parameter",
            "ParameterKey": "WFTextActionText",
            "Text": localized(locale, "PC 画面のアドレスを入力（末尾は /phone/shortcut）", "Enter the Mac address (ending in /phone/shortcut)"),
            "DefaultValue": "http://PC-IP:3000/phone/shortcut",
        },
        {
            "ActionIndex": 1,
            "Category": "Parameter",
            "ParameterKey": "WFTextActionText",
            "Text": localized(locale, "ペアリング完了画面の送信トークンを入力（先頭に Bearer と半角スペース）", "Enter the send token from the pairing screen (prefix with Bearer and a space)"),
            "DefaultValue": "Bearer PAIRING_TOKEN",
        },
    ]
    data = shortcut(
        localized(locale, "Macに送る", "Send to Mac"),
        actions,
        share_sheet=True,
        glyph=59708,
        color=795864575,
        input_classes=[
            "WFImageContentItem",
            "WFAVAssetContentItem",
            "WFGenericFileContentItem",
            "WFPDFContentItem",
        ],
        questions=questions if ask else [],
    )
    validate_shortcut(data, "send")
    return data

def receiving_shortcut(
    address: str = "http://PC-IP:3000/phone/shortcut/inbox",
    authorization: str = "Bearer PAIRING_TOKEN",
    *,
    ask: bool = True,
    locale: str = "ja",
) -> dict:
    """Receive every queued file and save it to iCloud Drive.

    Files are saved directly by Shortcuts to the Files app. The destination path is
    configured as ``iPhone Data Sharing/`` which, on iOS, is typically resolved under
    iCloud Drive / Shortcuts / iPhone Data Sharing. This removes the need for the helper
    shortcut "ファイルを移動".
    """
    url_uuid = uid()
    token_uuid = uid()
    inbox_uuid = uid()
    files_uuid = uid()
    repeat_uuid = uid()
    group_uuid = uid()
    item_name_uuid = uid()
    item_url_uuid = uid()
    download_uuid = uid()

    auth_value = token_string("￼", {0: reference(token_uuid, "Authorization")})
    actions = [
        action("gettext", UUID=url_uuid, CustomOutputName="Inbox address", WFTextActionText=address),
        action("gettext", UUID=token_uuid, CustomOutputName="Authorization", WFTextActionText=authorization),
        action(
            "downloadurl",
            UUID=inbox_uuid,
            CustomOutputName="Inbox response",
            WFURL=token_string("￼", {0: reference(url_uuid, "Inbox address")}),
            WFHTTPMethod="GET",
            ShowHeaders=True,
            WFHTTPHeaders=dictionary([field("Authorization", auth_value)]),
        ),
        action(
            "getvalueforkey",
            UUID=files_uuid,
            CustomOutputName="Files",
            WFDictionaryKey="files",
            WFInput=attachment(reference(inbox_uuid, "Inbox response")),
        ),
        action(
            "repeat.each",
            UUID=repeat_uuid,
            GroupingIdentifier=group_uuid,
            WFControlFlowMode=0,
            WFInput=attachment(reference(files_uuid, "Files")),
        ),
        action(
            "getvalueforkey",
            UUID=item_name_uuid,
            CustomOutputName="Original Name",
            WFDictionaryKey="name",
            WFInput=attachment(reference(repeat_uuid, "Repeat Item")),
        ),
        action(
            "getvalueforkey",
            UUID=item_url_uuid,
            CustomOutputName="Download URL",
            WFDictionaryKey="url",
            WFInput=attachment(reference(repeat_uuid, "Repeat Item")),
        ),
        action(
            "downloadurl",
            UUID=download_uuid,
            CustomOutputName="Received File",
            WFURL=token_string("￼", {0: reference(item_url_uuid, "Download URL")}),
            WFHTTPMethod="GET",
            ShowHeaders=True,
            WFHTTPHeaders=dictionary([field("Authorization", auth_value)]),
        ),
        action(
            "documentpicker.save",
            UUID=uid(),
            # "Save File" treats this as a relative subpath. Supplying the complete
            # iPhone Data Sharing/<original name> path preserves the filename without using the
            # unsupported Set Name action.
            WFInput=attachment(reference(download_uuid, "Received File")),
            WFAskWhereToSave=False,
            WFFileDestinationPath=token_string(
                "iPhone Data Sharing/\ufffc",
                {10: reference(item_name_uuid, "Original Name")},
            ),
            WFSaveFileOverwrite=False,
        ),
        action("repeat.each", UUID=uid(), GroupingIdentifier=group_uuid, WFControlFlowMode=2),
        action(
            "notification",
            UUID=uid(),
            WFNotificationActionTitle="iPhone Data Sharing",
            WFNotificationActionBody=localized(locale, "受信ファイルは「iCloud > Shortcuts > iPhone Data Sharing」にあります", "Received files are in “iCloud > Shortcuts > iPhone Data Sharing”"),
            WFNotificationActionSound=True,
        ),
        action(
            "url",
            UUID=(files_url_uuid := uid()),
            CustomOutputName="Files URL",
            WFURLActionURL=(
                "shareddocuments:///private/var/mobile/Library/Mobile%20Documents/"
                "com~apple~CloudDocs/Shortcuts/iPhone%20Data%20Sharing/"
            ),
        ),
        action(
            "openurl",
            UUID=uid(),
            WFInput=attachment(reference(files_url_uuid, "Files URL")),
        ),
    ]
    questions = [
        {
            "ActionIndex": 0,
            "Category": "Parameter",
            "ParameterKey": "WFTextActionText",
            "Text": localized(locale, "PC の受信APIアドレスを入力（末尾は /phone/shortcut/inbox）", "Enter the Mac receive API address (ending in /phone/shortcut/inbox)"),
            "DefaultValue": "http://PC-IP:3000/phone/shortcut/inbox",
        },
        {
            "ActionIndex": 1,
            "Category": "Parameter",
            "ParameterKey": "WFTextActionText",
            "Text": localized(locale, "ペアリング完了画面の受信トークンを入力（先頭に Bearer と半角スペース）", "Enter the receive token from the pairing screen (prefix with Bearer and a space)"),
            "DefaultValue": "Bearer PAIRING_TOKEN",
        },
    ]
    data = shortcut(
        localized(locale, "iPhone Data Sharing受信", "iPhone Data Sharing Receive"),
        actions,
        # Requested default: show this shortcut in the share sheet as well.
        # The receive flow itself does not consume Shortcut Input; enabling this
        # simply keeps its share-sheet setting and accepted types preconfigured.
        share_sheet=True,
        # Orange + download/inbox style glyph.
        glyph=59511,
        color=4287955199,  # #FF9500FF
        input_classes=SHARE_INPUT_CLASSES,
        questions=questions if ask else [],
    )
    validate_shortcut(data, "receive")
    return data


def sign_shortcut(data: dict, target: Path) -> None:
    """Sign a shortcut and print the full Shortcuts CLI error if signing fails."""
    with tempfile.TemporaryDirectory() as directory:
        unsigned = Path(directory) / "unsigned.shortcut"
        unsigned.write_bytes(plistlib.dumps(data, fmt=plistlib.FMT_BINARY))

        result = subprocess.run(
            [
                "/usr/bin/shortcuts",
                "sign",
                "--mode",
                "anyone",
                "--input",
                str(unsigned),
                "--output",
                str(target),
            ],
            text=True,
            capture_output=True,
        )

        if result.returncode != 0:
            print("=== shortcuts sign failed ===", file=sys.stderr)
            print(f"workflow: {data.get('WFWorkflowName', '<unknown>')}", file=sys.stderr)
            print(f"input:    {unsigned}", file=sys.stderr)
            print(f"output:   {target}", file=sys.stderr)
            print(f"exit:     {result.returncode}", file=sys.stderr)
            print("--- stdout ---", file=sys.stderr)
            print(result.stdout or "<empty>", file=sys.stderr)
            print("--- stderr ---", file=sys.stderr)
            print(result.stderr or "<empty>", file=sys.stderr)
            print("=============================", file=sys.stderr)
            raise RuntimeError(
                f"shortcuts sign failed for {data.get('WFWorkflowName', '<unknown>')} "
                f"with exit code {result.returncode}"
            )


def configured_from_stdin(kind: str, target: Path) -> None:
    config = json.load(sys.stdin)
    address = config.get("address")
    authorization = config.get("authorization")
    locale = normalized_locale(config.get("locale", "ja"))

    if not isinstance(address, str) or not isinstance(authorization, str):
        raise ValueError("Configured shortcut requires string address and authorization values")
    if not address.startswith("http://"):
        raise ValueError("Configured shortcut address must be an http:// LAN URL")
    if not authorization.startswith("Bearer ") or len(authorization) <= len("Bearer "):
        raise ValueError("Configured shortcut requires a non-empty Bearer token")

    # Never sign a production/configured shortcut while placeholders are still
    # present. This turns a silent 'nothing is sent' failure into a build error.
    forbidden = ("PC-IP", "PAIRING_TOKEN", "127.0.0.1", "localhost")
    if any(marker in address or marker in authorization for marker in forbidden):
        raise ValueError("Configured shortcut still contains a placeholder or loopback address")

    expected_suffix = "/phone/shortcut" if kind == "send" else "/phone/shortcut/inbox"
    if not address.rstrip("/").endswith(expected_suffix):
        raise ValueError(f"Configured {kind} shortcut has an unexpected endpoint: {address}")

    if kind == "send":
        data = sending_shortcut(address, authorization, ask=False, locale=locale)
    else:
        data = receiving_shortcut(address, authorization, ask=False, locale=locale)
    sign_shortcut(data, target)


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] in {"--configured", "--configured-send", "--configured-receive"}:
        kind = "receive" if sys.argv[1] == "--configured-receive" else "send"
        configured_from_stdin(kind, Path(sys.argv[2]))
        return

    OUTPUT.mkdir(exist_ok=True)
    print(
        "NOTE: no-argument mode creates TEMPLATE shortcuts only. "
        "For a paired iPhone, install from the Local Agent setup page so the "
        "real LAN address and Bearer token are embedded.",
        file=sys.stderr,
    )
    for basename, data in [
        ("Macに送る_テンプレート", sending_shortcut()),
        ("iPhone Data Sharing受信_テンプレート", receiving_shortcut()),
    ]:
        target = OUTPUT / f"{basename}.shortcut"
        sign_shortcut(data, target)
        print(target)


if __name__ == "__main__":
    main()
