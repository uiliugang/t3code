import * as Sse from "effect/encoding/Sse";

export function observeMediaEvents(
  path: string,
  fetcher: ((path: string, init: RequestInit) => Promise<Response>) | undefined,
  onMessage: (data: string) => void,
  onRejected?: () => void,
  withCredentials = false,
) {
  if (!fetcher) {
    const source = new EventSource(path, { withCredentials });
    source.addEventListener("message", (message) => onMessage(message.data));
    if (onRejected) {
      source.addEventListener("error", () => {
        if (source.readyState === EventSource.CLOSED) onRejected();
      });
    }
    return () => source.close();
  }

  const stop = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = async () => {
    const attempt = new AbortController();
    try {
      const response = await fetcher(path, {
        headers: { accept: "text/event-stream" },
        signal: AbortSignal.any([attempt.signal, stop.signal]),
      });
      if (response.status >= 500 || response.status === 429)
        throw new Error("Media stream unavailable");
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.startsWith("text/event-stream")
      ) {
        if (!stop.signal.aborted) onRejected?.();
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = Sse.makeParser((event) => {
        if (!stop.signal.aborted && event._tag === "Event" && event.event === "message")
          onMessage(event.data);
      });
      while (!stop.signal.aborted) {
        const part = await reader.read();
        if (part.done) break;
        const error = parser.feed(part.value);
        if (error) throw error;
      }
    } catch {
    } finally {
      attempt.abort();
    }
    if (!stop.signal.aborted) retry = setTimeout(() => void connect(), 3000);
  };
  void connect();
  return () => {
    stop.abort();
    clearTimeout(retry);
  };
}
