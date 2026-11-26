export interface DeviceMediaSocketEvents {
  open: Event;
  message: MessageEvent;
  close: CloseEvent;
  error: Parameters<NonNullable<WebSocket["onerror"]>>[0];
}

export interface DeviceMediaSocket {
  readonly readyState: number;
  binaryType: WebSocket["binaryType"];
  onopen: ((event: DeviceMediaSocketEvents["open"]) => void) | null;
  onmessage: ((event: DeviceMediaSocketEvents["message"]) => void) | null;
  onclose: ((event: DeviceMediaSocketEvents["close"]) => void) | null;
  onerror: ((event: DeviceMediaSocketEvents["error"]) => void) | null;
  addEventListener<K extends keyof DeviceMediaSocketEvents>(
    type: K,
    listener: (event: DeviceMediaSocketEvents[K]) => void,
  ): void;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(): void;
}

export interface DeviceMediaTransport {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly openSocket: (url: string) => DeviceMediaSocket;
}

export const openDeviceMediaSocket = (access: DeviceHubAccess, url: string): DeviceMediaSocket =>
  access.transport ? access.transport.openSocket(url) : new WebSocket(url);

export interface DeviceHubAccess {
  readonly transport?: DeviceMediaTransport;
  readonly encrypted?: boolean;
  readonly httpBase: string;
  readonly wsBase: string;
  readonly query: Readonly<Record<string, string>>;
  readonly credentials: boolean;
}

export const withDeviceHubQuery = (url: string, access: DeviceHubAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};
