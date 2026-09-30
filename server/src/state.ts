import type WebSocket from "ws";
import type { Device, StoredFile } from "./types.js";

export const devices = new Map<string, Device>();
export const files = new Map<string, StoredFile>();
export const connections = new Map<string, WebSocket>();
