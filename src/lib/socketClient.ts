import { ServerBroadcastMessage } from '../types';
import { getSessionToken, getKioskDevice } from './api';

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

      this.socket = new WebSocket(wsUrl);

      this.socket.onopen = () => {
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
            this.socket?.send(JSON.stringify({ type: 'KIOSK_DEVICE', credential: deviceCredential }));
          } catch {}
        }
        if (this.currentUserEmail) {
          this.sendPresence(this.currentUserEmail, this.currentUserName);
        }
      };

      this.socket.onmessage = (event) => {
        try {
          const data: ServerBroadcastMessage = JSON.parse(event.data);
          this.messageListeners.forEach((listener) => listener(data));
        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
        }
      };

      this.socket.onclose = (event) => {
        this.isConnected = false;
        this.notifyStatus(false);
        // 4401 = auth rejected: do NOT retry (no valid session). Anything else retries.
        if (event && (event as CloseEvent).code === 4401) return;
        this.scheduleReconnect();
      };

      this.socket.onerror = (err) => {
        console.warn('WebSocket connection error (will retry):', err);
        this.socket?.close();
      };
    } catch (err) {
      console.warn('Failed to initiate WebSocket connection:', err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.currentUserEmail, this.currentUserName);
    }, 3000);
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.socket.close();
      this.socket = null;
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
