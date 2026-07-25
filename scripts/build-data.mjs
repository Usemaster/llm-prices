#!/usr/bin/env node
/**
 * build-data.mjs — 构建 prices.json
 *
 * 数据来源:
 *   1. LiteLLM model_prices_and_context_window.json (国际厂商主源)
 *   2. OpenRouter /api/v1/models (国际厂商补充源, 仅补 LiteLLM 缺失的模型)
 *   3. data/manual-cn.json (国内厂商, 手工维护)
 *
 * 用法: node scripts/build-data.mjs
 * 输出: prices.json (仓库根目录, 由页面直接 fetch)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const FX_URL = "https://open.er-api.com/v6/latest/USD";
const FX_FALLBACK = 7.2;

// 国际厂商白名单: litellm_provider -> { 显示名, 官方定价页 }
const INTL_VENDORS = {
  openai: { name: "OpenAI", url: "https://openai.com/api/pricing/" },
  anthropic: { name: "Anthropic", url: "https://www.anthropic.com/pricing" },
  gemini: { name: "Google", url: "https://ai.google.dev/gemini-api/docs/pricing" },
  xai: { name: "xAI", url: "https://docs.x.ai/docs/models" },
  mistral: { name: "Mistral", url: "https://mistral.ai/pricing" },
};

// OpenRouter vendor 前缀 -> litellm_provider 名
const OR_PREFIX = {
  openai: "openai",
  anthropic: "anthropic",
  google: "gemini",
  "x-ai": "xai",
  mistralai: "mistral",
};

// 非文本对话模态: 图像生成 / 语音 / 实时 / 转写 / 搜索增强 / embedding 等一律剔除
const NON_CHAT = /(image|audio|tts|realtime|transcribe|search|computer-use|instruct|embedding|moderation|rerank|guard)/i;
// 快照与别名: 日期快照(2025-02-19 / 20250219 / 05-06 / 09-2025)、-latest、-beta、fine-tune
const SNAPSHOT = /(-\d{4}-\d{2}-\d{2}$|-\d{8}$|-\d{2}-\d{2}$|-\d{2}-\d{4}$|-latest$|-beta$|ft:|fine-tune)/i;

// 已停售/被全面替代的老模型: 只保留各厂商在售主力
const LEGACY = /^(gpt-3\.5-turbo-16k|gpt-4(-|$)|claude-3-|gemini-1|grok-2($|-)|(open-)?mistral-(7b|nemo|tiny|saba)|open-mixtral|pixtral|voxtral|open-codestral-mamba|labs-devstral)/i;

function isNoise(modelId) {
  return NON_CHAT.test(modelId) || SNAPSHOT.test(modelId) || LEGACY.test(modelId);
}

async function fetchJson(url, label) {
  const res = await fetch(url, { headers: { "user-agent": "llm-prices-builder" } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

async function getFxRate() {
  try {
    const data = await fetchJson(FX_URL, "fx");
    const rate = data?.rates?.CNY;
    if (typeof rate === "number" && rate > 0) return rate;
    throw new Error("bad payload");
  } catch (err) {
    console.warn(`[fx] 获取实时汇率失败 (${err.message}), 使用内置值 ${FX_FALLBACK}`);
    return FX_FALLBACK;
  }
}

function fromLiteLLM(raw) {
  const out = [];
  for (const [key, m] of Object.entries(raw)) {
    if (key === "sample_spec") continue;
    const vendor = INTL_VENDORS[m.litellm_provider];
    if (!vendor) continue;
    if (m.mode !== "chat") continue;
    const inCost = m.input_cost_per_token;
    const outCost = m.output_cost_per_token;
    if (!(inCost > 0) || !(outCost > 0)) continue;
    const modelId = key.replace(/^[a-z0-9-]+\//i, ""); // 去掉 "openai/" 这类前缀
    if (isNoise(modelId)) continue;
    out.push({
      vendor: vendor.name,
      region: "intl",
      model: modelId,
      modelId,
      input: +(inCost * 1e6).toPrecision(6),
      output: +(outCost * 1e6).toPrecision(6),
      currency: "USD",
      context: m.max_input_tokens ?? m.max_tokens ?? null,
      source: "litellm",
      sourceUrl: vendor.url,
      notes: "",
    });
  }
  return out;
}

function fromOpenRouter(raw, covered) {
  const out = [];
  for (const m of raw?.data ?? []) {
    const [prefix, ...rest] = String(m.id || "").split("/");
    const provider = OR_PREFIX[prefix];
    if (!provider) continue;
    const vendor = INTL_VENDORS[provider];
    const modelId = rest.join("/");
    if (!modelId || isNoise(modelId)) continue;
    if (modelId.endsWith(":free") || modelId.includes(":extended")) continue;
    const inCost = parseFloat(m.pricing?.prompt);
    const outCost = parseFloat(m.pricing?.completion);
    if (!(inCost > 0) || !(outCost > 0)) continue;
    const dedupeKey = `${vendor.name}:${modelId.toLowerCase()}`;
    if (covered.has(dedupeKey)) continue;
    covered.add(dedupeKey);
    out.push({
      vendor: vendor.name,
      region: "intl",
      model: modelId,
      modelId,
      input: +(inCost * 1e6).toPrecision(6),
      output: +(outCost * 1e6).toPrecision(6),
      currency: "USD",
      context: m.context_length ?? null,
      source: "openrouter",
      sourceUrl: vendor.url,
      notes: "价格来自 OpenRouter, 可能与官方直连价略有差异",
    });
  }
  return out;
}

function fromManualCN() {
  const raw = JSON.parse(readFileSync(join(ROOT, "data", "manual-cn.json"), "utf8"));
  return (raw.models ?? []).map((m) => ({
    vendor: m.vendor,
    region: "cn",
    model: m.model,
    modelId: m.modelId,
    input: m.input ?? m.inputCNY,
    output: m.output ?? m.outputCNY,
    currency: m.currency ?? "CNY",
    context: m.contextWindow ?? null,
    source: "manual",
    sourceUrl: m.sourceUrl ?? "",
    notes: m.notes ?? "",
    observedAt: m.observedAt ?? null,
  }));
}

// 同族不同版本快照去重: 如 magistral-medium-2506/-2509 只留最新,
// 有裸名(gpt-4)与日期版(gpt-4-0613)并存时只留裸名(通常指向最新版)
function dedupeVersions(models) {
  const SUFFIX = /-\d{3,4}$/;
  const groups = new Map();
  for (const m of models) {
    const key = m.vendor + "|" + m.modelId.replace(SUFFIX, "").toLowerCase();
    (groups.get(key) ?? groups.set(key, []).get(key)).push(m);
  }
  const out = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) { out.push(arr[0]); continue; }
    const bare = arr.find((m) => !SUFFIX.test(m.modelId));
    out.push(bare ?? arr.sort((a, b) => b.modelId.localeCompare(a.modelId))[0]);
  }
  return out;
}

function main() {
  return (async () => {
    const fx = await getFxRate();
    console.log(`[fx] USD/CNY = ${fx}`);

    const litellm = fromLiteLLM(await fetchJson(LITELLM_URL, "litellm"));
    console.log(`[litellm] ${litellm.length} 个国际模型`);

    const covered = new Set(litellm.map((m) => `${m.vendor}:${m.modelId.toLowerCase()}`));
    let openrouter = [];
    try {
      openrouter = fromOpenRouter(await fetchJson(OPENROUTER_URL, "openrouter"), covered);
      console.log(`[openrouter] 补充 ${openrouter.length} 个模型`);
    } catch (err) {
      console.warn(`[openrouter] 获取失败, 跳过 (${err.message})`);
    }

    const cn = fromManualCN();
    console.log(`[manual-cn] ${cn.length} 个国内模型`);

    const intl = dedupeVersions([...litellm, ...openrouter]);
    console.log(`[dedupe] 国际模型 ${litellm.length + openrouter.length} -> ${intl.length}`);

    const models = [...cn, ...intl].map((m) => ({
      ...m,
      // 统一折算字段: 前端排序/计算器只认 USD, 展示按用户选择的币种换算
      inputUSD: +(m.currency === "USD" ? m.input : m.input / fx).toPrecision(6),
      outputUSD: +(m.currency === "USD" ? m.output : m.output / fx).toPrecision(6),
    }));

    models.sort((a, b) => a.vendor.localeCompare(b.vendor, "zh-Hans-CN") || a.model.localeCompare(b.model));

    const out = {
      updatedAt: new Date().toISOString(),
      fx: { USD_CNY: fx, source: fx === FX_FALLBACK ? "fallback" : "open.er-api.com" },
      count: models.length,
      models,
    };
    writeFileSync(join(ROOT, "prices.json"), JSON.stringify(out, null, 2) + "\n");
    console.log(`[done] ${models.length} 个模型 -> prices.json`);
  })();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
