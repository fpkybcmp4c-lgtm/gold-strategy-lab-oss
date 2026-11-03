export function dataDirectory(): string;
export function loadEnvironment(): void;
export function openLocalStorage(directory?: string): { db: D1Database; bucket: { put(key: string, bytes: ArrayBuffer, options?: unknown): Promise<void>; get(key: string): Promise<{body: Uint8Array<ArrayBuffer>} | null>; delete(key: string): Promise<void> }; sql: import('node:sqlite').DatabaseSync; directory: string; close(): void };
export function getLocalStorage(): ReturnType<typeof openLocalStorage>;
