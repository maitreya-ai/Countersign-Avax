import { describe, expect, test } from "bun:test";
import { keccak256, toBytes } from "viem";
import { buildEvidence, truncateUtf8 } from "../src/evidence";
import { decodeHeader, encodeHeader } from "../src/encoding";
import { parseAgentId, NO_AGENT } from "../src/terms";

describe("evidence", () => {
  test("exact layout, no trailing newline, path without query", () => {
    const e = buildEvidence({ method: "post", path: "/honest/summarize?x=1", requestBody: '{"a":1}', status: 200, responseBody: '{"b":2}' });
    expect(e.text).toBe('ASSAY-EVIDENCE v1\nREQUEST POST /honest/summarize\n{"a":1}\n\nRESPONSE 200\n{"b":2}');
    expect(e.hash).toBe(keccak256(toBytes(e.text)));
  });

  test("bytes and strings give the same hash", () => {
    const body = "ünïcødé ✓";
    const a = buildEvidence({ method: "POST", path: "/p", requestBody: body, status: 200, responseBody: body });
    const b = buildEvidence({ method: "POST", path: "/p", requestBody: new TextEncoder().encode(body), status: 200, responseBody: new TextEncoder().encode(body) });
    expect(a.hash).toBe(b.hash);
  });

  test("rejects invalid UTF-8", () => {
    expect(() => buildEvidence({ method: "POST", path: "/p", requestBody: new Uint8Array([0xff, 0xfe]), status: 200, responseBody: "" })).toThrow();
  });

  test("truncation never splits a character", () => {
    const b = new TextEncoder().encode("aé✓");          // 1 + 2 + 3 bytes
    expect(new TextDecoder().decode(truncateUtf8(b, 4))).toBe("aé");
    expect(new TextDecoder().decode(truncateUtf8(b, 5))).toBe("aé");
    expect(truncateUtf8(b, 6)).toEqual(b);
  });
});

describe("x402 headers", () => {
  test("base64 JSON round trip with unicode", () => {
    const v = { rubric: "Exactly 5 bullets ✓", n: 1 };
    expect(decodeHeader(encodeHeader(v))).toEqual(v);
  });
});

describe("agent id", () => {
  test("null and empty mean no agent", () => {
    expect(parseAgentId(null)).toBe(NO_AGENT);
    expect(parseAgentId("")).toBe(NO_AGENT);
    expect(parseAgentId("296")).toBe(296n);
  });
});
