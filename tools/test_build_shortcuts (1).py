from __future__ import annotations

import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).with_name("build_shortcuts.py")


@pytest.fixture(scope="module")
def build_shortcuts():
    spec = importlib.util.spec_from_file_location("build_shortcuts", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _identifiers(data: dict) -> list[str]:
    return [
        item.get("WFWorkflowActionIdentifier", "").removeprefix("is.workflow.actions.")
        for item in data.get("WFWorkflowActions", [])
    ]


def _actions(data: dict, identifier: str) -> list[dict]:
    full = f"is.workflow.actions.{identifier}"
    return [
        item for item in data.get("WFWorkflowActions", [])
        if item.get("WFWorkflowActionIdentifier") == full
    ]


def test_sending_shortcut_uses_raw_file_body_not_multipart(build_shortcuts):
    data = build_shortcuts.sending_shortcut(
        "http://192.0.2.10:3000/phone/shortcut",
        "Bearer test-token",
        ask=False,
    )

    uploads = [
        item for item in _actions(data, "downloadurl")
        if item.get("WFWorkflowActionParameters", {}).get("WFHTTPMethod") == "POST"
        and item.get("WFWorkflowActionParameters", {}).get("WFHTTPBodyType") == "File"
    ]
    assert len(uploads) == 1

    params = uploads[0]["WFWorkflowActionParameters"]
    assert params["WFHTTPBodyType"] == "File"
    assert "WFRequestVariable" in params
    assert "WFFormValues" not in params

    headers = params["WFHTTPHeaders"]["Value"]["WFDictionaryFieldValueItems"]
    filename_header = next(
        item for item in headers
        if item["WFKey"]["Value"]["string"] == "X-Filename"
    )
    filename_value = filename_header["WFValue"]["Value"]
    filename_ref = filename_value["attachmentsByRange"]["{0, 1}"]
    assert filename_ref["OutputName"] == "Repeat Item"
    assert filename_ref["Aggrandizements"][0]["PropertyName"] == "Name"

    permit_header = next(
        item for item in headers
        if item["WFKey"]["Value"]["string"] == "X-Usage-Permit"
    )
    permit_ref = permit_header["WFValue"]["Value"]["attachmentsByRange"]["{0, 1}"]
    assert permit_ref["OutputName"] == "Transfer Permit"

    preflight = [
        item for item in _actions(data, "downloadurl")
        if item.get("WFWorkflowActionParameters", {}).get("WFHTTPMethod") == "POST"
        and isinstance(item.get("WFWorkflowActionParameters", {}).get("WFURL"), str)
        and item["WFWorkflowActionParameters"]["WFURL"].endswith("/phone/shortcut/permit")
    ]
    assert len(preflight) == 1

    request_variable = params["WFRequestVariable"]
    assert request_variable["WFSerializationType"] == "WFTextTokenAttachment"
    assert request_variable["Value"]["Type"] == "ActionOutput"
    assert request_variable["Value"]["OutputName"] == "Repeat Item"


def test_sending_shortcut_is_share_sheet_enabled(build_shortcuts):
    data = build_shortcuts.sending_shortcut(ask=False)

    assert "ActionExtension" in data["WFWorkflowTypes"]
    assert "WFImageContentItem" in data["WFWorkflowInputContentItemClasses"]
    assert "WFAVAssetContentItem" in data["WFWorkflowInputContentItemClasses"]
    assert "WFGenericFileContentItem" in data["WFWorkflowInputContentItemClasses"]
    assert "WFPDFContentItem" in data["WFWorkflowInputContentItemClasses"]


def test_sending_shortcut_does_not_contain_receive_only_actions(build_shortcuts):
    data = build_shortcuts.sending_shortcut(ask=False)
    identifiers = set(_identifiers(data))

    assert "documentpicker.save" not in identifiers
    assert "openurl" not in identifiers
    assert "setname" not in identifiers


def test_validate_send_rejects_multipart_form_upload(build_shortcuts):
    data = build_shortcuts.sending_shortcut(ask=False)
    upload = next(
        item for item in _actions(data, "downloadurl")
        if item.get("WFWorkflowActionParameters", {}).get("WFHTTPMethod") == "POST"
        and item.get("WFWorkflowActionParameters", {}).get("WFHTTPBodyType") == "File"
    )
    params = upload["WFWorkflowActionParameters"]
    params["WFHTTPBodyType"] = "Form"
    params["WFFormValues"] = build_shortcuts.dictionary(
        [build_shortcuts.field("file", "bad", 5)]
    )
    params.pop("WFRequestVariable", None)

    with pytest.raises(ValueError, match="raw file-body upload|multipart/Form"):
        build_shortcuts.validate_shortcut(data, "send")


def test_receiving_shortcut_saves_received_file_without_setname(build_shortcuts):
    data = build_shortcuts.receiving_shortcut(
        "http://192.0.2.10:3000/phone/shortcut/inbox",
        "Bearer test-token",
        ask=False,
    )
    identifiers = _identifiers(data)

    assert "setname" not in identifiers
    assert "documentpicker.save" in identifiers

    save = _actions(data, "documentpicker.save")[0]["WFWorkflowActionParameters"]
    assert save["WFAskWhereToSave"] is False
    destination = save["WFFileDestinationPath"]
    assert destination["WFSerializationType"] == "WFTextTokenString"
    assert destination["Value"]["string"] == "iPhone Data Sharing/\ufffc"
    assert save["WFSaveFileOverwrite"] is False

    wf_input = save["WFInput"]
    assert wf_input["WFSerializationType"] == "WFTextTokenAttachment"
    assert wf_input["Value"]["Type"] == "ActionOutput"
    assert wf_input["Value"]["OutputName"] == "Received File"


def test_receiving_shortcut_preserves_name_and_notifies_location(build_shortcuts):
    data = build_shortcuts.receiving_shortcut(ask=False)

    save = _actions(data, "documentpicker.save")[0]["WFWorkflowActionParameters"]
    destination = save["WFFileDestinationPath"]
    assert destination["WFSerializationType"] == "WFTextTokenString"
    assert destination["Value"]["string"] == "iPhone Data Sharing/\ufffc"
    name_ref = destination["Value"]["attachmentsByRange"]["{10, 1}"]
    assert name_ref["OutputName"] == "Original Name"

    assert len(_actions(data, "openurl")) == 1
    files_url = _actions(data, "url")[0]["WFWorkflowActionParameters"]["WFURLActionURL"]
    assert files_url.endswith("/Shortcuts/iPhone%20Data%20Sharing/")
    assert not any(
        item.get("WFWorkflowActionIdentifier") == "is.workflow.actions.downloadurl"
        and item.get("WFWorkflowActionParameters", {}).get("WFHTTPMethod") == "POST"
        for item in data["WFWorkflowActions"]
    )
    notifications = _actions(data, "notification")
    assert any(
        n["WFWorkflowActionParameters"].get("WFNotificationActionBody")
        == "受信ファイルは「iCloud > Shortcuts > iPhone Data Sharing」にあります"
        for n in notifications
    )
    assert any(
        n["WFWorkflowActionParameters"].get("WFNotificationActionSound") is True
        for n in notifications
        if n["WFWorkflowActionParameters"].get("WFNotificationActionBody")
        == "受信ファイルは「iCloud > Shortcuts > iPhone Data Sharing」にあります"
    )


def test_configured_send_rejects_placeholders(build_shortcuts, monkeypatch, tmp_path):
    config = {
        "address": "http://PC-IP:3000/phone/shortcut",
        "authorization": "Bearer PAIRING_TOKEN",
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(config)))

    with pytest.raises(ValueError, match="placeholder|loopback"):
        build_shortcuts.configured_from_stdin("send", tmp_path / "send.shortcut")


@pytest.mark.parametrize(
    "address",
    [
        "http://127.0.0.1:3000/phone/shortcut",
        "http://localhost:3000/phone/shortcut",
    ],
)
def test_configured_send_rejects_loopback(build_shortcuts, monkeypatch, tmp_path, address):
    config = {
        "address": address,
        "authorization": "Bearer real-token",
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(config)))

    with pytest.raises(ValueError, match="placeholder|loopback"):
        build_shortcuts.configured_from_stdin("send", tmp_path / "send.shortcut")


def test_configured_send_requires_expected_endpoint(build_shortcuts, monkeypatch, tmp_path):
    config = {
        "address": "http://192.0.2.10:3000/wrong",
        "authorization": "Bearer real-token",
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(config)))

    with pytest.raises(ValueError, match="unexpected endpoint"):
        build_shortcuts.configured_from_stdin("send", tmp_path / "send.shortcut")


def test_configured_receive_requires_expected_endpoint(build_shortcuts, monkeypatch, tmp_path):
    config = {
        "address": "http://192.0.2.10:3000/phone/shortcut",
        "authorization": "Bearer real-token",
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(config)))

    with pytest.raises(ValueError, match="unexpected endpoint"):
        build_shortcuts.configured_from_stdin("receive", tmp_path / "receive.shortcut")


def test_configured_send_builds_with_real_values(build_shortcuts, monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    def fake_sign(data: dict, target: Path) -> None:
        captured["data"] = data
        captured["target"] = target

    monkeypatch.setattr(build_shortcuts, "sign_shortcut", fake_sign)
    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "address": "http://192.0.2.10:3000/phone/shortcut",
                    "authorization": "Bearer real-token",
                }
            )
        ),
    )

    target = tmp_path / "send.shortcut"
    build_shortcuts.configured_from_stdin("send", target)

    assert captured["target"] == target
    data = captured["data"]
    assert isinstance(data, dict)
    assert data["WFWorkflowImportQuestions"] == []

    text_actions = _actions(data, "gettext")
    values = [
        item["WFWorkflowActionParameters"]["WFTextActionText"]
        for item in text_actions
    ]
    assert "http://192.0.2.10:3000/phone/shortcut" in values
    assert "Bearer real-token" in values


def test_configured_receive_builds_with_real_values(build_shortcuts, monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    def fake_sign(data: dict, target: Path) -> None:
        captured["data"] = data
        captured["target"] = target

    monkeypatch.setattr(build_shortcuts, "sign_shortcut", fake_sign)
    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "address": "http://192.0.2.10:3000/phone/shortcut/inbox",
                    "authorization": "Bearer real-token",
                }
            )
        ),
    )

    target = tmp_path / "receive.shortcut"
    build_shortcuts.configured_from_stdin("receive", target)

    assert captured["target"] == target
    data = captured["data"]
    assert isinstance(data, dict)
    assert data["WFWorkflowImportQuestions"] == []


def test_validate_receive_requires_save_action(build_shortcuts):
    data = build_shortcuts.receiving_shortcut(ask=False)
    data["WFWorkflowActions"] = [
        action for action in data["WFWorkflowActions"]
        if action["WFWorkflowActionIdentifier"] != "is.workflow.actions.documentpicker.save"
    ]

    with pytest.raises(ValueError, match="missing its save action"):
        build_shortcuts.validate_shortcut(data, "receive")


def test_validate_rejects_unknown_kind(build_shortcuts):
    with pytest.raises(ValueError, match="Unknown shortcut kind"):
        build_shortcuts.validate_shortcut({"WFWorkflowActions": []}, "other")
