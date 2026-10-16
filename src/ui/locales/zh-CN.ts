// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * 简体中文 catalog. `: Messages` makes tsc prove this file key-complete against
 * locales/en.ts - a missing, extra, or renamed key is a compile error.
 *
 * Conventions: command syntax (read/write/ctrl/...) and device mode names stay
 * English - they are syntax, not prose; percent/hex notation stays literal.
 */

import type { Messages } from './en.js';

export const zhCN: Messages = {
  // ------------------------------------------------------------- toolbar
  'toolbar.device': '设备',
  'toolbar.connect': '连接设备',
  'toolbar.reconnect': '重新连接',
  'toolbar.webusbUnavailable': 'WebUSB 不可用',
  'toolbar.connectHint': '点击"连接设备"并选择 SLogic16/32 U3。浏览器会记住此站点的授权。',
  'toolbar.noWebusb': '此浏览器不支持 WebUSB。请通过 http://127.0.0.1 使用 Brave 或 Chrome。',
  'toolbar.start': '开始',
  'toolbar.stop': '停止',
  'toolbar.stopping': '正在停止…',
  'toolbar.open': '打开…',
  'toolbar.save': '保存',
  'toolbar.fit': '适配',
  'toolbar.startTitle': '在已连接的设备上开始采集',
  'toolbar.stopTitle': '停止正在进行的采集',
  'toolbar.stoppingTitle': '正在等待待处理的 USB 传输被取消',
  'toolbar.connectFirstTitle': '请先连接设备',
  'toolbar.openTitle': '加载 sigrok .sr 会话或 .lwcap 文件',
  'toolbar.saveTitle': '将本次采集保存为 .lwcap',
  'toolbar.fitTitle': '缩放以显示整个采集',
  'toolbar.sidebarTitle': '选择右侧边栏',
  'toolbar.sidebarDevice': '设备与采集设置',
  'toolbar.sidebarAnalyzers': '协议分析器',
  'toolbar.sidebarNone': '无侧边栏',

  // ---------------------------------------------------- capture title
  'capture.none': '无采集',
  'capture.capturing': '正在采集 {channels} 通道 @ {rate}',
  'capture.loaded': '{source} · 加载耗时 {ms} ms',
  'capture.stoppedNoTrigger': '未触发 · 保留样本数 {samples}',
  'capture.live': '实时采集 · 样本数 {samples} @ {rate} · {duration}',

  // ------------------------------------------------------------- status
  'status.summary': '样本数 {samples} @ {rate}',
  'status.total': '共 {duration}',
  'status.view': '视图 {duration}',

  // -------------------------------------------------------- empty hint
  'emptyHint.line1': '尚未加载采集数据。',
  'emptyHint.line2': '打开 .sr 或 .lwcap 文件，或连接 SLogic16/32 U3。',

  // ------------------------------------- error prefixes (App.fail sites)
  'error.render': '渲染',
  'error.device': '设备',
  'error.openCapture': '打开采集',
  'error.save': '保存',
  'error.reconnect': '重新连接',
  'error.connect': '连接',
  'error.start': '启动',
  'error.startCapture': '启动采集',
  'error.stopCapture': '停止采集',
  'error.dropoutAccounting': '丢样统计',
  'error.decodeWorkerWarmup': '解码工作线程预热',
  'error.decode': '解码 {id}',
  'error.localeLoad': '无法加载语言包',

  // -------------------------------------------------------- hover readout
  'hover.width': '宽度：{duration}',
  'hover.widthInv': '宽度⁻¹：{freq}',
  'hover.freq': '频率：{freq}',
  'hover.duty': '占空比：{pct} %',
  'hover.noTransition': '视图内无跳变',

  // ---------------------------------------------------- trigger summary
  'trigger.level': '电平 {level}',
  'trigger.rising': '上升沿',
  'trigger.falling': '下降沿',
  'trigger.anyEdge': '任意边沿',
  'trigger.summary': '{condition} · 预触发 {pct}%',
  'trigger.summaryAnd': '{condition} · 预触发 {pct}% · 与 {count} 个条件',

  // -------------------------------------------------------- channel list
  'channels.settings': 'D{index} 设置',
  'channels.name': '通道名称',
  'channels.color': '通道颜色',
  'channels.customColor': '自定义颜色',
  'channels.triggerMode': '触发模式',
  'channels.cancel': '取消',
  'channels.removeAnalyzer': '移除 {label}',
  'channels.triggerHigh': '高电平',
  'channels.triggerLow': '低电平',
  'channels.triggerAny': '任意值（X）',

  // ------------------------------------------------------- capture panel
  'capturePanel.digital': '数字通道',
  'capturePanel.all': '全选',
  'capturePanel.clear': '清空',
  'capturePanel.sampleRate': '采样率',
  'capturePanel.threshold': '阈值',
  'capturePanel.dacNote': 'DAC 码 {code} = 实际 {volts} V。采集宽度 {channels} 通道（上限 {rate}）。',
  'capturePanel.capture': '采集',
  'capturePanel.freeRun': '自由运行',
  'capturePanel.timer': '定时',
  'capturePanel.durationS': '时长 (s)',
  'capturePanel.ceilingNote': '上限 {samples} 个样本 = 在 {rate} 下为 {duration}。自由运行会在到达上限时自行停止。',
  'capturePanel.softwareTrigger': '软件触发',
  'capturePanel.enableTrigger': '启用软件触发',
  'capturePanel.noPreTrigger': '无预触发',
  'capturePanel.preTriggerBuffer': '预触发缓冲',
  'capturePanel.noCondition': '未设置条件——采集将不触发运行。点击通道行（左列）上的设置按钮，选择边沿或电平。',
  'capturePanel.condHigh': '高',
  'capturePanel.condLow': '低',
  'capturePanel.condRising': '上升沿',
  'capturePanel.condFalling': '下降沿',
  'capturePanel.condEdge': '边沿',
  'capturePanel.condJoiner': ' 与 ',
  'capturePanel.armed': '已布防：{what}。T=0 位于触发点；触发点之前最多保留 {duration} 作为负时间。',
  'capturePanel.armedCapped': '已布防：{what}。T=0 位于触发点；触发点之前最多保留 {duration} 作为负时间（受 {megabytes} MiB 预触发缓冲限制）。',
  'capturePanel.waitingTrigger': '正在等待触发条件…',
  'capturePanel.triggered': '已触发——正在记录触发后窗口。',
  'capturePanel.triggerNotFound': '未触发而停止；未记录任何数据。',
  'capturePanel.recording': '正在记录 {seconds} s · 样本数 {samples} · {megabytes} MB',
  'capturePanel.dropped': '{samples} 个样本因传输丢失，已标记为间隙',
  'capturePanel.advanced': '高级',
  'capturePanel.testMode': '设备测试模式（下次采集生效）',
  'capturePanel.testNormal': '正常',
  'capturePanel.testSimulator': '模拟器',
  'capturePanel.testUsbMax': 'USB MAX SPEED',
  'capturePanel.usbConsole': 'USB 控制控制台',
  'capturePanel.usbPlaceholder': 'read 0x000c 4',
  'capturePanel.usbSend': '发送',
  'capturePanel.usbHelp': '命令：read <addr> [len]、write <addr> <byte>...、ctrl <value>、flags、clear-fifo、in <request> <value> <index> <len>、out <request> <value> <index> [byte]...',
  'capturePanel.consoleSeed': '输入 help 查看命令。数字为十进制或 0x 前缀的十六进制。',
  'capturePanel.consoleError': '错误：{detail}',

  // ------------------------------------------------------ analyzer panel
  'analyzerPanel.title': '分析器',
  'analyzerPanel.subWarm': 'sigrok 内置解码器：{count} 个。工作线程已就绪。',
  'analyzerPanel.subCold': 'sigrok 内置解码器：{count} 个。工作线程正在预热（约 850 ms，每次会话一次）。',
  'analyzerPanel.decoding': '解码中…',
  'analyzerPanel.attached': '已挂载',
  'analyzerPanel.decode': '解码',
  'analyzerPanel.remove': '移除',
  'analyzerPanel.cancelDecode': '取消解码',
  'analyzerPanel.add': '添加',
  'analyzerPanel.decoder': '解码器',
  'analyzerPanel.stacked': '{id} 需要 {inputs}，因此必须堆叠在产出解码器之上。本面板不提供堆叠功能。',
  'analyzerPanel.optionalSuffix': '（可选）',
  'analyzerPanel.attach': '挂载',
  'analyzerPanel.loadFirst': '请先加载或录制采集；解码器需要边沿数据。',

  // ----------------------------- analyzer status notes (formatted at render)
  'analyzerNote.pending': '未解码',
  'analyzerNote.edges': '边沿数 {count}',
  'analyzerNote.stats': '注解数 {anns}，{decodeMs} ms（实际耗时 {wallMs} ms）',
  'analyzerNote.timeout': '超时',
  'analyzerNote.cancelled': '已取消',

  // -------------------------------------------------------- settings menu
  'settings.title': '设置',
  'settings.titleHint': '语言与显示偏好',
  'settings.language': '语言',
  'settings.theme': '主题',

  // ------------------------------------------------------------ theme
  'theme.default': '默认',
  'theme.dark': '深色',
};
