#!/usr/bin/env node
/**
 * 开发用：往库里塞几篇本机真实论文，方便看阅读器与主题分组。
 *   node scripts/seed.mjs [baseUrl]
 * 重复执行是幂等的（按原路径去重）。
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:57571').replace(/\/+$/, '')
const API = BASE + '/paper-workbench/api/'

const PAPERS = [
  ['G:\\笔记\\LLM知识体系论文\\加速训练\\FlashAttention.pdf', '加速训练'],
  ['G:\\笔记\\LLM知识体系论文\\位置向量\\RoPE.pdf', '位置向量'],
  ['G:\\笔记\\LLM知识体系论文\\高效微调\\Prompt Tuning.pdf', '高效微调'],
  ['G:\\笔记\\LLM知识体系论文\\加速训练\\高效结构\\Longformer.pdf', '高效结构'],
]

async function rpc(method, args = {}) {
  const response = await fetch(API + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const data = await response.json()
  if (!data.ok) throw new Error(method + '：' + data.error)
  return data.value
}

for (const [path, topic] of PAPERS) {
  try {
    const value = await rpc('library.importPath', { path, topic })
    console.log((value.existed ? '已存在  ' : '已入库  ') + value.meta.title + '  [' + value.meta.id + ']')
  } catch (error) {
    console.log('跳过    ' + path + '  原因：' + error.message)
  }
}
