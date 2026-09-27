import { startTestProxy } from "../tests/helpers/proxy.js";
import { mockServer, setJevResponse } from "../tests/mocks/server.js";

mockServer.listen({ onUnhandledRequest: "warn" });
const proxy = await startTestProxy();

setJevResponse("malicious");

const MALICIOUS_RAW_TX = "0x02f8b1827a6901843b9aca00843b9aca0082c35094a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4880b844095ea7b3000000000000000000000000deadbeef00000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc001a07335fd02f31b254775073776e23cb9d5e417c1a3641f712c72bd31c863b99407a02e0164470a12c5e48d440deb29214cbb220d1fcf44ac63e06f5488555148f036";

const res = await fetch(proxy.url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction",
    params: [MALICIOUS_RAW_TX]
  })
});
const json = await res.json();
console.log(JSON.stringify(json, null, 2));

await proxy.close();
mockServer.close();
process.exit(0);
