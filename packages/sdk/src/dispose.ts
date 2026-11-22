// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

// `await using` needs Symbol.asyncDispose, which Node has from 18.18 and
// 20.4. On older runtimes it is defined here as Node defines it, so
// `[Symbol.asyncDispose]()` methods have one key everywhere. A call (not a
// bare import) so bundlers keep it under "sideEffects": false.

export function ensureDisposeSymbols(): void {
  const S = Symbol as unknown as { asyncDispose?: symbol; dispose?: symbol };
  if (typeof S.asyncDispose !== 'symbol') {
    Object.defineProperty(Symbol, 'asyncDispose', { value: Symbol.for('nodejs.asyncDispose'), configurable: true });
  }
  if (typeof S.dispose !== 'symbol') {
    Object.defineProperty(Symbol, 'dispose', { value: Symbol.for('nodejs.dispose'), configurable: true });
  }
}
