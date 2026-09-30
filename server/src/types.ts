export interface Device {
  deviceId: string;
  deviceName: string;
  registeredAt: Date;
}

export interface StoredFile {
  id: string;
  deviceId: string;
  originalName: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: Date;
}
