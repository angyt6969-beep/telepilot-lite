const fs = require("node:fs");
const path = require("node:path");

const pkgPath = require.resolve("teleproto/package.json");
const storeSessionPath = path.join(path.dirname(pkgPath), "sessions", "StoreSession.js");

let source = fs.readFileSync(storeSessionPath, "utf8");

if (source.includes("TELEPILOT_SAFE_STORE_NAMESPACE")) {
  console.log("TelePilot StoreSession patch already applied");
  process.exit(0);
}

const areaPattern = /this\.store\s*=\s*([A-Za-z0-9_.$]+)\.area\(\s*sessionName\s*,\s*new\s+([A-Za-z0-9_.$]+)\(\s*["']\.\/["']\s*\+\s*sessionName\s*\)\s*\);/;
const areaMatch = source.match(areaPattern);
if (!areaMatch) {
  throw new Error("TelePilot patch could not locate Teleproto StoreSession storage initialization. Refusing to deploy an unverified patch.");
}

source = source.replace(
  areaPattern,
  `const storageNamespace = sessionName.split(/[\\\\/]/).filter(Boolean).pop() || sessionName; // TELEPILOT_SAFE_STORE_NAMESPACE\n        this.store = ${areaMatch[1]}.area(storageNamespace, new ${areaMatch[2]}("./" + sessionName));`
);

const namespacePattern = /this\.sessionName\s*=\s*sessionName\s*\+\s*divider\s*;/;
if (!namespacePattern.test(source)) {
  throw new Error("TelePilot patch could not locate Teleproto StoreSession namespace assignment. Refusing to deploy an unverified patch.");
}

source = source.replace(namespacePattern, "this.sessionName = storageNamespace + divider;");

fs.writeFileSync(storeSessionPath, source, "utf8");
console.log("TelePilot patched Teleproto StoreSession path namespace safely");
