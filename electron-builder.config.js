'use strict';

/**
 * Configurazione di packaging (electron-builder).
 *
 * Perché electron-builder e non Electron Forge? Vedi docs/PACKAGING.md.
 * In breve: i formati richiesti (NSIS, portable, DMG, AppImage, deb) sono
 * tutti supportati nativamente da electron-builder; con Forge NSIS e
 * AppImage richiederebbero maker di terze parti non ufficiali.
 *
 * Risorse native: la cartella del convertitore per <piattaforma>-<arch> viene
 * copiata FUORI da app.asar (in resources/), perché un eseguibile non può
 * essere avviato dall'interno di un archivio asar. Le macro ${platform} e
 * ${arch} fanno sì che ogni pacchetto includa SOLO il convertitore della
 * propria piattaforma.
 *
 * Firma del codice: disattivata di default. Si abilita con variabili
 * d'ambiente (mai certificati nel repository): vedi docs/CODE_SIGNING.md.
 */

const signingRequested = process.env.VIDEO2MP3_SIGN === '1';

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.example.videotomp3desktop',
  productName: 'Video to MP3',
  copyright: 'Copyright © 2026 Video to MP3 Desktop contributors',
  // Nome degli artefatti: le build non firmate sono marcate chiaramente.
  artifactName: signingRequested
    ? '${productName}-${version}-${os}-${arch}.${ext}'
    : '${productName}-${version}-${os}-${arch}-UNSIGNED-DEV.${ext}',

  directories: {
    output: 'out/make',
    buildResources: 'resources/icons'
  },

  files: [
    'package.json',
    'src/main/**/*.js',
    'src/renderer/**/*',
    '!**/*.map',
    '!**/*.test.js'
  ],
  asar: true,

  // Il convertitore PyInstaller include già PyAV e le librerie FFmpeg:
  // non ci sono binari ffmpeg/ffprobe separati da copiare.
  extraResources: [
    { from: 'resources/python-converter/${platform}-${arch}', to: 'python-converter/${platform}-${arch}', filter: ['**/*', '!.gitkeep'] },
    { from: 'resources/licenses', to: 'licenses', filter: ['**/*'] },
    // Licenze integrali e SORGENTE CORRISPONDENTE del convertitore (obbligo GPL-3.0 sez. 6a):
    // vengono distribuiti insieme all'eseguibile. Generati da "npm run third-party".
    { from: 'resources/third-party/${platform}-${arch}', to: 'third-party/${platform}-${arch}', filter: ['**/*'] }
  ],

  // ---------------- Windows ----------------
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] }
    ],
    // Firma: impostare CSC_LINK / CSC_KEY_PASSWORD (o WIN_CSC_LINK) nell'ambiente.
    signAndEditExecutable: true
  },
  nsis: {
    oneClick: false,
    perMachine: false,                       // installazione per utente: nessun UAC richiesto
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Video to MP3',
    deleteAppDataOnUninstall: false,
    license: 'LICENSE'
  },
  portable: {
    artifactName: signingRequested
      ? '${productName}-${version}-portable-${arch}.${ext}'
      : '${productName}-${version}-portable-${arch}-UNSIGNED-DEV.${ext}'
  },

  // ---------------- macOS ----------------
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.utilities',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build-config/entitlements.mac.plist',
    entitlementsInherit: 'build-config/entitlements.mac.plist',
    // null = nessuna firma (build locale di sviluppo). Per firmare: VIDEO2MP3_SIGN=1 e CSC_NAME/CSC_LINK.
    identity: signingRequested ? undefined : null,
    // Notarizzazione: richiede APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.
    notarize: signingRequested && Boolean(process.env.APPLE_TEAM_ID)
  },
  dmg: {
    sign: false
  },

  // ---------------- Linux ----------------
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] }
    ],
    category: 'AudioVideo',
    maintainer: 'Video to MP3 Desktop contributors <noreply@example.invalid>',
    synopsis: 'Converti video in MP3, offline',
    executableName: 'video-to-mp3'
  },
  deb: {
    // Electron richiede alcune librerie di sistema; electron-builder aggiunge le dipendenze standard.
    priority: 'optional'
  },

  publish: null
};
