// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Français catalog. `: Messages` makes tsc prove this file key-complete against
 * locales/en.ts - a missing, extra, or renamed key is a compile error.
 *
 * French plural agreement is out of scope (see the task's prd.md), so count strings
 * use the count-neutral « Nom : {n} » shape. Apostrophes are the typographic
 * U+2019 throughout, which also keeps the single-quoted TS strings escape-free.
 * Command syntax (read/write/ctrl/...) and device mode names stay English.
 */

import type { Messages } from './en.js';

export const fr: Messages = {
  // ------------------------------------------------------------- toolbar
  'toolbar.device': 'Appareil',
  'toolbar.connect': 'Connecter l’appareil',
  'toolbar.reconnect': 'Reconnecter',
  'toolbar.webusbUnavailable': 'WebUSB indisponible',
  'toolbar.connectHint': 'Cliquez sur « Connecter l’appareil » et choisissez un SLogic16/32 U3. L’autorisation est mémorisée pour cette origine.',
  'toolbar.noWebusb': 'WebUSB est indisponible dans ce navigateur. Utilisez Brave ou Chrome via http://127.0.0.1.',
  'toolbar.start': 'Démarrer',
  'toolbar.stop': 'Arrêter',
  'toolbar.stopping': 'Arrêt…',
  'toolbar.open': 'Ouvrir…',
  'toolbar.save': 'Enregistrer',
  'toolbar.fit': 'Ajuster',
  'toolbar.shortDevice': 'Appareil',
  'toolbar.shortStart': 'Démarrer',
  'toolbar.shortStop': 'Arrêter',
  'toolbar.shortStopping': 'Arrêt…',
  'toolbar.shortOpen': 'Ouvrir',
  'toolbar.shortSave': 'Enregistrer',
  'toolbar.shortFit': 'Ajuster',
  'toolbar.shortSettings': 'Paramètres',
  'toolbar.shortAssistant': 'Assistant',
  'toolbar.shortLanguage': 'Langue',
  'toolbar.shortTheme': 'Thème',
  'toolbar.shortSidebar': 'Panneau',
  'toolbar.startTitle': 'Démarrer une capture sur l’appareil connecté',
  'toolbar.stopTitle': 'Arrêter la capture en cours',
  'toolbar.stoppingTitle': 'En attente de l’annulation des transferts USB en cours',
  'toolbar.openTitle': 'Charger une session sigrok .sr ou un .lwcap',
  'toolbar.saveTitle': 'Enregistrer cette capture en .lwcap',
  'toolbar.fitTitle': 'Zoomer sur toute la capture',
  'toolbar.sidebarTitle': 'Choisir le panneau latéral droit',
  'toolbar.themeTitle': 'Changer de thème',
  'toolbar.languageTitle': 'Choisir la langue',
  'toolbar.switchGroup': 'Langue et thème',
  'toolbar.assistantTitle': 'Assistant IA',
  'toolbar.sidebarDevice': 'Appareil et réglages de capture',
  'toolbar.sidebarAnalyzers': 'Analyseurs de protocole',
  'toolbar.sidebarAssistant': 'Assistant IA',
  'toolbar.sidebarNone': 'Aucun panneau latéral',

  // ---------------------------------------------------------- side panel
  'panel.resizeLabel': 'Redimensionner la barre latérale',
  'panel.resizeTitle': 'Glisser pour redimensionner la barre latérale',

  // ---------------------------------------------------- capture title
  'capture.none': 'aucune capture',
  'capture.capturing': 'capture en cours : {channels} canaux @ {rate}',
  'capture.loaded': '{source} · chargé en {ms} ms',
  'capture.stoppedNoTrigger': 'pas de trigger · échantillons conservés : {samples}',
  'capture.live': 'capture en direct · échantillons : {samples} @ {rate} · {duration}',

  // ------------------------------------------------------------- status
  'status.summary': 'échantillons : {samples} @ {rate}',
  'status.total': 'total {duration}',
  'status.loop': '{kept} conservés · {total} au total',
  'status.view': 'vue {duration}',

  // -------------------------------------------------------- empty hint
  'emptyHint.line1': 'Aucune capture chargée.',
  'emptyHint.line2': 'Ouvrez un fichier .sr ou .lwcap, ou connectez un SLogic16/32 U3.',

  // ------------------------------------- error prefixes (App.fail sites)
  'error.render': 'rendu',
  'error.device': 'appareil',
  'error.openCapture': 'ouverture de capture',
  'error.save': 'enregistrement',
  'error.reconnect': 'reconnexion',
  'error.connect': 'connexion',
  'error.start': 'démarrage',
  'error.startCapture': 'démarrage de capture',
  'error.stopCapture': 'arrêt de capture',
  'error.dropoutAccounting': 'comptage des pertes',
  'error.decodeWorkerWarmup': 'préchauffage du worker de décodage',
  'error.decode': 'décodage {id}',
  'error.localeLoad': 'Impossible de charger le catalogue de langue',

  // ---------------------------------------- status error detail codes
  'diagnostic.ui.localeLoad': '« {locale} » n’a pas pu être chargé',
  'diagnostic.ui.axisContext': 'contexte 2D de l’axe indisponible',
  'diagnostic.ui.captureLocked':
    'les réglages oscilloscope du groupe sont verrouillés pendant une capture ou un arrêt',
  'diagnostic.io.nothingToSave': 'rien à enregistrer',
  'diagnostic.file.noFiles': 'aucun fichier sélectionné',
  'diagnostic.file.unsupported':
    'rien d’exploitable dans {names} ; une session sigrok .sr ou un .lwcap est attendu',
  'diagnostic.file.lwcap.header':
    '.lwcap tronqué : {bytes} octets, moins que l’en-tête de {need} octets',
  'diagnostic.file.lwcap.magic': 'ce n’est pas un fichier .lwcap (magic {magic})',
  'diagnostic.file.lwcap.channels':
    'le nombre de canaux {channels} n’est pas une largeur prise en charge ({widths})',
  'diagnostic.file.lwcap.length': 'longueur de capture invraisemblable {length}',
  'diagnostic.file.lwcap.samplerate':
    'fréquence d’échantillonnage invraisemblable dans le .lwcap : {samplerate}',
  'diagnostic.file.lwcap.namesTruncated':
    '.lwcap tronqué : le bloc de noms de {bytes} octets dépasse la fin du fichier',
  'diagnostic.file.lwcap.namesInvalid': 'noms de canaux invalides dans le .lwcap',
  'diagnostic.file.lwcap.gapTruncated':
    '.lwcap tronqué : le trou {index} dépasse la fin du fichier',
  'diagnostic.file.lwcap.gapSpan': 'intervalle de trou corrompu [{start}, {end}) dans {source}',
  'diagnostic.file.lwcap.gapOrder':
    'intervalles de trou qui se chevauchent ou désordonnés à l’index {index}',
  'diagnostic.file.lwcap.channelHeaders':
    '.lwcap tronqué : les en-têtes de canaux dépassent la fin du fichier',
  'diagnostic.file.lwcap.initial': '.lwcap corrompu : le canal {channel} démarre au niveau {level}',
  'diagnostic.file.lwcap.edgeBytes':
    'octets tronqués ou en trop dans le .lwcap ({actual} vs {expected})',
  'diagnostic.file.lwcap.edgeRange':
    '.lwcap corrompu : front {index} du canal {channel} = {value} hors de [1, {length})',
  'diagnostic.file.lwcap.edgeOrder':
    '.lwcap corrompu : les fronts du canal {channel} ne sont pas strictement croissants à l’index {index}',
  'diagnostic.file.sr.notZip': 'ce n’est pas une archive zip',
  'diagnostic.file.sr.multiDisk': 'les archives zip multi-disques ne sont pas prises en charge',
  'diagnostic.file.sr.corruptDirectory':
    'zip corrompu : le répertoire central dépasse l’enregistrement de fin de répertoire central',
  'diagnostic.file.sr.directoryBounds':
    'zip corrompu : l’entrée {index} du répertoire central dépasse le répertoire',
  'diagnostic.file.sr.zip64': 'les archives ZIP64 ne sont pas prises en charge',
  'diagnostic.file.sr.entrySignature':
    'zip corrompu : l’entrée centrale {index} n’a pas de signature',
  'diagnostic.file.sr.dataDescriptor':
    'le membre {member} utilise un descripteur de données, ce qui n’est pas pris en charge',
  'diagnostic.file.sr.memberZip64':
    'le membre {member} exige ZIP64, ce qui n’est pas pris en charge',
  'diagnostic.file.sr.compression':
    'le membre {member} utilise la méthode de compression {method} ; seuls stored et deflate sont pris en charge',
  'diagnostic.file.sr.noLocalHeader':
    'le membre {member} n’a pas d’en-tête local là où le répertoire l’indique',
  'diagnostic.file.sr.localHeaderBounds':
    'l’en-tête local du membre {member} dépasse la fin du fichier',
  'diagnostic.file.sr.memberPastEnd': 'le membre {member} dépasse la fin du fichier',
  'diagnostic.file.sr.memberSize': 'taille incohérente pour le membre {member}',
  'diagnostic.file.sr.inflateFailed': 'impossible de décompresser le membre {member}',
  'diagnostic.file.sr.inflateSize':
    'le membre {member} se décompresse en {actual} octets, le répertoire en annonce {expected}',
  'diagnostic.file.sr.noMetadata':
    '{source} n’a pas de membre metadata : ce n’est pas une session sigrok',
  'diagnostic.file.sr.duplicateCapturefile':
    'metadata contient deux capturefile dans une même section de périphérique',
  'diagnostic.file.sr.analogCapture':
    'capturefile {capturefile} n’est pas une unité logique ; les captures analogiques ne sont pas prises en charge',
  'diagnostic.file.sr.noCapturefile': 'aucun capturefile logique dans metadata',
  'diagnostic.file.sr.noSamplerate': 'aucune fréquence d’échantillonnage dans metadata',
  'diagnostic.file.sr.probes': 'total probes {probes} est hors de 1..128',
  'diagnostic.file.sr.analogChannels':
    'les canaux analogiques de cette capture ne sont pas pris en charge ({count} présents)',
  'diagnostic.file.sr.unitsize': 'unitsize {unitsize} est hors de 1..16 octets',
  'diagnostic.file.sr.unitsizeProbes':
    'unitsize {unitsize} ne peut pas contenir {probes} canaux',
  'diagnostic.file.sr.samplerate': 'fréquence d’échantillonnage illisible {value}',
  'diagnostic.file.sr.dataLength':
    'la longueur {bytes} n’est pas un nombre entier d’échantillons de {unitsize} octets',
  'diagnostic.file.sr.tooLong': 'capture trop longue ({samples} échantillons)',
  'diagnostic.file.sr.noData':
    '{source} n’a pas de membres de données pour capturefile {capturefile}',
  'diagnostic.device.transportDead': 'le transport USB est mort ({reason})',
  'diagnostic.device.disconnected': '{device} a été déconnecté',
  'diagnostic.device.workerUnavailable':
    'le worker USB d’arrière-plan n’est pas disponible dans ce navigateur',
  'diagnostic.device.workerCrashed': 'le worker USB a échoué',
  'diagnostic.device.workerTimeout':
    'le worker USB n’a pas répondu à « {kind} » en {ms} ms',
  'diagnostic.device.workerNoDevice': 'le worker USB n’a signalé aucun appareil',
  'diagnostic.device.workerTerminated': 'le transport du worker USB a été arrêté',
  'diagnostic.device.workerNoStats': 'le worker USB a répondu sans statistiques',
  'diagnostic.device.workerNoConsole': 'le worker USB a répondu sans résultat de console',
  'diagnostic.device.workerUnclaimed':
    'le worker USB a répondu « {kind} » alors que personne n’attendait',
  'diagnostic.device.stopTimedOut':
    'la capture ne s’est pas arrêtée en {ms} ms ; le transport USB a été réinitialisé',
  'diagnostic.device.loopUnsettled':
    'la boucle de lecture de la capture précédente ne s’est jamais terminée après la libération de l’interface',
  'diagnostic.device.loopUnsettledClosed':
    'la boucle de lecture ne s’est jamais terminée après la libération de l’interface, le descripteur de l’appareil a donc été fermé',
  'diagnostic.device.reclaimFailed':
    'l’interface n’a pas pu être reconquise après l’annulation de la capture, l’appareil a donc été fermé',
  'diagnostic.device.unsupportedChannels':
    'nombre de canaux {channels} non pris en charge ; cet appareil propose {offered}',
  'diagnostic.device.unknownWidth':
    'l’appareil a annoncé un nombre de canaux non pris en charge : {channels}',
  'diagnostic.device.unsupportedSamplerate':
    'fréquence d’échantillonnage {samplerate} Hz non prise en charge ; l’appareil propose {offered}',
  'diagnostic.device.rateCeiling':
    '{rate} MHz dépasse le plafond de {ceiling} MHz pour {channels} canaux',
  'diagnostic.device.threshold': 'le seuil doit être un nombre, reçu {threshold}',
  'diagnostic.device.thresholdClips': 'le seuil {volts} V écrête le DAC (code {code})',
  'diagnostic.device.testMode': 'le mode de test doit être 0, 1 ou 2, reçu {mode}',
  'diagnostic.device.tuningPacket':
    'transferBytes {bytes} n’est pas un multiple de la taille de paquet de {packet} octets',
  'diagnostic.device.tuningDepth':
    'la profondeur de transfert {depth} est inférieure aux 4 nécessaires pour que l’appareil ne déborde pas',
  'diagnostic.device.tuningTransfer':
    'transferBytes {bytes} dépasse la limite de {limit} octets de Chromium WebUSB',
  'diagnostic.device.tuningQueue':
    'la file de transferts {depth} x {bytes} B dépasse le budget usbfs sûr de {budget} octets ; augmentez usbfs_memory_mb et queueBudgetBytes ensemble',
  'diagnostic.device.startRunning':
    'start() appelé alors qu’une capture est déjà en cours',
  'diagnostic.device.startStopping':
    'start() appelé avant la fin de l’arrêt de la capture précédente',
  'diagnostic.device.startBeforeOpen': 'start() appelé avant open()',
  'diagnostic.device.triggerLimitConflict':
    'softwareTrigger et deviceSampleLimit s’excluent ; bornez une capture déclenchée avec softwareTrigger.maxSamples',
  'diagnostic.device.coalescePacket':
    'coalesceBytes {bytes} n’est pas un multiple de la taille d’échantillon de {packet} octets',
  'diagnostic.device.triggerWidth':
    'la largeur du déclencheur logiciel {width} ne correspond pas à la largeur de capture {channels}',
  'diagnostic.device.bulkStatus': 'bulk IN a renvoyé le statut « {status} »',
  'diagnostic.device.bulkEmpty': 'bulk IN n’a renvoyé aucune donnée avec le statut « ok »',
  'diagnostic.device.consoleBusy':
    'la console USB est indisponible pendant une capture en cours ou en cours d’arrêt',
  'diagnostic.device.notOpen': 'l’appareil n’est pas ouvert',
  'diagnostic.device.notConnected': 'aucun appareil connecté',
  'diagnostic.device.noConsole': 'cet appareil n’expose pas de console USB',
  'diagnostic.device.sampleAccounting':
    'l’appareil compte {counted} échantillons livrés, le stockage en contient {stored}',
  'diagnostic.device.noData':
    '{device} n’a envoyé aucune donnée dans les {deadline} ms suivant RUN ({channels} canaux @ {rate} MHz). Une carte dans cet état répond à chaque transfert de contrôle et n’envoie rien sur le point de terminaison bulk : débranchez-la et rebranchez-la.',
  'diagnostic.device.underrunStalled':
    '{device} a saturé l’hôte : {channels} canaux @ {rate} MHz offrent {offered} Mo/s mais {count} transferts consécutifs ont pris {transferMs} ms pour {bytes} B (limite {limitMs} ms), {avg} Mo/s en moyenne sur {runMs} ms (minimum {minimum} Mo/s). Capture interrompue avant que le débordement de la FIFO de l’appareil ne bloque le point de terminaison. Le thread {thread} a été bloqué {stalls} fois pendant la capture, au pire {worstMs} ms à {atMs} ms ; la file couvre {coverMs} ms.',
  'diagnostic.device.underrunClean':
    '{device} a saturé l’hôte : {channels} canaux @ {rate} MHz offrent {offered} Mo/s mais {count} transferts consécutifs ont pris {transferMs} ms pour {bytes} B (limite {limitMs} ms), {avg} Mo/s en moyenne sur {runMs} ms (minimum {minimum} Mo/s). Capture interrompue avant que le débordement de la FIFO de l’appareil ne bloque le point de terminaison. Le thread {thread} n’a jamais été bloqué plus de {thresholdMs} ms, c’est donc l’appareil ou le chemin USB.',
  'diagnostic.device.openFailed': 'impossible d’ouvrir l’appareil USB',
  'diagnostic.device.configureFailed':
    'impossible de sélectionner la configuration de l’appareil',
  'diagnostic.device.claimFailed': 'impossible de revendiquer l’interface 0',
  'diagnostic.device.controlReadTimeout':
    'la lecture du registre {addr} ne s’est pas terminée en {ms} ms ; la carte a cessé de répondre aux transferts de contrôle',
  'diagnostic.device.controlWriteTimeout':
    'l’écriture dans le registre {addr} ne s’est pas terminée en {ms} ms ; la carte a cessé de répondre aux transferts de contrôle',
  'diagnostic.device.controlWriteStatus':
    'l’écriture dans le registre {addr} a renvoyé le statut « {status} »',
  'diagnostic.device.controlWriteLength':
    'l’écriture dans le registre {addr} a transmis {bytes} octets, 4 attendus',
  'diagnostic.device.controlReadStatus':
    'la lecture du registre {addr} a renvoyé le statut « {status} »',
  'diagnostic.device.controlReadLength':
    'la lecture du registre {addr} a renvoyé {bytes} octets, 4 attendus',
  'diagnostic.device.controlRequestTimeout':
    'la requête {request} de la console USB ne s’est pas terminée en {ms} ms ; la carte a cessé de répondre aux transferts de contrôle',
  'diagnostic.device.registerStuck':
    '{where}={wanted} ne s’est jamais maintenu sur {cycles} cycles lecture/écriture/lecture ({wrote} écrit, {readBack} relu)',
  'diagnostic.device.sampleLengthRejected':
    'longueur d’échantillonnage refusée : {value} écrit, {readBack} relu (comparaison sur les octets annoncés : {advertised})',
  'diagnostic.device.auxReadyTimeout':
    'sélecteur aux {selector} : bit de disponibilité jamais armé après {reads} lectures',
  'diagnostic.device.auxEcho': 'sélecteur aux {selector} : l’appareil a renvoyé l’écho {echoed}',
  'diagnostic.device.auxZeroLength':
    'sélecteur aux {selector} : l’appareil a annoncé une charge utile de longueur nulle',
  'diagnostic.device.auxValueTooWide':
    'sélecteur aux {selector} : la valeur {value} ne tient pas dans les octets annoncés pour le mot de charge utile {word} ({advertised})',
  'diagnostic.device.auxWordOutside':
    'sélecteur aux {selector} : le mot de charge utile {word} est entièrement hors de la charge utile de {bytes} octets annoncée',
  'diagnostic.device.auxFieldOutside':
    'sélecteur aux {selector} : le champ se termine à l’octet de charge utile {endByte} mais l’appareil n’accepte que {accepted} octets',
  'diagnostic.device.channelMaskRejected':
    'masque de canaux refusé : {mask} écrit, {readBack} relu (comparaison sur les octets annoncés : {advertised})',
  'diagnostic.device.channelMaskRejectedPadded':
    'masque de canaux refusé : {mask} écrit, {readBack} relu (comparaison sur le mot complet de quatre octets, remplissage compris)',
  'diagnostic.device.sampleratePayload':
    'la charge utile aux de fréquence d’échantillonnage fait {bytes} octets, il en faut au moins 8 pour le diviseur',
  'diagnostic.device.samplerateStuck':
    'impossible de configurer {rate} MHz sur base[{index}] = {base} MHz : le diviseur ne s’est jamais maintenu sur {cycles} cycles lecture/écriture/lecture ({wrote} écrit, {readBack} relu, horloge de base avant l’écriture {before} MHz)',
  'diagnostic.device.samplerateBaseChanged':
    'impossible de configurer {rate} MHz : l’horloge de base est passée de {before} MHz à {after} MHz (diviseur {divider} écrit, l’appareil a répondu indice {index}) sur {cycles} cycles lecture/écriture/lecture',
  'diagnostic.device.samplerateAnswered':
    'impossible de configurer {rate} MHz : diviseur {wrote} écrit sur l’horloge de base {before} MHz, l’appareil a répondu indice {index}, base {after} MHz, diviseur {readBack} sur {cycles} cycles lecture/écriture/lecture',
  'diagnostic.device.samplerateNotDivided':
    'impossible de configurer {rate} MHz : base[{index}] = {baseMHz} MHz ne la divise pas ({count} bases vérifiées ; l’indice {maxIndex} est le dernier qui existe)',
  'diagnostic.device.samplerateNotExpressible':
    'impossible de configurer {rate} MHz : base[{index}] = {baseMHz} MHz exige un diviseur de {divider}, au-delà des {maxDivider} que l’échantillonneur honore ({count} bases vérifiées ; l’indice {maxIndex} est le dernier qui existe)',
  'diagnostic.device.samplerateUnwalked':
    'impossible de configurer {rate} MHz : le diviseur ne s’est jamais maintenu et aucune horloge de base n’est devenue utilisable en {passes} passes',
  'diagnostic.device.thresholdRejected':
    'seuil refusé : code {code} écrit, {readBack} relu (comparaison sur les octets annoncés : {advertised})',
  'diagnostic.device.testModeRejected':
    'mode de test refusé : {mode} écrit, {readBack} relu (comparaison sur les octets annoncés : {advertised})',
  'diagnostic.usb.unavailable': 'WebUSB n’est pas disponible dans ce navigateur',
  'diagnostic.usb.blocked': 'le navigateur a bloqué l’accès aux appareils USB',
  'diagnostic.usb.notVisible':
    'l’appareil {vendor}:{product} n’est pas visible pour le worker USB ; accordez-le d’abord depuis la page',
  'diagnostic.decode.cancelled': 'décodage annulé',
  'diagnostic.decode.noCapture': 'aucune capture à décoder',
  'diagnostic.decode.channelOutOfRange':
    'le canal {channel} ne fait pas partie de cette capture ({channels} canaux)',
  'diagnostic.decode.timeout': 'le décodage a dépassé {ms} ms et a été annulé',
  'diagnostic.decode.disposed': 'le worker de décodage a été retiré',
  'diagnostic.decode.workerCrashed': 'le worker de décodage a échoué',
  'diagnostic.decode.workerFailed': 'le décodeur a échoué',
  'diagnostic.decode.workerUnexpected':
    'le worker de décodage a répondu {got}, alors que {want} était attendu',
  'diagnostic.decode.terminated': 'le worker de décodage a été arrêté',
  'diagnostic.decode.tooLong':
    'la capture compte {samples} échantillons ; le décodage est limité à {max} ({window} à 200 MSa/s). Décodez plutôt une sous-plage.',
  'diagnostic.decode.tooLongLoop':
    'la capture compte {samples} échantillons ; le décodage est limité à {max} ({window} à 200 MSa/s). Réduisez plutôt la fenêtre de boucle.',
  'diagnostic.decode.edgeBudget':
    '{edges} fronts sur les canaux mappés dépassent le budget de décodage de {budget}. Désactivez un canal ou réduisez la capture.',
  'diagnostic.decode.edgeBudgetLoop':
    '{edges} fronts sur les canaux mappés dépassent le budget de décodage de {budget}. Désactivez un canal ou réduisez la fenêtre de boucle.',
  'diagnostic.render.contextLost': 'le contexte WebGL a été perdu, le moteur de rendu est hors service',

  // -------------------------------------------------------- hover readout
  'hover.width': 'Largeur : {duration}',
  'hover.widthInv': 'largeur⁻¹ : {freq}',
  'hover.freq': 'Fréquence : {freq}',
  'hover.duty': 'Rapport cyclique : {pct} %',
  'hover.noTransition': 'aucune transition visible',

  // ---------------------------------------------------- trigger summary
  'trigger.level': 'Niveau {level}',
  'trigger.rising': 'Front montant',
  'trigger.falling': 'Front descendant',
  'trigger.anyEdge': 'Front quelconque',
  'trigger.summary': '{condition} · pré-trigger {pct} %',
  'trigger.summaryAnd': '{condition} · pré-trigger {pct} % · ET sur {count} conditions',

  // -------------------------------------------------------- channel list
  'channels.settings': 'Paramètres de D{index}',
  'channels.resetName': 'Rétablir le nom D{index}',
  'channels.name': 'Nom du canal',
  'channels.color': 'Couleur du canal',
  'channels.customColor': 'Couleur personnalisée',
  'channels.colorField': 'Saturation et luminosité',
  'channels.hue': 'Teinte',
  'channels.triggerMode': 'Mode de trigger',
  'channels.cancel': 'Annuler',
  'channels.removeAnalyzer': 'Retirer {label}',
  'channels.triggerHigh': 'Niveau haut',
  'channels.triggerLow': 'Niveau bas',
  'channels.triggerAny': 'Valeur quelconque (X)',

  // ------------------------------------------------------- capture panel
  'capturePanel.digital': 'Canaux numériques',
  'capturePanel.channelWidth': 'Largeur des canaux',
  'capturePanel.channelWidthBusy': 'La largeur des canaux est verrouillée pendant une capture',
  'capturePanel.oscilloscopeConfig': '{range} : configuration de l’oscilloscope analogique — {state}',
  'capturePanel.oscilloscopeEnabled': 'activé',
  'capturePanel.oscilloscopeDisabled': 'désactivé',
  'capturePanel.channelLocked': '{name} : activé et verrouillé par l’oscilloscope analogique {range}',
  'capturePanel.oscilloscopeActive': 'Oscilloscope analogique activé',
  'capturePanel.sampleRate': 'Fréquence d’échantillonnage',
  'capturePanel.threshold': 'Seuil',
  'capturePanel.dacNote': 'Code DAC {code} = {volts} V réel. Largeur de capture : {channels} CH (plafond {rate}).',
  'capturePanel.capture': 'Capture',
  'capturePanel.modeSingle': 'Unique',
  'capturePanel.modeRepeat': 'Répéter',
  'capturePanel.modeLoop': 'Boucle',
  'capturePanel.statusReady': 'Prêt',
  'capturePanel.statusCapturing': 'Acquisition',
  'capturePanel.statusStopping': 'Arrêt',
  'capturePanel.statusWaiting': 'En attente',
  'capturePanel.statusCompleted': 'Terminé',
  'capturePanel.statusReadyDetail': 'Prêt à acquérir',
  'capturePanel.statusFiniteDetail': 'Acquisition finie en cours',
  'capturePanel.statusUnlimitedDetail': 'Acquisition illimitée en cours ; arrêtez quand vous avez terminé',
  'capturePanel.statusLoopDetail': 'Acquisition en boucle en cours ; la dernière fenêtre est conservée',
  'capturePanel.statusStoppingDetail': 'Arrêt en cours ; la vue actuelle est conservée',
  'capturePanel.statusWaitingDetail': 'Nouvelle acquisition dans {interval}. Arrêtez pour annuler ; la vue est conservée.',
  'capturePanel.statusCompletedDetail': '{samples} échantillons · {duration}',
  'capturePanel.progress': 'Progression de l’acquisition',
  'capturePanel.unlimited': 'Illimité',
  'capturePanel.duration': 'Durée',
  'capturePanel.repeatInterval': 'Répéter toutes les',
  'capturePanel.loopRetention': 'Fenêtre retenue',
  'capturePanel.timeUnit': 'Unité',
  'capturePanel.loopWindow': 'Fenêtre {kept} / {limit} échantillons · {dropped} abandonnés',
  'capturePanel.loopWindowLimit': 'Plafond de fenêtre : {samples} échantillons = {duration} à {rate}.',
  'capturePanel.singleFiniteNote': 'Acquisition finie jusqu’à {max} {unit} ; faites glisser vers le segment droit pour Illimité.',
  'capturePanel.singleUnlimitedNote': 'Acquisition illimitée ; le brouillon de durée finie et l’unité sont conservés.',
  'capturePanel.repeatFiniteNote': 'Acquisition finie jusqu’à {max} {unit} ; chaque cycle terminé attend l’intervalle de répétition.',
  'capturePanel.softwareTrigger': 'Trigger logiciel',
  'capturePanel.enableTrigger': 'Activer le trigger logiciel',
  'capturePanel.noPreTrigger': 'Sans pré-trigger',
  'capturePanel.preTriggerBuffer': 'Tampon de pré-trigger',
  'capturePanel.noCondition': 'Aucune condition définie — la capture tournera sans trigger. Cliquez sur le bouton de paramètres d’une ligne de canal (colonne de gauche) et choisissez un front ou un niveau.',
  'capturePanel.condHigh': 'haut',
  'capturePanel.condLow': 'bas',
  'capturePanel.condRising': 'montant',
  'capturePanel.condFalling': 'descendant',
  'capturePanel.condEdge': 'front',
  'capturePanel.condJoiner': ' ET ',
  'capturePanel.armed': 'Armé : {what}. T=0 au trigger ; jusqu’à {duration} avant lui est conservé en temps négatif.',
  'capturePanel.armedCapped': 'Armé : {what}. T=0 au trigger ; jusqu’à {duration} avant lui est conservé en temps négatif (plafonné par le tampon de pré-trigger de {megabytes} Mio).',
  'capturePanel.waitingTrigger': 'En attente de la condition de trigger…',
  'capturePanel.triggered': 'Trigger détecté — enregistrement de la fenêtre post-trigger.',
  'capturePanel.triggerNotFound': 'Arrêté sans trigger ; rien n’a été enregistré.',
  'capturePanel.recording': 'Enregistrement {seconds} s · échantillons : {samples} · {megabytes} Mo',
  'capturePanel.dropped': 'échantillons perdus lors de pertes de données (marqués comme lacunes) : {samples}',
  'capturePanel.cursors': 'Curseurs',
  'capturePanel.cursorEmpty': 'Double-cliquez sur la forme d’onde pour placer un curseur.',
  'capturePanel.cursorFormat': 'temps / échantillons',
  'capturePanel.removeCursor': 'Supprimer le curseur {label}',
  'capturePanel.focusCursor': 'Centrer la vue sur le curseur {label}',
  'capturePanel.cursorDistance': 'Distance entre curseurs',
  'capturePanel.cursorDistanceFormat': 'Δtemps/Δéchantillons',
  'capturePanel.cursorDistanceEmpty': 'Placez deux curseurs sur la forme d’onde pour lire la distance entre eux.',
  'capturePanel.cursorDistanceNoRows': 'Ajoutez une ligne pour comparer deux curseurs.',
  'capturePanel.cursorDistanceAdd': 'Ajouter une ligne de distance',
  'capturePanel.cursorDistanceRemove': 'Supprimer la ligne de distance {row}',
  'capturePanel.cursorDistanceStart': 'Choisir le premier curseur de la ligne {row}',
  'capturePanel.cursorDistanceEnd': 'Choisir le second curseur de la ligne {row}',
  'capturePanel.cursorDistanceUnset': 'non défini',
  'capturePanel.cursorEdges': 'Fronts',
  'capturePanel.cursorEdgesFormat': 'Montants/Descendants/Fronts',
  'capturePanel.cursorEdgesEmpty': 'Placez deux curseurs sur la forme d’onde pour compter les fronts entre eux.',
  'capturePanel.cursorEdgesNoRows': 'Ajoutez une ligne pour compter les fronts entre deux curseurs.',
  'capturePanel.cursorEdgesAdd': 'Ajouter une ligne de fronts',
  'capturePanel.cursorEdgesRemove': 'Supprimer la ligne de fronts {row}',
  'capturePanel.cursorEdgesStart': 'Choisir le premier curseur de la ligne de fronts {row}',
  'capturePanel.cursorEdgesEnd': 'Choisir le second curseur de la ligne de fronts {row}',
  'capturePanel.cursorEdgesChannel': 'Choisir le canal de la ligne de fronts {row}',
  'capturePanel.cursorEdgesUnset': '–',
  'capturePanel.advanced': 'Avancé',
  'capturePanel.testMode': 'Mode de test de l’appareil (prochaine capture)',
  'capturePanel.testNormal': 'Normal',
  'capturePanel.testSimulator': 'Simulateur',
  'capturePanel.testUsbMax': 'USB MAX SPEED',
  'capturePanel.usbConsole': 'Console de contrôle USB',
  'capturePanel.usbPlaceholder': 'read 0x000c 4',
  'capturePanel.usbSend': 'Envoyer',
  'capturePanel.usbHelp': 'Commandes : read <addr> [len], write <addr> <byte>..., ctrl <value>, flags, clear-fifo, in <request> <value> <index> <len>, out <request> <value> <index> [byte]...',
  'capturePanel.consoleSeed': 'Tapez help pour les commandes. Nombres décimaux ou hexadécimaux préfixés 0x.',
  'capturePanel.consoleError': 'erreur : {detail}',

  // ------------------------------------------------------ analyzer panel
  'analyzerPanel.title': 'Analyseurs',
  'analyzerPanel.subWarm': 'décodeurs sigrok fournis : {count}. Worker prêt.',
  'analyzerPanel.subCold': 'décodeurs sigrok fournis : {count}. Worker en préchauffage (~850 ms, une fois par session).',
  'analyzerPanel.decoding': 'décodage…',
  'analyzerPanel.attached': 'Attachés',
  'analyzerPanel.decodeAction': 'Décoder {label}',
  'analyzerPanel.removeAction': 'Retirer {label}',
  'analyzerPanel.cancelDecode': 'Annuler le décodage',
  'analyzerPanel.add': 'Ajouter',
  'analyzerPanel.decoder': 'Décodeur',
  'analyzerPanel.decoderSearchLabel': 'Rechercher un protocole',
  'analyzerPanel.decoderSearchPlaceholder': 'Tapez pour filtrer les protocoles',
  'analyzerPanel.decoderNoMatch': 'Aucun protocole ne correspond à « {query} »',
  'analyzerPanel.stacked': '{id} consomme {inputs} et doit donc être empilé sur un producteur. L’empilement n’est pas exposé dans ce panneau.',
  'analyzerPanel.optionalSuffix': ' (optionnel)',
  'analyzerPanel.attach': 'Attacher',
  'analyzerPanel.loadFirst': 'Chargez ou enregistrez d’abord une capture ; un décodeur a besoin de fronts à lire.',

  // ----------------------------- analyzer status notes (formatted at render)
  'analyzerNote.pending': 'non décodé',
  'analyzerNote.edges': 'fronts : {count}',
  'analyzerNote.stats': 'annotations : {anns}, {decodeMs} ms ({wallMs} ms réelles)',
  'analyzerNote.snapshot': 'instantané d’une boucle en cours - ne suit pas la capture',
  'analyzerNote.timeout': 'expiré',
  'analyzerNote.cancelled': 'annulé',

  // ---------------------------------------------------- parallel bus / ADC
  'bus.title': 'Bus parallèle / CAN',
  'bus.sub': 'Combine les lignes de données en une valeur et la trace comme une forme d’onde analogique.',
  'bus.attached': 'Vues de bus',
  'bus.add': 'Ajouter une vue de bus',
  'bus.edit': 'Modifier la vue de bus',
  'bus.name': 'Nom',
  'bus.bankDialogTitle': '{range} : mode oscilloscope',
  'bus.defaultName': 'Forme d’onde analogique',
  'bus.enableBank': 'Activer le mode oscilloscope',
  'bus.channelOrder': 'Canaux et ordre de décodage',
  'bus.confirm': 'Confirmer',
  'bus.bits': 'Bits',
  'bus.start': 'Canal de départ',
  'bus.perBit': 'Attribuer chaque bit',
  'bus.swap': 'Inverser MSB/LSB',
  'bus.swapShort': 'MSB↔LSB',
  'bus.msbFirst': 'Le canal de départ est le MSB',
  'bus.bit': 'Bit {k}',
  'bus.bitLsb': 'Bit {k} (LSB)',
  'bus.bitMsb': 'Bit {k} (MSB)',
  'bus.clock': 'Horloge',
  'bus.clockNone': 'Aucune (tout changement de bit)',
  'bus.edge': 'Verrouiller sur',
  'bus.edgeRising': 'Front montant',
  'bus.edgeFalling': 'Front descendant',
  'bus.encoding': 'Codage',
  'bus.encUnsigned': 'Non signé',
  'bus.encTwos': 'Complément à deux',
  'bus.encOffset': 'Binaire décalé',
  'bus.fullScale': 'Pleine échelle (V)',
  'bus.offset': 'Décalage (V)',
  'bus.scaleHint': 'Laissez la pleine échelle vide pour afficher les valeurs brutes. Volts = décalage + valeur / 2^n × pleine échelle.',
  'bus.style': 'Tracer en',
  'bus.styleLine': 'Ligne',
  'bus.styleStep': 'Paliers',
  'bus.height': 'Hauteur de ligne',
  'bus.hideSources': 'Masquer les lignes des bits sources',
  'bus.addButton': 'Ajouter',
  'bus.save': 'Enregistrer',
  'bus.cancel': 'Annuler',
  'bus.editButton': 'Modifier',
  'bus.remove': 'Supprimer',
  'bus.building': 'construction de l’aperçu {pct} %',
  'bus.liveNote': 'Zoomez pour voir le bus pendant une capture',
  'bus.badChannels': 'Cette capture ne contient pas tous les canaux du bus',
  'bus.unknown': 'inconnu',
  'bus.code': 'valeur',

  // ------------------------------------------------------- AI assistant
  'assistant.title': 'Assistant IA',
  'assistant.settings': 'Réglages',
  'assistant.newChat': 'Nouvelle discussion',
  'assistant.new': 'Nouveau',
  'assistant.provider': 'Fournisseur',
  'assistant.providerClaude': 'Claude',
  'assistant.providerOpenai': 'Compatible OpenAI',
  'assistant.preset': 'Préréglage',
  'assistant.presetCustom': 'Personnalisé',
  'assistant.baseUrl': 'URL de base',
  'assistant.baseUrlHint': 'Laissez l’URL de base vide pour le point d’accès officiel. S’il est inaccessible depuis votre réseau, indiquez ici un relais d’API ou un proxy inverse, ou activez un proxy système ou navigateur. Une page web ne peut pas utiliser seule un proxy HTTP ou SOCKS5.',
  'assistant.apiKey': 'Clé API',
  'assistant.keyHint': 'La clé reste dans ce navigateur et n’est envoyée qu’à l’URL de base ci-dessus. Sans « mémoriser », elle est oubliée à la fermeture de l’onglet.',
  'assistant.rememberKey': 'Mémoriser la clé sur cet appareil',
  'assistant.model': 'Modèle',
  'assistant.modelPlaceholder': 'nom du modèle selon votre fournisseur',
  'assistant.noticeTitle': 'Avant de commencer',
  'assistant.notice': 'Vos messages et les résumés de capture que l’assistant lit avec ses outils (réglages, statistiques de fronts, données décodées) sont envoyés au fournisseur choisi, selon ses conditions. Rien d’autre ne quitte cette page. Modifier les réglages ou lancer une capture demande toujours votre accord.',
  'assistant.noticeAccept': 'J’ai compris',
  'assistant.placeholder': 'Posez une question sur vos signaux… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)',
  'assistant.send': 'Envoyer',
  'assistant.stop': 'Arrêter',
  'assistant.needKey': 'Saisissez d’abord une clé API dans les réglages.',
  'assistant.needModel': 'Saisissez d’abord un nom de modèle dans les réglages.',
  'assistant.empty': 'Demandez-moi de capturer, mesurer ou décoder des signaux. Par exemple :',
  'assistant.suggest1': 'Quels canaux sont actifs, et à quelles fréquences ?',
  'assistant.suggest2': 'Trouve l’UART dans cette capture et décode-le.',
  'assistant.suggest3': 'Prépare une capture de 1 s à 10 MHz sur D0-D3 et lance-la.',
  'assistant.thinking': 'Réflexion',
  'assistant.toolRunning': 'en cours…',
  'assistant.toolPending': 'en attente de votre accord',
  'assistant.toolDone': 'terminé',
  'assistant.toolError': 'échec',
  'assistant.toolDeclined': 'refusé',
  'assistant.approveTitle': 'L’assistant veut exécuter ceci. L’autoriser ?',
  'assistant.allow': 'Autoriser',
  'assistant.deny': 'Refuser',
  'assistant.allowAlways': 'Tout autoriser dans cette discussion',
  'assistant.result': 'Résultat',
  'assistant.newConversation': 'Les réglages ont changé : une nouvelle conversation commence ici.',
  'assistant.stopped.aborted': 'Arrêté.',
  'assistant.stopped.refusal': 'Le modèle a refusé de répondre{detail}.',
  'assistant.stopped.max_tokens': 'La réponse a atteint la limite de longueur.',
  'assistant.stopped.max_turns': 'Arrêté après de nombreuses étapes d’outils. Envoyez un message pour continuer.',
  'assistant.stopped.other': 'Le modèle s’est arrêté{detail}.',
  'assistant.error.auth': 'La clé API a été refusée ({status}). Vérifiez la clé et le fournisseur.',
  'assistant.error.rate': 'Le fournisseur limite le débit ({status}). Patientez un instant puis réessayez.',
  'assistant.error.network': 'Impossible de joindre {url}. Vérifiez l’URL de base, le réseau ou le proxy. Certains fournisseurs refusent les requêtes venant de pages web (CORS) ; un relais d’API aide dans ce cas.',
  'assistant.error.invalid': 'Le fournisseur a refusé la requête ({status}). Vérifiez le nom du modèle et l’URL de base.',
  'assistant.error.server': 'Le fournisseur a signalé une erreur ({status}). Réessayez.',
  'assistant.error.other': 'La requête a échoué.',
  'assistant.error.load': 'Impossible de charger le client Claude.',

  // -------------------------------------------------------- settings menu
  'settings.title': 'Paramètres',
  'settings.titleHint': 'Préférences d’affichage',
  'settings.detailedLabels': 'Libellés détaillés',
  'settings.language': 'Langue',
  'settings.theme': 'Thème',

  // ------------------------------------------------------------ theme
  'theme.default': 'Par défaut',
  'theme.dark': 'Sombre',
  'theme.light': 'Clair',
  'theme.system': 'Système',
};

export { frDecoder } from './decoder/fr.js';
