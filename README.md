# LLM API 价格对比

国内外主流大模型 API 价格对比站:纯静态单页,每日自动更新。

## 功能

- 价格主表:搜索 / 排序 / 筛选(按厂商、国内国外)
- 成本计算器:输入每月输入/输出 token 用量,自动算出各模型月成本并排序
- USD / CNY 币种切换(汇率为构建时获取的实时汇率)
- 点击任意行展开详情:API model id、原始标价、官方定价页链接、数据核对日期、阶梯价/缓存价备注

## 数据流

```
LiteLLM 价格库 ─┐
OpenRouter API ─┼─> scripts/build-data.mjs ─> prices.json ─> index.html(纯前端渲染)
data/manual-cn.json(国内厂商,人工维护) ─┘     + 实时 USD/CNY 汇率
```

- 国际厂商(OpenAI / Anthropic / Google / xAI / Mistral):构建时自动拉取,过滤非文本模态、快照别名与老模型
- 国内厂商(DeepSeek / 智谱 / 阿里百炼 / Kimi / 豆包 / 腾讯混元 / MiniMax):`data/manual-cn.json` 手工维护,每条附官方来源链接与核对日期

## 本地构建

```bash
node scripts/build-data.mjs   # 生成 prices.json,需 Node 20+
```

## 自动更新

`.github/workflows/update-prices.yml`:每天 UTC 01:17 跑构建,数据有变化则自动 commit。也可手动触发(workflow_dispatch)。

注意:自动更新只覆盖国际厂商与汇率;国内厂商价格无公开 API,需人工更新 `data/manual-cn.json` 后重新构建。

## 部署(Cloudflare Pages)

1. 把本目录推到 GitHub 仓库
2. Cloudflare Pages → 连接仓库:构建命令留空,输出目录填 `/`(根目录)
3. 完成。之后 Actions 每次提交 prices.json,Pages 自动重新部署

## 免责

价格可能滞后或存在阶梯价、缓存价、限时优惠等情况,实际计费请以各厂商官网为准。
