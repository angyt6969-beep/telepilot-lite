import { TelegramClient } from "teleproto";

const proto = TelegramClient?.prototype;

function nameOf(value) {
  return String(value?.className || value?.constructor?.name || "Unknown");
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function safeError(err) {
  return String(err?.errorMessage || err?.description || err?.message || err || "Unknown error")
    .replace(/https?:\/\/\S+/g, "[url]")
    .slice(0, 180);
}

function requestSummary(request) {
  return [
    `peers=${count(request?.peers)}`,
    `folderPeers=${count(request?.folderPeers)}`,
    request?.chatlist?.filterId !== undefined ? `filterId=${String(request.chatlist.filterId)}` : null,
  ].filter(Boolean).join(" ");
}

function responseSummary(result) {
  return [
    `result=${nameOf(result)}`,
    `chats=${count(result?.chats)}`,
    `peers=${count(result?.peers)}`,
    `alreadyPeers=${count(result?.alreadyPeers)}`,
    `missingPeers=${count(result?.missingPeers)}`,
    `updates=${count(result?.updates)}`,
  ].join(" ");
}

if (proto && !proto.__telepilotAddlistTraceInstalled) {
  const originalInvoke = proto.invoke;
  if (typeof originalInvoke !== "function") throw new Error("Unsupported TelegramClient shape for Addlist tracing");

  Object.defineProperty(proto, "__telepilotAddlistTraceInstalled", { value: true });

  proto.invoke = async function(request, ...rest) {
    const requestName = nameOf(request);
    if (!requestName.toLowerCase().includes("chatlist")) {
      return originalInvoke.call(this, request, ...rest);
    }

    const started = Date.now();
    console.log(`[Addlist trace] -> ${requestName} ${requestSummary(request)}`.trim());
    try {
      const result = await originalInvoke.call(this, request, ...rest);
      console.log(`[Addlist trace] <- ${requestName} ${responseSummary(result)} ms=${Date.now() - started}`);
      return result;
    } catch (err) {
      console.warn(`[Addlist trace] !! ${requestName} error=${safeError(err)} ms=${Date.now() - started}`);
      throw err;
    }
  };

  console.log("TelePilot Addlist diagnostic tracing enabled");
}
