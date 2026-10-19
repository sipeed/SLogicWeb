// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Русский catalog. `: Messages` makes tsc prove this file key-complete against
 * locales/en.ts - a missing, extra, or renamed key is a compile error.
 *
 * Russian plural agreement is out of scope (see the task's prd.md), so count strings
 * use the count-neutral "Существительное: {n}" shape instead of "{n} существительных".
 * Command syntax (read/write/ctrl/...) and device mode names stay English - they
 * are syntax, not prose.
 */

import type { Messages } from './en.js';

export const ru: Messages = {
  // ------------------------------------------------------------- toolbar
  'toolbar.device': 'Устройство',
  'toolbar.connect': 'Подключить устройство',
  'toolbar.reconnect': 'Переподключить',
  'toolbar.webusbUnavailable': 'WebUSB недоступен',
  'toolbar.connectHint': 'Нажмите «Подключить устройство» и выберите SLogic16/32 U3. Разрешение запоминается для этого источника.',
  'toolbar.noWebusb': 'WebUSB недоступен в этом браузере. Используйте Brave или Chrome через http://127.0.0.1.',
  'toolbar.start': 'Старт',
  'toolbar.stop': 'Стоп',
  'toolbar.stopping': 'Остановка…',
  'toolbar.demo': 'Демо',
  'toolbar.open': 'Открыть…',
  'toolbar.save': 'Сохранить',
  'toolbar.fit': 'Вписать',
  'toolbar.startTitle': 'Начать захват на подключённом устройстве',
  'toolbar.stopTitle': 'Остановить текущий захват',
  'toolbar.stoppingTitle': 'Ожидание отмены ожидающих USB-передач',
  'toolbar.demoTitle': 'Загрузить демонстрационный захват протоколов I2C, SPI и UART',
  'toolbar.demoLoading': 'Загрузка демонстрации…',
  'toolbar.openTitle': 'Загрузить сессию sigrok .sr или файл .lwcap',
  'toolbar.saveTitle': 'Сохранить этот захват как .lwcap',
  'toolbar.fitTitle': 'Масштабировать на весь захват',
  'toolbar.sidebarTitle': 'Выбор правой боковой панели',
  'toolbar.sidebarDevice': 'Устройство и настройки захвата',
  'toolbar.sidebarAnalyzers': 'Протокольные анализаторы',
  'toolbar.sidebarNone': 'Без боковой панели',

  // ---------------------------------------------------- capture title
  'capture.none': 'нет захвата',
  'capture.capturing': 'захват: каналов {channels} @ {rate}',
  'capture.loaded': '{source} · загружено за {ms} мс',
  'capture.demo': 'демонстрация протоколов',
  'capture.stoppedNoTrigger': 'нет триггера · сохранено образцов: {samples}',
  'capture.live': 'онлайн-захват · образцов: {samples} @ {rate} · {duration}',

  // ------------------------------------------------------------- status
  'status.summary': 'образцов: {samples} @ {rate}',
  'status.total': 'всего {duration}',
  'status.view': 'вид {duration}',

  // -------------------------------------------------------- empty hint
  'emptyHint.line1': 'Захват не загружен.',
  'emptyHint.line2': 'Откройте файл .sr или .lwcap или подключите SLogic16/32 U3.',

  // ------------------------------------- error prefixes (App.fail sites)
  'error.render': 'отрисовка',
  'error.device': 'устройство',
  'error.openCapture': 'открытие захвата',
  'error.demo': 'демо',
  'error.save': 'сохранение',
  'error.reconnect': 'переподключение',
  'error.connect': 'подключение',
  'error.start': 'запуск',
  'error.startCapture': 'запуск захвата',
  'error.stopCapture': 'остановка захвата',
  'error.dropoutAccounting': 'учёт пропусков',
  'error.decodeWorkerWarmup': 'прогрев воркера декодера',
  'error.decode': 'декодирование {id}',
  'error.localeLoad': 'Не удалось загрузить языковой каталог',

  // -------------------------------------------------------- hover readout
  'hover.width': 'Ширина: {duration}',
  'hover.widthInv': 'ширина⁻¹: {freq}',
  'hover.freq': 'Частота: {freq}',
  'hover.duty': 'Скважность: {pct} %',
  'hover.noTransition': 'в видимой области нет переходов',

  // ---------------------------------------------------- trigger summary
  'trigger.level': 'Уровень {level}',
  'trigger.rising': 'Нарастающий фронт',
  'trigger.falling': 'Спадающий фронт',
  'trigger.anyEdge': 'Любой фронт',
  'trigger.summary': '{condition} · предзахват {pct}%',
  'trigger.summaryAnd': '{condition} · предзахват {pct}% · условий по И: {count}',

  // -------------------------------------------------------- channel list
  'channels.settings': 'Настройки D{index}',
  'channels.name': 'Имя канала',
  'channels.color': 'Цвет канала',
  'channels.customColor': 'Пользовательский цвет',
  'channels.triggerMode': 'Режим триггера',
  'channels.cancel': 'Отмена',
  'channels.removeAnalyzer': 'Удалить {label}',
  'channels.triggerHigh': 'Высокий уровень',
  'channels.triggerLow': 'Низкий уровень',
  'channels.triggerAny': 'Любое значение (X)',
  'channels.nameHint.name': 'Цветная метка показывает имя канала (по умолчанию D{index}). Стиль меток: {path}.',
  'channels.nameHint.legacy': 'Цветная метка D{index} сохраняет цвет канала, белая подпись показывает имя. Стиль меток: {path}.',

  // ------------------------------------------------------- capture panel
  'capturePanel.digital': 'Цифровые каналы',
  'capturePanel.all': 'Все',
  'capturePanel.clear': 'Ничего',
  'capturePanel.sampleRate': 'Частота выборки',
  'capturePanel.threshold': 'Порог',
  'capturePanel.dacNote': 'Код DAC {code} = фактически {volts} В. Ширина захвата: {channels} кан. (потолок {rate}).',
  'capturePanel.capture': 'Захват',
  'capturePanel.freeRun': 'Свободный режим',
  'capturePanel.timer': 'Таймер',
  'capturePanel.durationS': 'Длительность (с)',
  'capturePanel.ceilingNote': 'Потолок: {samples} образцов = {duration} на {rate}. Свободный ход остановится сам на потолке.',
  'capturePanel.softwareTrigger': 'Программный триггер',
  'capturePanel.enableTrigger': 'Включить программный триггер',
  'capturePanel.noPreTrigger': 'Без предзахвата',
  'capturePanel.preTriggerBuffer': 'Буфер предзахвата',
  'capturePanel.noCondition': 'Условие не задано — захват пойдёт без триггера. Нажмите кнопку настроек в строке канала (левая колонка) и выберите фронт или уровень.',
  'capturePanel.condHigh': 'высокий',
  'capturePanel.condLow': 'низкий',
  'capturePanel.condRising': 'нарастающий',
  'capturePanel.condFalling': 'спадающий',
  'capturePanel.condEdge': 'фронт',
  'capturePanel.condJoiner': ' И ',
  'capturePanel.armed': 'Взведено: {what}. T=0 на триггере; до {duration} перед ним сохраняется как отрицательное время.',
  'capturePanel.armedCapped': 'Взведено: {what}. T=0 на триггере; до {duration} перед ним сохраняется как отрицательное время (ограничено буфером предзахвата {megabytes} МиБ).',
  'capturePanel.waitingTrigger': 'Ожидание условия триггера…',
  'capturePanel.triggered': 'Триггер сработал — идёт запись послетриггерного окна.',
  'capturePanel.triggerNotFound': 'Остановлено без триггера; ничего не записано.',
  'capturePanel.recording': 'Запись {seconds} с · образцов: {samples} · {megabytes} МБ',
  'capturePanel.dropped': 'потеряно образцов из-за пропусков (помечены как разрывы): {samples}',
  'capturePanel.advanced': 'Расширенные',
  'capturePanel.testMode': 'Тестовый режим устройства (для следующего захвата)',
  'capturePanel.testNormal': 'Обычный',
  'capturePanel.testSimulator': 'Симулятор',
  'capturePanel.testUsbMax': 'USB MAX SPEED',
  'capturePanel.usbConsole': 'Консоль управления USB',
  'capturePanel.usbPlaceholder': 'read 0x000c 4',
  'capturePanel.usbSend': 'Отправить',
  'capturePanel.usbHelp': 'Команды: read <addr> [len], write <addr> <byte>..., ctrl <value>, flags, clear-fifo, in <request> <value> <index> <len>, out <request> <value> <index> [byte]...',
  'capturePanel.consoleSeed': 'Введите help для списка команд. Числа десятичные или шестнадцатеричные с префиксом 0x.',
  'capturePanel.consoleError': 'ошибка: {detail}',

  // ------------------------------------------------------ analyzer panel
  'analyzerPanel.title': 'Анализаторы',
  'analyzerPanel.subWarm': 'встроенных декодеров sigrok: {count}. Воркер прогрет.',
  'analyzerPanel.subCold': 'встроенных декодеров sigrok: {count}. Воркер прогревается (~850 мс, раз за сессию).',
  'analyzerPanel.decoding': 'декодирование…',
  'analyzerPanel.attached': 'Подключённые',
  'analyzerPanel.decode': 'Декодировать',
  'analyzerPanel.remove': 'Удалить',
  'analyzerPanel.cancelDecode': 'Отменить декодирование',
  'analyzerPanel.add': 'Добавить',
  'analyzerPanel.decoder': 'Декодер',
  'analyzerPanel.stacked': '{id} требует {inputs}, поэтому должен быть наращён на производителя. Наращивание в этой панели недоступно.',
  'analyzerPanel.optionalSuffix': ' (необязательно)',
  'analyzerPanel.attach': 'Подключить',
  'analyzerPanel.loadFirst': 'Сначала загрузите или запишите захват; декодеру нужны фронты.',

  // ----------------------------- analyzer status notes (formatted at render)
  'analyzerNote.pending': 'не декодировано',
  'analyzerNote.edges': 'фронтов: {count}',
  'analyzerNote.stats': 'аннотаций: {anns}, {decodeMs} мс (реальное время {wallMs} мс)',
  'analyzerNote.timeout': 'тайм-аут',
  'analyzerNote.cancelled': 'отменено',

  // -------------------------------------------------------- settings menu
  'settings.title': 'Настройки',
  'settings.titleHint': 'Язык и параметры отображения',
  'settings.language': 'Язык',
  'settings.channelLabels': 'Метки каналов',
  'settings.theme': 'Тема',

  // --------------------------------------------------- channel label modes
  'channelLabels.name': 'Только имя',
  'channelLabels.legacy': 'Метка Dx и имя',

  // ------------------------------------------------------------ theme
  'theme.default': 'По умолчанию',
  'theme.dark': 'Тёмная',
};
