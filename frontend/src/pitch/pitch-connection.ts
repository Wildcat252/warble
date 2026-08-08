/**
 * Owns a single /ws/pitch WebSocket connection with auto-reconnect
 * (exponential backoff via reconnectDelayMs). Extracted from the old
 * features/pitch-overlay/index.ts, where this same ~60 lines of
 * connect/close/reconnect logic lived as module-level state — here it's
 * instance state instead, so exercise-player and range-test can each own an
 * independent connection with its own mount/unmount lifecycle instead of
 * sharing one module-singleton socket.
 */
import { parsePitchSocketMessage, reconnectDelayMs, type PitchFrame } from './socket';

export interface PitchConnectionCallbacks {
  onFrame(frame: PitchFrame): void;
  /** Fires once per successful (re)connection, when the server sends {"status":"connected"}. */
  onConnected?(): void;
}

export class PitchConnection {
  private ws: WebSocket | null = null;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;

  constructor(private readonly callbacks: PitchConnectionCallbacks) {}

  connect(): void {
    this.shouldReconnect = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws/pitch`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
    };
    ws.onerror = () => {
      ws.close();
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.shouldReconnect) return;
      this.reconnectAttempts += 1;
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, reconnectDelayMs(this.reconnectAttempts));
    };
    ws.onmessage = (event) => {
      let payload: unknown;
      try {
        payload = JSON.parse(event.data as string) as unknown;
      } catch {
        return;
      }
      const message = parsePitchSocketMessage(payload);
      if (message.kind === 'frame') this.callbacks.onFrame(message.frame);
      else if (message.kind === 'status') this.callbacks.onConnected?.();
    };
  }

  close(): void {
    this.shouldReconnect = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
