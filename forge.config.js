// Electron Forge configuration for Celldega App.
//
// Nothing here is exotic: the renderer is plain ESM served over the local
// loopback server at runtime, so there is no bundler/webpack plugin to
// configure. The one thing that matters is that node_modules/celldega ships a
// single 10.7 MB pre-bundled ESM file, which local_server.js reads off disk
// (fs reads work inside asar) and serves at /vendor/celldega.js.

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
