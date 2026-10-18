const path = require('node:path');
const { execFileSync } = require('node:child_process');
module.exports = async ({ appOutDir, electronPlatformName, packager }) => {
  if (electronPlatformName !== 'darwin') return;
  const app = path.join(appOutDir, packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  for (const name of ['ffmpeg', 'ffprobe']) {
    execFileSync('codesign', ['--verify', '--strict', path.join(app, 'Contents/Resources/platform/bin', name)], { stdio: 'inherit' });
  }
};
