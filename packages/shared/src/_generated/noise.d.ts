/* tslint:disable */
/* eslint-disable */

/**
 * One ordered, reliable connection. Authentication of the device belongs above this layer.
 */
export class NoisePeer {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  static client(environment: string, host_public: Uint8Array | number[]): NoisePeer;
  read(ciphertext: Uint8Array | number[]): Uint8Array;
  static server(environment: string, host_private: Uint8Array | number[]): NoisePeer;
  write(plaintext: Uint8Array | number[]): Uint8Array;
}

export function host_public_key(_private: Uint8Array | number[]): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_noisepeer_free: (a: number, b: number) => void;
  readonly host_public_key: (a: number, b: number) => [number, number, number, number];
  readonly noisepeer_client: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => [number, number, number];
  readonly noisepeer_read: (a: number, b: number, c: number) => [number, number, number, number];
  readonly noisepeer_server: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => [number, number, number];
  readonly noisepeer_write: (a: number, b: number, c: number) => [number, number, number, number];
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path:
    | { module_or_path: InitInput | Promise<InitInput> }
    | InitInput
    | Promise<InitInput>,
): Promise<InitOutput>;
