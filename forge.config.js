// Electron Forge configuration for Celldega App.
//
// Nothing here is exotic: the renderer is plain ESM served over the local
// loopback server at runtime, so there is no bundler/webpack plugin to
// configure. The one thing that matters is that node_modules/celldega ships a
// single 10.7 MB pre-bundled ESM file, which local_server.js reads off disk
// (fs reads work inside asar) and serves at /vendor/celldega.js.

const { version } = require('./package.json')

module.exports = {
  packagerConfig: {
    asar: true,
    name: 'Celldega',
    executableName: 'celldega',
    appBundleId: 'org.broadinstitute.celldega',
    // v0.1.0 ships unsigned. Add osxSign/osxNotarize here once Apple
    // developer credentials are available -- see README "Code signing".
  },
  rebuildConfig: {},
  makers: [
    {
      // Primary macOS download: drag-to-Applications installer
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      // Config as a function of the *target* arch. Using process.arch here
      // would be wrong: a universal build produced on an arm64 machine would
      // be labelled "arm64" despite also running on Intel.
      config: (arch) => ({
        name: `Celldega-App-${version}-${arch}`,
        // Volume name, shown when the DMG is mounted. Must be set explicitly
        // and kept short: it defaults to `name`, and macOS alias records cap
        // volume names at 27 chars -- "Celldega-App-0.1.0-universal" is 28,
        // which fails the build outright.
        title: 'Celldega',
        format: 'ULFO',
      }),
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux'],
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'celldega',
        setupExe: 'Celldega-Setup.exe',
      },
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          name: 'celldega',
          productName: 'Celldega',
          categories: ['Science'],
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          name: 'celldega',
          productName: 'Celldega',
          categories: ['Science'],
        },
      },
    },
  ],
}
