let reloadUserStateHandler = null;
let syncUserGroupsHandler = null;

export function setReloadUserStateHandler(handler) {
  reloadUserStateHandler = typeof handler === "function" ? handler : null;
}

export function reloadUserState(uid) {
  if (reloadUserStateHandler) return reloadUserStateHandler(String(uid));
  return false;
}

export function setSyncUserGroupsHandler(handler) {
  syncUserGroupsHandler = typeof handler === "function" ? handler : null;
}

export function syncUserGroups(uid) {
  if (syncUserGroupsHandler) return syncUserGroupsHandler(String(uid));
  return false;
}
