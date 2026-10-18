const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
module.exports = async ({ appOutDir, electronPlatformName, packager, arch }) => {
  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, packager.appInfo.productFilename + '.app', 'Contents/Resources')
    : path.join(appOutDir, 'resources');
  const root = path.join(resources, 'platform');
  const target = JSON.parse(fs.readFileSync(path.join(root, 'target.json'), 'utf8'));
  const archName = require('builder-util').Arch[arch];
  if (target.platform !== electronPlatformName || target.arch !== archName) throw Error('Prepared runtime does not match the installer target');
  for (const name of ['server/index.js', 'dist/index.html', 'data/regulatory-sources.json',
    'node_modules/express/package.json', 'node_modules/exceljs/package.json', 'node_modules/yauzl/package.json',
    'bin/ffmpeg' + (electronPlatformName === 'win32' ? '.exe' : ''), 'bin/ffprobe' + (electronPlatformName === 'win32' ? '.exe' : '')]) {
    if (!fs.existsSync(path.join(root, name))) throw Error('Missing installed runtime resource: ' + name);
  }
  if (fs.existsSync(path.join(root, '.env'))) throw Error('Private .env must never be included in installers');
  if (electronPlatformName === 'darwin') {
    const bundle = path.dirname(path.dirname(resources));
    // Finder metadata invalidates codesign. Remove only these two metadata
    // attributes from newly built resources; quarantine is deliberately kept.
    for (const attribute of ['com.apple.FinderInfo', 'com.apple.ResourceFork']) {
      try { execFileSync('/usr/bin/xattr', ['-r', '-d', attribute, bundle], { stdio: 'pipe' }); }
      catch (error) { if (!String(error.stderr).includes('No such xattr')) throw error; }
    }
  }
};
