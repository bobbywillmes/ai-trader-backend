import { ENDPOINT } from './model.js';

export type TransportHandlers = { message(data: unknown): void; close(code: number): void; error(): void };
export interface AlpacaIexTransport { send(message: string): void; close(): void; dispose(): void; isClosed(): boolean }
export type TransportFactory = (handlers: TransportHandlers) => AlpacaIexTransport;
export function requireNativeWebSocket(): void {
  if (Number(process.versions.node.split('.')[0]) < 24 || typeof WebSocket !== 'function') throw new Error('Research capture requires Node 24+ native WebSocket');
}
export const createNativeAlpacaIexTransport: TransportFactory = handlers => {
  requireNativeWebSocket();
  const socket = new WebSocket(ENDPOINT);
  const message = (event: { data: unknown }) => handlers.message(event.data);
  const close = (event: { code: number }) => handlers.close(event.code);
  const error = () => handlers.error();
  socket.addEventListener('message', message);
  socket.addEventListener('close', close);
  socket.addEventListener('error', error);
  return { send: message => socket.send(message), close: () => socket.close(), isClosed: () => socket.readyState === WebSocket.CLOSED, dispose: () => {
    socket.removeEventListener('message', message); socket.removeEventListener('close', close);
    // Keep the sanitized error listener until close: never expose native exception data.
  } };
};
