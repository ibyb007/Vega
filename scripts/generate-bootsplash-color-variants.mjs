import fs from 'node:fs';
import path from 'node:path';

// The splash art is now a full banner (logo + wordmark baked into a single
// 1280x720 image) rather than a flat-colored icon mark, so per-launcher-
// color retinting no longer applies -- there's no single "icon color" to
// swap the way the old pixel-scanning version did, and running that old
// tomato-hue heuristic against a photographic banner risked mis-tinting
// real image content that happened to fall in its color range. Every
// launcher color variant now shows the identical banner; this script is
// kept only so the file still does something sensible if it's ever run
// again, rather than silently going stale.
const variantNames = ['white', 'tomato', 'gray', 'blue', 'lavender'];
const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
const projectRoot = process.cwd();

for (const density of densities) {
  const sourcePath = path.join(
    projectRoot,
    'assets',
    'bootsplash',
    'android',
    `drawable-${density}`,
    'bootsplash_logo.png',
  );
  const source = fs.readFileSync(sourcePath);

  for (const name of variantNames) {
    const filename = `bootsplash_logo_${name}.png`;

    fs.writeFileSync(path.join(path.dirname(sourcePath), filename), source);
    fs.writeFileSync(
      path.join(
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'res',
        `drawable-${density}`,
        filename,
      ),
      source,
    );
  }
}
