export const wechatStatusMessages = {
  unpaired: "Not connected",
  waiting: "Waiting for scan",
  scanned: "Confirm on your phone",
  verify: "Verification code required",
  expired: "Pairing expired",
  connected: "Connected",
  offline: "Offline",
  reconnect_required: "Reconnect required",
} as const;
export const wechatErrorMessages = {
  network: "WeChat could not be reached. Check the connection and try again.",
  protocol: "WeChat rejected the request. Refresh pairing or try again.",
  credentials: "WeChat authorization expired. Unlink and pair again.",
  storage: "Could not save WeChat state. Check this environment's storage.",
  target: "This thread is unavailable. Select another thread.",
  unpaired: "Pair WeChat and send an activation message first.",
  busy: "Another WeChat operation is running. Try again shortly.",
} as const;
export const wechatDeliveryMessages = {
  pending: "Pending",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  unknown: "Delivery unconfirmed",
} as const;
