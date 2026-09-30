import { Router } from "express";
import QRCode from "qrcode";
import { connections, devices } from "../state.js";

export function createDevicesRouter(publicBaseUrl: string): Router {
  const router = Router();

  router.post("/register", (req, res) => {
    const { deviceId, deviceName } = req.body as {
      deviceId?: unknown;
      deviceName?: unknown;
    };

    if (typeof deviceId !== "string" || !deviceId.trim()) {
      res.status(400).json({ error: "deviceId is required" });
      return;
    }
    if (typeof deviceName !== "string" || !deviceName.trim()) {
      res.status(400).json({ error: "deviceName is required" });
      return;
    }

    devices.set(deviceId, {
      deviceId,
      deviceName: deviceName.trim().slice(0, 80),
      registeredAt: new Date(),
    });
    console.log("Device registered", { deviceId, deviceName });
    res.json({ success: true });
  });

  router.get("/:deviceId/qr", async (req, res, next) => {
    try {
      if (!devices.has(req.params.deviceId)) {
        res.status(404).json({ error: "Unknown device" });
        return;
      }
      const setupUrl = `${publicBaseUrl}/setup?deviceId=${encodeURIComponent(req.params.deviceId)}`;
      const image = await QRCode.toBuffer(setupUrl, {
        type: "png",
        width: 320,
        margin: 2,
        errorCorrectionLevel: "M",
      });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.send(image);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:deviceId", (req, res) => {
    const device = devices.get(req.params.deviceId);
    if (!device) {
      res.status(404).json({ error: "Unknown device" });
      return;
    }
    res.json({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      online: connections.has(device.deviceId),
    });
  });

  return router;
}
