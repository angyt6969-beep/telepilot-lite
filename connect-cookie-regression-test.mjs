import fs from "node:fs";
const source = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const good = 'readCookies(req)["__Host-telepilot_connect"]';
const bad = 'readCookies(req).__Host-telepilot_connect';
if (!source.includes(good)) throw new Error("Secure connect cookie lookup is missing");
if (source.includes(bad)) throw new Error("Broken hyphenated cookie property lookup returned");
console.log("connect cookie regression check ok");
