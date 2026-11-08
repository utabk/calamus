// codesign rejects files carrying Finder info / resource forks ("detritus"), which iCloud-synced
// folders and downloaded zips add. Strip extended attributes from the packed app before signing.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('xattr', ['-cr', app]);
};
