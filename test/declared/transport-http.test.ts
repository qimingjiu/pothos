/**
 * ArkHttpTransport（方舟 v3 OpenAI 兼容面，挂账件）测试：
 * 鉴权托管解析、choices 提取、错误面（404/401 可读且不带 key）、可注入 fetch。
 */
import { describe, expect, it } from "vitest";
import {
  ArkHttpTransport,
  parsePlatformKeyFromArkcliConfig,
} from "../../src/declared/classifier.js";

function okFetch(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as unknown as typeof fetch;
}

describe("parsePlatformKeyFromArkcliConfig（鉴权托管解析）", () => {
  it("取 type: platform 块的 api_key，不误取 agent-plan 块", () => {
    const yaml = [
      "lang: zh_cn",
      "profiles:",
      "  agent-plan_cn-beijing_personal:",
      "    tenant: volc",
      "    api_key: ark-agentplan-xxxxxxxx",
      "    type: agent-plan",
      "  platform_cn-beijing_accountwide:",
      "    tenant: volc",
      "    api_key: ark-platform-yyyyyyyy",
      "    type: platform",
      "    region: cn-beijing",
    ].join("\n");
    expect(parsePlatformKeyFromArkcliConfig(yaml)).toBe("ark-platform-yyyyyyyy");
  });

  it("无 platform 块 → null（调用方抛可读错误）", () => {
    const yaml = ["profiles:", "  agent-plan_x:", "    api_key: ark-a", "    type: agent-plan"].join("\n");
    expect(parsePlatformKeyFromArkcliConfig(yaml)).toBeNull();
  });
});

describe("ArkHttpTransport", () => {
  const fetchCtx = { calls: [] as Array<{ url: string; init: RequestInit }> };
  function transportWith(content: string, status = 200, body?: string): ArkHttpTransport {
    fetchCtx.calls.length = 0;
    const fn = (async (url: string, init: RequestInit = {}) => {
      fetchCtx.calls.push({ url, init });
      return new Response(body ?? JSON.stringify({ choices: [{ message: { content } }] }), {
        status,
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    }) as unknown as typeof fetch;
    return new ArkHttpTransport({
      model: "glm-5-2-260617",
      baseUrl: "https://v3.test/api/v3",
      apiKey: "ark-test-key",
      fetchFn: fn,
    });
  }

  it("choices[0].message.content 提取；请求体形状 = OpenAI 兼容（model/messages/temperature）", async () => {
    const t = transportWith('{"score":0}');
    const out = await t.complete('只输出 JSON 对象：{"score":0}', { temperature: 0 });
    expect(out).toBe('{"score":0}');
    expect(t.fingerprint).toEqual({ name: "glm-5-2-260617", promptV: "declare-prompt-v1" });
    const call = fetchCtx.calls[0]!;
    expect(call.url).toBe("https://v3.test/api/v3/chat/completions");
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("glm-5-2-260617");
    expect(Array.isArray(body["messages"])).toBe(true);
    expect(body["temperature"]).toBe(0);
    const auth = (call.init.headers as Record<string, string>)["Authorization"];
    expect(auth).toBe("Bearer ark-test-key");
  });

  it("404（模型未开通）错误面带 code 与 message，不带 key", async () => {
    const t = transportWith("", 404, JSON.stringify({ error: { code: "InvalidEndpointOrModel.NotFound", message: "The model or endpoint k2.6 does not exist" } }));
    await expect(t.complete("hi")).rejects.toThrow(/InvalidEndpointOrModel\.NotFound/);
    await expect(t.complete("hi")).rejects.not.toThrow(/ark-test-key/); // 密钥不进错误信息
  });

  it("非 JSON 响应体缺 choices → 明确报错（不静默吞）", async () => {
    const t = transportWith("", 200, JSON.stringify({ weird: true }));
    await expect(t.complete("hi")).rejects.toThrow(/缺 choices/);
  });
});
