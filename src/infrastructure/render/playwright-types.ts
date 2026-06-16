export interface PlaywrightModule {
  chromium: {
    launch(options: Record<string, unknown>): Promise<PlaywrightBrowser>;
  };
}

export interface PlaywrightBrowser {
  newContext(options: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

export interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

export interface PlaywrightPage {
  route(pattern: string, handler: RouteHandler): Promise<void>;
  routeWebSocket?(pattern: string, handler: WebSocketHandler): Promise<void>;
  on(event: "download" | "websocket", handler: (value: PlaywrightEventValue) => void): void;
  setDefaultTimeout?(timeoutMs: number): void;
  setDefaultNavigationTimeout?(timeoutMs: number): void;
  goto(url: string, options: Record<string, unknown>): Promise<PlaywrightResponse | null>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
}

export type RouteHandler = (route: PlaywrightRoute) => Promise<void> | void;
export type WebSocketHandler = (socket: PlaywrightWebSocketRoute) => Promise<void> | void;
export type PlaywrightEventValue = PlaywrightDownload | PlaywrightWebSocket;

export interface PlaywrightRoute {
  request(): PlaywrightRequest;
  fulfill(options: {
    status: number;
    body: Uint8Array;
    contentType?: string;
    headers?: Record<string, string>;
  }): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export interface PlaywrightRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  isNavigationRequest?(): boolean;
}

export interface PlaywrightResponse {
  status(): number;
}

export interface PlaywrightDownload {
  url(): string;
  cancel?(): Promise<void>;
}

export interface PlaywrightWebSocket {
  url(): string;
  close?(): Promise<void>;
}

export interface PlaywrightWebSocketRoute {
  url(): string;
  close(): Promise<void>;
}
