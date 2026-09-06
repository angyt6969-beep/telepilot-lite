import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function withDispatchContext(context, fn) {
  return storage.run({ ...(context || {}) }, fn);
}

export function currentDispatchContext() {
  return storage.getStore() || null;
}

export function childDispatchContext(patch, fn) {
  return storage.run({ ...(storage.getStore() || {}), ...(patch || {}) }, fn);
}
