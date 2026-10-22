import { ServerBroadcastMessage } from '../types';
import { getSessionToken, getKioskDevice, waitForSignInChangesToSettle, confirmSessionAfterSocketRefusal } from './api';

/**
 * Item 11 client part 1: wait before reconnect attempt N (0-based). The first
 * wait is about 3 s, as before; then it doubles up to 30 s, with +/-20 % jitter
 * so many phones do not reconnect at the same instant after an outage (1013).
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30000, 3000 * 2 ** Math.min(Math.max(attempt, 0), 4));
  return Math.round(base * (0.8 + 0.4 * random()));
}

type MessageListener = (message: ServerBroadcastMessage) => void;
type StatusListener = (connected: boolean) => void;

class RealtimeSocket {
  private socket: WebSocket | null = null;
  private messageListeners: Set<MessageListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private reconnectTimer: any = null;
  private isConnected: boolean = false;
  private currentUserEmail: string = '';
  private currentUserName: string = '';
  /** Failed attempts since the last message heard (drives the backoff). */
  private attempt = 0;
  /** Bumped by every new socket and every disconnect: late callbacks of an older one are ignored. */
  private generation = 0;

  constructor() {
    // will connect when initialized in browser
  }

  public connect(userEmail?: string, userName?: string) {
    if (typeof window === 'undefined') return;
    if (userEmail) this.currentUserEmail = userEmail;
    if (userName) this.currentUserName = userName;

    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      if (userEmail) {
        this.sendPresence(userEmail, userName || '');
      }
      return;
    }

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // Session token authenticates the socket; the server scopes all
      // real-time data to the token owner's agency.
      const token = getSessionToken();
      const wsUrl = `${protocol}//${window.location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;

      const sock = new WebSocket(wsUrl);
      const generation = ++this.generation;
      this.socket = sock;

      sock.onopen = () => {
        if (this.socket !== sock) return;
        this.isConnected = true;
        this.notifyStatus(true);
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        // 2b device proof (addendum, finding 1): on a paired kiosk tablet,
        // the FIRST frame must prove the device — a browser cannot set
        // headers on a WebSocket, and the secret never goes in the URL.
        // The server sends nothing until this verifies. On a phone socket
        // (no device credential stored) nothing is sent, and the server
        // ignores an unexpected frame there anyway.
        const deviceCredential = getKioskDevice();
        if (deviceCredential) {
          try {
            sock.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential: deviceCredential }));
          } catch {}
        }
        if (this.currentUserEmail) {
          this.sendPresence(this.currentUserEmail, this.currentUserName);
        }
      };

      sock.onmessage = (event) => {
        if (this.socket !== sock) return;
        // The server accepted this session and is talking: the next failure starts the backoff again.
        this.attempt = 0;
        try {
          const data: ServerBroadcastMessage = JSON.parse(event.data);
          this.messageListeners.forEach((listener) => listener(data));
        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
        }
      };

      sock.onclose = (event) => {
        // A socket this client already replaced or dropped: nothing to do.
        if (this.socket !== sock) return;
        this.socket = null;
        this.isConnected = false;
        this.notifyStatus(false);
        // Item 11: 4401 = the server refused or ended this session. Confirm it
        // over HTTP before signing out (only a 401 signs out). 1013 = the server
        // could not check the sign-in right now: reconnect with backoff, like
        // any other close. Never a sign-out.
        if (event && (event as CloseEvent).code === 4401) {
          void this.afterSessionRefused(token, generation);
          return;
        }
        this.scheduleReconnect();
      };

      sock.onerror = (err) => {
        console.warn('WebSocket connection error (will retry):', err);
        sock.close();
      };
    } catch (err) {
      console.warn('Failed to initiate WebSocket connection:', err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.currentUserEmail, this.currentUserName);
    }, delay);
  }

  /**
   * Item 11: a 4401 close. No token: no session to keep (as before, no retry).
   * Otherwise wait until no sign-in-changing request is in flight, then: a newer
   * token -> reconnect with it at once; the same token -> ask the server over
   * HTTP (a 401 signs out there, the app's one sign-out path); a working or
   * unanswered check -> reconnect with backoff.
   */
  private async afterSessionRefused(token: string | null, generation: number) {
    if (!token) return;
    await waitForSignInChangesToSettle();
    if (generation !== this.generation || this.socket) return;
    const current = getSessionToken();
    if (!current) return;
    if (current !== token) {
      this.connect(this.currentUserEmail, this.currentUserName);
      return;
    }
    const verdict = await confirmSessionAfterSocketRefusal(token);
    if (generation !== this.generation || this.socket) return;
    if (verdict === 'ended') return;
    this.scheduleReconnect();
  }

  private notifyStatus(status: boolean) {
    this.statusListeners.forEach((cb) => cb(status));
  }

  public onMessage(listener: MessageListener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  public onStatusChange(listener: StatusListener) {
    this.statusListeners.add(listener);
    listener(this.isConnected);
    return () => this.statusListeners.delete(listener);
  }

  public send(type: ServerBroadcastMessage['type'], payload: any) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          type,
          payload,
          timestamp: new Date().toISOString(),
          senderEmail: this.currentUserEmail,
        })
      );
    }
  }

  public sendPresence(email: string, name: string) {
    this.currentUserEmail = email;
    this.currentUserName = name;
    this.send('USER_PRESENCE', { email, name });
  }

  public disconnect() {
    this.generation += 1;
    this.attempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      const old = this.socket;
      this.socket = null;
      old.close();
    }
    this.isConnected = false;
    this.notifyStatus(false);
  }

  /** Reconnect with the current session token (call after login). */
  public reconnect() {
    this.disconnect();
    this.connect(this.currentUserEmail, this.currentUserName);
  }

  public getStatus() {
    return this.isConnected;
  }
}

export const realtimeSocket = new RealtimeSocket();
