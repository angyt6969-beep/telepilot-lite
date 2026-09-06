let reloadUserStateHandler = null;

export function setReloadUserStateHandler(handler) {
  reloadUserStateHandler = typeof handler === "function" ? handler : null;
}

export function reloadUserState(uid) {
  if (reloadUserStateHandler) return reloadUserStateHandler(String(uid));
  return false;
}
