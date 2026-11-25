export interface DeviceMediaSocket {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
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
