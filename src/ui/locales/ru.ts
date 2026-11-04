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
  'toolbar.open': 'Открыть…',
  'toolbar.save': 'Сохранить',
  'toolbar.fit': 'Вписать',
  'toolbar.fullscreen': 'Во весь экран',
  'toolbar.shortDevice': 'Устройство',
  'toolbar.shortStart': 'Старт',
  'toolbar.shortStop': 'Стоп',
  'toolbar.shortStopping': 'Остановка…',
  'toolbar.shortOpen': 'Открыть',
  'toolbar.shortSave': 'Сохранить',
  'toolbar.shortFit': 'Вписать',
  'toolbar.shortFullscreen': 'Во весь экран',
  'toolbar.shortSettings': 'Настройки',
  'toolbar.shortAssistant': 'Ассистент',
  'toolbar.shortLanguage': 'Язык',
  'toolbar.shortTheme': 'Тема',
  'toolbar.shortSidebar': 'Панели',
  'toolbar.startTitle': 'Начать захват на подключённом устройстве',
  'toolbar.stopTitle': 'Остановить текущий захват',
  'toolbar.stoppingTitle': 'Ожидание отмены ожидающих USB-передач',
  'toolbar.openTitle': 'Загрузить сессию sigrok .sr или файл .lwcap',
  'toolbar.saveTitle': 'Сохранить этот захват как .lwcap',
  'toolbar.fitTitle': 'Масштабировать на весь захват',
  'toolbar.enterFullscreenTitle': 'Перейти в полноэкранный режим',
  'toolbar.exitFullscreenTitle': 'Выйти из полноэкранного режима',
  'toolbar.fullscreenUnavailable': 'Полноэкранный режим недоступен',
  'toolbar.sidebarTitle': 'Выбор правой боковой панели',
  'toolbar.themeTitle': 'Тема: выбор режима',
  'toolbar.languageTitle': 'Выбор языка',
  'toolbar.switchGroup': 'Язык и тема',
  'toolbar.viewGroup': 'Вид и настройки',
  'toolbar.assistantTitle': 'ИИ-ассистент',
  'toolbar.sidebarDevice': 'Устройство и настройки захвата',
  'toolbar.sidebarAnalyzers': 'Протокольные анализаторы',
  'toolbar.sidebarAssistant': 'ИИ-ассистент',
  'toolbar.sidebarNone': 'Без боковой панели',

  // ---------------------------------------------------------- side panel
  'panel.resizeLabel': 'Изменить ширину боковой панели',
  'panel.resizeTitle': 'Перетащите, чтобы изменить ширину боковой панели',

  // ---------------------------------------------------- capture title
  'capture.none': 'нет захвата',
  'capture.capturing': 'захват: каналов {channels} @ {rate}',
  'capture.loaded': '{source} · загружено за {ms} мс',
  'capture.stoppedNoTrigger': 'нет триггера · сохранено образцов: {samples}',
  'capture.live': 'онлайн-захват · образцов: {samples} @ {rate} · {duration}',

  // ------------------------------------------------------------- status
  'status.summary': 'образцов: {samples} @ {rate}',
  'status.total': 'всего {duration}',
  'status.loop': 'хранится {kept} · всего {total}',
  'status.view': 'вид {duration}',

  // -------------------------------------------------------- empty hint
  'emptyHint.line1': 'Захват не загружен.',
  'emptyHint.line2': 'Откройте файл .sr или .lwcap или подключите SLogic16/32 U3.',

  // ------------------------------------- error prefixes (App.fail sites)
  'error.render': 'отрисовка',
  'error.device': 'устройство',
  'error.openCapture': 'открытие захвата',
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

  // ---------------------------------------- status error detail codes
  'diagnostic.ui.localeLoad': '«{locale}» не загружен',
  'diagnostic.ui.axisContext': '2D-контекст оси недоступен',
  'diagnostic.ui.captureLocked':
    'настройки осциллографа группы заблокированы, пока идёт захват или остановка',
  'diagnostic.io.nothingToSave': 'нечего сохранять',
  'diagnostic.file.noFiles': 'файлы не выбраны',
  'diagnostic.file.unsupported':
    'среди {names} нет загружаемого: нужен сеанс sigrok .sr или файл .lwcap',
  'diagnostic.file.lwcap.header':
    'файл .lwcap обрезан: {bytes} байт короче заголовка в {need} байт',
  'diagnostic.file.lwcap.magic': 'это не файл .lwcap (magic {magic})',
  'diagnostic.file.lwcap.channels':
    'число каналов {channels} не входит в поддерживаемую разрядность ({widths})',
  'diagnostic.file.lwcap.length': 'неправдоподобная длина записи {length}',
  'diagnostic.file.lwcap.samplerate': 'неправдоподобная частота дискретизации в .lwcap: {samplerate}',
  'diagnostic.file.lwcap.namesTruncated':
    'файл .lwcap обрезан: блок имён каналов размером {bytes} байт выходит за конец файла',
  'diagnostic.file.lwcap.namesInvalid': 'недопустимые имена каналов в .lwcap',
  'diagnostic.file.lwcap.gapTruncated':
    'файл .lwcap обрезан: пропуск {index} выходит за конец файла',
  'diagnostic.file.lwcap.gapSpan': 'повреждённый интервал пропуска [{start}, {end}) в {source}',
  'diagnostic.file.lwcap.gapOrder':
    'интервалы пропусков перекрываются или идут не по порядку на позиции {index}',
  'diagnostic.file.lwcap.channelHeaders':
    'файл .lwcap обрезан: заголовки каналов выходят за конец файла',
  'diagnostic.file.lwcap.initial': 'файл .lwcap повреждён: канал {channel} начинается с уровня {level}',
  'diagnostic.file.lwcap.edgeBytes':
    'в .lwcap усечённые или лишние байты ({actual} вместо {expected})',
  'diagnostic.file.lwcap.edgeRange':
    'файл .lwcap повреждён: переход {index} канала {channel} = {value} вне [1, {length})',
  'diagnostic.file.lwcap.edgeOrder':
    'файл .lwcap повреждён: переходы канала {channel} не строго возрастают на индексе {index}',
  'diagnostic.file.sr.notZip': 'это не zip-архив',
  'diagnostic.file.sr.multiDisk': 'многодисковые zip-архивы не поддерживаются',
  'diagnostic.file.sr.corruptDirectory':
    'zip повреждён: центральный каталог выходит за запись конца центрального каталога',
  'diagnostic.file.sr.directoryBounds':
    'zip повреждён: элемент центрального каталога {index} выходит за каталог',
  'diagnostic.file.sr.zip64': 'архивы ZIP64 не поддерживаются',
  'diagnostic.file.sr.entrySignature':
    'zip повреждён: у элемента центрального каталога {index} нет сигнатуры',
  'diagnostic.file.sr.dataDescriptor':
    'элемент {member} использует дескриптор данных, что не поддерживается',
  'diagnostic.file.sr.memberZip64':
    'элементу {member} нужен ZIP64, что не поддерживается',
  'diagnostic.file.sr.compression':
    'элемент {member} использует метод сжатия {method}; поддерживаются только stored и deflate',
  'diagnostic.file.sr.noLocalHeader':
    'у элемента {member} нет локального заголовка там, где указывает каталог',
  'diagnostic.file.sr.localHeaderBounds':
    'локальный заголовок элемента {member} выходит за конец файла',
  'diagnostic.file.sr.memberPastEnd': 'элемент {member} выходит за конец файла',
  'diagnostic.file.sr.memberSize': 'несовпадение размера элемента {member}',
  'diagnostic.file.sr.inflateFailed': 'не удалось распаковать элемент {member}',
  'diagnostic.file.sr.inflateSize':
    'элемент {member} распаковывается в {actual} байт, а каталог указывает {expected}',
  'diagnostic.file.sr.noMetadata':
    'в {source} нет элемента metadata, значит это не сеанс sigrok',
  'diagnostic.file.sr.duplicateCapturefile':
    'в одной секции устройства два capturefile',
  'diagnostic.file.sr.analogCapture':
    'capturefile {capturefile} не является логическим блоком; аналоговые записи не поддерживаются',
  'diagnostic.file.sr.noCapturefile': 'в metadata нет логического capturefile',
  'diagnostic.file.sr.noSamplerate': 'в metadata нет частоты дискретизации',
  'diagnostic.file.sr.probes': 'total probes {probes} вне диапазона 1..128',
  'diagnostic.file.sr.analogChannels':
    'аналоговые каналы в этой записи не поддерживаются (их {count})',
  'diagnostic.file.sr.unitsize': 'unitsize {unitsize} вне диапазона 1..16 байт',
  'diagnostic.file.sr.unitsizeProbes':
    'unitsize {unitsize} не вмещает {probes} каналов',
  'diagnostic.file.sr.samplerate': 'не удалось разобрать частоту дискретизации {value}',
  'diagnostic.file.sr.dataLength':
    'длина данных {bytes} не кратна образцам по {unitsize} байт',
  'diagnostic.file.sr.tooLong': 'запись слишком длинная ({samples} образцов)',
  'diagnostic.file.sr.noData':
    'в {source} нет элементов данных для capturefile {capturefile}',
  'diagnostic.device.transportDead': 'транспорт USB мёртв ({reason})',
  'diagnostic.device.disconnected': '{device} отключён',
  'diagnostic.device.workerUnavailable': 'фоновый воркер USB недоступен в этом браузере',
  'diagnostic.device.workerCrashed': 'воркер USB завершился с ошибкой',
  'diagnostic.device.workerTimeout': 'воркер USB не ответил «{kind}» за {ms} мс',
  'diagnostic.device.workerNoDevice': 'воркер USB не сообщил об устройстве',
  'diagnostic.device.workerTerminated': 'транспорт фонового воркера USB был остановлен',
  'diagnostic.device.workerNoStats': 'воркер USB ответил без статистики',
  'diagnostic.device.workerNoConsole': 'воркер USB ответил без результата консоли',
  'diagnostic.device.workerUnclaimed': 'воркер USB ответил «{kind}», когда ответ никто не ждал',
  'diagnostic.device.stopTimedOut':
    'запись не остановилась за {ms} мс; транспорт USB был сброшен',
  'diagnostic.device.loopUnsettled':
    'цикл чтения предыдущей записи так и не завершился после освобождения интерфейса',
  'diagnostic.device.loopUnsettledClosed':
    'цикл чтения так и не завершился после освобождения интерфейса, поэтому дескриптор устройства был закрыт',
  'diagnostic.device.reclaimFailed':
    'интерфейс не удалось занять заново после отмены записи, поэтому устройство было закрыто',
  'diagnostic.device.unsupportedChannels':
    'неподдерживаемое число каналов {channels}; это устройство предлагает {offered}',
  'diagnostic.device.unknownWidth':
    'устройство сообщило неподдерживаемое число каналов: {channels}',
  'diagnostic.device.unsupportedSamplerate':
    'неподдерживаемая частота дискретизации {samplerate} Гц; устройство предлагает {offered}',
  'diagnostic.device.rateCeiling':
    '{rate} МГц превышает потолок {ceiling} МГц для {channels} каналов',
  'diagnostic.device.threshold': 'порог должен быть числом, получено {threshold}',
  'diagnostic.device.thresholdClips': 'порог {volts} В ограничивает ЦАП (код {code})',
  'diagnostic.device.testMode': 'режим теста должен быть 0, 1 или 2, получено {mode}',
  'diagnostic.device.tuningPacket':
    'transferBytes {bytes} не кратно размеру пакета {packet} байт',
  'diagnostic.device.tuningDepth':
    'глубина передачи {depth} меньше 4, необходимых устройству, чтобы не переполниться',
  'diagnostic.device.tuningTransfer':
    'transferBytes {bytes} превышает предел Chromium WebUSB в {limit} байт',
  'diagnostic.device.tuningQueue':
    'очередь передач {depth} x {bytes} B превышает безопасный бюджет usbfs в {budget} байт; увеличьте usbfs_memory_mb и queueBudgetBytes вместе',
  'diagnostic.device.startRunning': 'start() вызван, когда запись уже идёт',
  'diagnostic.device.startStopping':
    'start() вызван до завершения остановки предыдущей записи',
  'diagnostic.device.startBeforeOpen': 'start() вызван до open()',
  'diagnostic.device.triggerLimitConflict':
    'softwareTrigger и deviceSampleLimit взаимоисключающие; ограничьте запись с триггером через softwareTrigger.maxSamples',
  'diagnostic.device.coalescePacket':
    'coalesceBytes {bytes} не кратно размеру отсчёта {packet} байт',
  'diagnostic.device.triggerWidth':
    'ширина программного триггера {width} не совпадает с шириной записи {channels}',
  'diagnostic.device.bulkStatus': 'bulk IN вернул статус «{status}»',
  'diagnostic.device.bulkEmpty': 'bulk IN не вернул данных со статусом «ok»',
  'diagnostic.device.consoleBusy':
    'консоль USB недоступна, пока запись идёт или останавливается',
  'diagnostic.device.notOpen': 'устройство не открыто',
  'diagnostic.device.notConnected': 'устройство не подключено',
  'diagnostic.device.noConsole': 'это устройство не предоставляет консоль USB',
  'diagnostic.device.sampleAccounting':
    'устройство насчитало {counted} доставленных отсчётов, в хранилище {stored}',
  'diagnostic.device.noData':
    '{device} не отдал данных за {deadline} мс после RUN ({channels} каналов @ {rate} МГц). Плата в таком состоянии отвечает на каждую управляющую передачу и ничего не отправляет на bulk-эндпоинт: отключите и снова подключите её.',
  'diagnostic.device.underrunStalled':
    '{device} перегрузил хост: {channels} каналов @ {rate} МГц дают {offered} МБ/с, но {count} передач подряд заняли {transferMs} мс на {bytes} B (предел {limitMs} мс), средняя {avg} МБ/с за {runMs} мс (минимум {minimum} МБ/с). Запись прервана до того, как переполнение FIFO устройства заблокировало эндпоинт. Поток {thread} блокировался {stalls} раз за запись, дольше всего {worstMs} мс на отметке {atMs} мс; очередь покрывает {coverMs} мс.',
  'diagnostic.device.underrunClean':
    '{device} перегрузил хост: {channels} каналов @ {rate} МГц дают {offered} МБ/с, но {count} передач подряд заняли {transferMs} мс на {bytes} B (предел {limitMs} мс), средняя {avg} МБ/с за {runMs} мс (минимум {minimum} МБ/с). Запись прервана до того, как переполнение FIFO устройства заблокировало эндпоинт. Поток {thread} ни разу не блокировался дольше {thresholdMs} мс, значит дело в устройстве или в шине USB.',
  'diagnostic.device.openFailed': 'не удалось открыть USB-устройство',
  'diagnostic.device.configureFailed': 'не удалось выбрать конфигурацию устройства',
  'diagnostic.device.claimFailed': 'не удалось захватить интерфейс 0',
  'diagnostic.device.controlReadTimeout':
    'чтение регистра {addr} не завершилось за {ms} мс; плата перестала отвечать на управляющие передачи',
  'diagnostic.device.controlWriteTimeout':
    'запись в регистр {addr} не завершилась за {ms} мс; плата перестала отвечать на управляющие передачи',
  'diagnostic.device.controlWriteStatus': 'запись в регистр {addr} вернула статус «{status}»',
  'diagnostic.device.controlWriteLength':
    'запись в регистр {addr} передала {bytes} байт, ожидалось 4',
  'diagnostic.device.controlReadStatus': 'чтение регистра {addr} вернуло статус «{status}»',
  'diagnostic.device.controlReadLength':
    'чтение регистра {addr} вернуло {bytes} байт, ожидалось 4',
  'diagnostic.device.controlRequestTimeout':
    'запрос консоли USB {request} не завершился за {ms} мс; плата перестала отвечать на управляющие передачи',
  'diagnostic.device.registerStuck':
    '{where}={wanted} не удержалось после {cycles} циклов чтение/запись/чтение (записано {wrote}, прочитано {readBack})',
  'diagnostic.device.sampleLengthRejected':
    'длина выборки не принята: записано {value}, прочитано {readBack} (сравнение по объявленным байтам: {advertised})',
  'diagnostic.device.auxReadyTimeout':
    'селектор aux {selector}: бит готовности не установился за {reads} чтений',
  'diagnostic.device.auxEcho': 'селектор aux {selector}: устройство вернуло эхо {echoed}',
  'diagnostic.device.auxZeroLength':
    'селектор aux {selector}: устройство сообщило полезную нагрузку нулевой длины',
  'diagnostic.device.auxValueTooWide':
    'селектор aux {selector}: значение {value} не помещается в объявленные для слова нагрузки {word} байты (их {advertised})',
  'diagnostic.device.auxWordOutside':
    'селектор aux {selector}: слово нагрузки {word} целиком вне объявленной нагрузки из {bytes} байт',
  'diagnostic.device.auxFieldOutside':
    'селектор aux {selector}: поле заканчивается на байте нагрузки {endByte}, а устройство принимает только {accepted} байт',
  'diagnostic.device.channelMaskRejected':
    'маска каналов не принята: записано {mask}, прочитано {readBack} (сравнение по объявленным байтам: {advertised})',
  'diagnostic.device.channelMaskRejectedPadded':
    'маска каналов не принята: записано {mask}, прочитано {readBack} (сравнение по полному четырёхбайтовому дополненному слову)',
  'diagnostic.device.sampleratePayload':
    'полезная нагрузка aux частоты дискретизации — {bytes} байт, для делителя нужно минимум 8',
  'diagnostic.device.samplerateStuck':
    'не удалось настроить {rate} МГц на base[{index}] = {base} МГц: делитель не удержался после {cycles} циклов чтение/запись/чтение (записано {wrote}, прочитано {readBack}, опорная частота до записи {before} МГц)',
  'diagnostic.device.samplerateBaseChanged':
    'не удалось настроить {rate} МГц: опорная частота изменилась с {before} МГц на {after} МГц (записан делитель {divider}, устройство ответило индексом {index}) после {cycles} циклов чтение/запись/чтение',
  'diagnostic.device.samplerateAnswered':
    'не удалось настроить {rate} МГц: записан делитель {wrote} на опорной частоте {before} МГц, устройство ответило индексом {index}, опорной частотой {after} МГц и делителем {readBack} после {cycles} циклов чтение/запись/чтение',
  'diagnostic.device.samplerateNotDivided':
    'не удалось настроить {rate} МГц: base[{index}] = {baseMHz} МГц не делится на неё (проверено баз: {count}; индекс {maxIndex} — последний существующий)',
  'diagnostic.device.samplerateNotExpressible':
    'не удалось настроить {rate} МГц: base[{index}] = {baseMHz} МГц требует делитель {divider}, больше {maxDivider}, который поддерживает сэмплер (проверено баз: {count}; индекс {maxIndex} — последний существующий)',
  'diagnostic.device.samplerateUnwalked':
    'не удалось настроить {rate} МГц: делитель не удержался, и ни одна опорная частота не стала пригодной за {passes} проходов',
  'diagnostic.device.thresholdRejected':
    'порог не принят: записан код {code}, прочитано {readBack} (сравнение по объявленным байтам: {advertised})',
  'diagnostic.device.testModeRejected':
    'режим теста не принят: записано {mode}, прочитано {readBack} (сравнение по объявленным байтам: {advertised})',
  'diagnostic.usb.unavailable': 'WebUSB недоступен в этом браузере',
  'diagnostic.usb.blocked': 'браузер заблокировал доступ к USB-устройствам',
  'diagnostic.usb.notVisible':
    'устройство {vendor}:{product} не видно воркеру USB; сначала предоставьте к нему доступ со страницы',
  'diagnostic.decode.cancelled': 'декодирование отменено',
  'diagnostic.decode.noCapture': 'нет захвата для декодирования',
  'diagnostic.decode.channelOutOfRange':
    'канала {channel} нет в этом захвате (всего каналов: {channels})',
  'diagnostic.decode.timeout': 'декодирование не уложилось в {ms} мс и было отменено',
  'diagnostic.decode.disposed': 'воркер декодирования закрыт',
  'diagnostic.decode.workerCrashed': 'воркер декодирования завершился с ошибкой',
  'diagnostic.decode.workerFailed': 'декодер завершился с ошибкой',
  'diagnostic.decode.workerUnexpected': 'воркер декодирования ответил {got}, ожидался {want}',
  'diagnostic.decode.terminated': 'воркер декодирования был остановлен',
  'diagnostic.decode.tooLong':
    'в захвате {samples} отсчётов; декодирование ограничено {max} ({window} при 200 MSa/s). Декодируйте поддиапазон.',
  'diagnostic.decode.tooLongLoop':
    'в захвате {samples} отсчётов; декодирование ограничено {max} ({window} при 200 MSa/s). Уменьшите окно цикла.',
  'diagnostic.decode.edgeBudget':
    '{edges} фронтов на сопоставленных каналах превышают бюджет декодирования {budget}. Отключите канал или уменьшите масштаб захвата.',
  'diagnostic.decode.edgeBudgetLoop':
    '{edges} фронтов на сопоставленных каналах превышают бюджет декодирования {budget}. Отключите канал или уменьшите окно цикла.',
  'diagnostic.render.contextLost': 'контекст WebGL потерян, рендерер больше не работает',

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
  'channels.resetName': 'Сбросить имя на D{index}',
  'channels.name': 'Имя канала',
  'channels.color': 'Цвет канала',
  'channels.customColor': 'Пользовательский цвет',
  'channels.colorField': 'Насыщенность и яркость',
  'channels.hue': 'Оттенок',
  'channels.triggerMode': 'Режим триггера',
  'channels.cancel': 'Отмена',
  'channels.removeAnalyzer': 'Удалить {label}',
  'channels.triggerHigh': 'Высокий уровень',
  'channels.triggerLow': 'Низкий уровень',
  'channels.triggerAny': 'Любое значение (X)',

  // ------------------------------------------------------- capture panel
  'capturePanel.digital': 'Цифровые каналы',
  'capturePanel.channelWidth': 'Ширина каналов',
  'capturePanel.channelWidthBusy': 'Ширину каналов нельзя изменить во время захвата',
  'capturePanel.oscilloscopeConfig': '{range}: настройка аналогового осциллографа — {state}',
  'capturePanel.oscilloscopeEnabled': 'включён',
  'capturePanel.oscilloscopeDisabled': 'выключен',
  'capturePanel.channelLocked': '{name}: включён и заблокирован аналоговым осциллографом {range}',
  'capturePanel.oscilloscopeActive': 'Аналоговый осциллограф включён',
  'capturePanel.sampleRate': 'Частота выборки',
  'capturePanel.threshold': 'Порог',
  'capturePanel.dacNote': 'Код DAC {code} = фактически {volts} В. Ширина захвата: {channels} CH (потолок {rate}).',
  'capturePanel.capture': 'Захват',
  'capturePanel.modeSingle': 'Одиночный',
  'capturePanel.modeRepeat': 'Повтор',
  'capturePanel.modeLoop': 'Цикл',
  'capturePanel.statusReady': 'Готово',
  'capturePanel.statusCapturing': 'Захват',
  'capturePanel.statusStopping': 'Остановка',
  'capturePanel.statusWaiting': 'Ожидание',
  'capturePanel.statusCompleted': 'Завершено',
  'capturePanel.statusReadyDetail': 'Готово к захвату',
  'capturePanel.statusFiniteDetail': 'Идёт конечный захват',
  'capturePanel.statusUnlimitedDetail': 'Идёт неограниченный захват; остановите по завершении',
  'capturePanel.statusLoopDetail': 'Идёт циклический захват; последнее окно сохраняется',
  'capturePanel.statusStoppingDetail': 'Остановка; текущий вид сохраняется',
  'capturePanel.statusWaitingDetail': 'Следующий захват через {interval}. Остановите для отмены; вид сохраняется.',
  'capturePanel.statusCompletedDetail': '{samples} образцов · {duration}',
  'capturePanel.progress': 'Ход захвата',
  'capturePanel.unlimited': 'Без ограничений',
  'capturePanel.duration': 'Длительность',
  'capturePanel.repeatInterval': 'Интервал повтора',
  'capturePanel.loopRetention': 'Удерживаемое окно',
  'capturePanel.timeUnit': 'Единица',
  'capturePanel.loopWindow': 'Окно {kept} / {limit} отсчётов · отброшено {dropped}',
  'capturePanel.loopWindowLimit': 'Потолок окна: {samples} отсчётов = {duration} на {rate}.',
  'capturePanel.singleFiniteNote': 'Конечный захват до {max} {unit}; перетащите в правый сегмент для неограниченного.',
  'capturePanel.singleUnlimitedNote': 'Неограниченный захват; конечный черновик длительности и единица сохраняются.',
  'capturePanel.repeatFiniteNote': 'Конечный захват до {max} {unit}; каждый завершённый цикл ждёт интервал повтора.',
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
  'capturePanel.cursors': 'Курсоры',
  'capturePanel.cursorEmpty': 'Дважды щёлкните по осциллограмме, чтобы поставить курсор.',
  'capturePanel.cursorFormat': 'время / отсчёты',
  'capturePanel.removeCursor': 'Удалить курсор {label}',
  'capturePanel.focusCursor': 'Центрировать вид на курсоре {label}',
  'capturePanel.cursorDistance': 'Расстояние курсоров',
  'capturePanel.cursorDistanceFormat': 'Δвремя/Δотсчёты',
  'capturePanel.cursorDistanceEmpty': 'Поставьте два курсора на осциллограмме, чтобы прочитать расстояние между ними.',
  'capturePanel.cursorDistanceNoRows': 'Добавьте строку, чтобы сравнить два курсора.',
  'capturePanel.cursorDistanceAdd': 'Добавить строку расстояния',
  'capturePanel.cursorDistanceRemove': 'Удалить строку расстояния {row}',
  'capturePanel.cursorDistanceStart': 'Выбрать первый курсор для строки {row}',
  'capturePanel.cursorDistanceEnd': 'Выбрать второй курсор для строки {row}',
  'capturePanel.cursorDistanceUnset': 'не выбран',
  'capturePanel.cursorEdges': 'Фронты',
  'capturePanel.cursorEdgesFormat': 'Нарастающие/Спадающие/Фронты',
  'capturePanel.cursorEdgesEmpty': 'Поставьте два курсора на осциллограмме, чтобы посчитать фронты между ними.',
  'capturePanel.cursorEdgesNoRows': 'Добавьте строку, чтобы посчитать фронты между двумя курсорами.',
  'capturePanel.cursorEdgesAdd': 'Добавить строку фронтов',
  'capturePanel.cursorEdgesRemove': 'Удалить строку фронтов {row}',
  'capturePanel.cursorEdgesStart': 'Выбрать первый курсор для строки фронтов {row}',
  'capturePanel.cursorEdgesEnd': 'Выбрать второй курсор для строки фронтов {row}',
  'capturePanel.cursorEdgesChannel': 'Выбрать канал для строки фронтов {row}',
  'capturePanel.cursorEdgesUnset': '–',
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
  'analyzerPanel.decodeAction': 'Декодировать {label}',
  'analyzerPanel.removeAction': 'Удалить {label}',
  'analyzerPanel.cancelDecode': 'Отменить декодирование',
  'analyzerPanel.add': 'Добавить',
  'analyzerPanel.decoder': 'Декодер',
  'analyzerPanel.decoderSearchLabel': 'Поиск протоколов',
  'analyzerPanel.decoderSearchPlaceholder': 'Введите текст для фильтрации протоколов',
  'analyzerPanel.decoderNoMatch': 'Нет протокола, соответствующего «{query}»',
  'analyzerPanel.stacked': '{id} требует {inputs}, поэтому должен быть наращён на производителя. Наращивание в этой панели недоступно.',
  'analyzerPanel.optionalSuffix': ' (необязательно)',
  'analyzerPanel.attach': 'Подключить',
  'analyzerPanel.loadFirst': 'Сначала загрузите или запишите захват; декодеру нужны фронты.',

  // ----------------------------- analyzer status notes (formatted at render)
  'analyzerNote.pending': 'не декодировано',
  'analyzerNote.edges': 'фронтов: {count}',
  'analyzerNote.stats': 'аннотаций: {anns}, {decodeMs} мс (реальное время {wallMs} мс)',
  'analyzerNote.snapshot': 'снимок работающего цикла - не следует за захватом',
  'analyzerNote.timeout': 'тайм-аут',
  'analyzerNote.cancelled': 'отменено',

  // ---------------------------------------------------- parallel bus / ADC
  'bus.title': 'Параллельная шина / АЦП',
  'bus.sub': 'Объединяет линии данных в одно значение и рисует его как аналоговый сигнал.',
  'bus.attached': 'Представления шины',
  'bus.add': 'Добавить представление шины',
  'bus.edit': 'Изменить представление шины',
  'bus.name': 'Название',
  'bus.bankDialogTitle': '{range}: режим осциллографа',
  'bus.defaultName': 'Аналоговая форма волны',
  'bus.enableBank': 'Включить режим осциллографа',
  'bus.channelOrder': 'Каналы и порядок декодирования',
  'bus.confirm': 'Подтвердить',
  'bus.bits': 'Разрядов',
  'bus.start': 'Начальный канал',
  'bus.perBit': 'Назначить каждый разряд',
  'bus.swap': 'Поменять MSB/LSB',
  'bus.swapShort': 'MSB↔LSB',
  'bus.msbFirst': 'Начальный канал — старший разряд (MSB)',
  'bus.bit': 'Разряд {k}',
  'bus.bitLsb': 'Разряд {k} (младший)',
  'bus.bitMsb': 'Разряд {k} (старший)',
  'bus.clock': 'Тактовый сигнал',
  'bus.clockNone': 'Нет (любое изменение разряда)',
  'bus.edge': 'Защёлкивать по',
  'bus.edgeRising': 'Фронту',
  'bus.edgeFalling': 'Спаду',
  'bus.encoding': 'Кодировка',
  'bus.encUnsigned': 'Без знака',
  'bus.encTwos': 'Дополнительный код',
  'bus.encOffset': 'Смещённый код',
  'bus.fullScale': 'Полная шкала (В)',
  'bus.offset': 'Смещение (В)',
  'bus.scaleHint': 'Оставьте полную шкалу пустой, чтобы видеть исходные значения. Вольты = смещение + значение / 2^n × полная шкала.',
  'bus.style': 'Рисовать',
  'bus.styleLine': 'Линией',
  'bus.styleStep': 'Ступеньками',
  'bus.height': 'Высота строки',
  'bus.hideSources': 'Скрыть строки исходных разрядов',
  'bus.addButton': 'Добавить',
  'bus.save': 'Сохранить',
  'bus.cancel': 'Отмена',
  'bus.editButton': 'Изменить',
  'bus.remove': 'Удалить',
  'bus.building': 'построение обзора {pct}%',
  'bus.liveNote': 'Увеличьте масштаб, чтобы видеть шину во время захвата',
  'bus.badChannels': 'В этом захвате нет всех каналов шины',
  'bus.unknown': 'неизвестно',
  'bus.code': 'значение',

  // ------------------------------------------------------- AI assistant
  'assistant.title': 'ИИ-ассистент',
  'assistant.settings': 'Настройки',
  'assistant.newChat': 'Новый чат',
  'assistant.new': 'Новый',
  'assistant.provider': 'Провайдер',
  'assistant.providerClaude': 'Claude',
  'assistant.providerOpenai': 'Совместимый с OpenAI',
  'assistant.preset': 'Шаблон',
  'assistant.presetCustom': 'Свой',
  'assistant.baseUrl': 'Base URL',
  'assistant.baseUrlHint': 'Оставьте Base URL пустым для официального адреса. Если он недоступен из вашей сети, укажите здесь адрес API-ретранслятора или обратного прокси либо включите системный или браузерный прокси. Веб-страница сама не может использовать HTTP- или SOCKS5-прокси.',
  'assistant.apiKey': 'API-ключ',
  'assistant.keyHint': 'Ключ хранится только в этом браузере и отправляется только на указанный Base URL. Без «запомнить» он удаляется при закрытии вкладки.',
  'assistant.rememberKey': 'Запомнить ключ на этом устройстве',
  'assistant.model': 'Модель',
  'assistant.modelPlaceholder': 'имя модели из документации провайдера',
  'assistant.noticeTitle': 'Перед началом',
  'assistant.notice': 'Ваши сообщения и сводки захвата, которые ассистент читает своими инструментами (настройки, статистика фронтов, декодированные данные), отправляются выбранному провайдеру на его условиях. Больше ничего не покидает эту страницу. Изменение настроек и запуск захвата всегда требуют вашего подтверждения.',
  'assistant.noticeAccept': 'Понятно',
  'assistant.placeholder': 'Спросите о своих сигналах… (Enter — отправить, Shift+Enter — новая строка)',
  'assistant.send': 'Отправить',
  'assistant.stop': 'Стоп',
  'assistant.needKey': 'Сначала укажите API-ключ в настройках.',
  'assistant.needModel': 'Сначала укажите имя модели в настройках.',
  'assistant.empty': 'Попросите меня захватить, измерить или декодировать сигналы. Например:',
  'assistant.suggest1': 'Какие каналы активны и на каких частотах?',
  'assistant.suggest2': 'Найди UART в этом захвате и декодируй его.',
  'assistant.suggest3': 'Настрой захват 1 с на 10 МГц по D0-D3 и запусти его.',
  'assistant.thinking': 'Размышления',
  'assistant.toolRunning': 'выполняется…',
  'assistant.toolPending': 'ждёт подтверждения',
  'assistant.toolDone': 'готово',
  'assistant.toolError': 'ошибка',
  'assistant.toolDeclined': 'отклонено',
  'assistant.approveTitle': 'Ассистент хочет выполнить это действие. Разрешить?',
  'assistant.allow': 'Разрешить',
  'assistant.deny': 'Отклонить',
  'assistant.allowAlways': 'Разрешать всё в этом чате',
  'assistant.result': 'Результат',
  'assistant.newConversation': 'Настройки изменились, здесь начинается новый разговор.',
  'assistant.stopped.aborted': 'Остановлено.',
  'assistant.stopped.refusal': 'Модель отказалась отвечать{detail}.',
  'assistant.stopped.max_tokens': 'Ответ достиг ограничения длины.',
  'assistant.stopped.max_turns': 'Остановлено после многих шагов с инструментами. Отправьте сообщение, чтобы продолжить.',
  'assistant.stopped.other': 'Модель остановилась{detail}.',
  'assistant.error.auth': 'API-ключ отклонён ({status}). Проверьте ключ и провайдера.',
  'assistant.error.rate': 'Провайдер ограничивает частоту запросов ({status}). Подождите и повторите.',
  'assistant.error.network': 'Не удалось подключиться к {url}. Проверьте Base URL, сеть или прокси. Некоторые провайдеры не принимают запросы с веб-страниц (CORS); в этом случае поможет API-ретранслятор.',
  'assistant.error.invalid': 'Провайдер отклонил запрос ({status}). Проверьте имя модели и Base URL.',
  'assistant.error.server': 'Провайдер сообщил об ошибке ({status}). Повторите попытку.',
  'assistant.error.other': 'Запрос не выполнен.',
  'assistant.error.load': 'Не удалось загрузить клиент Claude.',

  // -------------------------------------------------------- settings menu
  'settings.title': 'Настройки',
  'settings.titleHint': 'Параметры отображения',
  'settings.detailedLabels': 'Подробные подписи',
  'settings.language': 'Язык',
  'settings.theme': 'Тема',

  // ------------------------------------------------------------ theme
  'theme.default': 'По умолчанию',
  'theme.dark': 'Тёмная',
  'theme.light': 'Светлая',
  'theme.system': 'Системная',
};

export { ruDecoder } from './decoder/ru.js';
