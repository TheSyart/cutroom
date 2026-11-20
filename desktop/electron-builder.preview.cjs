module.exports = {
  extends: './electron-builder.yml',
  mac: {
    target: ['dmg', 'zip'],
    identity: null,
    artifactName: 'Cutroom-${version}-macos-${arch}-UNSIGNED-PREVIEW.${ext}',
  },
  win: {
    target: ['nsis'],
    artifactName: 'Cutroom-${version}-windows-${arch}-UNSIGNED-PREVIEW.${ext}',
  },
  linux: {
    target: ['AppImage', 'deb'],
    artifactName: 'Cutroom-${version}-linux-x64-UNSIGNED-PREVIEW.${ext}',
    maintainer: 'Cutroom maintainers',
    vendor: 'Cutroom',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
}
