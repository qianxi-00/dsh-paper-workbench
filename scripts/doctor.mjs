#!/usr/bin/env node
/**
 * 环境自检 CLI：`npm run doctor`
 *
 * 不开 DSH 也能跑，用来回答「为什么页图是空的 / 为什么翻译报错 / 数据存哪」。
 * 退出码：0 = 没有 error 项；1 = 有必须处理的项。
 */
import { runDoctor, formatDoctor } from '../lib/doctor.js'

const report = await runDoctor()
console.log(formatDoctor(report))
if (!report.ok) process.exitCode = 1
