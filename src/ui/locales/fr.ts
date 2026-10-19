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
  'toolbar.demo': 'Démo',
  'toolbar.open': 'Ouvrir…',
  'toolbar.save': 'Enregistrer',
  'toolbar.fit': 'Ajuster',
  'toolbar.startTitle': 'Démarrer une capture sur l’appareil connecté',
  'toolbar.stopTitle': 'Arrêter la capture en cours',
  'toolbar.stoppingTitle': 'En attente de l’annulation des transferts USB en cours',
  'toolbar.demoTitle': 'Charger la capture de démonstration des protocoles I2C, SPI et UART',
  'toolbar.demoLoading': 'Chargement de la démonstration…',
  'toolbar.openTitle': 'Charger une session sigrok .sr ou un .lwcap',
  'toolbar.saveTitle': 'Enregistrer cette capture en .lwcap',
  'toolbar.fitTitle': 'Zoomer sur toute la capture',
  'toolbar.sidebarTitle': 'Choisir le panneau latéral droit',
  'toolbar.sidebarDevice': 'Appareil et réglages de capture',
  'toolbar.sidebarAnalyzers': 'Analyseurs de protocole',
  'toolbar.sidebarNone': 'Aucun panneau latéral',

  // ---------------------------------------------------------- side panel
  'panel.resizeLabel': 'Redimensionner la barre latérale',
  'panel.resizeTitle': 'Glisser pour redimensionner la barre latérale',

  // ---------------------------------------------------- capture title
  'capture.none': 'aucune capture',
  'capture.capturing': 'capture en cours : {channels} canaux @ {rate}',
  'capture.loaded': '{source} · chargé en {ms} ms',
  'capture.demo': 'démonstration de protocoles',
  'capture.stoppedNoTrigger': 'pas de trigger · échantillons conservés : {samples}',
  'capture.live': 'capture en direct · échantillons : {samples} @ {rate} · {duration}',

  // ------------------------------------------------------------- status
  'status.summary': 'échantillons : {samples} @ {rate}',
  'status.total': 'total {duration}',
  'status.view': 'vue {duration}',

  // -------------------------------------------------------- empty hint
  'emptyHint.line1': 'Aucune capture chargée.',
  'emptyHint.line2': 'Ouvrez un fichier .sr ou .lwcap, ou connectez un SLogic16/32 U3.',

  // ------------------------------------- error prefixes (App.fail sites)
  'error.render': 'rendu',
  'error.device': 'appareil',
  'error.openCapture': 'ouverture de capture',
  'error.demo': 'démo',
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
  'channels.triggerMode': 'Mode de trigger',
  'channels.cancel': 'Annuler',
  'channels.removeAnalyzer': 'Retirer {label}',
  'channels.triggerHigh': 'Niveau haut',
  'channels.triggerLow': 'Niveau bas',
  'channels.triggerAny': 'Valeur quelconque (X)',

  // ------------------------------------------------------- capture panel
  'capturePanel.digital': 'Canaux numériques',
  'capturePanel.all': 'Tous',
  'capturePanel.clear': 'Aucun',
  'capturePanel.sampleRate': 'Fréquence d’échantillonnage',
  'capturePanel.threshold': 'Seuil',
  'capturePanel.dacNote': 'Code DAC {code} = {volts} V réel. Largeur de capture : {channels} canaux (plafond {rate}).',
  'capturePanel.capture': 'Capture',
  'capturePanel.freeRun': 'Marche libre',
  'capturePanel.timer': 'Minuteur',
  'capturePanel.durationS': 'Durée (s)',
  'capturePanel.ceilingNote': 'Plafond : {samples} échantillons = {duration} à {rate}. Une marche libre s’y arrête d’elle-même.',
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
  'analyzerPanel.decode': 'Décoder',
  'analyzerPanel.remove': 'Retirer',
  'analyzerPanel.cancelDecode': 'Annuler le décodage',
  'analyzerPanel.add': 'Ajouter',
  'analyzerPanel.decoder': 'Décodeur',
  'analyzerPanel.stacked': '{id} consomme {inputs} et doit donc être empilé sur un producteur. L’empilement n’est pas exposé dans ce panneau.',
  'analyzerPanel.optionalSuffix': ' (optionnel)',
  'analyzerPanel.attach': 'Attacher',
  'analyzerPanel.loadFirst': 'Chargez ou enregistrez d’abord une capture ; un décodeur a besoin de fronts à lire.',

  // ----------------------------- analyzer status notes (formatted at render)
  'analyzerNote.pending': 'non décodé',
  'analyzerNote.edges': 'fronts : {count}',
  'analyzerNote.stats': 'annotations : {anns}, {decodeMs} ms ({wallMs} ms réelles)',
  'analyzerNote.timeout': 'expiré',
  'analyzerNote.cancelled': 'annulé',

  // -------------------------------------------------------- settings menu
  'settings.title': 'Paramètres',
  'settings.titleHint': 'Langue et préférences d’affichage',
  'settings.language': 'Langue',
  'settings.theme': 'Thème',

  // ------------------------------------------------------------ theme
  'theme.default': 'Par défaut',
  'theme.dark': 'Sombre',
};
