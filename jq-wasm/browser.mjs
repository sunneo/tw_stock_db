import {
  JqError,
  makeConvenience,
  makeLoadJq,
  streamingHook
} from "./chunk-OUKQZV2W.mjs";

// src/browser.ts
function fromURL(url) {
  return (reject) => ({ instantiateWasm: streamingHook(url, reject) });
}
var defaultBuilder = fromURL(new URL("./build/jq.wasm", import.meta.url));
var platform = { defaultBuilder, fromURL };
var loadJq = makeLoadJq(platform);
var { raw, json, first, version } = makeConvenience(loadJq);
export {
  JqError,
  first,
  json,
  loadJq,
  raw,
  version
};
